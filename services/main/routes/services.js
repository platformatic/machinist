'use strict'

module.exports = async function routes (fastify, options) {
  fastify.get('/services/:namespace', {
    schema: {
      description: 'Get services by metadata labels',
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'k8s#/definitions/namespace' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          labels: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['labels']
      }
    }
  }, async (request, reply) => {
    const { namespace } = request.params
    const labelEntries = request.query.labels || []

    const labels = {}
    for (const entry of labelEntries) {
      const [key, value] = entry.split('=')
      labels[key] = value
    }

    return fastify.k8s.getServicesByLabels(namespace, labels)
  })
}
