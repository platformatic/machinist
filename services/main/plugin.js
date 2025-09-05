'use strict'

const autoload = require('@fastify/autoload')
const sensible = require('@fastify/sensible')
const { join } = require('path')

async function plugin (fastify, options) {
  fastify.register(sensible)
  fastify.register(autoload, { dir: join(__dirname, 'plugins'), options })
  fastify.register(autoload, { dir: join(__dirname, 'routes') })
}

module.exports = plugin
