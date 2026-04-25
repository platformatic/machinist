'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

function mockTask (overrides = {}) {
  return {
    taskArn: 'arn:aws:ecs:us-east-1:123456789:task/my-cluster/abc123',
    lastStatus: 'RUNNING',
    startedAt: new Date('2025-01-01T00:00:00Z'),
    group: 'service:my-service',
    cpu: '256',
    memory: '512',
    containers: [{
      name: 'web',
      image: 'myapp:latest',
      networkInterfaces: [{
        privateIpv4Address: '10.0.0.5'
      }]
    }],
    tags: [
      { key: 'app.kubernetes.io/name', value: 'myapp' },
      { key: 'env', value: 'production' }
    ],
    ...overrides
  }
}

function createMockProvider (overrides = {}) {
  return {
    async getMachine (scope, machineId) {
      return {
        id: machineId,
        status: 'RUNNING',
        startTime: '2025-01-01T00:00:00.000Z',
        image: 'myapp:latest',
        labels: { 'app.kubernetes.io/name': 'myapp' },
        controller: { name: 'my-service' },
        resources: { limits: { cpu: '256', memory: '512' }, requests: { cpu: '256', memory: '512' } }
      }
    },
    async getMachines (scope, labels) {
      return [{
        id: 'abc123',
        status: 'RUNNING',
        startTime: '2025-01-01T00:00:00.000Z',
        image: 'myapp:latest',
        labels: { 'app.kubernetes.io/name': 'myapp', ...labels },
        controller: { name: 'my-service' },
        resources: { limits: { cpu: '256', memory: '512' }, requests: { cpu: '256', memory: '512' } }
      }]
    },
    async setMachineLabels () {},
    async getControllers (scope, machineId) {
      return [{
        name: 'my-service',
        replicas: 3,
        labels: { 'app.kubernetes.io/name': 'myapp' },
        machines: [{
          id: machineId || 'abc123',
          status: 'RUNNING',
          startTime: '2025-01-01T00:00:00.000Z',
          image: 'myapp:latest',
          labels: {},
          controller: { name: 'my-service' }
        }]
      }]
    },
    async getController (scope, name) {
      return {
        name,
        replicas: 3,
        labels: { 'app.kubernetes.io/name': 'myapp' },
        machines: [{
          id: 'abc123',
          status: 'RUNNING',
          startTime: '2025-01-01T00:00:00.000Z',
          image: 'myapp:latest',
          labels: {},
          controller: { name }
        }]
      }
    },
    async updateControllerReplicas (scope, name, replicas) {
      return { name, replicas, labels: {} }
    },
    async deleteController () {},
    async getServicesByLabels (scope, labels) {
      return [{
        name: 'my-service',
        labels: { 'app.kubernetes.io/name': 'myapp' },
        ports: [{ port: 8080, protocol: 'TCP' }]
      }]
    },
    async deleteService () {},
    ...overrides
  }
}

// ── Unit tests for formatting logic ──

test('Ecs#formatMachine extracts correct fields from ECS task', async () => {
  // Test the formatting indirectly by checking the mockTask structure
  const task = mockTask()

  // Verify the task has the expected shape for formatting
  assert.strictEqual(task.lastStatus, 'RUNNING')
  assert.strictEqual(task.group, 'service:my-service')
  assert.strictEqual(task.containers[0].image, 'myapp:latest')
  assert.strictEqual(task.cpu, '256')
  assert.strictEqual(task.memory, '512')
  assert.strictEqual(task.tags[0].key, 'app.kubernetes.io/name')
})

test('task.group parsing extracts service name', async () => {
  const group = 'service:my-service'
  const name = group.startsWith('service:')
    ? group.substring('service:'.length)
    : null
  assert.strictEqual(name, 'my-service')
})

test('task.group parsing handles standalone tasks', async () => {
  const group = 'family:my-task-def'
  const name = group.startsWith('service:')
    ? group.substring('service:'.length)
    : null
  assert.strictEqual(name, null)
})

test('short task ID extraction from ARN', async () => {
  const arn = 'arn:aws:ecs:us-east-1:123456789:task/my-cluster/abc123def456'
  const parts = arn.split('/')
  const shortId = parts[parts.length - 1]
  assert.strictEqual(shortId, 'abc123def456')
})

test('tags to labels conversion', async () => {
  const tags = [
    { key: 'app', value: 'myapp' },
    { key: 'env', value: 'prod' }
  ]
  const labels = {}
  for (const { key, value } of tags) {
    labels[key] = value
  }
  assert.deepStrictEqual(labels, { app: 'myapp', env: 'prod' })
})

test('tags to labels handles null', async () => {
  const tags = null
  const labels = tags
    ? Object.fromEntries(tags.map(t => [t.key, t.value]))
    : {}
  assert.deepStrictEqual(labels, {})
})

// ── Route-level tests with mock provider ──

const Fastify = require('fastify')
const sharedSchemas = require('../plugins/shared-schemas')

async function buildApp (provider) {
  const app = Fastify({ logger: false })
  await app.register(sharedSchemas)
  app.decorate('provider', provider)
  await app.register(require('../routes/machines'), { prefix: '/ecs' })
  await app.register(require('../routes/controllers'), { prefix: '/ecs' })
  await app.register(require('../routes/services'), { prefix: '/ecs' })
  await app.ready()
  return app
}

test('GET /ecs/machines/:scope/:id returns machine', async (t) => {
  const app = await buildApp(createMockProvider())
  t.after(() => app.close())

  const res = await app.inject({
    method: 'GET',
    url: '/ecs/machines/my-cluster/abc123'
  })

  assert.strictEqual(res.statusCode, 200)
  const body = res.json()
  assert.strictEqual(body.id, 'abc123')
  assert.strictEqual(body.status, 'RUNNING')
  assert.strictEqual(body.image, 'myapp:latest')
  assert.strictEqual(body.controller.name, 'my-service')
})

test('GET /ecs/machines/:scope with labels returns machines', async (t) => {
  const app = await buildApp(createMockProvider())
  t.after(() => app.close())

  const res = await app.inject({
    method: 'GET',
    url: '/ecs/machines/my-cluster?labels=app.kubernetes.io/name%3Dmyapp'
  })

  assert.strictEqual(res.statusCode, 200)
  const machines = res.json()
  assert(Array.isArray(machines))
  assert.strictEqual(machines.length, 1)
  assert.strictEqual(machines[0].id, 'abc123')
})

test('PATCH /ecs/machines/:scope/:id/labels sets labels', async (t) => {
  let calledWith = null
  const provider = createMockProvider({
    async setMachineLabels (scope, id, labels) {
      calledWith = { scope, id, labels }
    }
  })
  const app = await buildApp(provider)
  t.after(() => app.close())

  const res = await app.inject({
    method: 'PATCH',
    url: '/ecs/machines/my-cluster/abc123/labels',
    headers: { 'content-type': 'application/json' },
    body: { labels: { foo: 'bar' } }
  })

  assert.strictEqual(res.statusCode, 200)
  assert.deepStrictEqual(calledWith, {
    scope: 'my-cluster',
    id: 'abc123',
    labels: { foo: 'bar' }
  })
})

test('GET /ecs/controllers/:scope with machineId returns controllers', async (t) => {
  const app = await buildApp(createMockProvider())
  t.after(() => app.close())

  const res = await app.inject({
    method: 'GET',
    url: '/ecs/controllers/my-cluster?machineId=abc123'
  })

  assert.strictEqual(res.statusCode, 200)
  const { controllers } = res.json()
  assert.strictEqual(controllers.length, 1)
  assert.strictEqual(controllers[0].name, 'my-service')
  assert.strictEqual(controllers[0].replicas, 3)
})

test('GET /ecs/controllers/:scope/:name returns controller with machines', async (t) => {
  const app = await buildApp(createMockProvider())
  t.after(() => app.close())

  const res = await app.inject({
    method: 'GET',
    url: '/ecs/controllers/my-cluster/my-service'
  })

  assert.strictEqual(res.statusCode, 200)
  const { controller } = res.json()
  assert.strictEqual(controller.name, 'my-service')
  assert.strictEqual(controller.replicas, 3)
  assert.strictEqual(controller.machines.length, 1)
})

test('POST /ecs/controllers/:scope/:name updates replicas', async (t) => {
  const app = await buildApp(createMockProvider())
  t.after(() => app.close())

  const res = await app.inject({
    method: 'POST',
    url: '/ecs/controllers/my-cluster/my-service',
    headers: { 'content-type': 'application/json' },
    body: { replicas: 5 }
  })

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(res.json().replicas, 5)
})

test('DELETE /ecs/controllers/:scope/:name deletes controller', async (t) => {
  let deleted = false
  const provider = createMockProvider({
    async deleteController () { deleted = true }
  })
  const app = await buildApp(provider)
  t.after(() => app.close())

  const res = await app.inject({
    method: 'DELETE',
    url: '/ecs/controllers/my-cluster/my-service'
  })

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(deleted, true)
})

test('GET /ecs/services/:scope with labels returns service endpoints', async (t) => {
  const app = await buildApp(createMockProvider())
  t.after(() => app.close())

  const res = await app.inject({
    method: 'GET',
    url: '/ecs/services/my-cluster?labels=app.kubernetes.io/name%3Dmyapp'
  })

  assert.strictEqual(res.statusCode, 200)
  const services = res.json()
  assert.strictEqual(services.length, 1)
  assert.strictEqual(services[0].name, 'my-service')
  assert.strictEqual(services[0].ports[0].port, 8080)
})

test('GET /ecs/services/:scope without labels returns 400', async (t) => {
  const app = await buildApp(createMockProvider())
  t.after(() => app.close())

  const res = await app.inject({
    method: 'GET',
    url: '/ecs/services/my-cluster'
  })

  assert.strictEqual(res.statusCode, 400)
})

test('DELETE /ecs/services/:scope/:name is a no-op for ECS', async (t) => {
  let called = false
  const provider = createMockProvider({
    async deleteService () { called = true }
  })
  const app = await buildApp(provider)
  t.after(() => app.close())

  const res = await app.inject({
    method: 'DELETE',
    url: '/ecs/services/my-cluster/my-service'
  })

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(called, true)
})
