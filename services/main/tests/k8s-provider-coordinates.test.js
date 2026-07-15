'use strict'

// Unit tests for the K8s provider's providerMetadata enforcement.
// These don't need a k3d cluster — they exercise validation that runs before
// any HTTP call to K8s.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { K8s } = require('../plugins/providers/k8s')

function buildProvider () {
  // The validation runs before any apiClient.request, so we don't need a real
  // K8s API. K8sClient with a stub apiUrl is fine — we never reach it.
  return new K8s({
    config: {
      PLT_K8S_REST_API_URL: 'http://k8s.local',
      PLT_K8S_ALLOW_SELFSIGNED_CERT: true
    },
    log: { debug () {}, info () {}, warn () {}, error () {} },
    caContent: '',
    tokenPath: 'test',
    authType: 'token',
    clientCreds: {}
  })
}

const REQUIRED = /requires providerMetadata with `kind` and `apiVersion`/

test('getController throws when providerMetadata is undefined', async () => {
  const k8s = buildProvider()
  await assert.rejects(() => k8s.getController('default', 'my-app'), REQUIRED)
})

test('getController throws when providerMetadata is empty object', async () => {
  const k8s = buildProvider()
  await assert.rejects(() => k8s.getController('default', 'my-app', {}), REQUIRED)
})

test('getController throws when only kind is provided', async () => {
  const k8s = buildProvider()
  await assert.rejects(
    () => k8s.getController('default', 'my-app', { kind: 'Deployment' }),
    REQUIRED
  )
})

test('getController throws when only apiVersion is provided', async () => {
  const k8s = buildProvider()
  await assert.rejects(
    () => k8s.getController('default', 'my-app', { apiVersion: 'apps/v1' }),
    REQUIRED
  )
})

test('updateControllerReplicas throws when providerMetadata is missing', async () => {
  const k8s = buildProvider()
  await assert.rejects(
    () => k8s.updateControllerReplicas('default', 'my-app', 3),
    REQUIRED
  )
})

test('updateControllerReplicas throws when providerMetadata is incomplete', async () => {
  const k8s = buildProvider()
  await assert.rejects(
    () => k8s.updateControllerReplicas('default', 'my-app', 3, { kind: 'Deployment' }),
    REQUIRED
  )
})

test('deleteController throws when providerMetadata is missing', async () => {
  const k8s = buildProvider()
  await assert.rejects(() => k8s.deleteController('default', 'my-app'), REQUIRED)
})

test('deleteController throws when providerMetadata is incomplete', async () => {
  const k8s = buildProvider()
  await assert.rejects(
    () => k8s.deleteController('default', 'my-app', { apiVersion: 'apps/v1' }),
    REQUIRED
  )
})

test('error message names the missing fields', async () => {
  const k8s = buildProvider()
  await assert.rejects(
    () => k8s.getController('default', 'my-app'),
    err => {
      assert.match(err.message, /K8s provider/)
      assert.match(err.message, /providerMetadata/)
      assert.match(err.message, /kind/)
      assert.match(err.message, /apiVersion/)
      return true
    }
  )
})
