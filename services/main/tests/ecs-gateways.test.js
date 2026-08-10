'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const elbSdk = require('@aws-sdk/client-elastic-load-balancing-v2')
const { Ecs } = require('../plugins/providers/ecs')

// The ECS analogue of a Gateway is the shared ALB listener, provisioned by the
// deployment's CDK stack and passed in by config. machinist only discovers it.

const LISTENER_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/plt-shared/50dc6c495c0c9188/f2f7dc8efc522ab2'
const LB_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/plt-shared/50dc6c495c0c9188'

function buildEcs (listenerArn) {
  const config = { PLT_ECS_REGION: 'us-east-1', PLT_ECS_CLUSTER: 'my-cluster' }
  if (listenerArn) config.PLT_ECS_LISTENER_ARN = listenerArn
  return new Ecs({ config, log: { debug () {}, info () {}, warn () {}, error () {} } })
}

function withElbStub (handler, fn) {
  const original = elbSdk.ElasticLoadBalancingV2Client.prototype.send
  elbSdk.ElasticLoadBalancingV2Client.prototype.send = async function (command) {
    return handler(command.input)
  }
  return Promise.resolve(fn()).finally(() => {
    elbSdk.ElasticLoadBalancingV2Client.prototype.send = original
  })
}

test('reports no gateways when no listener is configured', async () => {
  // Same situation as a Kubernetes cluster with no Gateway resource: routing is
  // simply off, and the caller must not treat it as an error.
  assert.deepStrictEqual(await buildEcs().listGateways('my-cluster'), [])
})

test('reports the configured listener as a gateway', async () => {
  const gateways = await withElbStub(
    input => {
      assert.deepStrictEqual(input.ListenerArns, [LISTENER_ARN])
      return {
        Listeners: [{
          ListenerArn: LISTENER_ARN,
          LoadBalancerArn: LB_ARN,
          Port: 443,
          Protocol: 'HTTPS'
        }]
      }
    },
    () => buildEcs(LISTENER_ARN).listGateways('my-cluster')
  )

  assert.strictEqual(gateways.length, 1)
  // ICC reads gateways[0].metadata.name, so the shape has to match the k8s one.
  assert.strictEqual(gateways[0].metadata.name, 'plt-shared')
  assert.strictEqual(gateways[0].metadata.namespace, 'my-cluster')
  assert.strictEqual(gateways[0].providerMetadata.listenerArn, LISTENER_ARN)
  assert.strictEqual(gateways[0].providerMetadata.loadBalancerArn, LB_ARN)
  assert.strictEqual(gateways[0].providerMetadata.port, 443)
  assert.strictEqual(gateways[0].providerMetadata.protocol, 'HTTPS')
})

test('reports no gateways when the configured listener does not exist', async () => {
  const gateways = await withElbStub(
    () => ({ Listeners: [] }),
    () => buildEcs(LISTENER_ARN).listGateways('my-cluster')
  )
  assert.deepStrictEqual(gateways, [])
})

test('a describe failure propagates rather than being read as no gateways', async () => {
  // Silently returning [] here would look identical to "routing is off" and the
  // caller would leave a stale listener in place without anything reporting it.
  await assert.rejects(
    () => withElbStub(
      () => { throw new Error('AccessDenied') },
      () => buildEcs(LISTENER_ARN).listGateways('my-cluster')
    ),
    /AccessDenied/
  )
})

test('an unset listener warns once, not silently and not repeatedly', async () => {
  const warnings = []
  const ecs = new Ecs({
    config: { PLT_ECS_REGION: 'us-east-1', PLT_ECS_CLUSTER: 'my-cluster' },
    log: { debug () {}, info () {}, error () {}, warn: msg => warnings.push(msg) }
  })

  // Reaching listGateways means skew protection is on and something wants to
  // route, so an unset listener is a wiring mistake rather than a choice.
  await ecs.listGateways('my-cluster')
  await ecs.listGateways('my-cluster')
  await ecs.listGateways('my-cluster')

  assert.strictEqual(warnings.length, 1, 'reconciliation is periodic; do not repeat the warning')
  assert.match(warnings[0], /PLT_ECS_LISTENER_ARN/)
  assert.match(warnings[0], /deployment stack outputs/)
})
