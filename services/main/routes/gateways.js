'use strict'

// TODO(ecs): Skew protection — design provider-agnostic traffic routing
// abstraction when adding skew protection for non-K8s providers.

module.exports = async function routes (fastify) {
  fastify.get('/gateway/gateways/:namespace', {
    schema: {
      description: 'List Gateways in a namespace',
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'machinist#/definitions/namespace' }
        }
      }
    }
  }, async (request) => {
    const { namespace } = request.params
    return fastify.provider.listGateways(namespace)
  })
}
