'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const Fastify = require('fastify')
const { setupPluginOpt } = require('./helper')
const config = require('../plugins/config')

test('include process.env vars that start with PLT_', async (t) => {
  const fastify = Fastify()
  t.after(async () => { await fastify.close() })
  process.env.PLT_SHOULD_APPEAR = 'test'
  const opts = setupPluginOpt()
  assert.strictEqual(opts.PLT_SHOULD_APPEAR, undefined)
  await fastify.register(config, opts)
  assert.strictEqual(fastify.appConfig.PLT_SHOULD_APPEAR, 'test')
})
