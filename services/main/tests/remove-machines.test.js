'use strict'

// The machines to remove first on a scale down: these tests stub the APIs of the providers, and need no cluster.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mockClient } = require('aws-sdk-client-mock')
const { ECSClient, DescribeServicesCommand, GetTaskProtectionCommand, ListTasksCommand, UpdateServiceCommand, UpdateTaskProtectionCommand } = require('@aws-sdk/client-ecs')
const { K8s } = require('../plugins/providers/k8s')
const { Ecs } = require('../plugins/providers/ecs')

const log = { debug () {}, info () {}, warn () {}, error () {} }
const coordinates = { kind: 'Deployment', apiVersion: 'apps/v1' }
const DELETION_COST = 'controller.kubernetes.io/pod-deletion-cost'
const REMOVE_FIRST = 'machinist.platformatic.dev/remove-first'
const PREVIOUS_COST = 'machinist.platformatic.dev/previous-deletion-cost'
const LOWEST = '-2147483648'
const marked = { [DELETION_COST]: LOWEST, [REMOVE_FIRST]: 'true' }

// A pod of the ReplicaSet of the deployment, unless it has another owner
function pod (name, annotations = {}, extra = {}) {
  return { metadata: { name, uid: `uid-${name}`, annotations, ownerReferences: [{ controller: true, uid: 'rs-1' }], ...extra } }
}

// controllerChanges are functions which change the controller as somebody else would, one before each write of it:
// that write is then refused, since the controller is not the one which was read anymore
function buildK8s ({ replicas = 3, pods = [], selector = { matchLabels: { app: 'objects' } }, failPods = false, annotations, conflicts = {}, failWrite = false, controllerChanges = [] } = {}) {
  const k8s = new K8s({
    config: { PLT_K8S_REST_API_URL: 'http://k8s.local', PLT_K8S_ALLOW_SELFSIGNED_CERT: true },
    log,
    caContent: '',
    tokenPath: 'test',
    authType: 'token',
    clientCreds: {}
  })
  const requests = []
  // The pods as the API has them: a write of one which changed since it was read is refused
  const stored = new Map(pods.map(item => [item.metadata.name, structuredClone({ ...item, metadata: { resourceVersion: '1', ...item.metadata } })]))
  const controller = {
    metadata: { name: 'objects', uid: 'deployment-1', labels: {}, resourceVersion: '1', annotations },
    spec: { replicas, selector, template: { image: 'v1' } }
  }
  const conflict = () => {
    const error = new Error('the object has been modified')
    error.statusCode = 409
    return error
  }

  function writeController (body, replace) {
    const change = controllerChanges.shift()

    if (change) {
      change(controller)
      controller.metadata.resourceVersion = String(Number(controller.metadata.resourceVersion) + 1)
    }

    if (failWrite || body.metadata?.resourceVersion !== controller.metadata.resourceVersion) {
      throw conflict()
    }

    if (replace) {
      controller.metadata = body.metadata
      controller.spec = body.spec
    } else {
      for (const [key, value] of Object.entries(body.metadata.annotations ?? {})) {
        controller.metadata.annotations ??= {}

        if (value === null) {
          delete controller.metadata.annotations[key]
        } else {
          controller.metadata.annotations[key] = value
        }
      }

      Object.assign(controller.spec, body.spec)
    }

    controller.metadata.resourceVersion = String(Number(controller.metadata.resourceVersion) + 1)
    return structuredClone(controller)
  }

  k8s.apiClient = {
    async request (path, options = {}) {
      const method = options.method ?? 'GET'
      requests.push({ method, path, body: options.body ? JSON.parse(options.body) : undefined })

      if (path.includes('/replicasets?labelSelector=')) {
        return {
          items: [
            { metadata: { uid: 'rs-1', ownerReferences: [{ controller: true, uid: 'deployment-1' }] } },
            // Of another deployment, selected by the same labels
            { metadata: { uid: 'rs-other', ownerReferences: [{ controller: true, uid: 'deployment-other' }] } }
          ]
        }
      }

      if (path.includes('/pods?labelSelector=')) {
        if (failPods) {
          throw new Error('pods are forbidden')
        }

        return { items: structuredClone([...stored.values()]) }
      }

      if (path.includes('/pods/')) {
        const name = path.split('/').pop()

        const current = stored.get(name)

        // A pod read again after a conflict: as scripted, or as it is
        if (method === 'GET') {
          return conflicts[name]?.length > 0 ? conflicts[name].shift() : structuredClone(current)
        }

        // Somebody else changed the pod since it was read: as scripted, or for real
        const body = JSON.parse(options.body)

        if (conflicts[name]?.length > 0 || (conflicts[name] === undefined && body.metadata.resourceVersion !== current.metadata.resourceVersion)) {
          throw conflict()
        }

        current.metadata.annotations ??= {}

        for (const [key, value] of Object.entries(body.metadata.annotations)) {
          if (value === null) {
            delete current.metadata.annotations[key]
          } else {
            current.metadata.annotations[key] = value
          }
        }

        current.metadata.resourceVersion = String(Number(current.metadata.resourceVersion) + 1)

        return {}
      }

      return method === 'GET' ? structuredClone(controller) : writeController(JSON.parse(options.body), method === 'PUT')
    }
  }

  return { k8s, requests, controller, stored }
}

// The writes of the controller
const controllerWrites = requests => requests.filter(request => request.method !== 'GET' && !request.path.includes('/pods/'))

const patches = requests => requests.filter(request => request.method === 'PATCH' && request.path.includes('/pods/')).map(request => [request.path.split('/').pop(), request.body.metadata.annotations])

test('k8s: without machines to remove the count is changed as before', async () => {
  const { k8s, requests } = buildK8s()
  const controller = await k8s.updateControllerReplicas('default', 'objects', 2, coordinates)

  assert.deepStrictEqual(controller, { name: 'objects', replicas: 2, labels: {}, providerMetadata: coordinates })
  assert.deepStrictEqual(requests.map(request => request.method), ['GET', 'PUT'])

  const empty = await k8s.updateControllerReplicas('default', 'objects', 2, coordinates, [])
  assert.strictEqual(empty.removal, undefined)
})

test('k8s: the pods to remove get the lowest deletion cost before the count is lowered', async () => {
  const { k8s, requests } = buildK8s({ pods: [pod('a'), pod('b'), pod('c', marked)] })
  const controller = await k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['b', 'gone'])

  assert.strictEqual(controller.replicas, 2)
  assert.deepStrictEqual(controller.removal, { steered: true, machines: ['b'] })
  assert.deepStrictEqual(patches(requests), [
    ['b', marked],
    // c was marked by an earlier request and is still there: it is not preferred anymore
    ['c', { [DELETION_COST]: null, [REMOVE_FIRST]: null, [PREVIOUS_COST]: null }]
  ])

  // The preference is set before the count, which is written alone, with the mark of the controller
  assert.strictEqual(requests.at(-1).path, '/apis/apps/v1/namespaces/default/deployments/objects')
  assert.strictEqual(requests.at(-1).method, 'PATCH')
  assert.deepStrictEqual(requests.at(-1).body.spec, { replicas: 2 })
})

test('k8s: a pod already marked or terminating is not written again', async () => {
  const { k8s, requests } = buildK8s({
    pods: [pod('a', marked), pod('b', {}, { deletionTimestamp: '2026-01-01T00:00:00Z' }), pod('c')]
  })
  const controller = await k8s.updateControllerReplicas('default', 'objects', 1, coordinates, ['a', 'b'])

  assert.deepStrictEqual(controller.removal, { steered: true, machines: ['a'] })
  assert.deepStrictEqual(patches(requests), [])
})

test('k8s: the pods are found with the whole selector, and only those the controller owns are touched', async () => {
  const selector = {
    matchLabels: { app: 'worker' },
    matchExpressions: [
      { key: 'track', operator: 'In', values: ['stable', 'beta'] },
      { key: 'tier', operator: 'NotIn', values: ['batch'] },
      { key: 'zone', operator: 'Exists' },
      { key: 'debug', operator: 'DoesNotExist' }
    ]
  }
  const foreign = [{ controller: true, uid: 'rs-other' }]
  const { k8s, requests } = buildK8s({
    selector,
    pods: [
      pod('a'),
      // Of the other deployment: neither marked when named, nor unmarked while it is being scaled down
      pod('canary-1', {}, { ownerReferences: foreign }),
      pod('canary-2', marked, { ownerReferences: foreign }),
      pod('orphan', marked, { ownerReferences: undefined })
    ]
  })
  const controller = await k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['a', 'canary-1'])

  assert.deepStrictEqual(controller.removal, { steered: true, machines: ['a'] })
  assert.deepStrictEqual(patches(requests), [['a', marked]])

  const expected = encodeURIComponent('app=worker,track in (stable,beta),tier notin (batch),zone,!debug')
  assert.deepStrictEqual(requests.filter(request => request.path.includes('labelSelector')).map(request => request.path), [
    `/apis/apps/v1/namespaces/default/replicasets?labelSelector=${expected}`,
    `/api/v1/namespaces/default/pods?labelSelector=${expected}`
  ])

  // A ReplicaSet scaled directly owns its pods itself
  const direct = buildK8s({ pods: [pod('a', {}, { ownerReferences: [{ controller: true, uid: 'deployment-1' }] }), pod('b')] })
  const scaled = await direct.k8s.updateControllerReplicas('default', 'objects', 2, { kind: 'ReplicaSet', apiVersion: 'apps/v1' }, ['a', 'b'])
  assert.deepStrictEqual(scaled.removal, { steered: true, machines: ['a'] })
  assert.strictEqual(direct.requests.some(request => request.path.includes('/replicasets?')), false)
})

test('k8s: a pod which stays gets back the deletion cost it had', async () => {
  const { k8s, requests } = buildK8s({
    pods: [
      // Named now: its own cost is kept aside
      pod('a', { [DELETION_COST]: '1000' }),
      // Marked before, with a cost of its own
      pod('b', { ...marked, [PREVIOUS_COST]: '500' }),
      // Marked before, and its cost was changed since: it is not ours to take back
      pod('c', { [DELETION_COST]: '42', [REMOVE_FIRST]: 'true' }),
      pod('d')
    ]
  })
  await k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['a'])

  assert.deepStrictEqual(patches(requests), [
    ['a', { ...marked, [PREVIOUS_COST]: '1000' }],
    ['b', { [DELETION_COST]: '500', [REMOVE_FIRST]: null, [PREVIOUS_COST]: null }],
    ['c', { [REMOVE_FIRST]: null, [PREVIOUS_COST]: null }]
  ])
})

test('k8s: a marked pod whose cost was changed is not counted as preferred', async () => {
  const { k8s, requests } = buildK8s({ pods: [pod('a', { [DELETION_COST]: '1000', [REMOVE_FIRST]: 'true' }), pod('b'), pod('c')] })
  const controller = await k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['a'])

  // The cost stays as it was changed, and the mark is dropped
  assert.deepStrictEqual(controller.removal, { steered: false, machines: [], reason: 'machines-not-found' })
  assert.deepStrictEqual(patches(requests), [['a', { [REMOVE_FIRST]: null, [PREVIOUS_COST]: null }]])
})

test('k8s: a scale down which names no machine takes the marks back first', async () => {
  const CONTROLLER_MARK = 'machinist.platformatic.dev/remove-first-pods'

  // The request which marks pods says so on the controller before it marks any
  const first = buildK8s({ pods: [pod('a'), pod('b'), pod('c')] })
  await first.k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['a', 'b'])
  const writes = first.requests.filter(request => request.method !== 'GET')
  assert.deepStrictEqual(writes.map(request => [request.method, request.path.split('/').pop()]), [['PATCH', 'objects'], ['PATCH', 'a'], ['PATCH', 'b'], ['PATCH', 'objects']])
  assert.deepStrictEqual(writes[0].body, { metadata: { annotations: { [CONTROLLER_MARK]: 'true' }, resourceVersion: '1' } })
  assert.deepStrictEqual(writes.at(-1).body, { metadata: { annotations: { [CONTROLLER_MARK]: 'true' }, resourceVersion: '2' }, spec: { replicas: 2 } })

  // The count cannot be written: the pods are marked, and the controller says so for the next change to find
  const lost = buildK8s({ pods: [pod('a'), pod('b'), pod('c')], controllerChanges: [null, controller => { controller.spec.replicas = 9 }] })
  await assert.rejects(lost.k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['a']), { statusCode: 409 })
  assert.deepStrictEqual(patches(lost.requests).map(([name]) => name), ['a'])
  assert.strictEqual(lost.controller.metadata.annotations[CONTROLLER_MARK], 'true')
  // Somebody else scaled it meanwhile: the count asked on what was read is not written over theirs
  assert.strictEqual(lost.controller.spec.replicas, 9)

  // The same count asked again while the controller may still be choosing the pod to remove: the marks stay
  const same = buildK8s({ replicas: 2, annotations: { [CONTROLLER_MARK]: 'true' }, pods: [pod('a', marked), pod('b'), pod('c')] })
  await same.k8s.updateControllerReplicas('default', 'objects', 2, coordinates)
  assert.deepStrictEqual(same.requests.map(request => request.method), ['GET', 'PUT'])
  assert.strictEqual(same.controller.metadata.annotations[CONTROLLER_MARK], 'true')

  // b stayed, marked. A caller which names no machine must not have it removed for that
  const plain = buildK8s({ replicas: 2, annotations: { [CONTROLLER_MARK]: 'true' }, pods: [pod('b', marked), pod('c')] })
  const controller = await plain.k8s.updateControllerReplicas('default', 'objects', 1, coordinates)

  assert.strictEqual(controller.removal, undefined)
  assert.deepStrictEqual(patches(plain.requests), [['b', { [DELETION_COST]: null, [REMOVE_FIRST]: null, [PREVIOUS_COST]: null }]])
  assert.deepStrictEqual(plain.requests.at(-1).body, { metadata: { annotations: { [CONTROLLER_MARK]: null }, resourceVersion: '1' }, spec: { replicas: 1 } })
  assert.strictEqual(plain.controller.metadata.annotations[CONTROLLER_MARK], undefined)
  assert.strictEqual(plain.controller.spec.replicas, 1)

  // A controller which never had marked pods is scaled with the two requests it always took
  const never = buildK8s({ replicas: 2, pods: [pod('b', marked)] })
  await never.k8s.updateControllerReplicas('default', 'objects', 1, coordinates)
  assert.deepStrictEqual(never.requests.map(request => request.method), ['GET', 'PUT'])

  // The marks cannot be read: the count is changed all the same
  const failing = buildK8s({ replicas: 2, annotations: { [CONTROLLER_MARK]: 'true' }, failPods: true })
  assert.strictEqual((await failing.k8s.updateControllerReplicas('default', 'objects', 1, coordinates)).replicas, 1)
})

test('k8s: the count is written alone, on the controller which was read', async () => {
  const CONTROLLER_MARK = 'machinist.platformatic.dev/remove-first-pods'

  // Kubernetes writes the status of the controller between the read and each write: the writes are made again
  const status = controller => { controller.status = { observed: true } }
  const busy = buildK8s({ pods: [pod('a'), pod('b'), pod('c')], controllerChanges: [status, null, status] })
  const scaled = await busy.k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['a'])
  assert.strictEqual(scaled.replicas, 2)
  assert.deepStrictEqual(scaled.removal, { steered: true, machines: ['a'] })
  assert.strictEqual(controllerWrites(busy.requests).length, 4)

  // A deploy changes the pods of the controller while its pods are looked at: the count is written, and the
  // controller keeps what was deployed
  const deployed = buildK8s({ pods: [pod('a'), pod('b'), pod('c')], controllerChanges: [controller => { controller.spec.template.image = 'v2' }] })
  await deployed.k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['a'])
  assert.deepStrictEqual(deployed.controller.spec.template, { image: 'v2' })
  assert.strictEqual(deployed.controller.spec.replicas, 2)
  assert.strictEqual(deployed.controller.metadata.annotations[CONTROLLER_MARK], 'true')

  // Something else lowers the count to the one asked, before the pod was marked: Kubernetes can have chosen another
  // pod already, so the request does not say that it steered
  const scaledByOther = buildK8s({ pods: [pod('a'), pod('b'), pod('c')], controllerChanges: [null, controller => { controller.spec.replicas = 2 }] })
  await assert.rejects(scaledByOther.k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['a']), { statusCode: 409 })

  // The controller is deleted and created again under the same name before the count is written: the new one is
  // not scaled with the count asked for the old one
  const recreated = buildK8s({ pods: [pod('a'), pod('b'), pod('c')], controllerChanges: [null, controller => { controller.metadata.uid = 'deployment-2' }] })
  await assert.rejects(recreated.k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['a']), { statusCode: 409 })
  assert.strictEqual(recreated.controller.spec.replicas, 3)

  // A request which names no machine, on a controller with no marked pod, is the single write it always was
  await assert.rejects(buildK8s({ controllerChanges: [status] }).k8s.updateControllerReplicas('default', 'objects', 2, coordinates), { statusCode: 409 })
})

test('k8s: a pod changed while it is written is read again and decided again', async () => {
  const version = (name, annotations, resourceVersion) => pod(name, annotations, { resourceVersion })

  // a gets a cost of 7 from somebody else between the list and the patch: it is the one kept aside
  const marking = buildK8s({
    pods: [version('a', {}, '1'), pod('b'), pod('c')],
    conflicts: { a: [version('a', { [DELETION_COST]: '7' }, '2')] }
  })
  const controller = await marking.k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['a'])
  assert.deepStrictEqual(controller.removal, { steered: true, machines: ['a'] })

  const writes = marking.requests.filter(request => request.method === 'PATCH' && request.path.includes('/pods/')).map(request => request.body.metadata)
  assert.deepStrictEqual(writes, [
    { resourceVersion: '1', annotations: marked },
    { resourceVersion: '2', annotations: { ...marked, [PREVIOUS_COST]: '7' } }
  ])

  // b is being unmarked, and its cost is changed meanwhile: the new cost is left alone
  const unmarking = buildK8s({
    pods: [version('a', {}, '1'), version('b', marked, '1'), pod('c')],
    conflicts: { b: [version('b', { [DELETION_COST]: '9', [REMOVE_FIRST]: 'true' }, '2')] }
  })
  await unmarking.k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['a'])
  assert.deepStrictEqual(patches(unmarking.requests).filter(([name]) => name === 'b'), [
    ['b', { [DELETION_COST]: null, [REMOVE_FIRST]: null, [PREVIOUS_COST]: null }],
    ['b', { [REMOVE_FIRST]: null, [PREVIOUS_COST]: null }]
  ])

  // a is replaced by another pod of the same name, or leaves the controller, between the list and the patch: the
  // pod read again is not written
  for (const other of [version('a', {}, '2'), { ...version('a', {}, '2'), metadata: { ...version('a', {}, '2').metadata, ownerReferences: [{ controller: true, uid: 'rs-other' }] } }]) {
    if (other.metadata.ownerReferences[0].uid === 'rs-1') {
      other.metadata.uid = 'uid-replacement'
    }

    const moved = buildK8s({ pods: [version('a', {}, '1'), pod('b'), pod('c')], conflicts: { a: [other] } })
    const result = await moved.k8s.updateControllerReplicas('default', 'objects', 2, coordinates, ['a'])
    assert.deepStrictEqual(result.removal, { steered: false, machines: [], reason: 'machines-not-found' })
    assert.strictEqual(patches(moved.requests).length, 1)
  }

  // A pod which keeps changing fails the steering, not the change of the count
  const busy = buildK8s({
    pods: [version('a', {}, '1'), pod('b')],
    conflicts: { a: [version('a', {}, '2'), version('a', {}, '3'), version('a', {}, '4')] }
  })
  const given = await busy.k8s.updateControllerReplicas('default', 'objects', 1, coordinates, ['a'])
  assert.strictEqual(given.replicas, 1)
  assert.deepStrictEqual(given.removal, { steered: false, machines: [], reason: 'failed' })
})

test('k8s: the count is changed even when the removal cannot be steered', async () => {
  const cases = [
    [{ pods: [pod('a')] }, 5, coordinates, ['a'], 'not-a-scale-down'],
    [{ pods: [pod('a')] }, 3, coordinates, ['a'], 'not-a-scale-down'],
    [{ pods: [pod('a')] }, 2, { kind: 'StatefulSet', apiVersion: 'apps/v1' }, ['a'], 'unsupported-controller'],
    [{ pods: [pod('a')], selector: {} }, 2, coordinates, ['a'], 'no-selector'],
    [{ pods: [pod('a')], selector: { matchExpressions: [{ key: 'a', operator: 'Gt', values: ['1'] }] } }, 2, coordinates, ['a'], 'no-selector'],
    [{ pods: [pod('a')] }, 2, coordinates, ['other'], 'machines-not-found'],
    [{ failPods: true }, 2, coordinates, ['a'], 'failed']
  ]

  for (const [options, replicas, metadata, remove, reason] of cases) {
    const { k8s, requests } = buildK8s(options)
    const controller = await k8s.updateControllerReplicas('default', 'objects', replicas, metadata, remove)

    assert.strictEqual(controller.replicas, replicas, reason)
    assert.deepStrictEqual(controller.removal, { steered: false, machines: [], reason })
    assert.strictEqual(patches(requests).length, 0, reason)
    assert.strictEqual(controllerWrites(requests).filter(request => request.body.spec?.replicas === replicas).length, 1, reason)
  }
})

const arn = id => `arn:aws:ecs:us-east-1:123456789:task/my-cluster/${id}`
const minutes = count => new Date(Date.now() + count * 60 * 1000)

// protectedTasks is { id: expirationDate }, for the tasks which are protected already
function buildEcs (taskIds, { desiredCount = taskIds.length, protectedTasks = {}, protection = { failures: [] }, config = {} } = {}) {
  const ecs = new Ecs({ config: { PLT_ECS_REGION: 'us-east-1', ...config }, log })
  const mock = mockClient(ECSClient)

  mock.on(DescribeServicesCommand).resolves({ services: [{ serviceName: 'objects', desiredCount }] })
  mock.on(ListTasksCommand).resolves({ taskArns: taskIds.map(arn) })
  mock.on(GetTaskProtectionCommand).callsFake(input => ({
    protectedTasks: input.tasks.map(taskArn => {
      const expirationDate = protectedTasks[taskArn.split('/').pop()]
      return expirationDate ? { taskArn, protectionEnabled: true, expirationDate } : { taskArn, protectionEnabled: false }
    }),
    failures: []
  }))
  mock.on(UpdateServiceCommand).callsFake(input => ({ service: { serviceName: input.service, desiredCount: input.desiredCount, tags: [] } }))

  if (protection instanceof Error) {
    mock.on(UpdateTaskProtectionCommand).rejects(protection)
  } else {
    mock.on(UpdateTaskProtectionCommand).resolves(protection)
  }

  ecs.ecsClient = mock
  return { ecs, mock }
}

const protections = mock => mock.commandCalls(UpdateTaskProtectionCommand).map(call => call.args[0].input.tasks)

test('ecs: without machines to remove the count is changed as before', async () => {
  const { ecs, mock } = buildEcs(['a', 'b', 'c'])
  const controller = await ecs.updateControllerReplicas('my-cluster', 'objects', 2, {})

  assert.deepStrictEqual(controller, { name: 'objects', replicas: 2, labels: {}, providerMetadata: {} })
  assert.deepStrictEqual(mock.calls().map(call => call.args[0].constructor.name), ['UpdateServiceCommand'])
})

test('ecs: the tasks to keep are protected before the count is lowered', async () => {
  const { ecs, mock } = buildEcs(['a', 'b', 'c', 'd'])
  // By ID, or by ARN
  const controller = await ecs.updateControllerReplicas('my-cluster', 'objects', 2, {}, ['b', arn('d'), 'gone'])

  assert.strictEqual(controller.replicas, 2)
  assert.deepStrictEqual(controller.removal, { steered: true, machines: ['b', 'd'] })
  assert.deepStrictEqual(mock.commandCalls(UpdateTaskProtectionCommand).map(call => call.args[0].input), [{
    cluster: 'my-cluster',
    tasks: [arn('a'), arn('c')],
    protectionEnabled: true,
    expiresInMinutes: 5
  }])

  // The protection comes before the new count
  const order = mock.calls().map(call => call.args[0].constructor.name)
  assert.deepStrictEqual(order, ['DescribeServicesCommand', 'ListTasksCommand', 'GetTaskProtectionCommand', 'UpdateTaskProtectionCommand', 'UpdateServiceCommand'])
})

test('ecs: no more tasks are protected than the new count, in batches of ten', async () => {
  // One machine named, and the count goes down by two: the service chooses the second among the unprotected ones
  const few = buildEcs(['a', 'b', 'c', 'd'])
  const controller = await few.ecs.updateControllerReplicas('my-cluster', 'objects', 2, {}, ['a'])
  assert.deepStrictEqual(controller.removal, { steered: true, machines: ['a'] })
  assert.deepStrictEqual(protections(few.mock), [[arn('b'), arn('c')]])

  const ids = Array.from({ length: 25 }, (_, i) => `task-${i}`)
  const many = buildEcs(ids)
  await many.ecs.updateControllerReplicas('my-cluster', 'objects', 24, {}, ['task-0'])
  assert.deepStrictEqual(protections(many.mock).map(tasks => tasks.length), [10, 10, 4])

  // Down to none: nothing to protect
  const none = buildEcs(['a', 'b'])
  const emptied = await none.ecs.updateControllerReplicas('my-cluster', 'objects', 0, {}, ['a', 'b'])
  assert.deepStrictEqual(emptied.removal, { steered: true, machines: ['a', 'b'] })
  assert.deepStrictEqual(protections(none.mock), [])
})

test('ecs: a task to remove which is protected is not unprotected, and the removal is not steered', async () => {
  // Three tasks went to two a moment ago, removing a: b and c are still protected. Now b is to be removed
  const { ecs, mock } = buildEcs(['b', 'c'], { protectedTasks: { b: minutes(4), c: minutes(4) } })
  const controller = await ecs.updateControllerReplicas('my-cluster', 'objects', 1, {}, ['b'])

  assert.strictEqual(controller.replicas, 1)
  assert.deepStrictEqual(controller.removal, { steered: false, machines: ['b'], reason: 'machines-protected' })
  assert.deepStrictEqual(protections(mock), [])

  // A protection which ran out does not count
  const expired = buildEcs(['b', 'c'], { protectedTasks: { b: minutes(-1) } })
  const steered = await expired.ecs.updateControllerReplicas('my-cluster', 'objects', 1, {}, ['b'])
  assert.deepStrictEqual(steered.removal, { steered: true, machines: ['b'] })
  assert.deepStrictEqual(protections(expired.mock), [[arn('c')]])
})

test('ecs: a protection which lasts long enough is left as it is, and counts first among the tasks kept', async () => {
  // c protected itself for an hour: setting it again would shorten it to five minutes. b is protected for one more
  // minute, which is extended
  const { ecs, mock } = buildEcs(['a', 'b', 'c', 'd'], { protectedTasks: { b: minutes(1), c: minutes(60) } })
  const controller = await ecs.updateControllerReplicas('my-cluster', 'objects', 3, {}, ['a'])

  assert.deepStrictEqual(controller.removal, { steered: true, machines: ['a'] })
  assert.deepStrictEqual(protections(mock), [[arn('b'), arn('d')]])

  // Two tasks to keep, and the protected one is one of them: d is left for the service to choose from
  const two = buildEcs(['a', 'b', 'c', 'd'], { protectedTasks: { c: minutes(60) } })
  await two.ecs.updateControllerReplicas('my-cluster', 'objects', 2, {}, ['a'])
  assert.deepStrictEqual(protections(two.mock), [[arn('b')]])
})

test('ecs: the desired count of the service tells a scale down, not the tasks which run', async () => {
  // A rollout: five tasks for a desired count of three
  const { ecs, mock } = buildEcs(['a', 'b', 'c', 'd', 'e'], { desiredCount: 3 })
  const controller = await ecs.updateControllerReplicas('my-cluster', 'objects', 3, {}, ['a'])

  assert.deepStrictEqual(controller.removal, { steered: false, machines: [], reason: 'not-a-scale-down' })
  assert.deepStrictEqual(mock.calls().map(call => call.args[0].constructor.name), ['DescribeServicesCommand', 'UpdateServiceCommand'])
})

test('ecs: nothing is steered when no task has to stop, or when the protection is turned off', async () => {
  // A desired count of three with two tasks only: the service gets to two without stopping any
  const short = buildEcs(['a', 'b'], { desiredCount: 3 })
  const controller = await short.ecs.updateControllerReplicas('my-cluster', 'objects', 2, {}, ['a'])
  assert.deepStrictEqual(controller.removal, { steered: false, machines: [], reason: 'nothing-to-remove' })
  assert.deepStrictEqual(protections(short.mock), [])

  // The applications protect their own tasks: this provider writes no protection
  const off = buildEcs(['a', 'b', 'c'], { config: { PLT_ECS_SCALE_IN_PROTECTION: false } })
  const scaled = await off.ecs.updateControllerReplicas('my-cluster', 'objects', 2, {}, ['a'])
  assert.strictEqual(scaled.replicas, 2)
  assert.deepStrictEqual(scaled.removal, { steered: false, machines: [], reason: 'disabled' })
  assert.deepStrictEqual(off.mock.calls().map(call => call.args[0].constructor.name), ['UpdateServiceCommand'])
})

test('ecs: the count is changed even when the removal cannot be steered', async () => {
  const denied = new Error('User is not authorized to perform: ecs:UpdateTaskProtection')
  const cases = [
    [['a', 'b'], {}, 2, ['a'], { steered: false, machines: [], reason: 'not-a-scale-down' }],
    [['a', 'b'], {}, 1, ['other'], { steered: false, machines: [], reason: 'machines-not-found' }],
    [['a', 'b'], { protection: denied }, 1, ['a'], { steered: false, machines: [], reason: 'failed' }],
    [['a', 'b'], { protection: { failures: [{ arn: arn('b'), reason: 'TASK_NOT_VALID' }] } }, 1, ['a'], { steered: false, machines: ['a'], reason: 'protection-failed' }]
  ]

  for (const [tasks, options, replicas, remove, removal] of cases) {
    const { ecs, mock } = buildEcs(tasks, options)
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
