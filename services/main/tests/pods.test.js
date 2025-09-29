'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { bootstrap, applyYaml, removeYaml, getPods } = require('./helper')

const deploymentFixture = join(__dirname, 'fixtures', 'pods', 'deployment.yaml')

before(async () => {
  await applyYaml(deploymentFixture)
})

after(async () => {
  await removeYaml(deploymentFixture)
})

test('get pod', async t => {
  const { app } = await bootstrap(t)
  const { items } = await getPods({ 'app.kubernetes.io/instance': 'deployment-fixture' })
  const podName = items[0].metadata.name

  const result = await app.inject({
    method: 'GET',
    url: `/pods/default/${podName}`,
    headers: {
      'content-type': 'application/json'
    }
  })

  assert.strictEqual(result.statusCode, 200)

  const { id, status, privateIp, image, startTime, resources } = result.json()
  assert.deepStrictEqual(resources, {
    limits: { cpu: '1', memory: '1Gi' },
    requests: { cpu: '500m', memory: '512Mi' }
  })
  assert.equal(id, podName)
  assert.equal(image, 'platformatic/machinist-test:latest')
})

test('set pod labels', async t => {
  const { app } = await bootstrap(t)
  const { items } = await getPods({ 'app.kubernetes.io/instance': 'deployment-fixture' })
  const podName = items[0].metadata.name

  const result = await app.inject({
    method: 'PATCH',
    url: `/pods/default/${podName}/labels`,
    headers: {
      'content-type': 'application/json'
    },
    body: {
      labels: {
        foo: 'bar',
        bar: 'baz'
      }
    }
  })

  assert.strictEqual(result.statusCode, 200)

  {
    const { items } = await getPods({ foo: 'bar' })
    assert.equal(items[0].metadata.name, podName)
  }
})
