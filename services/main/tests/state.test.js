'use strict'

const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { bootstrap, applyYaml } = require('./helper')

const deploymentFixture = join(__dirname, 'fixtures', 'state', 'deployment.yaml')

before(async () => {
  await applyYaml(deploymentFixture)
})

test('get state of namespace', async t => {
  const { app } = await bootstrap(t)
  const result = await app.inject({
    method: 'GET',
    url: '/state/default?podSelector=app.kubernetes.io/instance%3ddeployment-fixture-state',
    headers: {
      'content-type': 'application/json'
    }
  })

  assert.strictEqual(result.statusCode, 200)

  const [pod] = result.json().pods
  assert(pod.id.startsWith('nginx-echo-server-deployment-state'))
  assert.equal(pod.image, 'platformatic/machinist-test:latest')
})
