'use strict'

// Unit tests for the K8s provider's applyDeployment/applyService idempotency.
// These don't need a k3d cluster — a fake apiClient records the requests.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { K8s } = require('../plugins/providers/k8s')

function buildProvider () {
  return new K8s({
    config: {
      PLT_K8S_REST_API_URL: 'http://k8s.local',
      PLT_K8S_ALLOW_SELFSIGNED_CERT: true
    },
    log: { debug () {}, info () {}, warn () {}, error () {} },
    caContent: '',
    token: 'test',
    authType: 'token',
    clientCreds: {}
  })
}

function notFound () {
  const err = new Error('not found')
  err.statusCode = 404
  return err
}

// Fake apiClient: records requests, answers the probe GET from `existing`.
function fakeClient ({ existing = null } = {}) {
  const calls = []
  return {
    calls,
    request: async (path, overrides = {}) => {
      const method = overrides.method || 'GET'
      calls.push({ path, method, body: overrides.body ? JSON.parse(overrides.body) : undefined })
      if (method === 'GET') {
        if (existing) return existing
        throw notFound()
      }
      return { ok: true }
    }
  }
}

test('applyDeployment POSTs a new Deployment when none exists', async () => {
  const k8s = buildProvider()
  const client = fakeClient({ existing: null })
  k8s.apiClient = client

  await k8s.applyDeployment('platformatic', { metadata: { name: 'my-app-v1' }, spec: {} })

  assert.strictEqual(client.calls.length, 2)
  assert.strictEqual(client.calls[0].method, 'GET')
  assert.strictEqual(client.calls[0].path, '/apis/apps/v1/namespaces/platformatic/deployments/my-app-v1')
  assert.strictEqual(client.calls[1].method, 'POST')
  assert.strictEqual(client.calls[1].path, '/apis/apps/v1/namespaces/platformatic/deployments')
  assert.strictEqual(client.calls[1].body.metadata.name, 'my-app-v1')
})

test('applyDeployment PUTs with the existing resourceVersion on update (idempotent)', async () => {
  const k8s = buildProvider()
  const client = fakeClient({ existing: { metadata: { name: 'my-app-v1', resourceVersion: 'rv-42' } } })
  k8s.apiClient = client

  await k8s.applyDeployment('platformatic', { metadata: { name: 'my-app-v1' }, spec: {} })

  assert.strictEqual(client.calls[1].method, 'PUT')
  assert.strictEqual(client.calls[1].path, '/apis/apps/v1/namespaces/platformatic/deployments/my-app-v1')
  assert.strictEqual(client.calls[1].body.metadata.resourceVersion, 'rv-42')
})

test('applyService POSTs a new Service when none exists', async () => {
  const k8s = buildProvider()
  const client = fakeClient({ existing: null })
  k8s.apiClient = client

  await k8s.applyService('platformatic', { metadata: { name: 'my-app-v1-svc' }, spec: { type: 'ClusterIP' } })

  assert.strictEqual(client.calls[1].method, 'POST')
  assert.strictEqual(client.calls[1].path, '/api/v1/namespaces/platformatic/services')
})

test('applyService echoes the immutable clusterIP + resourceVersion on update', async () => {
  const k8s = buildProvider()
  const client = fakeClient({
    existing: { metadata: { name: 'my-app-v1-svc', resourceVersion: 'rv-7' }, spec: { clusterIP: '10.43.0.9' } }
  })
  k8s.apiClient = client

  await k8s.applyService('platformatic', { metadata: { name: 'my-app-v1-svc' }, spec: { type: 'ClusterIP' } })

  assert.strictEqual(client.calls[1].method, 'PUT')
  assert.strictEqual(client.calls[1].body.spec.clusterIP, '10.43.0.9')
  assert.strictEqual(client.calls[1].body.metadata.resourceVersion, 'rv-7')
})

test('applyDeployment rethrows non-404 probe errors', async () => {
  const k8s = buildProvider()
  const boom = new Error('boom')
  boom.statusCode = 500
  k8s.apiClient = { request: async () => { throw boom } }

  await assert.rejects(() => k8s.applyDeployment('platformatic', { metadata: { name: 'x' } }), /boom/)
})
