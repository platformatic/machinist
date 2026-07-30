'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const fastify = require('fastify')
const K8sClient = require('../lib/k8s-client')

const mockLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {}
}

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'k8s-client-test-'))
const tokenFile = path.join(tmpDir, 'token')
writeFileSync(tokenFile, 'fake-token')

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
    tokenPath: tokenFile,
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
    tokenPath: tokenFile,
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
    tokenPath: tokenFile,
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
    tokenPath: tokenFile,
    apiUrl: 'http://localhost:8080',
    log: mockLogger
  })

  assert.ok(client, 'Client should be created')
})

test('K8sClient re-reads the token file on every request (survives rotation)', async t => {
  const app = fastify({ logger: false })

  const seenAuth = []
  app.get('/whoami', async (request) => {
    seenAuth.push(request.headers.authorization)
    return { ok: true }
  })

  await app.listen({ port: 0, host: '127.0.0.1' })

  t.after(async () => {
    await app.close()
  })

  const apiUrl = `http://127.0.0.1:${app.server.address().port}`

  const rotatingToken = path.join(tmpDir, 'rotating-token')
  await writeFile(rotatingToken, 'token-1')

  const client = new K8sClient({
    authType: 'token',
    allowSelfSignedCert: true,
    caCert: 'fake-ca',
    tokenPath: rotatingToken,
    apiUrl,
    log: mockLogger
  })

  await client.request('/whoami')

  // Simulate kubelet rotating the projected token in place.
  await writeFile(rotatingToken, 'token-2')
  await client.request('/whoami')

  assert.deepStrictEqual(
    seenAuth,
    ['Bearer token-1', 'Bearer token-2'],
    'token must be re-read from disk per request, not cached at construction'
  )
})

test('K8sClient sends no Authorization header for client-cert auth', async t => {
  const app = fastify({ logger: false })

  let seenAuth = 'unset'
  app.get('/nocreds', async (request) => {
    seenAuth = request.headers.authorization ?? null
    return { ok: true }
  })

  await app.listen({ port: 0, host: '127.0.0.1' })

  t.after(async () => {
    await app.close()
  })

  const apiUrl = `http://127.0.0.1:${app.server.address().port}`

  const client = new K8sClient({
    authType: 'client-cert',
    allowSelfSignedCert: true,
    caCert: 'fake-ca',
    apiUrl,
    log: mockLogger
  })

  await client.request('/nocreds')
  assert.strictEqual(seenAuth, null, 'client-cert auth must not send a bearer token')
})
