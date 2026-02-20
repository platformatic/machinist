'use strict'

module.exports = async function routes (fastify, options) {
  fastify.get('/gateway/httproutes/:namespace/:name', {
    schema: {
      description: 'Get an HTTPRoute by name',
      params: {
        type: 'object',
        properties: {
          namespace: { type: 'string' },
          name: { type: 'string' }
        },
        required: ['namespace', 'name']
      }
    }
  }, async (request, reply) => {
    const { namespace, name } = request.params
    return fastify.k8s.getHTTPRoute(namespace, name)
  })

  fastify.put('/gateway/httproutes/:namespace', {
    schema: {
      description: 'Create or update an HTTPRoute',
      params: {
        type: 'object',
        properties: {
          namespace: { type: 'string' }
        },
        required: ['namespace']
      },
      body: {
        type: 'object'
      }
    }
  }, async (request, reply) => {
    const { namespace } = request.params
    return fastify.k8s.applyHTTPRoute(namespace, request.body)
  })

  fastify.delete('/gateway/httproutes/:namespace/:name', {
    schema: {
      description: 'Delete an HTTPRoute',
      params: {
        type: 'object',
        properties: {
          namespace: { type: 'string' },
          name: { type: 'string' }
        },
        required: ['namespace', 'name']
      }
    }
  }, async (request, reply) => {
    const { namespace, name } = request.params
    return fastify.k8s.deleteHTTPRoute(namespace, name)
  })
}
