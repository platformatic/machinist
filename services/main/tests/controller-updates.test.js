'use strict'

const { join } = require('node:path')
const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const { applyYaml, bootstrap } = require('./helper')

const deploymentFixture = join(__dirname, 'fixtures', 'controller-updates', 'deployment.yaml')
const replicaSetFixture = join(__dirname, 'fixtures', 'controller-updates', 'replica-set.yaml')
const replicationControllerFixture = join(__dirname, 'fixtures', 'controller-updates', 'replication-controller.yaml')
const statefulSetFixture = join(__dirname, 'fixtures', 'controller-updates', 'stateful-set.yaml')

before(async () => {
  await Promise.allSettled([
    applyYaml(deploymentFixture),
    applyYaml(replicaSetFixture),
    applyYaml(replicationControllerFixture),
    applyYaml(statefulSetFixture)
  ])
})

test('update replica count for controller', async t => {
  const { app } = await bootstrap(t)

  // Deployments
  {
    const result = await app.inject({
      method: 'POST',
      url: '/k8s/controllers/default/nginx-echo-server-deployment-controller-updates',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 7 })
    })

    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(result.json().replicas, 7)
  }

  // ReplicaSets
  {
    const result = await app.inject({
      method: 'POST',
      url: '/k8s/controllers/default/nginx-echo-server-replicaset-controller-updates',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 7 })
    })

    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(result.json().replicas, 7)
  }

  // ReplicationControllers
  {
    const result = await app.inject({
      method: 'POST',
      url: '/k8s/controllers/default/nginx-echo-server-replicationcontroller-controller-updates',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 7 })
    })

    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(result.json().replicas, 7)
  }

  // StatefulSets
  {
    const result = await app.inject({
      method: 'POST',
      url: '/k8s/controllers/default/nginx-echo-server-statefulset-controller-updates',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 7 })
    })

    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(result.json().replicas, 7)
  }
})

test('fail to update when no controller found', async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'POST',
    url: '/k8s/controllers/default/unknown-controller',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replicas: 7 })
  })

  assert.strictEqual(result.statusCode, 404)
})
