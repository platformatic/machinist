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

  await t.test('list gateways in namespace', async t => {
    const { app } = await bootstrap(t)

    const result = await app.inject({
      method: 'GET',
      url: '/k8s/gateway/gateways/default'
    })

    assert.strictEqual(result.statusCode, 200)

    const gateways = result.json()
    assert.ok(Array.isArray(gateways))
    const found = gateways.find(gw => gw.metadata.name === 'platform-gateway')
    assert.ok(found)
  })
})
