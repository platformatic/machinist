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
```

### Required IAM permissions

```json
{
  "Effect": "Allow",
  "Action": [
    "ecs:ListTasks", "ecs:DescribeTasks",
    "ecs:ListServices", "ecs:DescribeServices",
    "ecs:UpdateService", "ecs:DeleteService",
    "ecs:TagResource", "ecs:UntagResource",
    "ecs:ListTagsForResource",
    "tag:GetResources"
  ],
  "Resource": "*"
}
```

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

### K8s integration tests

Requires [k3d](https://k3d.io/stable/#installation) and
[kubectl](https://kubernetes.io/docs/tasks/tools/#kubectl).

```sh
pnpm test              # Full cycle: create cluster, run tests, destroy cluster
pnpm test:setup        # Create cluster only
pnpm test:unit         # Run tests only
pnpm test:teardown     # Destroy cluster only
```

### ECS unit tests

ECS tests use mock providers and run without AWS credentials:

```sh
npx borp tests/ecs-provider.test.js
```
