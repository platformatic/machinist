'use strict'

const fp = require('fastify-plugin')

module.exports = fp(function (fastify, opts, done) {
  fastify.addSchema({
    $id: 'machinist',
    type: 'object',
    definitions: {
      namespace: { type: 'string' },
      machineId: { type: 'string' }
    }
  })

  fastify.addSchema({
    $id: 'machine',
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string' },
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
