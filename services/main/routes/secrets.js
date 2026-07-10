'use strict'

module.exports = async function routes (fastify) {
  fastify.put('/secrets/:namespace', {
    schema: {
      description: 'Create or update a Secret (idempotent)',
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
    return fastify.provider.applySecret(namespace, request.body)
  })
}
