'use strict'

// TODO(ecs): Skew protection — design provider-agnostic traffic routing
// abstraction when adding skew protection for non-K8s providers.

module.exports = async function routes (fastify) {
  fastify.put('/gateway/httproutes/:namespace', {
    schema: {
      description: 'Create or update an HTTPRoute',
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
    return fastify.provider.applyHTTPRoute(namespace, request.body)
  })

  fastify.delete('/gateway/httproutes/:namespace/:name', {
    schema: {
      description: 'Delete an HTTPRoute',
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'machinist#/definitions/namespace' },
          name: { type: 'string' }
        }
      }
    }
  }, async (request) => {
    const { namespace, name } = request.params
    return fastify.provider.deleteHTTPRoute(namespace, name)
  })
}
