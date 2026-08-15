'use strict'

// Provider-specific gateway discovery behind one endpoint. Kubernetes returns
// Gateway API resources; ECS exposes its configured ALB listener as equivalent
// gateway metadata for the neutral RoutePlan path.

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
