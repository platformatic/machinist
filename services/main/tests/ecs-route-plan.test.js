'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const ecsSdk = require('@aws-sdk/client-ecs')
const elbSdk = require('@aws-sdk/client-elastic-load-balancing-v2')
const { Ecs } = require('../plugins/providers/ecs')

// applyRoutePlan is a full resync: delete every rule ICC owns for the app, then
// create the desired set. These tests pin the properties that shape was chosen
// for -- idempotence, order independence, and not touching anyone else's rules.

const LISTENER_ARN = 'arn:aws:elasticloadbalancing:::listener/app/plt-shared/lb1/l1'

function buildEcs () {
  return new Ecs({
    config: {
      PLT_ECS_REGION: 'us-east-1',
      PLT_ECS_CLUSTER: 'my-cluster',
      PLT_ECS_LISTENER_ARN: LISTENER_ARN,
      PLT_ECS_PRIORITY_RETRY_BASE_MS: 0
    },
    log: { debug () {}, info () {}, warn () {}, error () {} }
  })
}

const plan = {
  appName: 'myapp',
  hostname: 'myapp.example.com',
  routingMode: 'query',
  rules: [
    { match: { kind: 'queryParam', name: 'dpl', value: 'v1' }, backend: { serviceName: 'myapp-v1' }, versionId: 'v1' },
    { match: { kind: 'header', name: 'x-deployment-id', value: 'v1' }, backend: { serviceName: 'myapp-v1' }, versionId: 'v1' },
    { match: { kind: 'default' }, backend: { serviceName: 'myapp-v2' }, versionId: 'v2', issueCookie: false }
  ]
}

// One harness for both SDKs; `calls` records what the provider asked AWS to do.
function priorityInUse () {
  const err = new Error('The specified priority is in use')
  err.name = 'PriorityInUseException'
  return err
}

// `failCreateOrdinals` fails the Nth CreateRule call (1-based) with the error a
// losing priority race produces. Failing a later create is what leaves rules
// behind for the cleanup path to remove.
function withAws ({ services = {}, existingRules = [], health = 'healthy', failCreateOrdinals = [] }, fn) {
  let createCount = 0
  const calls = []
  const originalEcs = ecsSdk.ECSClient.prototype.send
  const originalElb = elbSdk.ElasticLoadBalancingV2Client.prototype.send

  ecsSdk.ECSClient.prototype.send = async function (command) {
    const name = command.constructor.name
    if (name === 'DescribeServicesCommand') {
      const serviceName = command.input.services[0]
      const tg = services[serviceName]
      if (!tg) return { services: [], failures: [{ reason: 'MISSING' }] }
      return { services: [{ serviceName, loadBalancers: tg === 'none' ? [] : [{ targetGroupArn: tg }] }] }
    }
    throw new Error(`unexpected ECS command: ${name}`)
  }

  elbSdk.ElasticLoadBalancingV2Client.prototype.send = async function (command) {
    const name = command.constructor.name
    calls.push({ name, input: command.input })
    switch (name) {
      case 'DescribeRulesCommand':
        // The real API returns NO tags here: a Rule is only
        // { RuleArn, Priority, Conditions, Actions, IsDefault, Transforms }.
        // Stripping them is what makes this stub faithful.
        return { Rules: existingRules.map(({ Tags, ...rule }) => rule) }
      case 'DescribeTagsCommand':
        return {
          TagDescriptions: command.input.ResourceArns.map(arn => ({
            ResourceArn: arn,
            Tags: (existingRules.find(r => r.RuleArn === arn) || {}).Tags || []
          }))
        }
      case 'DescribeTargetHealthCommand': {
        const state = typeof health === 'string'
          ? health
          : (health[command.input.TargetGroupArn] || 'healthy')
        return { TargetHealthDescriptions: [{ TargetHealth: { State: state } }] }
      }
      case 'DeleteRuleCommand':
        return {}
      case 'CreateRuleCommand':
        createCount++
        if (failCreateOrdinals.includes(createCount)) throw priorityInUse()
        return { Rules: [{ RuleArn: `arn:rule/${command.input.Priority}` }] }
      default:
        throw new Error(`unexpected ELB command: ${name}`)
    }
  }

  return Promise.resolve(fn(calls)).finally(() => {
    ecsSdk.ECSClient.prototype.send = originalEcs
    elbSdk.ElasticLoadBalancingV2Client.prototype.send = originalElb
  })
}

const SERVICES = { 'myapp-v1': 'arn:tg/v1', 'myapp-v2': 'arn:tg/v2' }

function managedRule (arn, app = 'myapp') {
  return { RuleArn: arn, Tags: [{ Key: 'plt.dev/managed-by', Value: 'icc' }, { Key: 'plt.dev/application', Value: app }] }
}

function bootstrapRule (arn, versionId, priority = '2') {
  return {
    ...managedRule(arn),
    Priority: priority,
    Conditions: [{
      Field: 'http-header',
      HttpHeaderConfig: { HttpHeaderName: 'x-platformatic-bootstrap', Values: ['token'] }
    }],
    Actions: [{ Type: 'forward', TargetGroupArn: `arn:tg/${versionId}` }],
    Tags: [
      ...managedRule(arn).Tags,
      { Key: 'plt.dev/version', Value: versionId },
      { Key: 'plt.dev/purpose', Value: 'bootstrap' }
    ]
  }
}

test('applies the plan by creating one rule per plan rule', async () => {
  const result = await withAws({ services: SERVICES }, calls =>
    buildEcs().applyRoutePlan('my-cluster', plan).then(r => ({ r, calls }))
  ).then(({ r, calls }) => {
    const created = calls.filter(c => c.name === 'CreateRuleCommand')
    assert.strictEqual(created.length, 3)
    assert.strictEqual(created[0].input.ListenerArn, LISTENER_ARN)
    return r
  })

  assert.strictEqual(result.created, 3)
  assert.strictEqual(result.deleted, 0)
})

test('deletes the app rules it already owns before creating', async () => {
  await withAws({
    services: SERVICES,
    existingRules: [managedRule('arn:rule/old-1'), managedRule('arn:rule/old-2')]
  }, async calls => {
    await buildEcs().applyRoutePlan('my-cluster', plan)

    const deleted = calls.filter(c => c.name === 'DeleteRuleCommand').map(c => c.input.RuleArn)
    assert.deepStrictEqual(deleted, ['arn:rule/old-1', 'arn:rule/old-2'])

    // Every delete must precede every create, or a create could collide with an
    // old rule still holding the priority.
    const firstCreate = calls.findIndex(c => c.name === 'CreateRuleCommand')
    const lastDelete = calls.map(c => c.name).lastIndexOf('DeleteRuleCommand')
    assert.ok(lastDelete < firstCreate)
  })
})

test('preserves a bootstrap rule until its version appears in the route plan', async () => {
  await withAws({
    services: SERVICES,
    existingRules: [bootstrapRule('arn:rule/bootstrap-v3', 'v3')]
  }, async calls => {
    await buildEcs().applyRoutePlan('my-cluster', plan)

    const deleted = calls.filter(call => call.name === 'DeleteRuleCommand')
    assert.strictEqual(deleted.length, 0, 'an old-plan reconcile must not break a pending CreateService')
    assert.deepStrictEqual(
      calls.filter(call => call.name === 'CreateRuleCommand').map(call => call.input.Priority),
      [3, 4, 5],
      'the preserved bootstrap priority remains occupied'
    )
  })
})

test('replaces a bootstrap rule when its version is in the route plan', async () => {
  await withAws({
    services: SERVICES,
    existingRules: [bootstrapRule('arn:rule/bootstrap-v1', 'v1')]
  }, async calls => {
    await buildEcs().applyRoutePlan('my-cluster', plan)

    assert.deepStrictEqual(
      calls.filter(call => call.name === 'DeleteRuleCommand').map(call => call.input.RuleArn),
      ['arn:rule/bootstrap-v1']
    )
  })
})

test('does not report a bootstrap association as a live HTTP route', async () => {
  await withAws({
    existingRules: [bootstrapRule('arn:rule/bootstrap-v3', 'v3')]
  }, async () => {
    assert.strictEqual(await buildEcs().getHTTPRoute('my-cluster', 'myapp'), null)
  })
})

test('route deletion removes bootstrap rules too', async () => {
  await withAws({
    existingRules: [bootstrapRule('arn:rule/bootstrap-v3', 'v3')]
  }, async calls => {
    const result = await buildEcs().deleteHTTPRoute('my-cluster', 'myapp')
    assert.strictEqual(result.deleted, 1)
    assert.deepStrictEqual(
      calls.filter(call => call.name === 'DeleteRuleCommand').map(call => call.input.RuleArn),
      ['arn:rule/bootstrap-v3']
    )
  })
})

test('never deletes rules belonging to another application or to the customer', async () => {
  await withAws({
    services: SERVICES,
    existingRules: [
      managedRule('arn:rule/mine'),
      managedRule('arn:rule/other-app', 'other'),
      { RuleArn: 'arn:rule/customer', Tags: [{ Key: 'team', Value: 'platform' }] },
      { RuleArn: 'arn:rule/untagged' }
    ]
  }, async calls => {
    await buildEcs().applyRoutePlan('my-cluster', plan)
    const deleted = calls.filter(c => c.name === 'DeleteRuleCommand').map(c => c.input.RuleArn)
    assert.deepStrictEqual(deleted, ['arn:rule/mine'])
  })
})

test('applying the same plan twice converges to the same rules', async () => {
  const priorities = []
  for (let i = 0; i < 2; i++) {
    await withAws({ services: SERVICES }, async calls => {
      await buildEcs().applyRoutePlan('my-cluster', plan)
      priorities.push(calls.filter(c => c.name === 'CreateRuleCommand').map(c => c.input.Priority))
    })
  }
  assert.deepStrictEqual(priorities[0], priorities[1])
})

test('a draining version with no healthy target loses only its own pinning rule', async () => {
  // v1 is unhealthy, v2 (the active version) is fine.
  await withAws({ services: SERVICES, health: { 'arn:tg/v1': 'unhealthy' } }, async calls => {
    await buildEcs().applyRoutePlan('my-cluster', plan)
    const created = calls.filter(c => c.name === 'CreateRuleCommand')
    // Only the default rule remains; the two v1 rules are dropped. Requests
    // carrying ?dpl=v1 fall through to the active version, which can serve.
    assert.strictEqual(created.length, 1)
    assert.deepStrictEqual(created[0].input.Conditions.map(c => c.Field), ['host-header'])
  })
})

test('an unhealthy ACTIVE version refuses the apply and touches nothing', async () => {
  // The resync deletes before it creates, so completing here would replace a
  // working route with one that answers 503 and then report success.
  await withAws({
    services: SERVICES,
    health: { 'arn:tg/v2': 'unhealthy' },
    existingRules: [managedRule('arn:rule/live')]
  }, async calls => {
    await assert.rejects(
      () => buildEcs().applyRoutePlan('my-cluster', plan),
      err => err.code === 'MCHNST_ACTIVE_TARGET_GROUP_UNHEALTHY' && /v2/.test(err.message)
    )
    assert.strictEqual(calls.filter(c => c.name === 'DeleteRuleCommand').length, 0, 'must not delete the live rules')
    assert.strictEqual(calls.filter(c => c.name === 'CreateRuleCommand').length, 0)
  })
})

test('a service with no target group is reported rather than skipped', async () => {
  await withAws({ services: { 'myapp-v1': 'none', 'myapp-v2': 'arn:tg/v2' } }, async () => {
    await assert.rejects(
      () => buildEcs().applyRoutePlan('my-cluster', plan),
      err => err.code === 'MCHNST_TARGET_GROUP_NOT_FOUND' && /myapp-v1/.test(err.message)
    )
  })
})

test('applying a plan with no listener configured is refused', async () => {
  const ecs = new Ecs({
    config: { PLT_ECS_REGION: 'us-east-1', PLT_ECS_CLUSTER: 'my-cluster' },
    log: { debug () {}, info () {}, warn () {}, error () {} }
  })
  await assert.rejects(
    () => ecs.applyRoutePlan('my-cluster', plan),
    err => err.code === 'MCHNST_LISTENER_NOT_CONFIGURED'
  )
})

// ── Route level ──

async function buildAppWithRoutePlanRoute (provider, prefix) {
  const Fastify = require('fastify')
  const sharedSchemas = require('../plugins/shared-schemas')
  const app = Fastify({ logger: false })
  await app.register(sharedSchemas)
  app.decorate('provider', provider)
  await app.register(require('../routes/routeplans'), { prefix })
  await app.ready()
  return app
}

test('PUT /ecs/gateway/routeplans/:namespace applies the plan', async (t) => {
  await withAws({ services: SERVICES }, async () => {
    const app = await buildAppWithRoutePlanRoute(buildEcs(), '/ecs')
    t.after(() => app.close())

    const res = await app.inject({
      method: 'PUT',
      url: '/ecs/gateway/routeplans/my-cluster',
      headers: { 'content-type': 'application/json' },
      body: plan
    })

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.json().created, 3)
  })
})

test('PUT /k8s/gateway/routeplans/:namespace returns 501', async (t) => {
  const { K8s } = require('../plugins/providers/k8s')
  const k8s = Object.create(K8s.prototype)
  const app = await buildAppWithRoutePlanRoute(k8s, '/k8s')
  t.after(() => app.close())

  const res = await app.inject({
    method: 'PUT',
    url: '/k8s/gateway/routeplans/my-cluster',
    headers: { 'content-type': 'application/json' },
    body: plan
  })

  assert.strictEqual(res.statusCode, 501)
  assert.strictEqual(res.json().code, 'MCHNST_NOT_IMPLEMENTED_BY_PROVIDER')
})

test('priorities avoid rules the customer owns on the same listener', async () => {
  // A customer rule sitting at the front must not be overwritten: ALB rejects a
  // duplicate priority, so the resync would fail outright.
  await withAws({
    services: SERVICES,
    existingRules: [
      { RuleArn: 'arn:rule/customer-a', Priority: '2', Tags: [{ Key: 'team', Value: 'platform' }] },
      { RuleArn: 'arn:rule/customer-b', Priority: '3', Tags: [{ Key: 'team', Value: 'platform' }] }
    ]
  }, async calls => {
    await buildEcs().applyRoutePlan('my-cluster', plan)
    const priorities = calls.filter(c => c.name === 'CreateRuleCommand').map(c => c.input.Priority)
    assert.deepStrictEqual(priorities, [4, 5, 6])
    // And the customer's rules are still there.
    assert.strictEqual(calls.filter(c => c.name === 'DeleteRuleCommand').length, 0)
  })
})

test('an application reuses the priorities its own previous rules held', async () => {
  // Our rules are freed by the deletes in the same resync, so a stable app keeps
  // stable priorities rather than drifting upward on every reconcile.
  await withAws({
    services: SERVICES,
    existingRules: [
      { ...managedRule('arn:rule/mine-1'), Priority: '2' },
      { ...managedRule('arn:rule/mine-2'), Priority: '3' },
      { ...managedRule('arn:rule/mine-3'), Priority: '4' }
    ]
  }, async calls => {
    await buildEcs().applyRoutePlan('my-cluster', plan)
    const priorities = calls.filter(c => c.name === 'CreateRuleCommand').map(c => c.input.Priority)
    assert.deepStrictEqual(priorities, [2, 3, 4])
  })
})

test('a lost priority race is retried, and the partial attempt is cleaned up', async () => {
  // Reading occupancy and creating are not atomic: a concurrent reconcile can
  // take the block between the two. The loser has already deleted its own
  // rules, so failing here would leave the application with no routing.
  // Fail the second create: the first has already landed, so there is a partial
  // attempt to undo.
  await withAws({ services: SERVICES, failCreateOrdinals: [2] }, async calls => {
    const result = await buildEcs().applyRoutePlan('my-cluster', plan)
    assert.strictEqual(result.created, 3, 'the retry should complete the plan')

    // The rule created before the failure must not be left behind.
    const deleted = calls.filter(c => c.name === 'DeleteRuleCommand').map(c => c.input.RuleArn)
    assert.ok(deleted.length >= 1, 'the losing attempt should clean up after itself')
    assert.ok(deleted.includes('arn:rule/2'), 'the rule created before the failure must be removed')

    // Occupancy is re-read rather than reused.
    const describes = calls.filter(c => c.name === 'DescribeRulesCommand')
    assert.ok(describes.length >= 2, 'the retry must re-read the listener')
  })
})

test('a priority race that never clears gives up rather than looping', async () => {
  await withAws({ services: SERVICES, failCreateOrdinals: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, async () => {
    await assert.rejects(
      () => buildEcs().applyRoutePlan('my-cluster', plan),
      err => err.name === 'PriorityInUseException'
    )
  })
})

test('an error that is not a priority conflict is not retried', async () => {
  const original = elbSdk.ElasticLoadBalancingV2Client.prototype.send
  await withAws({ services: SERVICES }, async calls => {
    const ecs = buildEcs()
    const patched = elbSdk.ElasticLoadBalancingV2Client.prototype.send
    elbSdk.ElasticLoadBalancingV2Client.prototype.send = async function (command) {
      if (command.constructor.name === 'CreateRuleCommand') throw new Error('AccessDenied')
      return patched.call(this, command)
    }
    await assert.rejects(() => ecs.applyRoutePlan('my-cluster', plan), /AccessDenied/)
    const describes = calls.filter(c => c.name === 'DescribeRulesCommand')
    assert.strictEqual(describes.length, 1, 'must not retry a non-conflict failure')
  })
  elbSdk.ElasticLoadBalancingV2Client.prototype.send = original
})

test('a competing reconcile that keeps taking blocks is chased, then completed', async () => {
  // The realistic race: the competitor does not fail once, it keeps claiming the
  // block this attempt just allocated. Each retry must therefore see the new
  // occupancy and move past it rather than re-picking the same numbers.
  const competitorRules = []
  let attempt = 0

  const originalEcs = ecsSdk.ECSClient.prototype.send
  const originalElb = elbSdk.ElasticLoadBalancingV2Client.prototype.send
  const priorities = []

  ecsSdk.ECSClient.prototype.send = async function (command) {
    const serviceName = command.input.services[0]
    return { services: [{ serviceName, loadBalancers: [{ targetGroupArn: SERVICES[serviceName] }] }] }
  }

  elbSdk.ElasticLoadBalancingV2Client.prototype.send = async function (command) {
    const name = command.constructor.name
    switch (name) {
      case 'DescribeRulesCommand':
        return { Rules: competitorRules.map(p => ({ RuleArn: `arn:rule/other-${p}`, Priority: String(p), IsDefault: false })) }
      case 'DescribeTagsCommand':
        // All competitor rules; none are ours.
        return { TagDescriptions: command.input.ResourceArns.map(arn => ({ ResourceArn: arn, Tags: [{ Key: 'team', Value: 'other' }] })) }
      case 'DescribeTargetHealthCommand':
        return { TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }] }
      case 'DeleteRuleCommand':
        return {}
      case 'CreateRuleCommand': {
        const p = command.input.Priority
        priorities.push(p)
        // On the first two attempts the competitor grabs the base we chose.
        if (priorities.filter(x => x === p).length === 1 && attempt < 2 && !competitorRules.includes(p)) {
          attempt++
          competitorRules.push(p)
          const err = new Error('The specified priority is in use')
          err.name = 'PriorityInUseException'
          throw err
        }
        return { Rules: [{ RuleArn: `arn:rule/${p}` }] }
      }
      default:
        throw new Error(`unexpected ELB command: ${name}`)
    }
  }

  try {
    const result = await buildEcs().applyRoutePlan('my-cluster', plan)
    assert.strictEqual(result.created, 3, 'it should finish once it finds a clear block')
    // It moved forward rather than re-picking the same base each time.
    const bases = [...new Set(priorities)]
    assert.ok(bases.length > 3, 'each attempt must allocate around the new occupancy')
  } finally {
    ecsSdk.ECSClient.prototype.send = originalEcs
    elbSdk.ElasticLoadBalancingV2Client.prototype.send = originalElb
  }
})
