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
  fastify.get('/services/:namespace', {
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
    const { namespace } = request.params
    const labelEntries = request.query.labels || []

    const labels = {}
    for (const entry of labelEntries) {
      const [key, value] = entry.split('=')
      labels[key] = value
    }

    return fastify.provider.getServicesByLabels(namespace, labels)
  })

  fastify.put('/services/:namespace', {
    schema: {
      description: 'Create or update a Service (idempotent)',
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
    return fastify.provider.applyService(namespace, request.body)
  })

  fastify.delete('/services/:namespace/:name', {
    schema: {
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
    return fastify.provider.deleteService(namespace, name)
  })
}
