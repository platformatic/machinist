'use strict'

const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { bootstrap, applyYaml } = require('./helper')

const fixture = join(__dirname, 'fixtures', 'services', 'deployment.yaml')

before(async () => {
  await applyYaml(fixture)
})

test('get services by metadata labels', async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'GET',
    url: '/services/default?labels=app.kubernetes.io/name%3Dmyapp&labels=plt.dev/version%3D1.2.4',
    headers: {
      'content-type': 'application/json'
    }
  })

  assert.strictEqual(result.statusCode, 200)

  const services = result.json()
  assert(Array.isArray(services))
  assert(services.length >= 1)

  const svc = services.find(s => s.metadata.name === 'myapp-v1-2-4')
  assert(svc)
  assert.strictEqual(svc.metadata.labels['app.kubernetes.io/name'], 'myapp')
  assert.strictEqual(svc.metadata.labels['plt.dev/version'], '1.2.4')
})

test('returns empty array when no services match labels', async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'GET',
    url: '/services/default?labels=app.kubernetes.io/name%3Dnonexistent',
    headers: {
      'content-type': 'application/json'
    }
  })

  assert.strictEqual(result.statusCode, 200)

  const services = result.json()
  assert(Array.isArray(services))
  assert.strictEqual(services.length, 0)
})

test('returns 400 when labels query param is missing', async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'GET',
    url: '/services/default',
    headers: {
      'content-type': 'application/json'
    }
  })

  assert.strictEqual(result.statusCode, 400)
})
