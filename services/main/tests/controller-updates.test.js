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

  // Deployment
  {
    const result = await app.inject({
      method: 'POST',
      url: '/k8s/controllers/default/nginx-echo-server-deployment-controller-updates',
      query: { kind: 'Deployment', apiVersion: 'apps/v1' },
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 7 })
    })

    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(result.json().replicas, 7)
    assert.strictEqual(result.json().providerMetadata.kind, 'Deployment')
  }

  // ReplicaSet
  {
    const result = await app.inject({
      method: 'POST',
      url: '/k8s/controllers/default/nginx-echo-server-replicaset-controller-updates',
      query: { kind: 'ReplicaSet', apiVersion: 'apps/v1' },
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 7 })
    })

    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(result.json().replicas, 7)
  }

  // ReplicationController
  {
    const result = await app.inject({
      method: 'POST',
      url: '/k8s/controllers/default/nginx-echo-server-replicationcontroller-controller-updates',
      query: { kind: 'ReplicationController', apiVersion: 'v1' },
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 7 })
    })

    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(result.json().replicas, 7)
  }

  // StatefulSet
  {
    const result = await app.inject({
      method: 'POST',
      url: '/k8s/controllers/default/nginx-echo-server-statefulset-controller-updates',
      query: { kind: 'StatefulSet', apiVersion: 'apps/v1' },
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 7 })
    })

    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(result.json().replicas, 7)
  }
})

test('update without providerMetadata returns 500', async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'POST',
    url: '/k8s/controllers/default/nginx-echo-server-deployment-controller-updates',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replicas: 7 })
  })

  // K8s provider rejects the call because kind/apiVersion are required.
  assert.strictEqual(result.statusCode, 500)
})

test('fail to update when no controller found', async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'POST',
    url: '/k8s/controllers/default/unknown-controller',
    query: { kind: 'Deployment', apiVersion: 'apps/v1' },
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replicas: 7 })
  })

  // K8sClient now passes the 404 from K8s API through with statusCode 404
  assert.strictEqual(result.statusCode, 404)
})
