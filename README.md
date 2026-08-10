# machinist

`machinist` is an infrastructure abstraction layer that exposes a unified REST API
for managing compute resources across different providers. It sits between the
`intelligent-command-center` (ICC) and the underlying infrastructure (Kubernetes,
AWS ECS, etc.), normalizing provider-specific APIs into a common set of operations.

## Architecture

```
ICC (control-plane, scaler)
       |
       | HTTP REST
       v
   machinist
       |
       | Provider interface
       v
  ┌─────────┬──────────┐
  │   K8s   │   ECS    │  ... future providers
  └─────────┴──────────┘
```

Machinist is a **thin API mapper**, not a business logic controller. Each provider
translates the generic interface into provider-specific API calls. No business logic
lives in machinist — it only normalizes data shapes and delegates operations.

## Provider Interface

Every provider implements the same set of methods, documented in
[`services/main/lib/provider-interface.js`](services/main/lib/provider-interface.js).
The provider is selected via the `PLT_PROVIDER` environment variable (`k8s` or `ecs`).

### Data Models

Three resource types flow through the API, all with the same shape regardless of provider:

#### Machine

A single compute unit (K8s Pod / ECS Task).

```javascript
{
  id: "abc123",                            // K8s: pod name. ECS: task ID (short)
  status: "Running",                       // K8s: pod phase. ECS: lastStatus
  startTime: "2025-01-01T00:00:00.000Z",
  image: "myapp:latest",                   // First container's image
  labels: {                                // K8s: pod labels. ECS: task tags
    "app.kubernetes.io/name": "myapp"
  },
  controller: {                            // Owning compute group
    name: "my-deployment"                  // K8s: top-level deployment name. ECS: service name
  },
  resources: {
    limits:   { cpu: "1",    memory: "1Gi"   },
    requests: { cpu: "500m", memory: "512Mi" }  // ECS: same as limits (no distinction)
  }
}
```

#### Controller

A compute group that manages replicas (K8s Deployment / ECS Service).

```javascript
{
  name: "my-deployment",                   // K8s: deployment name. ECS: service name
  replicas: 3,                             // K8s: spec.replicas. ECS: desiredCount
  labels: {                                // K8s: metadata.labels. ECS: service tags
    "app.kubernetes.io/name": "myapp"
  },
  machines: [Machine, ...]                 // Associated machines
}
```

#### ServiceEndpoint

A network endpoint for reaching an application (K8s Service / ECS load balancer + Cloud Map).

```javascript
{
  name: "my-service",                      // K8s: service name. ECS: service name
  labels: {                                // K8s: metadata.labels. ECS: service tags
    "app.kubernetes.io/name": "myapp"
  },
  ports: [
    { port: 8080, protocol: "TCP" }        // K8s: spec.ports. ECS: LB containerPort or Cloud Map port
  ]
}
```

### Methods

| Method | Purpose | K8s Implementation | ECS Implementation |
|--------|---------|--------------------|--------------------|
| `getMachine(scope, id)` | Get a single machine | `GET /api/v1/.../pods/{id}` + ownerRef walk | `DescribeTasks` + parse `task.group` |
| `getMachines(scope, labels?)` | List machines, optionally filtered by labels | `GET /api/v1/.../pods?labelSelector=...` | `GetResources` (tag filter) + `DescribeTasks` |
| `setMachineLabels(scope, id, labels)` | Set metadata on a machine | `PATCH` pod with strategic-merge-patch | `TagResource` on task ARN |
| `getControllers(scope, machineId?)` | List controllers, or find controller for a machine | Get pods, group by ownerRef controller | `ListServices` + `DescribeServices`, or parse `task.group` |
| `getController(scope, name)` | Get a controller with its machines | Resolve kind/apiVersion internally, fetch deployment + pods by matchLabels | `DescribeServices` + `ListTasks` + `DescribeTasks` |
| `updateControllerReplicas(scope, name, n)` | Scale a controller | Read-modify-write: GET deployment, set `spec.replicas`, PUT | `UpdateService({ desiredCount: n })` |
| `deleteController(scope, name)` | Delete a controller | `DELETE` deployment | `DeleteService({ force: true })` |
| `getServicesByLabels(scope, labels)` | Find network endpoints by labels | `GET /api/v1/.../services?labelSelector=...` | `GetResources` (tag filter) + `DescribeServices` |
| `deleteService(scope, name)` | Delete a network endpoint | `DELETE` K8s Service | No-op (ECS Service = controller, already deleted by `deleteController`) |

### Scope

The `scope` parameter is a provider-specific resource boundary:

- **K8s**: namespace (e.g., `default`, `production`)
- **ECS**: cluster name (e.g., `my-cluster`)

### Skew Protection (K8s only)

Traffic routing for canary/versioned deployments uses K8s Gateway API resources.
These methods are only implemented by the K8s provider:

| Method | Purpose |
|--------|---------|
| `listGateways(scope)` | Discover Gateway resources in scope |
| `applyHTTPRoute(scope, httpRoute)` | Create/update traffic routing rules |
| `deleteHTTPRoute(scope, name)` | Remove traffic routing rules |

## REST API

All routes are served under a `/:provider/` prefix (e.g., `/k8s/machines/...` or `/ecs/machines/...`).

### Machines

```
GET    /:provider/machines/:scope/:id              Get machine details
GET    /:provider/machines/:scope?labels[]=k=v      List machines by labels
PATCH  /:provider/machines/:scope/:id/labels        Set machine labels
```

### Controllers

```
GET    /:provider/controllers/:scope?machineId=x    Find controller(s) for a machine
GET    /:provider/controllers/:scope/:name           Get controller with machines
POST   /:provider/controllers/:scope/:name           Scale replicas (body: { replicas })
DELETE /:provider/controllers/:scope/:name           Delete controller
```

### Services

```
GET    /:provider/services/:scope?labels[]=k=v      Find service endpoints by labels
DELETE /:provider/services/:scope/:name              Delete service endpoint
```

### Gateways / HTTPRoutes (K8s only)

```
GET    /:provider/gateway/gateways/:scope            List gateways
PUT    /:provider/gateway/httproutes/:scope           Create/update HTTPRoute
DELETE /:provider/gateway/httproutes/:scope/:name     Delete HTTPRoute
```

## K8s Provider

The K8s provider communicates with the Kubernetes API server using HTTP/2 via `undici`.

### How kind/apiVersion resolution works

K8s needs `kind` (e.g., `Deployment`) and `apiVersion` (e.g., `apps/v1`) to construct
API paths. Since the generic interface doesn't expose these, the K8s provider resolves
them internally:

1. **From machine context**: When fetching machines (pods), the provider walks
   `ownerReferences` up to the top-level controller. Each ownerReference carries
   `kind` and `apiVersion`, so the provider knows the type.

2. **Direct controller queries**: When called with just a name (e.g.,
   `getController(scope, "my-app")`), the provider tries common API groups in order:
   `apps/v1 Deployment` -> `apps/v1 StatefulSet` -> `apps/v1 ReplicaSet` ->
   `v1 ReplicationController`. Stops at the first successful response.

3. **Internal cache**: After resolution, the mapping `(scope, name) -> (kind, apiVersion)`
   is cached for the lifetime of the provider instance.

### Authentication

| Mode | Config |
|------|--------|
| Bearer token (default) | Reads from `/var/run/secrets/kubernetes.io/serviceaccount/token` |
| Client certificate | `PLT_K8S_CLIENT_CERT` and `PLT_K8S_CLIENT_KEY` (base64 encoded) |

### Configuration

```
PLT_PROVIDER=k8s                          Provider selection
PLT_K8S_AUTH_TYPE=token                    token | client-cert
PLT_K8S_REST_API_URL=https://kubernetes.default.svc
PLT_K8S_CA_PATH=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
PLT_K8S_TOKEN_PATH=/var/run/secrets/kubernetes.io/serviceaccount/token
PLT_K8S_ALLOW_SELFSIGNED_CERT=false
PLT_K8S_CLIENT_CERT=                      Base64-encoded client cert
PLT_K8S_CLIENT_KEY=                       Base64-encoded client key
```

## ECS Provider

The ECS provider communicates with AWS APIs using `@aws-sdk/client-ecs` and
`@aws-sdk/client-resource-groups-tagging-api`.

### Key differences from K8s

| Aspect | K8s | ECS |
|--------|-----|-----|
| Scoping | Namespace | Cluster |
| Controller hierarchy | Pod -> ReplicaSet -> Deployment (recursive walk) | Task -> Service (flat: `task.group`) |
| Label filtering | Native `labelSelector` on all list APIs | Not supported in ECS list APIs. Uses `ResourceGroupsTaggingAPI.GetResources` for tag-based queries |
| Resources | Requests (guaranteed) + Limits (max) | Single value (no distinction) |
| Service = networking | K8s Service is a separate networking resource | ECS Service IS the controller. `deleteService` is a no-op |
| Replica update | Read-modify-write (GET, set replicas, PUT full object) | Single atomic call: `UpdateService({ desiredCount })` |
| Tags | Unlimited labels | Max 50 tags per resource |

### How tag-based queries work

ECS list APIs (`ListTasks`, `ListServices`) do not support tag filters. To find resources
by tags, the provider uses a two-step process:

1. `ResourceGroupsTaggingAPI.GetResources({ TagFilters, ResourceTypeFilters: ["ecs:task"] })`
   returns ARNs matching the tags.
2. `DescribeTasks({ tasks: [arns...] })` fetches the full details.

This adds latency compared to K8s label selectors but produces the same result.

### Authentication

The provider uses the AWS SDK default credential chain:

1. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
2. Shared credentials file (`~/.aws/credentials`)
3. ECS container credentials (automatic when running on ECS)
4. EC2 Instance Metadata (IMDS)

### Configuration

```
PLT_PROVIDER=ecs                          Provider selection
PLT_ECS_REGION=us-east-1                  AWS region
PLT_ECS_CLUSTER=my-cluster                ECS cluster name
PLT_ECS_LISTENER_ARN=arn:aws:...          ALB listener for skew-protection routing (optional)
```

`PLT_ECS_LISTENER_ARN` is the shared ALB listener that skew-protection routing
programs. It is provisioned outside machinist, by the deployment's own
infrastructure stack, and machinist only discovers and writes rules on it. Leave
it unset to run without version routing: `listGateways` then reports nothing,
which is the same situation as a Kubernetes cluster with no Gateway resource.

### Required IAM permissions

```json
{
  "Effect": "Allow",
  "Action": [
    "ecs:ListTasks", "ecs:DescribeTasks",
    "ecs:ListServices", "ecs:DescribeServices",
    "ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService",
    "ecs:RegisterTaskDefinition",
    "ecs:TagResource", "ecs:UntagResource",
    "ecs:ListTagsForResource",
    "tag:GetResources"
  ],
  "Resource": "*"
}
```

Creating workloads also needs `iam:PassRole` for the execution and task roles
named by `PLT_ECS_EXECUTION_ROLE_ARN` and `PLT_ECS_TASK_ROLE_ARN`, scoped to
those two role ARNs. Private images add `secretsmanager:CreateSecret`, `secretsmanager:PutSecretValue`,
`secretsmanager:DeleteSecret` and `secretsmanager:RestoreSecret`. Cloud Map
addressing adds `servicediscovery:ListServices`, `servicediscovery:CreateService`,
`servicediscovery:GetNamespace`, `servicediscovery:DeleteService`,
`servicediscovery:ListInstances` and `servicediscovery:DeregisterInstance`.

The delete permissions are not optional extras: deleting a version removes the
Cloud Map service and the pull secret it created, and without them each expired
version leaves both behind for the lifetime of the application.

Skew-protection routing needs these in addition. They are only required when
`PLT_ECS_LISTENER_ARN` is set:

```json
{
  "Effect": "Allow",
  "Action": [
    "elasticloadbalancing:DescribeListeners",
    "elasticloadbalancing:DescribeLoadBalancers",
    "elasticloadbalancing:DescribeRules",
    "elasticloadbalancing:DescribeTargetGroups",
    "elasticloadbalancing:DescribeTargetHealth",
    "elasticloadbalancing:CreateRule",
    "elasticloadbalancing:DeleteRule",
    "elasticloadbalancing:CreateTargetGroup",
    "elasticloadbalancing:DeleteTargetGroup",
    "elasticloadbalancing:AddTags",
    "elasticloadbalancing:DescribeTags"
  ],
  "Resource": "*"
}
```

`CreateRule` and `DeleteRule` can be scoped to the listener ARN. The `Describe*`
actions cannot: ELB does not support resource-level permissions on them, so they
have to stay on `*`.

Machinist creates one target group per version and attaches it in the same
`CreateService` call that creates the workload. Attaching one to a service that
already exists is an `UpdateService` on `loadBalancers`, which restarts its
tasks -- on a draining version that would destroy the sessions skew protection
exists to preserve -- so creation is the only moment it is free. The group is
deleted with the version, because target groups per load balancer is 100 and is
not adjustable.

No `RegisterTargets` permission is needed or wanted: ECS registers and
deregisters the task addresses itself, from the `loadBalancers` on the service.

## Installation

### Prerequisites

**For K8s provider:**
1. An existing Kubernetes cluster
2. RBAC for machinist in required namespaces (see `infra/machinist.yaml`)

**For ECS provider:**
1. An ECS cluster
2. IAM credentials with the permissions listed above

### Helm chart (K8s)

```sh
helm install oci://ghcr.io/platformatic/helm \
    --version "^4" \
    --set "services.icc.deploy=false"
```

### Manual (K8s)

```sh
kubectl --namespace <your-namespace> apply -f infra/machinist.yaml
```

## Testing

There are two suites, with different dependencies:

| Suite | Command | Needs |
|---|---|---|
| Unit and K8s integration | `pnpm test:unit` | the `plt-machinist-test` K3d cluster |
| ECS provider routing (end to end) | `pnpm test:e2e:ecs` | the emulator stack from `docker-compose.yml` |

`pnpm test` prepares both, runs both, and always cleans up, including after a
failure. It requires Docker, [k3d](https://k3d.io/stable/#installation), and
[kubectl](https://kubernetes.io/docs/tasks/tools/#kubectl). Use Node.js 24,
pnpm 11, and k3d 5.8.3 to match CI.

Run these commands from the repository root:

```sh
pnpm test             # Prepare everything, run both suites, clean up
pnpm test:setup       # Prepare the cluster, CRDs, test image, and emulator
pnpm test:unit        # Unit and K8s tests against an already-prepared cluster
pnpm test:e2e:ecs     # ECS/ALB tests against an already-running emulator
pnpm test:teardown    # Destroy the test cluster and the emulator stack
```

The cluster name `plt-machinist-test` is reserved for this suite and is removed
at the end of the run. The existing `plt-development` cluster is not touched.
Run `pnpm lint` separately for the same lint check CI performs before the suite.

### K8s integration tests

`test:setup` creates the `plt-machinist-test` K3d cluster, installs the Gateway
API CRDs, and builds and imports `platformatic/machinist-test:latest`. CI does
the same, with the cluster created by `k3d-action` instead.

### ECS provider routing tests

The ECS provider programs ALB listener rules rather than Kubernetes objects, so
these tests run it against [floci](https://github.com/floci-io/floci), an AWS
emulator with a real ALB data plane. They assert both that the API accepts the
rules the provider creates and that those rules route real traffic to the right
backend. LocalStack cannot stand in for it: ELBv2 is a licensed service there.

`docker-compose.yml` at the repository root defines the stack, started by
`test:setup` and by CI:

- **floci** on **4566** (the AWS API) and **8081** (the ALB listener the tests
  create). Both ports must be free.
- Two BusyBox backends on fixed addresses in `172.30.0.0/24`, registered as the
  IP targets of the per-version target groups.

Images are pinned: the emulator is the reference these tests measure against, so
a floating tag could change what routing is asserted to do without a commit.

`pnpm test:e2e:ecs` **fails** rather than skips when the stack is not running,
so a suite cannot report success without having executed anything. The tests
live in `services/main/tests/e2e/`, outside the `tests/*.test.js` unit glob, so
`test:unit` never picks them up.

What they do not cover: ECS tasks do not serve the traffic, the machinist HTTP
route-plan endpoint is not exercised, and neither is ICC-to-machinist
communication or ECS task discovery.

### Conformance probe against real AWS

The emulator is a reimplementation, and a known divergent one, so authoritative
ALB matching semantics need a real load balancer.
`services/main/scripts/probe-alb-query-routing.sh` asks for them. It is run by
hand, against an account, and is not part of any suite:

```sh
./services/main/scripts/probe-alb-query-routing.sh --listener <arn> --yes
```

It needs one existing HTTP/HTTPS listener and permission to create, tag and
delete rules on it -- no target groups and no backends, because every rule it
creates answers with `fixed-response`, which isolates matching from forwarding.
It is safe against a live listener by construction: rules are scoped to the host
`plt-skew-probe.invalid`, which no real client sends, tagged
`plt.dev/managed-by=icc-probe` so they cannot be mistaken for the rules ICC
manages, allocated into free priorities, and removed on every exit path. It does
briefly consume 3 of the listener's rule quota.

It asserts the semantics ICC depends on, and separately *records* the answers to
questions the emulator cannot settle: a repeated key with conflicting values,
the case of the key itself, and wildcards in a request. Quotas are not probed;
read those from Service Quotas.

### ECS unit tests

ECS tests use mock providers and run without AWS credentials:

```sh
npx borp tests/ecs-provider.test.js
```
