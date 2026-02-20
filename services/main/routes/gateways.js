'use strict'

module.exports = async function routes (fastify, options) {
  fastify.get('/gateway/gateways', {
    schema: {
      description: 'List all Gateways cluster-wide'
    }
  }, async (request, reply) => {
    return fastify.k8s.listAllGateways()
  })

  fastify.get('/gateway/gateways/:namespace', {
    schema: {
      description: 'List Gateways in a namespace',
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'k8s#/definitions/namespace' }
        }
      }
    }
  }, async (request, reply) => {
    const { namespace } = request.params
    return fastify.k8s.listGateways(namespace)
  })

  fastify.get('/gateway/gateways/:namespace/:name', {
    schema: {
      description: 'Get a specific Gateway',
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'k8s#/definitions/namespace' },
          name: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { namespace, name } = request.params
    return fastify.k8s.getGateway(namespace, name)
  })
}
