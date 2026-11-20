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

// What a provider did with the machines the caller asked to remove first, see the POST route below. Present only in
// the answer to a request which named machines.
const removalSchema = {
  type: 'object',
  properties: {
    // Whether the provider was told to remove the machines first: a preference on Kubernetes, see the provider
    steered: { type: 'boolean' },
    // The machines of the controller found among those named
    machines: { type: 'array', items: { type: 'string' } },
    // Why the removal was not steered
    reason: { type: 'string' }
  }
}

const scaledControllerSchema = {
  ...controllerSchema,
  properties: { ...controllerSchema.properties, removal: removalSchema }
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
          replicas: { type: 'number' },
          // Optional: the machines to remove first when the count is lowered, i.e. those the caller emptied. Without
          // it the provider chooses, as it always did. A machinist which predates it ignores it, and its answer has
          // no `removal`: that is how a caller tells that the removal was not steered.
          remove: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 100
          }
        },
        required: ['replicas']
      },
      response: {
        200: scaledControllerSchema
      }
    }
  }, async (request) => {
    const { namespace, name } = request.params
    const { replicas, remove } = request.body
    const providerMetadata = { ...request.query }
    return fastify.provider.updateControllerReplicas(namespace, name, replicas, providerMetadata, remove)
  })

  fastify.put('/controllers/:namespace', {
    schema: {
      description: 'Create or update a Deployment (idempotent)',
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
    return fastify.provider.applyDeployment(namespace, request.body)
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
