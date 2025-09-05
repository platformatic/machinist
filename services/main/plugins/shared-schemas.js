'use strict'

const fp = require('fastify-plugin')

module.exports = fp(function (fastify, opts, done) {
  fastify.addSchema({
    $id: 'k8s',
    type: 'object',
    definitions: {
      namespace: { type: 'string' },
      podId: { type: 'string' },
      hpaId: { type: 'string' }
    }
  })

  fastify.addSchema({
    $id: 'pod',
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string' },
      privateIp: { type: 'string' },
      startTime: { type: 'string', format: 'date-time' },
      image: { type: 'string' },
      labels: {
        type: 'object',
        patternProperties: {
          '^.*$': { type: 'string' }
        }
      },
      controller: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          apiVersion: { type: 'string' },
          name: { type: 'string' }
        }
      },
      resources: {
        type: 'object',
        properties: {
          limits: {
            type: 'object',
            properties: {
              cpu: { type: 'string' },
              memory: { type: 'string' }
            }
          },
          requests: {
            type: 'object',
            properties: {
              cpu: { type: 'string' },
              memory: { type: 'string' }
            }
          }
        }
      }
    }
  })

  done()
}, { name: 'routeSchemas' })
