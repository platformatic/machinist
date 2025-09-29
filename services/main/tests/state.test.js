'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { bootstrap, applyYaml, removeYaml, getPods } = require('./helper')

const deploymentFixture = join(__dirname, 'fixtures', 'state', 'deployment.yaml')

before(async () => {
  await applyYaml(deploymentFixture)
})

after(async () => {
  await removeYaml(deploymentFixture)
})

test('get state of namespace', async t => {
  const { app } = await bootstrap(t)
  const result = await app.inject({
    method: 'GET',
    url: '/state/default?podSelector=app.kubernetes.io/instance%3ddeployment-fixture',
    headers: {
      'content-type': 'application/json'
    }
  })

  assert.strictEqual(result.statusCode, 200)

  const [pod] = result.json().pods
  assert(pod.id.startsWith('nginx-echo-server-deployment'))
  assert.equal(pod.image, 'platformatic/machinist-test:latest')
})
