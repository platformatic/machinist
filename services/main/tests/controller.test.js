'use strict'

const { join } = require('node:path')
const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const { applyYaml, bootstrap, getPods } = require('./helper')

const deploymentFixture = join(__dirname, 'fixtures', 'controller', 'deployment.yaml')

before(async () => {
  await applyYaml(deploymentFixture)
})

test('get all controllers in a scope', async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'GET',
    url: '/k8s/controllers/default',
    headers: { 'content-type': 'application/json' }
  })

  assert.strictEqual(result.statusCode, 200, result.json())

  const controller = result.json().controllers
    .find(c => c.name === 'nginx-echo-server-deployment-controller')
  assert.ok(controller)
  assert(controller.machines.length >= controller.replicas)
})

test('get controller from a machine', async t => {
  const { app } = await bootstrap(t)
  const { items } = await getPods({ 'app.kubernetes.io/instance': 'deployment-fixture-controller' })
  const podName = items[0].metadata.name

  const result = await app.inject({
    method: 'GET',
    url: `/k8s/controllers/default?machineId=${podName}`,
    headers: { 'content-type': 'application/json' }
  })

  assert.strictEqual(result.statusCode, 200)

  const [controller] = result.json().controllers
  assert.strictEqual(controller.name, 'nginx-echo-server-deployment-controller')
  assert(controller.machines.length >= controller.replicas)
})

test('get controller by name', async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'GET',
    url: '/k8s/controllers/default/nginx-echo-server-deployment-controller',
    headers: { 'content-type': 'application/json' }
  })

  assert.strictEqual(result.statusCode, 200)

  const { controller } = result.json()
  assert.strictEqual(controller.name, 'nginx-echo-server-deployment-controller')
  assert(controller.machines.length >= controller.replicas)
})
