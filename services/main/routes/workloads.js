'use strict'

// The provider-neutral workload endpoint. ICC computes a workload spec once and
// posts it here; the provider renders it into its own primitives. Kubernetes
// keeps using /controllers, /services and /secrets, where ICC sends fully
// rendered manifests, because a Deployment is self-contained and a task
// definition is not. See ECS-SUPPORT.md D1 and D4.

module.exports = async function (fastify) {
  fastify.put('/workloads/:namespace', {
    schema: {
      description: 'Create or update a workload from a provider-neutral spec (idempotent)',
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'machinist#/definitions/namespace' }
        }
      },
      body: {
        type: 'object'
      }
    }
  }, async (request) => {
    const { namespace } = request.params
    return fastify.provider.applyWorkload(namespace, request.body)
  })
}
