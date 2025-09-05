'use strict'

module.exports = async function routes (fastify, options) {
  fastify.get('/state/:namespace', {
    schema: {
      query: {
        type: 'object',
        properties: {
          podSelector: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['podSelector']
      }
    }
  }, async (request, reply) => {
    const { namespace } = request.params
    const podSelectors = request.query.podSelector || []

    const labels = podSelectors.reduce((acc, selector) => {
      const [key, value] = selector.split('=')
      acc[key] = value
      return acc
    }, {})

    try {
      const [pods, services] = await Promise.all([
        fastify.k8s.getPods(namespace, labels),
        fastify.k8s.getServices(namespace, labels)
      ])

      const serviceNames = services.map(service => service.metadata.name)
      let ingresses = []
      if (serviceNames.length > 0) {
        const serviceNames = services.map(service => service.metadata.name)
        ingresses = await fastify.k8s.getIngressRoutes(namespace, serviceNames)
      }

      const namespaceState = {
        pods,
        services,
        ingresses
      }

      return namespaceState
    } catch (error) {
      fastify.log.error({ namespace, error }, 'Error fetching namespace state')
      throw error
    }
  })
}
