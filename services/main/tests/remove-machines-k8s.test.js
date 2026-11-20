'use strict'

// The machines to remove first on a scale down, against a real cluster: the ReplicaSet controller removes the pods
// which were named, and not those it would have chosen.

const { join } = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { applyYaml, removeYaml, bootstrap, getPods } = require('./helper')

const fixture = join(__dirname, 'fixtures', 'remove-machines', 'deployment.yaml')
const labels = { 'app.kubernetes.io/instance': 'remove-machines-fixture' }
const url = '/k8s/controllers/default/remove-machines-deployment'
const query = { kind: 'Deployment', apiVersion: 'apps/v1' }

// The pods of the deployment which are not on their way out, once there are as many as expected and all run
async function runningPods (count) {
  for (let i = 0; i < 120; i++) {
    const { items } = await getPods(labels)
    const pods = items.filter(pod => !pod.metadata.deletionTimestamp)

    if (pods.length === count && pods.every(pod => pod.status?.phase === 'Running')) {
      return pods
    }

    await sleep(500)
  }

  throw new Error(`The deployment never had ${count} running pods`)
}

async function scale (app, body) {
  const result = await app.inject({ method: 'POST', url, query, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.strictEqual(result.statusCode, 200, result.body)
  return result.json()
}

test('the pods named are the ones removed when a deployment is scaled down', async t => {
  await removeYaml(fixture).catch(() => {})
  await runningPods(0).catch(() => {})
  await applyYaml(fixture)
  t.after(() => removeYaml(fixture).catch(() => {}))

  const { app } = await bootstrap(t)
  const names = pods => pods.map(pod => pod.metadata.name).sort()

  // Twice, from four pods to two: by chance the two named would be the ones removed once in six
  for (let round = 0; round < 2; round++) {
    await scale(app, { replicas: 4 })
    const before = names(await runningPods(4))
    const chosen = [before[round], before[round + 2]]

    const scaled = await scale(app, { replicas: 2, remove: chosen })
    assert.strictEqual(scaled.replicas, 2)
    assert.strictEqual(scaled.removal.steered, true)
    assert.deepStrictEqual(scaled.removal.machines.sort(), chosen)

    const after = names(await runningPods(2))
    assert.deepStrictEqual(after, before.filter(name => !chosen.includes(name)))
  }

  // One pod named and kept, since the count does not go down: it is not preferred at the next scale down
  const [first, second] = names(await runningPods(2))
  const kept = await scale(app, { replicas: 2, remove: [first] })
  assert.deepStrictEqual(kept.removal, { steered: false, machines: [], reason: 'not-a-scale-down' })

  // Two pods named, and the count goes down by one: the one which stays keeps its mark
  await scale(app, { replicas: 3 })
  const three = names(await runningPods(3))
  const added = three.find(name => name !== first && name !== second)
  await scale(app, { replicas: 2, remove: [first, added] })
  const [survivor] = (await runningPods(2)).filter(pod => pod.metadata.annotations?.['machinist.platformatic.dev/remove-first'] === 'true')
  assert.ok([first, added].includes(survivor?.metadata.name))

  // It loses the mark when another pod is named, which is then the one removed
  await scale(app, { replicas: 3 })
  await runningPods(3)
  const marked = await scale(app, { replicas: 2, remove: [second] })
  assert.deepStrictEqual(marked.removal, { steered: true, machines: [second] })
  assert.ok(!names(await runningPods(2)).includes(second))

  for (const pod of await runningPods(2)) {
    assert.strictEqual(pod.metadata.annotations?.['machinist.platformatic.dev/remove-first'], undefined)
    assert.strictEqual(pod.metadata.annotations?.['controller.kubernetes.io/pod-deletion-cost'], undefined)
  }
})
