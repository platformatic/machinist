'use strict'

// TODO(ecs): Skew protection — design provider-agnostic traffic routing
// abstraction when adding skew protection for non-K8s providers.

module.exports = async function routes (fastify) {
  fastify.put('/gateway/httproutes/:scope', {
    schema: {
      description: 'Create or update an HTTPRoute',
      params: {
        type: 'object',
        properties: {
          scope: { $ref: 'machinist#/definitions/scope' }
        }
      },
      body: {
        type: 'object'
      }
    }
  }, async (request) => {
    const { scope } = request.params
    return fastify.provider.applyHTTPRoute(scope, request.body)
  })

  fastify.delete('/gateway/httproutes/:scope/:name', {
    schema: {
      description: 'Delete an HTTPRoute',
      params: {
        type: 'object',
        properties: {
          scope: { $ref: 'machinist#/definitions/scope' },
          name: { type: 'string' }
        }
      }
    }
  }, async (request) => {
    const { scope, name } = request.params
    return fastify.provider.deleteHTTPRoute(scope, name)
  })
}
