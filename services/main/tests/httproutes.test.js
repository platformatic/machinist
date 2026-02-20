'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { bootstrap } = require('./helper')

const httpRouteFixture = {
  apiVersion: 'gateway.networking.k8s.io/v1',
  kind: 'HTTPRoute',
  metadata: {
    name: 'myapp-skew-test',
    labels: {
      'plt.dev/managed-by': 'icc',
      'plt.dev/application': 'myapp'
    }
  },
  spec: {
    parentRefs: [
      { name: 'platform-gateway', namespace: 'default' }
    ],
    hostnames: ['myapp.example.com'],
    rules: [
      {
        backendRefs: [
          { name: 'myapp-v1', port: 3042 }
        ]
      }
    ]
  }
}

test('apply creates a new HTTPRoute', async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'PUT',
    url: '/gateway/httproutes/default',
    headers: { 'content-type': 'application/json' },
    body: httpRouteFixture
  })

  assert.strictEqual(result.statusCode, 200)

  const route = result.json()
  assert.strictEqual(route.metadata.name, 'myapp-skew-test')
  assert.strictEqual(route.kind, 'HTTPRoute')
  assert(route.metadata.resourceVersion)

  // Cleanup
  await app.inject({
    method: 'DELETE',
    url: '/gateway/httproutes/default/myapp-skew-test'
  })
})

test('get HTTPRoute by name', async t => {
  const { app } = await bootstrap(t)

  await app.inject({
    method: 'PUT',
    url: '/gateway/httproutes/default',
    headers: { 'content-type': 'application/json' },
    body: httpRouteFixture
  })

  const result = await app.inject({
    method: 'GET',
    url: '/gateway/httproutes/default/myapp-skew-test'
  })

  assert.strictEqual(result.statusCode, 200)

  const route = result.json()
  assert.strictEqual(route.metadata.name, 'myapp-skew-test')
  assert.strictEqual(route.spec.hostnames[0], 'myapp.example.com')
  assert.strictEqual(route.spec.rules[0].backendRefs[0].name, 'myapp-v1')

  await app.inject({
    method: 'DELETE',
    url: '/gateway/httproutes/default/myapp-skew-test'
  })
})

test('apply updates an existing HTTPRoute', async t => {
  const { app } = await bootstrap(t)

  await app.inject({
    method: 'PUT',
    url: '/gateway/httproutes/default',
    headers: { 'content-type': 'application/json' },
    body: httpRouteFixture
  })

  const updated = structuredClone(httpRouteFixture)
  updated.spec.rules = [
    {
      matches: [{
        headers: [{
          name: 'Cookie',
          type: 'RegularExpression',
          value: '(^|;\\s*)__plt_dpl=v1-abc123(;|$)'
        }]
      }],
      backendRefs: [{ name: 'myapp-v1', port: 3042 }]
    },
    {
      backendRefs: [{ name: 'myapp-v2', port: 3042 }]
    }
  ]

  const result = await app.inject({
    method: 'PUT',
    url: '/gateway/httproutes/default',
    headers: { 'content-type': 'application/json' },
    body: updated
  })

  assert.strictEqual(result.statusCode, 200)

  const route = result.json()
  assert.strictEqual(route.spec.rules.length, 2)
  assert.strictEqual(route.spec.rules[0].backendRefs[0].name, 'myapp-v1')
  assert.strictEqual(route.spec.rules[1].backendRefs[0].name, 'myapp-v2')

  await app.inject({
    method: 'DELETE',
    url: '/gateway/httproutes/default/myapp-skew-test'
  })
})

test('delete HTTPRoute', async t => {
  const { app } = await bootstrap(t)

  await app.inject({
    method: 'PUT',
    url: '/gateway/httproutes/default',
    headers: { 'content-type': 'application/json' },
    body: httpRouteFixture
  })

  const result = await app.inject({
    method: 'DELETE',
    url: '/gateway/httproutes/default/myapp-skew-test'
  })

  assert.strictEqual(result.statusCode, 200)

  const getResult = await app.inject({
    method: 'GET',
    url: '/gateway/httproutes/default/myapp-skew-test'
  })

  assert.strictEqual(getResult.statusCode, 404)
})

test('get non-existent HTTPRoute returns error', async t => {
  const { app } = await bootstrap(t)

  const result = await app.inject({
    method: 'GET',
    url: '/gateway/httproutes/default/does-not-exist'
  })

  assert.strictEqual(result.statusCode, 404)
})
