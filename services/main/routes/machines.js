'use strict'

module.exports = async function routes (fastify) {
  fastify.get('/machines/:scope/:id', {
    schema: {
      params: {
        type: 'object',
        properties: {
          scope: { $ref: 'machinist#/definitions/scope' },
          id: { $ref: 'machinist#/definitions/machineId' }
        }
      },
      response: {
        200: { $ref: 'machine#' }
      }
    }
  }, async (request) => {
    const { scope, id } = request.params
    return fastify.provider.getMachine(scope, id)
  })

  fastify.get('/machines/:scope', {
    schema: {
      params: {
        type: 'object',
        properties: {
          scope: { $ref: 'machinist#/definitions/scope' }
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
    const { scope } = request.params
    const labelEntries = request.query.labels || []

    const labels = {}
    for (const entry of labelEntries) {
      const [key, value] = entry.split('=')
      labels[key] = value
    }

    return fastify.provider.getMachines(scope, labels)
  })

  fastify.patch('/machines/:scope/:id/labels', {
    schema: {
      params: {
        type: 'object',
        properties: {
          scope: { $ref: 'machinist#/definitions/scope' },
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
    const { scope, id } = request.params
    const { labels } = request.body

    await fastify.provider.setMachineLabels(scope, id, labels)
    return { labels }
  })
}
