# machinist

`machinist` is minimal wrapper around the Kubernetes REST API that is specific
to the needs of the `intelligent-command-center`.

## Features

* pod to deployment mapping allowing for lookups via `Pod`, `Service`, or
  replication controller name
* namespace state to sync dashboard information in `intelligent-command-center`

## Installation

### Prerequisites

1. An existing Kubernetes cluster
2. An existing ingress controller
3. RBAC for `machinist` in required namespaces
    * If `machinist` is installed using our Helm chart, the namespaces can be
      set at that time.

### Option 1: `intelligent-command-center` install script

With this option, both `machinist` and `intelligent-command-center` are
installed together. The instructions are maintained in
[intelligent-command-center/scripts/README](https://github.com/platformatic/intelligent-command-center/tree/main/scripts/README.md).

### Option 2: Helm chart

Using our Helm chart allows for installing only `machinist` while following our
recommended setup in a simple way.

```sh
helm install oci://ghcr.io/platformatic/helm \
    --version "^4" \
    --set "services.icc.deploy=false"
```

### Option 3: Manual

A sample kubeyaml deployment is available in [infra/machinist.yaml](infra/machinist.yaml).
To apply it:

```sh
kubectl --namespace <your-namespace> apply -f infra/machinist.yaml
```

This isn't a production ready deployment but a quick way to take `machinist` for
a test drive.

## Testing

The following software is required to run tests against a real Kubernetes
cluster locally:

* [k3d](https://k3d.io/stable/#installation) - A Docker-based version of k3s
  that works well across all operating systems
* [kubectl](https://kubernetes.io/docs/tasks/tools/#kubectl) - Command-line tool
  for working with a Kubernetes cluster

When running `pnpm test`, a Kubernetes cluster is created with `k3d`, tests are
run against this cluster, and then the Kubernetes cluster is destroyed. This
process can be split into the following commands:

* `pnpm test:setup` - Create cluster and registry proxy
* `pnpm test:unit` - Execute tests
* `pnpm test:teardown` - Destroy cluster and registry
