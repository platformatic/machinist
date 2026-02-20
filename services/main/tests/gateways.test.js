'use strict'

const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { bootstrap, applyYaml, removeYaml } = require('./helper')

const fixtureDir = path.join(__dirname, 'fixtures', 'gateways')
const gatewayFixture = path.join(fixtureDir, 'gateway.yaml')

test('gateway auto-discovery', async t => {
  await applyYaml(gatewayFixture)
  t.after(async () => {
    await removeYaml(gatewayFixture)
  })

  await t.test('list all gateways', async t => {
    const { app } = await bootstrap(t)

    const result = await app.inject({
      method: 'GET',
      url: '/gateway/gateways'
    })

    assert.strictEqual(result.statusCode, 200)

    const gateways = result.json()
    assert.ok(Array.isArray(gateways))
    const found = gateways.find(gw => gw.metadata.name === 'platform-gateway')
    assert.ok(found)
  })

  await t.test('list gateways in namespace', async t => {
    const { app } = await bootstrap(t)

    const result = await app.inject({
      method: 'GET',
      url: '/gateway/gateways/default'
    })

    assert.strictEqual(result.statusCode, 200)

    const gateways = result.json()
    assert.ok(Array.isArray(gateways))
    const found = gateways.find(gw => gw.metadata.name === 'platform-gateway')
    assert.ok(found)
  })

  await t.test('get gateway by name', async t => {
    const { app } = await bootstrap(t)

    const result = await app.inject({
      method: 'GET',
      url: '/gateway/gateways/default/platform-gateway'
    })

    assert.strictEqual(result.statusCode, 200)

    const gw = result.json()
    assert.strictEqual(gw.kind, 'Gateway')
    assert.strictEqual(gw.metadata.name, 'platform-gateway')
  })

  await t.test('get non-existent gateway returns 404', async t => {
    const { app } = await bootstrap(t)

    const result = await app.inject({
      method: 'GET',
      url: '/gateway/gateways/default/does-not-exist'
    })

    assert.strictEqual(result.statusCode, 404)
  })

  await t.test('labeled gateway for auto-discovery', async t => {
    const { app } = await bootstrap(t)

    const result = await app.inject({
      method: 'GET',
      url: '/gateway/gateways/default/platform-gateway'
    })

    assert.strictEqual(result.statusCode, 200)

    const gw = result.json()
    assert.strictEqual(gw.metadata.labels['plt.dev/managed-by'], 'platformatic')
  })
})
