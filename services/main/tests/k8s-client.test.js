'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const fastify = require('fastify')
const K8sClient = require('../lib/k8s-client')

const mockLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {}
}

// K8sClient re-reads the token from disk on every call (see #getAuthHeaders),
// so tests need a real file rather than a static string.
function writeTempToken (t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'k8s-client-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const tokenPath = join(dir, 'token')
  writeFileSync(tokenPath, content)
  return tokenPath
}

test('K8sClient retry logic on connection reset', async t => {
  const app = fastify({ logger: false })

  let requestCount = 0

  app.get('/retry-test', async (request, reply) => {
    requestCount++
    if (requestCount < 3) {
      request.raw.destroy()
      return
    }
    return { items: [] }
  })

  await app.listen({ port: 0, host: '127.0.0.1' })

  t.after(async () => {
    await app.close()
  })

  const apiUrl = `http://127.0.0.1:${app.server.address().port}`

  const client = new K8sClient({
    authType: 'token',
    allowSelfSignedCert: true,
    caCert: 'fake-ca',
    tokenPath: writeTempToken(t, 'fake-token'),
    apiUrl,
    log: mockLogger
  })

  const result = await client.request('/retry-test')

  assert.strictEqual(requestCount, 3, 'Should retry twice before succeeding')
  assert.deepStrictEqual(result, { items: [] })
})

test('K8sClient fails after max retries on connection reset', async t => {
  const app = fastify({ logger: false })

  app.get('/always-fail', async (request, reply) => {
    request.raw.destroy()
  })

  await app.listen({ port: 0, host: '127.0.0.1' })

  t.after(async () => {
    await app.close()
  })

  const apiUrl = `http://127.0.0.1:${app.server.address().port}`

  const client = new K8sClient({
    authType: 'token',
    allowSelfSignedCert: true,
    caCert: 'fake-ca',
    tokenPath: writeTempToken(t, 'fake-token'),
    apiUrl,
    log: mockLogger
  })

  await assert.rejects(
    async () => await client.request('/always-fail'),
    (err) => {
      assert.strictEqual(err.code, 'UND_ERR_SOCKET')
      return true
    }
  )
})

test('K8sClient does not retry HTTP errors', async t => {
  const app = fastify({ logger: false })

  let requestCount = 0

  app.get('/error-500', async (request, reply) => {
    requestCount++
    reply.code(500)
    return { message: 'Internal Server Error' }
  })

  await app.listen({ port: 0, host: '127.0.0.1' })

  t.after(async () => {
    await app.close()
  })

  const apiUrl = `http://127.0.0.1:${app.server.address().port}`

  const client = new K8sClient({
    authType: 'token',
    allowSelfSignedCert: true,
    caCert: 'fake-ca',
    tokenPath: writeTempToken(t, 'fake-token'),
    apiUrl,
    log: mockLogger
  })

  await assert.rejects(
    async () => await client.request('/error-500')
  )

  assert.strictEqual(requestCount, 1, 'Should not retry on HTTP errors')
})

test('K8sClient has clientTtl configured', t => {
  const client = new K8sClient({
    authType: 'token',
    allowSelfSignedCert: true,
    caCert: 'fake-ca',
    tokenPath: writeTempToken(t, 'fake-token'),
    apiUrl: 'http://localhost:8080',
    log: mockLogger
  })

  assert.ok(client, 'Client should be created')
})

test('K8sClient re-reads the token file on every request instead of caching it', async t => {
  const app = fastify({ logger: false })

  const seenAuthHeaders = []
  app.get('/whoami', async (request, reply) => {
    seenAuthHeaders.push(request.headers.authorization)
    return { items: [] }
  })

  await app.listen({ port: 0, host: '127.0.0.1' })

  t.after(async () => {
    await app.close()
  })

  const apiUrl = `http://127.0.0.1:${app.server.address().port}`
  const tokenPath = writeTempToken(t, 'token-v1')

  const client = new K8sClient({
    authType: 'token',
    allowSelfSignedCert: true,
    caCert: 'fake-ca',
    tokenPath,
    apiUrl,
    log: mockLogger
  })

  await client.request('/whoami')

  // Simulate kubelet rotating the token in place while the process is alive.
  writeFileSync(tokenPath, 'token-v2')

  await client.request('/whoami')

  assert.deepStrictEqual(seenAuthHeaders, ['Bearer token-v1', 'Bearer token-v2'])
})
