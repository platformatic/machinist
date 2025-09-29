'use strict'

const { join } = require('node:path')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { applyYaml, bootstrap, removeYaml } = require('./helper')

const deploymentFixture = join(__dirname, 'fixtures', 'deployment.yaml')
const replicaSetFixture = join(__dirname, 'fixtures', 'replica-set.yaml')
const replicationControllerFixture = join(__dirname, 'fixtures', 'replication-controller.yaml')
const statefulSetFixture = join(__dirname, 'fixtures', 'stateful-set.yaml')

before(async () => {
  console.log('RUNNING BEFORE')
  await Promise.allSettled([
    applyYaml(deploymentFixture),
    applyYaml(replicaSetFixture),
    applyYaml(replicationControllerFixture),
    applyYaml(statefulSetFixture)
  ])
})

after(async () => {
  await Promise.allSettled([
    removeYaml(deploymentFixture),
    removeYaml(replicaSetFixture),
    removeYaml(replicationControllerFixture),
    removeYaml(statefulSetFixture)
  ])
})

test('update replica count for controller', async t => {
  const { app } = await bootstrap(t)

  // Deployments
  {
    const result = await app.inject({
      method: 'POST',
      url: '/controllers/default/nginx-echo-server-deployment?apiVersion=apps%2Fv1&kind=Deployment',
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
      url: '/controllers/default/nginx-echo-server-replicaset?apiVersion=apps%2Fv1&kind=ReplicaSet',
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
      url: '/controllers/default/nginx-echo-server-replicationcontroller?apiVersion=v1&kind=ReplicationController',
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
      url: '/controllers/default/nginx-echo-server-statefulset?apiVersion=apps%2Fv1&kind=StatefulSet',
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
