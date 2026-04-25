'use strict'

const autoload = require('@fastify/autoload')
const sensible = require('@fastify/sensible')
const { join } = require('path')

async function plugin (fastify, options) {
  fastify.register(sensible)
  fastify.register(autoload, { dir: join(__dirname, 'plugins'), options })

  const provider = process.env.PLT_PROVIDER || 'k8s'
  fastify.register(autoload, {
    dir: join(__dirname, 'routes'),
    options: { prefix: `/${provider}` }
  })
}

module.exports = plugin
