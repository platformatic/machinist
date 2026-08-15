'use strict'

// Kubernetes keeps its declarative HTTPRoute endpoint. Providers that render
// the neutral routing model themselves use /gateway/routeplans instead.

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

  fastify.get('/gateway/httproutes/:namespace/:name', {
    schema: {
      description: 'Get an HTTPRoute',
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'machinist#/definitions/namespace' },
          name: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { namespace, name } = request.params
    const route = await fastify.provider.getHTTPRoute(namespace, name)
    if (!route) {
      return reply.code(404).send({ message: `HTTPRoute ${namespace}/${name} not found` })
    }
    return route
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
