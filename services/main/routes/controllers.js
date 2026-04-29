'use strict'

const controllerSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    replicas: { type: 'number' },
    labels: {
      type: 'object',
      additionalProperties: { type: 'string' }
    },
    providerMetadata: {
      type: 'object',
      additionalProperties: true
    },
    machines: {
      type: 'array',
      items: { $ref: 'machine#' }
    }
  }
}

module.exports = async function routes (fastify) {
  fastify.get('/controllers/:scope', {
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
          machineId: { type: 'string' }
        },
        // Allow opaque providerMetadata fields (e.g. kind, apiVersion for K8s)
        additionalProperties: true
      },
      response: {
        200: {
          type: 'object',
          properties: {
            controllers: {
              type: 'array',
              items: controllerSchema
            }
          }
        }
      }
    }
  }, async (request) => {
    const { scope } = request.params
    const { machineId } = request.query

    const controllers = await fastify.provider.getControllers(scope, machineId)
    return { controllers }
  })

  fastify.get('/controllers/:scope/:name', {
    schema: {
      params: {
        type: 'object',
        properties: {
          scope: { $ref: 'machinist#/definitions/scope' },
          name: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        // Opaque provider-specific identifying info (e.g. kind, apiVersion for K8s)
        additionalProperties: true
      },
      response: {
        200: {
          type: 'object',
          properties: {
            controller: controllerSchema
          }
        }
      }
    }
  }, async (request) => {
    const { scope, name } = request.params
    const providerMetadata = { ...request.query }
    const controller = await fastify.provider.getController(scope, name, providerMetadata)
    return { controller }
  })

  fastify.post('/controllers/:scope/:name', {
    schema: {
      params: {
        type: 'object',
        properties: {
          scope: { $ref: 'machinist#/definitions/scope' },
          name: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        // providerMetadata fields (e.g. kind, apiVersion for K8s)
        additionalProperties: true
      },
      body: {
        type: 'object',
        properties: {
          replicas: { type: 'number' }
        },
        required: ['replicas']
      },
      response: {
        200: controllerSchema
      }
    }
  }, async (request) => {
    const { scope, name } = request.params
    const { replicas } = request.body
    const providerMetadata = { ...request.query }
    return fastify.provider.updateControllerReplicas(scope, name, replicas, providerMetadata)
  })

  fastify.delete('/controllers/:scope/:name', {
    schema: {
      params: {
        type: 'object',
        properties: {
          scope: { $ref: 'machinist#/definitions/scope' },
          name: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        additionalProperties: true
      }
    }
  }, async (request) => {
    const { scope, name } = request.params
    const providerMetadata = { ...request.query }
    return fastify.provider.deleteController(scope, name, providerMetadata)
  })
}
