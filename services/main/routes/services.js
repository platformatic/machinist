'use strict'

const serviceEndpointSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    labels: {
      type: 'object',
      additionalProperties: { type: 'string' }
    },
    ports: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          port: { type: 'number' },
          protocol: { type: 'string' }
        }
      }
    }
  }
}

module.exports = async function routes (fastify) {
  fastify.get('/services/:scope', {
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
        },
        required: ['labels']
      },
      response: {
        200: {
          type: 'array',
          items: serviceEndpointSchema
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

    return fastify.provider.getServicesByLabels(scope, labels)
  })

  fastify.delete('/services/:scope/:name', {
    schema: {
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
    return fastify.provider.deleteService(scope, name)
  })
}
