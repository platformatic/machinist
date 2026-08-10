'use strict'

// Renders a provider-neutral route plan (icc-3 lib/route-plan.js) into ALB
// listener rules. Pure: no AWS calls, no clients. The provider resolves target
// group ARNs and applies the result; everything about rule shape lives here.
//
// See ecs-skew-protection-plan.md (D4, D6, F1, F3).

// Every rule ICC creates carries these tags. The resync in applyRoutePlan
// deletes by them, so a rule the customer manages on the same listener is never
// touched -- there is no other way to tell whose rule is whose on a shared
// listener.
const MANAGED_BY_TAG = 'plt.dev/managed-by'
const MANAGED_BY_VALUE = 'icc'
const APPLICATION_TAG = 'plt.dev/application'
const VERSION_TAG = 'plt.dev/version'

// ALB priorities are 1..50000 and must be unique per listener, which is shared
// by every application behind the load balancer. Rules for one application take
// a contiguous run so they keep the plan's order; the run is allocated from
// observed occupancy, see allocatePriorityBase.

function tagsFor (plan, versionId) {
  const tags = [
    { Key: MANAGED_BY_TAG, Value: MANAGED_BY_VALUE },
    { Key: APPLICATION_TAG, Value: plan.appName }
  ]
  if (versionId) tags.push({ Key: VERSION_TAG, Value: versionId })
  return tags
}

// A plan match becomes ALB rule conditions. The host header is always included:
// the listener is shared by every application, so without it one app's pinning
// rule would match another app's traffic.
//
// ALB has no path-rewrite action, which is why a plan without a hostname cannot
// be rendered at all -- ICC refuses those upstream (F1, D4).
function conditionsFor (match, hostname) {
  const host = { Field: 'host-header', HostHeaderConfig: { Values: [hostname] } }

  switch (match.kind) {
    case 'queryParam':
      return [host, {
        Field: 'query-string',
        QueryStringConfig: { Values: [{ Key: match.name, Value: match.value }] }
      }]

    case 'header':
      return [host, {
        Field: 'http-header',
        HttpHeaderConfig: { HttpHeaderName: match.name, Values: [match.value] }
      }]

    case 'default':
      return [host]

    case 'cookie':
      // Cookie pinning needs the edge to set a Set-Cookie response header, which
      // an ALB cannot do, so ICC never sends a cookie plan to this provider.
      throw new Error('cookie pinning is not supported on ALB; use query routing')

    default:
      throw new Error(`unsupported route plan match kind: ${match.kind}`)
  }
}

// Desired listener rules for one application, in plan order.
//
// `targetGroups` maps versionId -> target group ARN. A version with no target
// group is a configuration error the caller reports; it must not be silently
// dropped, or the version would lose its pinning without anything saying so.
function renderRules (plan, targetGroups, { priorityBase }) {
  if (!plan.hostname) {
    throw new Error(`route plan for "${plan.appName}" has no hostname; ALB cannot route it by path`)
  }

  return plan.rules.map((rule, index) => {
    const targetGroupArn = targetGroups.get(rule.versionId)
    if (!targetGroupArn) {
      throw new Error(`no target group for version "${rule.versionId}" of "${plan.appName}"`)
    }

    return {
      Priority: priorityBase + index,
      Conditions: conditionsFor(rule.match, plan.hostname),
      Actions: [{ Type: 'forward', TargetGroupArn: targetGroupArn }],
      Tags: tagsFor(plan, rule.versionId)
    }
  })
}

// The lowest free run of `count` consecutive priorities, given what the listener
// already holds.
//
// Allocated from observed occupancy rather than hashed from the application
// name. A hash over a fixed number of blocks collides -- 200 application names
// over 1000 blocks produced 18 collisions in practice -- and it cannot see the
// customer's own rules at all. ALB rejects a duplicate priority outright, so a
// collision is a hard failure rather than a degraded route.
//
// `occupied` should exclude the rules ICC is about to delete: those numbers are
// being freed in the same reconcile and are the ones we most want to reuse, so
// that a stable application keeps stable priorities.
function allocatePriorityBase (count, occupied = [], { start = 2, max = 50000 } = {}) {
  const taken = new Set(occupied.map(Number).filter(Number.isFinite))

  // Priority 1 is left free deliberately: 0 is invalid, and keeping the very
  // front clear lets an operator insert an override ahead of everything ICC
  // manages without renumbering.
  for (let base = start; base + count - 1 <= max; base++) {
    let free = true
    for (let i = 0; i < count; i++) {
      if (taken.has(base + i)) { free = false; break }
    }
    if (free) return base
  }
  throw new Error(`no free block of ${count} listener priorities below ${max}`)
}

function isManagedRule (rule, appName) {
  const tags = rule.Tags || []
  const managed = tags.some(t => t.Key === MANAGED_BY_TAG && t.Value === MANAGED_BY_VALUE)
  if (!managed) return false
  if (!appName) return true
  return tags.some(t => t.Key === APPLICATION_TAG && t.Value === appName)
}

module.exports = {
  renderRules,
  allocatePriorityBase,
  isManagedRule,
  conditionsFor,
  tagsFor,
  MANAGED_BY_TAG,
  MANAGED_BY_VALUE,
  APPLICATION_TAG,
  VERSION_TAG
}
