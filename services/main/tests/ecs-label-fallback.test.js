'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const ecsSdk = require('@aws-sdk/client-ecs')
const taggingSdk = require('@aws-sdk/client-resource-groups-tagging-api')
const { Ecs } = require('../plugins/providers/ecs')

// ECS does not propagate tags to tasks unless the service sets `propagateTags`,
// whose default is NONE. A task with no tags is therefore the normal case, and
// without a fallback the caller sees a machine with no labels and version
// detection silently finds nothing.

const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789:task/my-cluster/abc123'
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789:service/my-cluster/my-service'

function task (overrides = {}) {
  return {
    taskArn: TASK_ARN,
    lastStatus: 'RUNNING',
    startedAt: new Date('2025-01-01T00:00:00Z'),
    group: 'service:my-service',
    containers: [{ name: 'web', image: 'myapp:latest' }],
    tags: [],
    ...overrides
  }
}

function buildEcs () {
  return new Ecs({
    config: { PLT_ECS_REGION: 'us-east-1', PLT_ECS_CLUSTER: 'my-cluster' },
    log: { debug () {}, info () {}, warn () {}, error () {} }
  })
}

// Dispatches on command type so one stub can answer tasks, services and lists.
function withEcsStub (handlers, fn) {
  const original = ecsSdk.ECSClient.prototype.send
  ecsSdk.ECSClient.prototype.send = async function (command) {
    const name = command.constructor.name
    const handler = handlers[name]
    if (!handler) throw new Error(`unexpected ECS command in test: ${name}`)
    return handler(command.input)
  }
  return Promise.resolve(fn()).finally(() => {
    ecsSdk.ECSClient.prototype.send = original
  })
}

function withTaggingStub (arnsByType, fn) {
  const original = taggingSdk.ResourceGroupsTaggingAPIClient.prototype.send
  taggingSdk.ResourceGroupsTaggingAPIClient.prototype.send = async function (command) {
    const type = command.input.ResourceTypeFilters[0]
    const arns = arnsByType[type] || []
    return { ResourceTagMappingList: arns.map(ResourceARN => ({ ResourceARN })) }
  }
  return Promise.resolve(fn()).finally(() => {
    taggingSdk.ResourceGroupsTaggingAPIClient.prototype.send = original
  })
}

test('a task with no tags inherits its service tags as labels', async () => {
  const machine = await withEcsStub({
    DescribeTasksCommand: () => ({ tasks: [task()], failures: [] }),
    DescribeServicesCommand: () => ({
      services: [{
        serviceName: 'my-service',
        tags: [
          { key: 'app.kubernetes.io/name', value: 'myapp' },
          { key: 'plt.dev/version', value: 'v2' }
        ]
      }]
    })
  }, () => buildEcs().getMachine('my-cluster', TASK_ARN))

  assert.deepStrictEqual(machine.labels, {
    'app.kubernetes.io/name': 'myapp',
    'plt.dev/version': 'v2'
  })
})

test('a task with its own tags keeps them and ignores the service tags', async () => {
  const machine = await withEcsStub({
    DescribeTasksCommand: () => ({
      tasks: [task({ tags: [{ key: 'plt.dev/version', value: 'from-task' }] })],
      failures: []
    }),
    DescribeServicesCommand: () => ({
      services: [{ serviceName: 'my-service', tags: [{ key: 'plt.dev/version', value: 'from-service' }] }]
    })
  }, () => buildEcs().getMachine('my-cluster', TASK_ARN))

  assert.deepStrictEqual(machine.labels, { 'plt.dev/version': 'from-task' })
})

test('an unreadable service leaves labels empty rather than failing the lookup', async () => {
  const machine = await withEcsStub({
    DescribeTasksCommand: () => ({ tasks: [task()], failures: [] }),
    DescribeServicesCommand: () => { throw new Error('AccessDenied') }
  }, () => buildEcs().getMachine('my-cluster', TASK_ARN))

  assert.deepStrictEqual(machine.labels, {})
  assert.strictEqual(machine.id, 'abc123')
})

test('a task with no parent service resolves to empty labels', async () => {
  const machine = await withEcsStub({
    DescribeTasksCommand: () => ({ tasks: [task({ group: 'family:standalone' })], failures: [] })
  }, () => buildEcs().getMachine('my-cluster', TASK_ARN))

  assert.deepStrictEqual(machine.labels, {})
})

test('getMachines finds tasks via service tags when no task carries them', async () => {
  const machines = await withTaggingStub(
    { 'ecs:task': [], 'ecs:service': [SERVICE_ARN] },
    () => withEcsStub({
      ListTasksCommand: () => ({ taskArns: [TASK_ARN] }),
      DescribeTasksCommand: () => ({ tasks: [task()], failures: [] }),
      DescribeServicesCommand: () => ({
        services: [{ serviceName: 'my-service', tags: [{ key: 'plt.dev/version', value: 'v2' }] }]
      })
    }, () => buildEcs().getMachines('my-cluster', { 'app.kubernetes.io/name': 'myapp' }))
  )

  assert.strictEqual(machines.length, 1)
  assert.strictEqual(machines[0].id, 'abc123')
  assert.deepStrictEqual(machines[0].labels, { 'plt.dev/version': 'v2' })
})

test('getMachines still returns nothing when neither tasks nor services match', async () => {
  const machines = await withTaggingStub(
    { 'ecs:task': [], 'ecs:service': [] },
    () => withEcsStub({}, () => buildEcs().getMachines('my-cluster', { 'app.kubernetes.io/name': 'nope' }))
  )

  assert.deepStrictEqual(machines, [])
})

test('getMachines prefers task tags and does not consult services when they match', async () => {
  let describedServices = false
  const machines = await withTaggingStub(
    { 'ecs:task': [TASK_ARN], 'ecs:service': [SERVICE_ARN] },
    () => withEcsStub({
      DescribeTasksCommand: () => ({
        tasks: [task({ tags: [{ key: 'plt.dev/version', value: 'from-task' }] })],
        failures: []
      }),
      DescribeServicesCommand: () => {
        describedServices = true
        return { services: [] }
      }
    }, () => buildEcs().getMachines('my-cluster', { 'plt.dev/version': 'from-task' }))
  )

  assert.strictEqual(machines.length, 1)
  assert.deepStrictEqual(machines[0].labels, { 'plt.dev/version': 'from-task' })
  assert.strictEqual(describedServices, false, 'service tags should not be fetched when the task has its own')
})
