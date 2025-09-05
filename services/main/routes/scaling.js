'use strict'

const { parseMemoryMetric } = require('../plugins/providers/metrics-source')

module.exports = async function routes (fastify, options) {
  fastify.addSchema({
    $id: 'hpa',
    type: 'object',
    properties: {
      behaviours: {
        type: 'object',
        properties: {
          up: {
            type: 'object',
            properties: {
              percentOfPods: { type: 'number' },
              period: { type: 'number' },
              stabilization: { type: 'number' }
            }
          },
          down: {
            type: 'object',
            properties: {
              percentOfPods: { type: 'number' },
              period: { type: 'number' },
              stabilization: { type: 'number' }
            }
          }
        }
      },
      replicas: {
        type: 'object',
        properties: {
          min: { type: 'number' },
          max: { type: 'number' }
        }
      },
      metrics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            targetValue: { type: 'number' },
            targetType: { type: 'string' }
          }
        }
      }
    }
  })

  fastify.get('/scaling/:namespace', {
    schema: {
      description: 'Get default scaling rules',
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'k8s#/definitions/namespace' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            defaults: { $ref: 'hpa#' }
          }
        }
      }
    }
  }, async function (request, reply) {
    const defaultRules = fastify.k8s.hpaDefaultRules
    return {
      defaults: {
        behaviours: {
          up: defaultRules.up,
          down: defaultRules.down
        },
        replicas: defaultRules.replicas,
        metrics: defaultRules.metrics.map(m => {
          return m.toMarker()
        })
      }
    }
  })

  fastify.post('/scaling/:namespace', {
    schema: {
      description: 'Create new HPA',
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'k8s#/definitions/namespace' }
        }
      },
      body: {
        type: 'object',
        properties: {
          id: { $ref: 'k8s#/definitions/hpaId' },
          podId: { $ref: 'k8s#/definitions/podId' },
          replicas: {
            type: 'object',
            properties: {
              min: { type: 'number' },
              max: { type: 'number' }
            },
            required: ['min', 'max']
          }
        },
        required: ['id', 'podId', 'replicas']
      },
      response: {
        200: { $ref: 'hpa#' }
      }
    }
  }, async function (req, res) {
    const { namespace } = req.params
    const { id, podId, replicas } = req.body

    // Skip creating an HPA
    if (replicas.min === 0 && replicas.max === 0) {
      return {
        behaviours: { up: {}, down: {} },
        replics: { min: 0, max: 0 },
        metrics: []
      }
    }

    const { spec: hpa } = await fastify.k8s.createHpa({
      namespace,
      name: id,
      podId,
      minReplicas: replicas.min,
      maxReplicas: replicas.max
    })

    const defaultRules = fastify.k8s.hpaDefaultRules

    const memoryMetricSource = hpa.metrics.find(m => m.pods.metric.name === 'plt_svc_memory_use')
    const metrics = defaultRules.metrics
    metrics.push(parseMemoryMetric(memoryMetricSource))

    return {
      behaviours: {
        up: defaultRules.up,
        down: defaultRules.down
      },
      replicas: {
        max: hpa.maxReplicas,
        min: hpa.minReplicas
      },
      metrics: metrics.map(m => m.toMarker())
    }
  })

  fastify.post('/scaling/:namespace/:id', {
    schema: {
      description: 'Update HPA scaling rules',
      params: {
        type: 'object',
        properties: {
          id: { $ref: 'k8s#/definitions/hpaId' },
          namespace: { $ref: 'k8s#/definitions/namespace' }
        }
      },
      body: {
        type: 'object',
        properties: {
          replicas: {
            type: 'object',
            properties: {
              min: { type: 'number' },
              max: { type: 'number' }
            },
            required: ['min', 'max']
          }
        },
        required: ['replicas']
      },
      response: {
        200: { $ref: 'hpa#' }
      }
    }
  }, async function (request, reply) {
    const { namespace, id } = request.params
    const { replicas } = request.body

    const hpa = await fastify.k8s.updateHpa(
      namespace,
      id,
      { minReplicas: replicas.min, maxReplicas: replicas.max }
    )

    const defaultRules = fastify.k8s.hpaDefaultRules
    const memoryMetricSource = hpa.metrics.find(m => m.pods.metric.name === 'plt_svc_memory_use')
    const metrics = defaultRules.metrics
    metrics.push(parseMemoryMetric(memoryMetricSource))

    return {
      behaviours: {
        up: defaultRules.up,
        down: defaultRules.down
      },
      replicas: {
        max: hpa.maxReplicas,
        min: hpa.minReplicas
      },
      metrics: metrics.map(m => m.toMarker())
    }
  })

  fastify.get('/scaling/:namespace/:id', {
    schema: {
      description: 'Get HPA scaling rules',
      params: {
        type: 'object',
        properties: {
          id: { $ref: 'k8s#/definitions/hpaId' },
          namespace: { $ref: 'k8s#/definitions/namespace' }
        }
      },
      response: {
        200: { $ref: 'hpa#' }
      }
    }
  }, async function (request, reply) {
    const { namespace, id } = request.params
    const { spec: hpa } = await fastify.k8s.getHpa(namespace, id)
    const defaultRules = fastify.k8s.hpaDefaultRules

    const metrics = defaultRules.metrics

    const memoryMetricSource = hpa.metrics.find(m => m.pods.metric.name === 'plt_svc_memory_use')
    if (memoryMetricSource) {
      metrics.push(parseMemoryMetric(memoryMetricSource))
    }

    return {
      behaviours: {
        up: defaultRules.up,
        down: defaultRules.down
      },
      replicas: {
        max: hpa.maxReplicas,
        min: hpa.minReplicas
      },
      metrics: metrics.map(m => m.toMarker())
    }
  })
}
