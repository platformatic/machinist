'use strict'

// TODO(ecs): Skew protection — design provider-agnostic traffic routing
// abstraction when adding skew protection for non-K8s providers.

module.exports = async function routes (fastify) {
  fastify.get('/gateway/gateways/:scope', {
    schema: {
      description: 'List Gateways in a scope',
      params: {
        type: 'object',
        properties: {
          scope: { $ref: 'machinist#/definitions/scope' }
        }
      }
    }
  }, async (request) => {
    const { scope } = request.params
    return fastify.provider.listGateways(scope)
  })
}
