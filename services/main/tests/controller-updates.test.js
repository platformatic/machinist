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
      url: '/controllers/default/nginx-echo-server-deployment-controller-updates?apiVersion=apps%2Fv1&kind=Deployment',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicaCount: 7 })
    })

    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(result.json().replicas, 7)
  }

  // ReplicaSets
  {
    const result = await app.inject({
      method: 'POST',
      url: '/controllers/default/nginx-echo-server-replicaset-controller-updates?apiVersion=apps%2Fv1&kind=ReplicaSet',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicaCount: 7 })
    })

    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(result.json().replicas, 7)
  }

  // ReplicationControllers
  {
    const result = await app.inject({
      method: 'POST',
      url: '/controllers/default/nginx-echo-server-replicationcontroller-controller-updates?apiVersion=v1&kind=ReplicationController',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicaCount: 7 })
    })

    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(result.json().replicas, 7)
  }

  // StatefulSets
  {
    const result = await app.inject({
      method: 'POST',
      url: '/controllers/default/nginx-echo-server-statefulset-controller-updates?apiVersion=apps%2Fv1&kind=StatefulSet',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicaCount: 7 })
    })

    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(result.json().replicas, 7)
  }
})

test('fail to update when no controller found', async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'POST',
    url: '/controllers/default/unknown-controller?apiVersion=apps%2Fv1&kind=Deployment',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replicaCount: 7 })
  })

  assert.strictEqual(result.statusCode, 404)
})
