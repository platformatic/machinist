'use strict'

module.exports = async function routes (fastify, options) {
  fastify.addSchema({
    $id: 'pods',
    type: 'array',
    items: { $ref: 'pod#' }
  })

  fastify.get('/pods/:namespace/:id', {
    schema: {
      description: 'Get pod details',
      params: {
        type: 'object',
        properties: {
          id: { $ref: 'k8s#/definitions/podId' },
          namespace: { $ref: 'k8s#/definitions/namespace' }
        }
      },
      response: {
        200: { $ref: 'pod#' }
      }
    }
  }, async function (req, reply) {
    const { namespace, id } = req.params
    return fastify.k8s.getPod(namespace, id)
  })

  fastify.patch('/pods/:namespace/:id/labels', {
    schema: {
      description: 'Set pod labels',
      params: {
        type: 'object',
        properties: {
          id: { $ref: 'k8s#/definitions/podId' },
          namespace: { $ref: 'k8s#/definitions/namespace' }
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
  }, async function (req) {
    const { namespace, id } = req.params
    const { labels } = req.body

    await fastify.k8s.setMachineLabels(id, namespace, labels)
    return { labels }
  })
}
