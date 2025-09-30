'use strict'

module.exports = async function routes (fastify, options) {
  fastify.get('/controllers/:namespace', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          podId: { type: 'string' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            controllers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string' },
                  apiVersion: { type: 'string' },
                  name: { type: 'string' },
                  replicas: { type: 'number' },
                  metadata: {
                    type: 'object',
                    properties: {
                      labels: {
                        type: 'object',
                        additionalProperties: { type: 'string' }
                      },
                      annotations: {
                        type: 'object',
                        additionalProperties: { type: 'string' }
                      }
                    }
                  },
                  pods: {
                    type: 'array',
                    items: { $ref: 'pod#' }
                  }
                }
              }
            }
          }
        }
      }
    },
    async handler (request, reply) {
      const { namespace } = request.params
      const { podId } = request.query

      let pods = []
      if (podId) {
        pods.push(await fastify.k8s.getPod(namespace, podId))
      } else {
        pods = await fastify.k8s.getPods(namespace)
      }

      request.log.debug({ pods }, 'What pods did we get?')

      const controllersMap = {}

      for (const pod of pods) {
        if (!pod.controller) continue

        const identifier = pod.controller.name

        if (controllersMap[identifier]) {
          controllersMap[identifier].pods.push(pod)
        } else {
          const newController = {
            ...pod.controller,
            replicas: pod.controller.spec?.replicas,
            pods: [pod]
          }
          controllersMap[identifier] = newController
        }

        request.log.debug({ identifier, controllersMap })
      }

      return {
        controllers: Object.values(controllersMap)
      }
    }
  })

  fastify.get('/controllers/:namespace/:controllerId', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          apiVersion: { type: 'string' }
        },
        required: ['apiVersion', 'kind']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            controller: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                apiVersion: { type: 'string' },
                name: { type: 'string' },
                replicas: { type: 'number' },
                metadata: {
                  type: 'object',
                  properties: {
                    labels: {
                      type: 'object',
                      additionalProperties: { type: 'string' }
                    },
                    annotations: {
                      type: 'object',
                      additionalProperties: { type: 'string' }
                    }
                  }
                },
                pods: {
                  type: 'array',
                  items: { $ref: 'pod#' }
                }
              }
            }
          }
        }
      }
    },
    async handler (request, reply) {
      const { controllerId, namespace } = request.params
      const { apiVersion, kind } = request.query

      const controller = await fastify.k8s.getController(namespace, controllerId, apiVersion, kind)

      const pods = await fastify.k8s.getPods(namespace, controller.spec?.selector?.matchLabels || {})

      return {
        controller: {
          ...controller,
          replicas: controller.spec.replicas,
          pods
        }
      }
    }
  })

  fastify.post('/controllers/:namespace/:controllerId', {
    schema: {
      description: 'Update number of replicas for a controller',
      body: {
        type: 'object',
        properties: {
          replicaCount: { type: 'number' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          apiVersion: { type: 'string' }
        },
        required: ['apiVersion', 'kind']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            apiVersion: { type: 'string' },
            name: { type: 'string' },
            replicas: { type: 'number' }
          }
        }
      }
    },
    async handler (request, reply) {
      const { controllerId, namespace } = request.params
      const { apiVersion, kind } = request.query
      const { replicaCount } = request.body

      const controller = await fastify.k8s.updateController(namespace, { kind, apiVersion, name: controllerId }, replicaCount)

      return {
        kind: controller.kind,
        apiVersion: controller.apiVersion,
        name: controller.metadata?.name,
        replicas: controller.spec?.replicas
      }
    }
  })
}
