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

  // The ports traffic reaches the machine on (Kubernetes Services, ECS load balancer listeners / Cloud Map), each
  // with the container port it is forwarded to. `port` is null when only the container port is known (an ECS task
  // definition). The application listening on a `targetPort` is the one reachable from outside.
  fastify.get('/machines/:namespace/:id/ports', {
    schema: {
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'machinist#/definitions/namespace' },
          id: { $ref: 'machinist#/definitions/machineId' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ports: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  port: { type: ['integer', 'null'] },
                  targetPort: { type: 'integer' }
                },
                required: ['port', 'targetPort']
              }
            }
          },
          required: ['ports']
        }
      }
    }
  }, async (request) => {
    const { namespace, id } = request.params
    const ports = await fastify.provider.getMachinePorts(namespace, id)
    return { ports }
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
