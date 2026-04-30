'use strict'

module.exports = async function routes (fastify) {
  fastify.get('/machines/:namespace/:id', {
    schema: {
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'machinist#/definitions/namespace' },
          id: { $ref: 'machinist#/definitions/machineId' }
        }
      },
      response: {
        200: { $ref: 'machine#' }
      }
    }
  }, async (request) => {
    const { namespace, id } = request.params
    return fastify.provider.getMachine(namespace, id)
  })

  fastify.get('/machines/:namespace', {
    schema: {
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'machinist#/definitions/namespace' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          labels: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      }
    }
  }, async (request) => {
    const { namespace } = request.params
    const labelEntries = request.query.labels || []

    const labels = {}
    for (const entry of labelEntries) {
      const [key, value] = entry.split('=')
      labels[key] = value
    }

    return fastify.provider.getMachines(namespace, labels)
  })

  fastify.patch('/machines/:namespace/:id/labels', {
    schema: {
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'machinist#/definitions/namespace' },
          id: { $ref: 'machinist#/definitions/machineId' }
        }
      },
      body: {
        type: 'object',
        properties: {
          labels: {
            type: 'object',
            additionalProperties: { type: 'string' }
          }
        }
      }
    }
  }, async (request) => {
    const { namespace, id } = request.params
    const { labels } = request.body

    await fastify.provider.setMachineLabels(namespace, id, labels)
    return { labels }
  })
}
