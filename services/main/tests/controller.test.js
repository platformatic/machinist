'use strict'

const { join } = require('node:path')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout } = require('node:timers/promises')
const { applyYaml, bootstrap, removeYaml, getPods } = require('./helper')

const deploymentFixture = join(__dirname, 'fixtures', 'deployment.yaml')

before(async () => {
  await applyYaml(deploymentFixture)
})

after(async () => {
  await removeYaml(deploymentFixture)
})

test('get all controllers in a namespace', { only: true }, async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'GET',
    url: '/controllers/default',
    headers: { 'content-type': 'application/json' }
  })

  assert.strictEqual(result.statusCode, 200, result.json())

  const [firstController, ...otherControllers] = result.json().controllers
  assert.strictEqual(otherControllers.length, 0)
  assert.strictEqual(firstController.kind, 'Deployment')
  assert.strictEqual(firstController.name, 'nginx-echo-server-deployment')
  assert(firstController.pods.length >= firstController.replicas)
})

test('get controller from a pod', async t => {
  const { app } = await bootstrap(t)
  const { items } = await getPods({ 'app.kubernetes.io/instance': 'deployment-fixture' })
  const podName = items[0].metadata.name

  const result = await app.inject({
    method: 'GET',
    url: `/controllers/default?podId=${podName}`,
    headers: { 'content-type': 'application/json' }
  })

  assert.strictEqual(result.statusCode, 200)

  const [controller] = result.json().controllers
  assert.strictEqual(controller.kind, 'Deployment')
  assert.strictEqual(controller.name, 'nginx-echo-server-deployment')
  assert(controller.pods.length >= controller.replicas)
})

test('get controller from controller', async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'GET',
    url: '/controllers/default/nginx-echo-server-deployment?apiVersion=apps%2Fv1&kind=Deployment',
    headers: { 'content-type': 'application/json' }
  })

  assert.strictEqual(result.statusCode, 200)

  const { controller } = result.json()
  assert.strictEqual(controller.kind, 'Deployment')
  assert.strictEqual(controller.name, 'nginx-echo-server-deployment')
  assert(controller.pods.length >= controller.replicas)
})
