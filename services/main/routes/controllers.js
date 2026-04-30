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
  fastify.get('/controllers/:namespace', {
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
    const { namespace } = request.params
    const { machineId } = request.query

    const controllers = await fastify.provider.getControllers(namespace, machineId)
    return { controllers }
  })

  fastify.get('/controllers/:namespace/:name', {
    schema: {
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'machinist#/definitions/namespace' },
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
    const { namespace, name } = request.params
    const providerMetadata = { ...request.query }
    const controller = await fastify.provider.getController(namespace, name, providerMetadata)
    return { controller }
  })

  fastify.post('/controllers/:namespace/:name', {
    schema: {
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'machinist#/definitions/namespace' },
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
    const { namespace, name } = request.params
    const { replicas } = request.body
    const providerMetadata = { ...request.query }
    return fastify.provider.updateControllerReplicas(namespace, name, replicas, providerMetadata)
  })

  fastify.delete('/controllers/:namespace/:name', {
    schema: {
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'machinist#/definitions/namespace' },
          name: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        additionalProperties: true
      }
    }
  }, async (request) => {
    const { namespace, name } = request.params
    const providerMetadata = { ...request.query }
    return fastify.provider.deleteController(namespace, name, providerMetadata)
  })
}
