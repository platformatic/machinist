'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const albRules = require('../lib/alb-rules')

// The translator is pure, so everything about rule shape, ordering and ownership
// is testable without AWS. What it cannot answer is whether an ALB actually
// routes this way; that needs the real-AWS probe (plan E9).

const TG = new Map([
  ['v2', 'arn:aws:elasticloadbalancing:::targetgroup/v2'],
  ['v1', 'arn:aws:elasticloadbalancing:::targetgroup/v1']
])

function plan (overrides = {}) {
  return {
    appName: 'myapp',
    hostname: 'myapp.example.com',
    routingMode: 'query',
    rules: [
      { match: { kind: 'queryParam', name: 'dpl', value: 'v1' }, backend: { serviceName: 'myapp-v1' }, versionId: 'v1' },
      { match: { kind: 'header', name: 'x-deployment-id', value: 'v1' }, backend: { serviceName: 'myapp-v1' }, versionId: 'v1' },
      { match: { kind: 'default' }, backend: { serviceName: 'myapp-v2' }, versionId: 'v2', issueCookie: false }
    ],
    ...overrides
  }
}

function render (p = plan(), tg = TG) {
  return albRules.renderRules(p, tg, { priorityBase: 100 })
}

test('a query pin becomes a query-string condition scoped by host', () => {
  const [pin] = render()
  assert.deepStrictEqual(pin.Conditions, [
    { Field: 'host-header', HostHeaderConfig: { Values: ['myapp.example.com'] } },
    { Field: 'query-string', QueryStringConfig: { Values: [{ Key: 'dpl', Value: 'v1' }] } }
  ])
  assert.deepStrictEqual(pin.Actions, [{ Type: 'forward', TargetGroupArn: TG.get('v1') }])
})

test('a preview match becomes an http-header condition', () => {
  const [, preview] = render()
  assert.deepStrictEqual(preview.Conditions[1], {
    Field: 'http-header',
    HttpHeaderConfig: { HttpHeaderName: 'x-deployment-id', Values: ['v1'] }
  })
})

test('the default rule matches the host alone and forwards to the active version', () => {
  const rules = render()
  const last = rules.at(-1)
  assert.deepStrictEqual(last.Conditions, [
    { Field: 'host-header', HostHeaderConfig: { Values: ['myapp.example.com'] } }
  ])
  assert.deepStrictEqual(last.Actions, [{ Type: 'forward', TargetGroupArn: TG.get('v2') }])
})

test('every rule is host-scoped so a shared listener cannot cross apps', () => {
  for (const rule of render()) {
    assert.strictEqual(rule.Conditions[0].Field, 'host-header')
  }
})

test('priorities ascend in plan order from the base', () => {
  const rules = render()
  assert.deepStrictEqual(rules.map(r => r.Priority), [100, 101, 102])
})

test('every rule carries the ownership tags', () => {
  for (const rule of render()) {
    const tags = Object.fromEntries(rule.Tags.map(t => [t.Key, t.Value]))
    assert.strictEqual(tags['plt.dev/managed-by'], 'icc')
    assert.strictEqual(tags['plt.dev/application'], 'myapp')
  }
})

test('a plan with no hostname is refused: ALB cannot rewrite the path', () => {
  assert.throws(() => render(plan({ hostname: null })), /no hostname/)
})

test('a cookie match is refused: an ALB cannot set the cookie', () => {
  const p = plan({
    rules: [{ match: { kind: 'cookie', name: '__plt_dpl', value: 'v1' }, backend: { serviceName: 'myapp-v1' }, versionId: 'v1' }]
  })
  assert.throws(() => render(p), /cookie pinning is not supported/)
})

test('a version with no target group is an error, not a silently dropped rule', () => {
  assert.throws(() => render(plan(), new Map([['v2', 'arn:tg/v2']])), /no target group for version "v1"/)
})

test('priorities are allocated around what the listener already holds', () => {
  // Hashing the application name collided -- 200 names over 1000 blocks gave 18
  // collisions -- and could not see the customer's rules at all. ALB rejects a
  // duplicate priority outright, so a collision is a hard failure.
  assert.strictEqual(albRules.allocatePriorityBase(3, []), 2)
  assert.strictEqual(albRules.allocatePriorityBase(3, [2, 3]), 4)
  assert.strictEqual(albRules.allocatePriorityBase(2, [2, 4]), 5)
})

test('allocation leaves priority 1 free for an operator override', () => {
  assert.ok(albRules.allocatePriorityBase(1, []) >= 2)
})

test('allocation reuses a gap large enough for the whole run', () => {
  // 2..3 free, then 4 taken: a run of 2 fits at the front, a run of 3 does not.
  assert.strictEqual(albRules.allocatePriorityBase(2, [4]), 2)
  assert.strictEqual(albRules.allocatePriorityBase(3, [4]), 5)
})

test('allocation refuses rather than exceeding the ALB priority range', () => {
  // 49999 and 50000 are both valid priorities, so a run of two fits there...
  assert.strictEqual(albRules.allocatePriorityBase(2, [], { start: 49999, max: 50000 }), 49999)
  // ...but with them taken there is nowhere left to go, and inventing a
  // priority above the range would be rejected by ALB.
  assert.throws(
    () => albRules.allocatePriorityBase(2, [49999, 50000], { start: 49999, max: 50000 }),
    /no free block/
  )
})

test('rules for two applications cannot collide once occupancy is respected', () => {
  const first = albRules.allocatePriorityBase(3, [])
  const occupied = [first, first + 1, first + 2]
  const second = albRules.allocatePriorityBase(3, occupied)
  assert.ok(second >= first + 3, 'the second application must not reuse the first block')
})

test('ownership is decided by tags, and other rules on the listener are not ours', () => {
  const ours = { Tags: [{ Key: 'plt.dev/managed-by', Value: 'icc' }, { Key: 'plt.dev/application', Value: 'myapp' }] }
  const otherApp = { Tags: [{ Key: 'plt.dev/managed-by', Value: 'icc' }, { Key: 'plt.dev/application', Value: 'other' }] }
  const customer = { Tags: [{ Key: 'team', Value: 'platform' }] }
  const untagged = {}

  assert.strictEqual(albRules.isManagedRule(ours, 'myapp'), true)
  assert.strictEqual(albRules.isManagedRule(otherApp, 'myapp'), false)
  assert.strictEqual(albRules.isManagedRule(customer, 'myapp'), false)
  assert.strictEqual(albRules.isManagedRule(untagged, 'myapp'), false)
})

test('rendering is deterministic, so re-applying an unchanged plan is a no-op', () => {
  assert.deepStrictEqual(render(), render())
})
