'use strict'

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout: sleep } = require('node:timers/promises')
const { request } = require('undici')

// The ECS provider's routing half -- machinist's ALB translator and resync --
// against a real ELBv2 implementation with a real data plane.
//
// Run with `pnpm test:e2e:ecs`, which needs the emulator stack from
// docker-compose.yml at the repo root. This file FAILS rather than skips when
// the stack is absent: it lives outside the `tests/*.test.js` unit glob
// precisely so that it can be strict, and a suite that quietly passes without
// executing anything is worse than one that does not run.
//
// It exists because the provider previously talked to AWS only through
// hand-written stubs, so every assumption about the ELBv2 API was really an
// assumption about the stub. One was wrong -- DescribeRules was stubbed as if a
// Rule carried its Tags -- and the tests passed for as long as the stub agreed
// with the mistake. Here the API answers instead, and the rules the provider
// creates are then exercised with real HTTP through the load balancer.
//
// Deliberately NOT covered, so the name does not oversell it:
//
// - ECS tasks do not serve the traffic. The backends are compose containers
//   registered as IP targets; the ECS services exist to supply the target group
//   metadata the provider reads, which is all this layer uses them for.
// - The machinist HTTP surface (PUT /gateway/routeplans/:namespace). The
//   provider is driven directly, so routes/routeplans.js is unit-tested only.
// - ICC -> machinist communication, and everything ICC-side above it.
// - Task discovery through the Resource Groups Tagging API, and task-to-target
//   -group registration, which belong to the ECS deploy path rather than to
//   routing.
//
// And it is still an emulator: floci requires every key/value pair in a
// query-string condition to match where AWS is satisfied by one. Plan E9 runs
// the same assertions against a real ALB, and only that settles the semantics
// and the quotas.

const ENDPOINT = process.env.PLT_TEST_AWS_ENDPOINT || 'http://127.0.0.1:4566'
const REGION = 'us-east-1'
const CLUSTER = 'plt-e2e'
const HOSTNAME = 'myapp.example.com'
const LISTENER_PORT = 8081
// Fixed by docker-compose.yml: an IP target group needs an address.
const BACKENDS = { v1: '172.30.0.11', v2: '172.30.0.12' }
// The tasks of a workload the provider creates itself never run in an emulator,
// so this address stands in for them. See the applyWorkload test below.
const WORKLOAD_BACKEND = '172.30.0.13'

async function requireEmulator () {
  try {
    const res = await request(`${ENDPOINT}/_localstack/health`, { headersTimeout: 3000 })
    res.body.resume()
    if (res.statusCode === 200) return
  } catch (err) {
    throw new Error(
      `no AWS emulator at ${ENDPOINT} (${err.code || err.message}). ` +
      'Start it with `docker compose up -d --wait` from the machinist repo root, ' +
      'or run the whole suite with `pnpm test`.'
    )
  }
  throw new Error(`the AWS emulator at ${ENDPOINT} is not healthy`)
}

describe('ecs provider routing against an emulated alb', () => {
  let elb
  let ecs
  let elbClient
  let Ecs
  let fixture
  const savedEnv = { ...process.env }

  before(async () => {
    await requireEmulator()

    // Set before anything constructs a client: the SDK resolves the endpoint and
    // credentials once, at construction. AWS_PROFILE is cleared so a developer's
    // real profile cannot be picked up and pointed at a test.
    process.env.AWS_ENDPOINT_URL = ENDPOINT
    process.env.AWS_ACCESS_KEY_ID = 'test'
    process.env.AWS_SECRET_ACCESS_KEY = 'test'
    process.env.AWS_REGION = REGION
    process.env.AWS_EC2_METADATA_DISABLED = 'true'
    delete process.env.AWS_PROFILE

    elb = require('@aws-sdk/client-elastic-load-balancing-v2')
    ecs = require('@aws-sdk/client-ecs')
    Ecs = require('../../plugins/providers/ecs').Ecs
    elbClient = new elb.ElasticLoadBalancingV2Client({ region: REGION })

    fixture = await buildFixture()
  })

  after(() => {
    process.env = savedEnv
  })

  const ignoreMissing = promise => promise.catch(() => {})

  // The emulator outlives a single run, so the fixture is torn down and rebuilt
  // rather than assumed absent. Otherwise a second run collides on every name,
  // and on the listener port.
  async function reset (ecsClient) {
    const { LoadBalancers } = await elbClient.send(new elb.DescribeLoadBalancersCommand({}))
    for (const lb of LoadBalancers || []) {
      if (lb.LoadBalancerName !== 'plt-e2e-lb') continue
      const { Listeners } = await elbClient.send(new elb.DescribeListenersCommand({
        LoadBalancerArn: lb.LoadBalancerArn
      }))
      for (const listener of Listeners || []) {
        await ignoreMissing(elbClient.send(new elb.DeleteListenerCommand({ ListenerArn: listener.ListenerArn })))
      }
      await ignoreMissing(elbClient.send(new elb.DeleteLoadBalancerCommand({ LoadBalancerArn: lb.LoadBalancerArn })))
    }

    const { TargetGroups } = await elbClient.send(new elb.DescribeTargetGroupsCommand({}))
    for (const tg of TargetGroups || []) {
      if (!tg.TargetGroupName?.startsWith('plt-e2e-')) continue
      await ignoreMissing(elbClient.send(new elb.DeleteTargetGroupCommand({ TargetGroupArn: tg.TargetGroupArn })))
    }

    for (const version of ['v1', 'v2', 'v3']) {
      await ignoreMissing(ecsClient.send(new ecs.DeleteServiceCommand({
        cluster: CLUSTER, service: `myapp-${version}`, force: true
      })))
    }
  }

  // An ALB with a listener, one target group per version, and an ECS service per
  // version attached to its target group -- which is where the provider reads
  // target groups from, since attaching one later would restart the tasks.
  //
  // v1 and v2 have a live backend behind them; v3 deliberately has none, so the
  // health preflight has something to refuse.
  async function buildFixture () {
    const ecsClient = new ecs.ECSClient({ region: REGION })
    await ignoreMissing(ecsClient.send(new ecs.CreateClusterCommand({ clusterName: CLUSTER })))
    await reset(ecsClient)

    const { Vpcs } = await describeVpcs()
    const vpcId = Vpcs[0]

    const subnets = await subnetIds()
    const { LoadBalancers } = await elbClient.send(new elb.CreateLoadBalancerCommand({
      Name: 'plt-e2e-lb', Subnets: subnets
    }))
    const loadBalancerArn = LoadBalancers[0].LoadBalancerArn

    const targetGroups = {}
    for (const version of ['v1', 'v2', 'v3']) {
      const { TargetGroups } = await elbClient.send(new elb.CreateTargetGroupCommand({
        Name: `plt-e2e-${version}`,
        Protocol: 'HTTP',
        Port: 8080,
        VpcId: vpcId,
        TargetType: 'ip',
        // The emulator runs real health checks, so the defaults would take
        // 30s x 5 before a target is usable. These are the AWS minimums.
        HealthCheckIntervalSeconds: 5,
        HealthyThresholdCount: 2,
        HealthCheckPath: '/'
      }))
      targetGroups[version] = TargetGroups[0].TargetGroupArn

      if (BACKENDS[version]) {
        await elbClient.send(new elb.RegisterTargetsCommand({
          TargetGroupArn: targetGroups[version],
          Targets: [{ Id: BACKENDS[version], Port: 8080 }]
        }))
      }
    }

    const { Listeners } = await elbClient.send(new elb.CreateListenerCommand({
      LoadBalancerArn: loadBalancerArn,
      Protocol: 'HTTP',
      Port: LISTENER_PORT,
      DefaultActions: [{ Type: 'forward', TargetGroupArn: targetGroups.v2 }]
    }))

    const { taskDefinition } = await ecsClient.send(new ecs.RegisterTaskDefinitionCommand({
      family: 'plt-e2e', containerDefinitions: [{ name: 'app', image: 'busybox', memory: 128 }]
    }))
    for (const version of ['v1', 'v2', 'v3']) {
      await ecsClient.send(new ecs.CreateServiceCommand({
        cluster: CLUSTER,
        serviceName: `myapp-${version}`,
        taskDefinition: taskDefinition.taskDefinitionArn,
        desiredCount: 1,
        loadBalancers: [{
          targetGroupArn: targetGroups[version], containerName: 'app', containerPort: 8080
        }]
      }))
    }

    // The preflight refuses to route to a target group with nothing healthy in
    // it, so the backends have to pass their checks before any test runs.
    for (const version of Object.keys(BACKENDS)) {
      await waitForHealthy(targetGroups[version])
    }

    // applyWorkload needs somewhere to put its tasks. The security group is
    // required by the emulator where real ECS treats it as optional.
    const sgXml = await ec2Query('CreateSecurityGroup', {
      GroupName: `plt-e2e-sg-${process.pid}`, GroupDescription: 'e2e', VpcId: vpcId
    })
    const securityGroupId = sgXml.match(/<groupId>([^<]+)<\/groupId>/)[1]

    return {
      listenerArn: Listeners[0].ListenerArn,
      targetGroups,
      subnets,
      securityGroupId,
      vpcId
    }
  }

  async function waitForHealthy (targetGroupArn) {
    for (let i = 0; i < 60; i++) {
      const { TargetHealthDescriptions } = await elbClient.send(new elb.DescribeTargetHealthCommand({
        TargetGroupArn: targetGroupArn
      }))
      if ((TargetHealthDescriptions || []).some(t => t.TargetHealth?.State === 'healthy')) return
      await sleep(500)
    }
    assert.fail(`target group ${targetGroupArn} never became healthy`)
  }

  // The EC2 query API, read directly. The emulator routes by the service in the
  // SigV4 credential scope and does not verify the signature, which is enough to
  // read a fixture without adding the whole EC2 SDK as a test dependency.
  async function ec2Query (action, params = {}) {
    const body = new URLSearchParams({ Action: action, Version: '2016-11-15', ...params })
    const res = await request(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `AWS4-HMAC-SHA256 Credential=test/20260101/${REGION}/ec2/aws4_request`
      },
      body: body.toString()
    })
    return res.body.text()
  }

  async function describeVpcs () {
    const xml = await ec2Query('DescribeVpcs')
    return { Vpcs: [...xml.matchAll(/<vpcId>([^<]+)<\/vpcId>/g)].map(m => m[1]) }
  }

  async function subnetIds () {
    const xml = await ec2Query('DescribeSubnets')
    return [...xml.matchAll(/<subnetId>([^<]+)<\/subnetId>/g)].map(m => m[1]).slice(0, 2)
  }

  function buildEcs () {
    return new Ecs({
      config: {
        PLT_ECS_REGION: REGION,
        PLT_ECS_CLUSTER: CLUSTER,
        PLT_ECS_LISTENER_ARN: fixture.listenerArn,
        PLT_ECS_PRIORITY_RETRY_BASE_MS: 0
      },
      log: { debug () {}, info () {}, warn () {}, error () {} }
    })
  }

  function plan (rules) {
    return { appName: 'myapp', hostname: HOSTNAME, routingMode: 'query', rules }
  }

  const queryPin = version => ({
    match: { kind: 'queryParam', name: 'dpl', value: version },
    backend: { serviceName: `myapp-${version}` },
    versionId: version
  })
  const headerPin = version => ({
    match: { kind: 'header', name: 'x-deployment-id', value: version },
    backend: { serviceName: `myapp-${version}` },
    versionId: version
  })
  const defaultTo = version => ({
    match: { kind: 'default' },
    backend: { serviceName: `myapp-${version}` },
    versionId: version
  })

  const fullPlan = () => plan([queryPin('v1'), headerPin('v1'), defaultTo('v2')])

  // A request through the load balancer itself. Which backend answers is the
  // only thing that finally proves the rules are right.
  async function through (path, headers = {}) {
    const res = await request(`http://127.0.0.1:${LISTENER_PORT}${path}`, {
      headers: { host: HOSTNAME, ...headers }
    })
    return (await res.body.text()).trim()
  }

  async function liveRules () {
    const { Rules } = await elbClient.send(new elb.DescribeRulesCommand({
      ListenerArn: fixture.listenerArn
    }))
    return Rules.filter(r => !r.IsDefault).sort((a, b) => Number(a.Priority) - Number(b.Priority))
  }

  async function tagsOf (ruleArn) {
    const { TagDescriptions } = await elbClient.send(new elb.DescribeTagsCommand({
      ResourceArns: [ruleArn]
    }))
    return Object.fromEntries((TagDescriptions[0].Tags || []).map(t => [t.Key, t.Value]))
  }

  async function clearListener () {
    for (const rule of await liveRules()) {
      await elbClient.send(new elb.DeleteRuleCommand({ RuleArn: rule.RuleArn }))
    }
  }

  test('the plan routes real traffic: a pin reaches its own version', async (t) => {
    t.after(clearListener)
    await buildEcs().applyRoutePlan(CLUSTER, fullPlan())

    assert.strictEqual(await through('/'), 'v2', 'unpinned traffic reaches the active version')
    assert.strictEqual(await through('/?dpl=v1'), 'v1', 'the pin reaches the draining version')
    assert.strictEqual(await through('/?dpl=v1&utm_source=x'), 'v1', 'alongside other parameters')
    assert.strictEqual(await through('/?utm_source=x&dpl=v1'), 'v1', 'in any position')
    assert.strictEqual(await through('/?dpl=v2'), 'v2', 'a pin with no rule falls through, it does not fail')
    assert.strictEqual(await through('/', { 'x-deployment-id': 'v1' }), 'v1', 'the preview header too')
  })

  test('the pin is matched whole, and case insensitively', async (t) => {
    t.after(clearListener)
    await buildEcs().applyRoutePlan(CLUSTER, fullPlan())

    // Whole value, not a prefix and not a substring, or one version label would
    // capture traffic pinned to another.
    assert.strictEqual(await through('/?dpl=v1x'), 'v2', 'not a prefix match')
    assert.strictEqual(await through('/?dpl=v'), 'v2', 'not a partial match')
    assert.strictEqual(await through('/?dplx=v1'), 'v2', 'the key is matched whole too')

    // An empty or valueless parameter is not a pin, so it must reach the active
    // version rather than matching a version whose label happens to be empty.
    assert.strictEqual(await through('/?dpl='), 'v2', 'an empty value is not a pin')
    assert.strictEqual(await through('/?dpl'), 'v2', 'nor is a valueless key')

    // ALB compares case insensitively, where the Gateway API is exact. Asserted
    // because it is a real behavioural difference between the two providers,
    // not an emulator artefact: two version labels differing only in case are
    // indistinguishable here. See F6 in ecs-skew-protection-plan.md.
    assert.strictEqual(await through('/?dpl=V1'), 'v1', 'the value is case insensitive')
    assert.strictEqual(await through('/?dpl=v1&dpl=v1'), 'v1', 'a repeated identical pin still matches')

    // Not asserted: a query repeating the key with DIFFERENT values
    // (`?dpl=v1&dpl=v2`). The AWS reference reads as "found in the query
    // string", which would match either; this emulator keeps the last
    // occurrence only. ICC never emits such a URL, but a client could, so the
    // real behaviour is an E9 question rather than something to pin here.
  })

  test('the plan lands on the listener as real rules, in plan order', async (t) => {
    t.after(clearListener)
    await buildEcs().applyRoutePlan(CLUSTER, fullPlan())

    const rules = await liveRules()
    assert.strictEqual(rules.length, 3)

    // Compared field by field rather than as whole objects: a RuleCondition also
    // carries the deprecated flat `Values` member, which ICC neither sets nor
    // reads and which implementations fill in differently.
    const fieldsOf = rule => rule.Conditions.map(c => c.Field)
    assert.deepStrictEqual(fieldsOf(rules[0]), ['host-header', 'query-string'])
    assert.deepStrictEqual(rules[0].Conditions[0].HostHeaderConfig, { Values: [HOSTNAME] })
    assert.deepStrictEqual(rules[0].Conditions[1].QueryStringConfig, {
      Values: [{ Key: 'dpl', Value: 'v1' }]
    })

    assert.deepStrictEqual(fieldsOf(rules[1]), ['host-header', 'http-header'])
    assert.deepStrictEqual(rules[1].Conditions[1].HttpHeaderConfig, {
      HttpHeaderName: 'x-deployment-id', Values: ['v1']
    })

    // The default rule matches the host and nothing else.
    assert.deepStrictEqual(fieldsOf(rules[2]), ['host-header'])

    assert.deepStrictEqual(rules[0].Actions[0], {
      Type: 'forward', TargetGroupArn: fixture.targetGroups.v1
    })

    // Priorities come back as strings from the API, which is what the allocator
    // is handed on the next reconcile.
    assert.deepStrictEqual(rules.map(r => r.Priority), ['2', '3', '4'])
  })

  test('a rule created with tags is readable by tag, and only by DescribeTags', async (t) => {
    t.after(clearListener)
    await buildEcs().applyRoutePlan(CLUSTER, fullPlan())
    const [first] = await liveRules()

    // The mistake the stubs hid: a Rule has no Tags member at all, so ownership
    // cannot be resolved from DescribeRules however the query is written.
    assert.ok(!('Tags' in first), 'DescribeRules must not return tags')

    assert.deepStrictEqual(await tagsOf(first.RuleArn), {
      'plt.dev/managed-by': 'icc',
      'plt.dev/application': 'myapp',
      'plt.dev/version': 'v1'
    })
  })

  test('re-applying the same plan converges instead of accumulating rules', async (t) => {
    t.after(clearListener)
    const provider = buildEcs()
    await provider.applyRoutePlan(CLUSTER, fullPlan())
    const before = await liveRules()

    const result = await provider.applyRoutePlan(CLUSTER, fullPlan())
    const after = await liveRules()

    assert.strictEqual(result.deleted, 3, 'the resync removes its own previous rules')
    assert.strictEqual(after.length, 3)
    // The application keeps its priorities: its own rules are excluded from the
    // occupied set, so the block it just released is the one it takes again.
    assert.deepStrictEqual(after.map(r => r.Priority), before.map(r => r.Priority))
    assert.strictEqual(await through('/?dpl=v1'), 'v1', 'and it still routes')
  })

  test("a customer's own rule is left alone, and allocation routes around it", async (t) => {
    t.after(clearListener)
    const { Rules } = await elbClient.send(new elb.CreateRuleCommand({
      ListenerArn: fixture.listenerArn,
      Priority: 3,
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/legacy'] } }],
      Actions: [{ Type: 'forward', TargetGroupArn: fixture.targetGroups.v2 }],
      Tags: [{ Key: 'team', Value: 'platform' }]
    }))
    const customerArn = Rules[0].RuleArn

    await buildEcs().applyRoutePlan(CLUSTER, fullPlan())

    const rules = await liveRules()
    assert.ok(rules.some(r => r.RuleArn === customerArn), 'the customer rule must survive')

    // Priority 3 is taken and the run needs three consecutive slots, so the
    // block starts after it rather than at 2.
    const ours = rules.filter(r => r.RuleArn !== customerArn).map(r => Number(r.Priority))
    assert.deepStrictEqual(ours, [4, 5, 6])
  })

  test('an unhealthy active version refuses the apply, and traffic keeps flowing', async (t) => {
    t.after(clearListener)
    const provider = buildEcs()
    await provider.applyRoutePlan(CLUSTER, fullPlan())
    const before = await liveRules()

    await assert.rejects(
      () => provider.applyRoutePlan(CLUSTER, plan([queryPin('v1'), defaultTo('v3')])),
      err => err.code === 'MCHNST_ACTIVE_TARGET_GROUP_UNHEALTHY'
    )

    assert.deepStrictEqual(
      (await liveRules()).map(r => r.RuleArn).sort(),
      before.map(r => r.RuleArn).sort(),
      'a refused apply must not have deleted anything'
    )
    // The point of refusing: the previous routing is still serving.
    assert.strictEqual(await through('/'), 'v2')
    assert.strictEqual(await through('/?dpl=v1'), 'v1')
  })

  test('an unhealthy draining version loses only its own pinning rule', async (t) => {
    t.after(clearListener)
    await buildEcs().applyRoutePlan(CLUSTER, plan([queryPin('v3'), queryPin('v1'), defaultTo('v2')]))

    const rules = await liveRules()
    assert.strictEqual(rules.length, 2, 'v3 has no healthy target, so it gets no rule')
    const versions = []
    for (const rule of rules) versions.push((await tagsOf(rule.RuleArn))['plt.dev/version'])
    assert.deepStrictEqual(versions, ['v1', 'v2'])

    // Better than a rule pointing at an empty target group, which would answer
    // 503: the pin falls through to a version that can serve.
    assert.strictEqual(await through('/?dpl=v3'), 'v2')
  })

  test('the live routing reads back as the plan that produced it', async (t) => {
    t.after(clearListener)
    const provider = buildEcs()
    await provider.applyRoutePlan(CLUSTER, fullPlan())

    const live = await provider.getHTTPRoute(CLUSTER, 'myapp')
    assert.strictEqual(live.appName, 'myapp')
    assert.deepStrictEqual(live.rules, [
      { versionId: 'v1', match: { kind: 'queryParam' } },
      { versionId: 'v1', match: { kind: 'header' } },
      { versionId: 'v2', match: { kind: 'default' } }
    ])
  })

  test('deleting the route removes our rules and nothing else', async (t) => {
    t.after(clearListener)
    const provider = buildEcs()
    await provider.applyRoutePlan(CLUSTER, fullPlan())
    const { Rules } = await elbClient.send(new elb.CreateRuleCommand({
      ListenerArn: fixture.listenerArn,
      Priority: 900,
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/legacy'] } }],
      Actions: [{ Type: 'forward', TargetGroupArn: fixture.targetGroups.v2 }]
    }))

    await provider.deleteHTTPRoute(CLUSTER, 'myapp')

    assert.deepStrictEqual((await liveRules()).map(r => r.RuleArn), [Rules[0].RuleArn])
    assert.strictEqual(await provider.getHTTPRoute(CLUSTER, 'myapp'), null)
    // Pinning is gone, so a pinned request lands on the active version rather
    // than on a rule pointing at a version that may no longer exist.
    assert.strictEqual(await through('/?dpl=v1'), 'v2')
  })

  test('a duplicate priority raises the error the retry loop matches on', async (t) => {
    t.after(clearListener)
    // The retry exists for a concurrent reconcile taking the block between the
    // read and the create, and it keys off this exact name. The wire code is
    // `PriorityInUse`; only the SDK's mapping makes it the name below.
    const create = priority => elbClient.send(new elb.CreateRuleCommand({
      ListenerArn: fixture.listenerArn,
      Priority: priority,
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/taken'] } }],
      Actions: [{ Type: 'forward', TargetGroupArn: fixture.targetGroups.v2 }]
    }))

    await create(700)
    await assert.rejects(() => create(700), err => err.name === 'PriorityInUseException')
  })

  test('a workload the provider creates is routable without anyone attaching a target group', async (t) => {
    // The gap this closes: applyWorkload used to create a service with no
    // loadBalancers, and applyRoutePlan reads the target group off exactly that
    // field. Deploy then route, and every apply failed with "the service is not
    // attached to a target group".
    const provider = new Ecs({
      config: {
        PLT_ECS_REGION: REGION,
        PLT_ECS_CLUSTER: CLUSTER,
        PLT_ECS_LISTENER_ARN: fixture.listenerArn,
        PLT_ECS_PRIORITY_RETRY_BASE_MS: 0,
        PLT_ECS_SUBNETS: fixture.subnets.join(','),
        PLT_ECS_SECURITY_GROUPS: fixture.securityGroupId
      },
      log: { debug () {}, info () {}, warn () {}, error () {} }
    })

    const ecsClient = new ecs.ECSClient({ region: REGION })
    t.after(async () => {
      await clearListener()
      await ignoreMissing(ecsClient.send(new ecs.DeleteServiceCommand({
        cluster: CLUSTER, service: 'myapp-v4', force: true
      })))
    })

    const created = await provider.applyWorkload(CLUSTER, {
      name: 'myapp-v4',
      appName: 'myapp',
      image: 'busybox:1.37.0',
      ports: { app: 8080, metrics: 9090 },
      healthCheck: { readyPath: '/', livePath: '/', port: 'app' },
      labels: { 'app.kubernetes.io/name': 'myapp', 'plt.dev/version': 'v4' }
    })

    assert.ok(created.targetGroupArn, 'the workload must come with its own target group')

    // The emulator starts no container, so the task's address is supplied here.
    // Everything after this line is the provider's own doing.
    await elbClient.send(new elb.RegisterTargetsCommand({
      TargetGroupArn: created.targetGroupArn,
      Targets: [{ Id: WORKLOAD_BACKEND, Port: 8080 }]
    }))
    await waitForHealthy(created.targetGroupArn)

    await provider.applyRoutePlan(CLUSTER, plan([
      { match: { kind: 'queryParam', name: 'dpl', value: 'v4' }, backend: { serviceName: 'myapp-v4' }, versionId: 'v4' },
      defaultTo('v2')
    ]))

    assert.strictEqual(await through('/?dpl=v4'), 'v4', 'the pin reaches the version the provider deployed')
    assert.strictEqual(await through('/'), 'v2', 'and the active version still serves everything else')
  })

  test('the listener is discovered as a gateway with its real metadata', async () => {
    const gateways = await buildEcs().listGateways(CLUSTER)
    assert.strictEqual(gateways.length, 1)
    assert.strictEqual(gateways[0].metadata.name, 'plt-e2e-lb')
    assert.strictEqual(gateways[0].providerMetadata.listenerArn, fixture.listenerArn)
    assert.strictEqual(gateways[0].providerMetadata.port, LISTENER_PORT)
    assert.strictEqual(gateways[0].providerMetadata.protocol, 'HTTP')
  })
})
