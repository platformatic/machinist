'use strict'

// The machines to remove first on a scale down: these tests stub the APIs of the providers, and need no cluster.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mockClient } = require('aws-sdk-client-mock')
const { ECSClient, ListTasksCommand, UpdateServiceCommand, UpdateTaskProtectionCommand } = require('@aws-sdk/client-ecs')
const { K8s } = require('../plugins/providers/k8s')
const { Ecs } = require('../plugins/providers/ecs')

const log = { debug () {}, info () {}, warn () {}, error () {} }
const coordinates = { kind: 'Deployment', apiVersion: 'apps/v1' }
const DELETION_COST = 'controller.kubernetes.io/pod-deletion-cost'
const REMOVE_FIRST = 'machinist.platformatic.dev/remove-first'

function pod (name, annotations = {}, extra = {}) {
  return { metadata: { name, annotations, ...extra } }
}

function buildK8s ({ replicas = 3, pods = [], matchLabels = { app: 'objects' }, failPods = false } = {}) {
  const k8s = new K8s({
    config: { PLT_K8S_REST_API_URL: 'http://k8s.local', PLT_K8S_ALLOW_SELFSIGNED_CERT: true },
    log,
    caContent: '',
    tokenPath: 'test',
    authType: 'token',
    clientCreds: {}
  })
  const requests = []

  k8s.apiClient = {
    async request (path, options = {}) {
      const method = options.method ?? 'GET'
      requests.push({ method, path, body: options.body ? JSON.parse(options.body) : undefined })

      if (path.includes('/pods?labelSelector=')) {
        if (failPods) {
          throw new Error('pods are forbidden')
        }

        return { items: pods }
      }

      if (method === 'PUT') {
        return JSON.parse(options.body)
      }

      if (method === 'PATCH') {
        return {}
      }

      return { metadata: { name: 'objects', labels: {} }, spec: { replicas, selector: { matchLabels } } }
    }
  }

  return { k8s, requests }
}

test('k8s: without machines to remove the count is changed as before', async () => {
  const { k8s, requests } = buildK8s()
  const controller = await k8s.updateControllerReplicas('default', 'objects', 2, coordinates)

  assert.deepStrictEqual(controller, { name: 'objects', replicas: 2, labels: {}, providerMetadata: coordinates })
  assert.deepStrictEqual(requests.map(request => request.method), ['GET', 'PUT'])

  const empty = await k8s.updateControllerReplicas('default', 'objects', 2, coordinates, [])
  assert.strictEqual(empty.removal, undefined)
})

test('k8s: the pods to remove get the lowest deletion cost before the count is lowered', async () => {
  const { k8s, requests } = buildK8s({
    pods: [pod('a'), pod('b'), pod('c', { [DELETION_COST]: '-2147483648', [REMOVE_FIRST]: 'true' })]
  })
  const controller = await k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['b', 'gone'])

  assert.strictEqual(controller.replicas, 2)
  assert.deepStrictEqual(controller.removal, { steered: true, machines: ['b'] })

  const writes = requests.filter(request => request.method !== 'GET')
  assert.deepStrictEqual(writes.map(request => [request.method, request.path]), [
    ['PATCH', '/api/v1/namespaces/default/pods/b'],
    // c was marked by an earlier request and is still there: it is not preferred anymore
    ['PATCH', '/api/v1/namespaces/default/pods/c'],
    ['PUT', '/apis/apps/v1/namespaces/default/deployments/objects']
  ])
  assert.deepStrictEqual(writes[0].body, { metadata: { annotations: { [DELETION_COST]: '-2147483648', [REMOVE_FIRST]: 'true' } } })
  assert.deepStrictEqual(writes[1].body, { metadata: { annotations: { [DELETION_COST]: null, [REMOVE_FIRST]: null } } })
  assert.strictEqual(requests.find(request => request.path.includes('labelSelector')).path, '/api/v1/namespaces/default/pods?labelSelector=app=objects')
})

test('k8s: a pod already marked or terminating is not written again', async () => {
  const { k8s, requests } = buildK8s({
    pods: [pod('a', { [REMOVE_FIRST]: 'true' }), pod('b', {}, { deletionTimestamp: '2026-01-01T00:00:00Z' }), pod('c')]
  })
  const controller = await k8s.updateControllerReplicas('default', 'objects', 1, coordinates, ['a', 'b'])

  assert.deepStrictEqual(controller.removal, { steered: true, machines: ['a'] })
  assert.deepStrictEqual(requests.filter(request => request.method === 'PATCH'), [])
})

test('k8s: the count is changed even when the removal cannot be steered', async () => {
  const cases = [
    [{ pods: [pod('a')] }, 5, coordinates, ['a'], 'not-a-scale-down'],
    [{ pods: [pod('a')] }, 3, coordinates, ['a'], 'not-a-scale-down'],
    [{ pods: [pod('a')] }, 2, { kind: 'StatefulSet', apiVersion: 'apps/v1' }, ['a'], 'unsupported-controller'],
    [{ pods: [pod('a')], matchLabels: {} }, 2, coordinates, ['a'], 'no-selector'],
    [{ pods: [pod('a')] }, 2, coordinates, ['other'], 'machines-not-found'],
    [{ failPods: true }, 2, coordinates, ['a'], 'failed']
  ]

  for (const [options, replicas, metadata, remove, reason] of cases) {
    const { k8s, requests } = buildK8s(options)
    const controller = await k8s.updateControllerReplicas('default', 'objects', replicas, metadata, remove)

    assert.strictEqual(controller.replicas, replicas, reason)
    assert.deepStrictEqual(controller.removal, { steered: false, machines: [], reason })
    assert.strictEqual(requests.filter(request => request.method === 'PATCH').length, 0, reason)
    assert.strictEqual(requests.filter(request => request.method === 'PUT').length, 1, reason)
  }
})

const arn = id => `arn:aws:ecs:us-east-1:123456789:task/my-cluster/${id}`

function buildEcs (taskIds, protection = { failures: [] }) {
  const ecs = new Ecs({ config: { PLT_ECS_REGION: 'us-east-1' }, log })
  const mock = mockClient(ECSClient)

  mock.on(ListTasksCommand).resolves({ taskArns: taskIds.map(arn) })
  mock.on(UpdateServiceCommand).callsFake(input => ({ service: { serviceName: input.service, desiredCount: input.desiredCount, tags: [] } }))

  if (protection instanceof Error) {
    mock.on(UpdateTaskProtectionCommand).rejects(protection)
  } else {
    mock.on(UpdateTaskProtectionCommand).resolves(protection)
  }

  ecs.ecsClient = mock
  return { ecs, mock }
}

test('ecs: without machines to remove the count is changed as before', async () => {
  const { ecs, mock } = buildEcs(['a', 'b', 'c'])
  const controller = await ecs.updateControllerReplicas('my-cluster', 'objects', 2, {})

  assert.deepStrictEqual(controller, { name: 'objects', replicas: 2, labels: {}, providerMetadata: {} })
  assert.strictEqual(mock.commandCalls(ListTasksCommand).length, 0)
  assert.strictEqual(mock.commandCalls(UpdateTaskProtectionCommand).length, 0)
})

test('ecs: the tasks to keep are protected before the count is lowered', async () => {
  const { ecs, mock } = buildEcs(['a', 'b', 'c', 'd'])
  // By ID, or by ARN
  const controller = await ecs.updateControllerReplicas('my-cluster', 'objects', 2, {}, ['b', arn('d'), 'gone'])

  assert.strictEqual(controller.replicas, 2)
  assert.deepStrictEqual(controller.removal, { steered: true, machines: ['b', 'd'] })

  const protections = mock.commandCalls(UpdateTaskProtectionCommand)
  assert.strictEqual(protections.length, 1)
  assert.deepStrictEqual(protections[0].args[0].input, {
    cluster: 'my-cluster',
    tasks: [arn('a'), arn('c')],
    protectionEnabled: true,
    expiresInMinutes: 5
  })

  // The protection comes before the new count
  const order = mock.calls().map(call => call.args[0].constructor.name)
  assert.deepStrictEqual(order, ['ListTasksCommand', 'UpdateTaskProtectionCommand', 'UpdateServiceCommand'])
})

test('ecs: no more tasks are protected than the new count, in batches of ten', async () => {
  // One machine named, and the count goes down by two: the service chooses the second among the unprotected ones
  const few = buildEcs(['a', 'b', 'c', 'd'])
  const controller = await few.ecs.updateControllerReplicas('my-cluster', 'objects', 2, {}, ['a'])
  assert.deepStrictEqual(controller.removal, { steered: true, machines: ['a'] })
  assert.deepStrictEqual(few.mock.commandCalls(UpdateTaskProtectionCommand)[0].args[0].input.tasks, [arn('b'), arn('c')])

  const ids = Array.from({ length: 25 }, (_, i) => `task-${i}`)
  const many = buildEcs(ids)
  await many.ecs.updateControllerReplicas('my-cluster', 'objects', 24, {}, ['task-0'])
  assert.deepStrictEqual(many.mock.commandCalls(UpdateTaskProtectionCommand).map(call => call.args[0].input.tasks.length), [10, 10, 4])

  // Down to none: nothing to protect
  const none = buildEcs(['a', 'b'])
  const emptied = await none.ecs.updateControllerReplicas('my-cluster', 'objects', 0, {}, ['a', 'b'])
  assert.deepStrictEqual(emptied.removal, { steered: true, machines: ['a', 'b'] })
  assert.strictEqual(none.mock.commandCalls(UpdateTaskProtectionCommand).length, 0)
})

test('ecs: the count is changed even when the removal cannot be steered', async () => {
  const denied = new Error('User is not authorized to perform: ecs:UpdateTaskProtection')
  const cases = [
    [['a', 'b'], undefined, 2, ['a'], { steered: false, machines: [], reason: 'not-a-scale-down' }],
    [['a', 'b'], undefined, 1, ['other'], { steered: false, machines: [], reason: 'machines-not-found' }],
    [['a', 'b'], denied, 1, ['a'], { steered: false, machines: [], reason: 'failed' }],
    [['a', 'b'], { failures: [{ arn: arn('b'), reason: 'TASK_NOT_VALID' }] }, 1, ['a'], { steered: false, machines: ['a'], reason: 'protection-failed' }]
  ]

  for (const [tasks, protection, replicas, remove, removal] of cases) {
    const { ecs, mock } = buildEcs(tasks, protection)
    const controller = await ecs.updateControllerReplicas('my-cluster', 'objects', replicas, {}, remove)

    assert.strictEqual(controller.replicas, replicas, removal.reason)
    assert.deepStrictEqual(controller.removal, removal)
    assert.strictEqual(mock.commandCalls(UpdateServiceCommand).length, 1, removal.reason)
  }
})

test('the route passes the machines to the provider, and answers with what it did', async t => {
  const fastify = require('fastify')()
  t.after(() => fastify.close())
  const calls = []

  fastify.decorate('provider', {
    async updateControllerReplicas (...args) {
      calls.push(args)
      const controller = { name: args[1], replicas: args[2], labels: {}, providerMetadata: {} }
      return args[4] ? { ...controller, removal: { steered: true, machines: args[4] } } : controller
    }
  })
  await fastify.register(require('../plugins/shared-schemas'))
  await fastify.register(require('../routes/controllers'))

  // As a caller which predates the machines to remove
  const plain = await fastify.inject({ method: 'POST', url: '/controllers/default/objects', payload: { replicas: 2 } })
  assert.deepStrictEqual(plain.json(), { name: 'objects', replicas: 2, labels: {}, providerMetadata: {} })
  assert.strictEqual(calls[0][4], undefined)

  const steered = await fastify.inject({ method: 'POST', url: '/controllers/default/objects?kind=Deployment', payload: { replicas: 1, remove: ['a'] } })
  assert.deepStrictEqual(steered.json().removal, { steered: true, machines: ['a'] })
  assert.deepStrictEqual(calls[1], ['default', 'objects', 1, { kind: 'Deployment' }, ['a']])
})
