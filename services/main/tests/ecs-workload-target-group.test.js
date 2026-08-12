'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mockClient } = require('aws-sdk-client-mock')
const {
  ECSClient,
  RegisterTaskDefinitionCommand,
  CreateServiceCommand,
  DescribeServicesCommand,
  DeleteServiceCommand,
  TagResourceCommand
} = require('@aws-sdk/client-ecs')
const {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
  RestoreSecretCommand
} = require('@aws-sdk/client-secrets-manager')
const {
  ServiceDiscoveryClient,
  ListServicesCommand: ListDiscoveryServicesCommand,
  CreateServiceCommand: CreateDiscoveryServiceCommand,
  DeleteServiceCommand: DeleteDiscoveryServiceCommand,
  ListInstancesCommand,
  DeregisterInstanceCommand,
  GetNamespaceCommand,
  GetServiceCommand
} = require('@aws-sdk/client-servicediscovery')
const {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand
} = require('@aws-sdk/client-resource-groups-tagging-api')
const {
  ElasticLoadBalancingV2Client,
  DescribeListenersCommand,
  DescribeRulesCommand,
  DescribeTagsCommand,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  CreateTargetGroupCommand,
  CreateRuleCommand,
  DeleteRuleCommand,
  DeleteTargetGroupCommand
} = require('@aws-sdk/client-elastic-load-balancing-v2')
const { Ecs } = require('../plugins/providers/ecs')

// A version is only addressable by a listener rule through its own target
// group, and applyRoutePlan reads that group off the ECS service. Creating the
// workload without one produced a service that could never be routed to:
// "the service is not attached to a target group". These tests join the two
// halves -- workload creation and routing -- at that field.
//
// Attaching later is not an option. It is an UpdateService on `loadBalancers`,
// which restarts the tasks, and doing that to a draining version destroys the
// pinned sessions skew protection exists to preserve.

const LISTENER_ARN = 'arn:aws:elasticloadbalancing:us-east-1:1:listener/app/plt/lb1/l1'
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/plt/lb1'
const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/my-app-v1-abc123/t1'
const BOOTSTRAP_RULE_ARN = 'arn:aws:elasticloadbalancing:us-east-1:1:listener-rule/app/plt/lb1/l1/bootstrap'

function buildSpec (overrides = {}) {
  return {
    name: 'my-app-v1',
    appName: 'my-app',
    image: 'registry.example.com/my-app:1.0.0',
    ports: { app: 3042, metrics: 9090 },
    healthCheck: { readyPath: '/ready', livePath: '/status', port: 'metrics' },
    labels: { 'app.kubernetes.io/name': 'my-app', 'plt.dev/version': 'v1' },
    ...overrides
  }
}

function buildEcs ({
  listenerArn = LISTENER_ARN,
  existingTargetGroup = false,
  deleteFails = false,
  createServiceFails = false
} = {}) {
  const events = []
  const ecs = new Ecs({
    config: {
      PLT_ECS_REGION: 'us-east-1',
      PLT_ECS_CLUSTER: 'my-cluster',
      PLT_ECS_SUBNETS: 'subnet-a',
      PLT_ECS_SECURITY_GROUPS: 'sg-1',
      PLT_ECS_CLEANUP_RETRY_BASE_MS: 0,
      ...(listenerArn ? { PLT_ECS_LISTENER_ARN: listenerArn } : {})
    },
    log: { debug () {}, info () {}, warn () {}, error () {} }
  })

  const ecsMock = mockClient(ECSClient)
  ecsMock.on(RegisterTaskDefinitionCommand).resolves({ taskDefinition: { taskDefinitionArn: 'arn:td/1' } })
  ecsMock.on(DescribeServicesCommand).resolves({ services: [] })
  if (createServiceFails) {
    ecsMock.on(CreateServiceCommand).callsFake(() => {
      events.push('create-service')
      throw new Error('ECS service creation failed')
    })
  } else {
    ecsMock.on(CreateServiceCommand).callsFake(input => {
      events.push('create-service')
      return { service: { serviceName: input.serviceName, serviceArn: 'arn:svc/1' } }
    })
  }
  ecsMock.on(TagResourceCommand).resolves({})
  ecsMock.on(DeleteServiceCommand).resolves({})
  ecs.ecsClient = ecsMock

  ecs.secretsClient = mockClient(SecretsManagerClient)
  const discoveryMock = mockClient(ServiceDiscoveryClient)
  discoveryMock.on(ListDiscoveryServicesCommand).resolves({ Services: [] })
  ecs.discoveryClient = discoveryMock

  const elbMock = mockClient(ElasticLoadBalancingV2Client)
  elbMock.on(DescribeListenersCommand).resolves({ Listeners: [{ ListenerArn: listenerArn, LoadBalancerArn: LB_ARN }] })
  elbMock.on(DescribeRulesCommand).resolves({ Rules: [] })
  elbMock.on(DescribeTagsCommand).resolves({ TagDescriptions: [] })
  elbMock.on(CreateRuleCommand).callsFake(() => {
    events.push('create-bootstrap-rule')
    return { Rules: [{ RuleArn: BOOTSTRAP_RULE_ARN }] }
  })
  elbMock.on(DeleteRuleCommand).callsFake(() => {
    events.push('delete-rule')
    return {}
  })
  elbMock.on(DescribeLoadBalancersCommand).resolves({ LoadBalancers: [{ LoadBalancerArn: LB_ARN, VpcId: 'vpc-42' }] })
  if (existingTargetGroup) {
    elbMock.on(DescribeTargetGroupsCommand).resolves({ TargetGroups: [{ TargetGroupArn: TG_ARN }] })
  } else {
    // The API answers "does it exist" by throwing, which is what the provider
    // has to treat as "no" rather than as a failure.
    const notFound = new Error('One or more target groups not found')
    notFound.name = 'TargetGroupNotFoundException'
    elbMock.on(DescribeTargetGroupsCommand).rejects(notFound)
  }
  elbMock.on(CreateTargetGroupCommand).resolves({ TargetGroups: [{ TargetGroupArn: TG_ARN }] })
  if (deleteFails) {
    const inUse = new Error('Target group is currently in use by a listener or a rule')
    inUse.name = 'ResourceInUseException'
    elbMock.on(DeleteTargetGroupCommand).rejects(inUse)
  } else {
    elbMock.on(DeleteTargetGroupCommand).callsFake(() => {
      events.push('delete-target-group')
      return {}
    })
  }
  ecs.elbClient = elbMock

  return { ecs, ecsMock, elbMock, events }
}

test('a new workload is created already attached to its own target group', async () => {
  const { ecs, ecsMock, events } = buildEcs()

  const result = await ecs.applyWorkload('my-cluster', buildSpec())

  const [create] = ecsMock.commandCalls(CreateServiceCommand)
  assert.deepStrictEqual(create.args[0].input.loadBalancers, [{
    targetGroupArn: TG_ARN,
    containerName: 'my-app-v1',
    containerPort: 3042
  }])
  assert.strictEqual(result.targetGroupArn, TG_ARN)
  assert.deepStrictEqual(events.slice(0, 2), ['create-bootstrap-rule', 'create-service'])
})

test('the bootstrap rule associates the target group without matching normal traffic', async () => {
  const { ecs, elbMock } = buildEcs()

  await ecs.applyWorkload('my-cluster', buildSpec({
    labels: {
      'app.kubernetes.io/name': 'my-app',
      'plt.dev/version': 'v1',
      'plt.dev/hostname': 'my-app.example.com'
    }
  }))

  const { input } = elbMock.commandCalls(CreateRuleCommand)[0].args[0]
  assert.strictEqual(input.ListenerArn, LISTENER_ARN)
  assert.deepStrictEqual(input.Actions, [{ Type: 'forward', TargetGroupArn: TG_ARN }])
  assert.ok(input.Conditions.some(condition =>
    condition.Field === 'host-header' && condition.HostHeaderConfig.Values.includes('my-app.example.com')))
  assert.ok(input.Conditions.some(condition =>
    condition.Field === 'http-header' &&
    condition.HttpHeaderConfig.HttpHeaderName === 'x-platformatic-bootstrap'))

  const tags = Object.fromEntries(input.Tags.map(tag => [tag.Key, tag.Value]))
  assert.strictEqual(tags['plt.dev/managed-by'], 'icc')
  assert.strictEqual(tags['plt.dev/application'], 'my-app')
  assert.strictEqual(tags['plt.dev/version'], 'v1')
  assert.strictEqual(tags['plt.dev/purpose'], 'bootstrap')
})

test('a failed ECS service creation removes the bootstrap rule before the new target group', async () => {
  const { ecs, elbMock, events } = buildEcs({ createServiceFails: true })

  await assert.rejects(
    () => ecs.applyWorkload('my-cluster', buildSpec()),
    /ECS service creation failed/
  )

  assert.strictEqual(elbMock.commandCalls(DeleteRuleCommand).length, 1)
  assert.strictEqual(elbMock.commandCalls(DeleteTargetGroupCommand).length, 1)
  assert.deepStrictEqual(events, [
    'create-bootstrap-rule',
    'create-service',
    'delete-rule',
    'delete-target-group'
  ])
})

test('the target group is created in the load balancer\'s own VPC', async () => {
  const { ecs, elbMock } = buildEcs()

  await ecs.applyWorkload('my-cluster', buildSpec())

  const [create] = elbMock.commandCalls(CreateTargetGroupCommand)
  // A target group has to sit in the same VPC as the load balancer fronting it,
  // so the load balancer is asked rather than the subnets configured for ECS.
  assert.strictEqual(create.args[0].input.VpcId, 'vpc-42')
  assert.strictEqual(create.args[0].input.TargetType, 'ip')
  assert.strictEqual(create.args[0].input.Port, 3042)
})

test('the health check mirrors the readiness probe, not the container check', async () => {
  const { ecs, elbMock } = buildEcs()

  await ecs.applyWorkload('my-cluster', buildSpec())

  const { input } = elbMock.commandCalls(CreateTargetGroupCommand)[0].args[0]
  assert.strictEqual(input.HealthCheckPath, '/ready')
  // The spec puts readiness on the metrics port. Checking the traffic port
  // instead would mark every target unhealthy, and applyRoutePlan would then
  // refuse to route to the version at all.
  assert.strictEqual(input.HealthCheckPort, '9090')
})

test('a readiness probe on the app port checks the traffic port', async () => {
  const { ecs, elbMock } = buildEcs()

  await ecs.applyWorkload('my-cluster', buildSpec({
    healthCheck: { readyPath: '/ready', livePath: '/status', port: 'app' }
  }))

  assert.strictEqual(
    elbMock.commandCalls(CreateTargetGroupCommand)[0].args[0].input.HealthCheckPort,
    'traffic-port'
  )
})

test('the target group carries the ownership tags', async () => {
  const { ecs, elbMock } = buildEcs()

  await ecs.applyWorkload('my-cluster', buildSpec())

  const tags = Object.fromEntries(
    elbMock.commandCalls(CreateTargetGroupCommand)[0].args[0].input.Tags.map(t => [t.Key, t.Value])
  )
  assert.strictEqual(tags['plt.dev/managed-by'], 'icc')
  assert.strictEqual(tags['plt.dev/application'], 'my-app')
  assert.strictEqual(tags['plt.dev/version'], 'v1')
})

test('an existing target group is reused, not recreated', async () => {
  const { ecs, elbMock } = buildEcs({ existingTargetGroup: true })

  const result = await ecs.applyWorkload('my-cluster', buildSpec())

  assert.strictEqual(elbMock.commandCalls(CreateTargetGroupCommand).length, 0)
  assert.strictEqual(result.targetGroupArn, TG_ARN)
})

test('without a listener nothing is created and the result is unchanged', async () => {
  const { ecs, ecsMock, elbMock } = buildEcs({ listenerArn: null })

  const result = await ecs.applyWorkload('my-cluster', buildSpec())

  // A target group per version with nowhere to attach it would only consume the
  // per-load-balancer quota, which is 100 and cannot be raised.
  assert.strictEqual(elbMock.commandCalls(CreateTargetGroupCommand).length, 0)
  assert.strictEqual(ecsMock.commandCalls(CreateServiceCommand)[0].args[0].input.loadBalancers, undefined)
  assert.ok(!('targetGroupArn' in result), 'the return shape must not change for unrouted deployments')
})

test('deleting the workload deletes its target group', async () => {
  const { ecs, elbMock } = buildEcs({ existingTargetGroup: true })

  await ecs.deleteController('my-cluster', 'my-app-v1')

  assert.deepStrictEqual(
    elbMock.commandCalls(DeleteTargetGroupCommand)[0].args[0].input,
    { TargetGroupArn: TG_ARN }
  )
})

test('deleting a workload removes an orphaned bootstrap rule before its target group', async () => {
  const { ecs, elbMock, events } = buildEcs({ existingTargetGroup: true })
  elbMock.on(DescribeRulesCommand).resolves({
    Rules: [{
      RuleArn: BOOTSTRAP_RULE_ARN,
      Priority: '2',
      Actions: [{ Type: 'forward', TargetGroupArn: TG_ARN }]
    }]
  })
  elbMock.on(DescribeTagsCommand).resolves({
    TagDescriptions: [{
      ResourceArn: BOOTSTRAP_RULE_ARN,
      Tags: [{ Key: 'plt.dev/managed-by', Value: 'icc' }]
    }]
  })

  await ecs.deleteController('my-cluster', 'my-app-v1')

  assert.deepStrictEqual(events, ['delete-rule', 'delete-target-group'])
  assert.deepStrictEqual(
    elbMock.commandCalls(DeleteRuleCommand)[0].args[0].input,
    { RuleArn: BOOTSTRAP_RULE_ARN }
  )
})

test('a target group that cannot be deleted is reported, not thrown', async () => {
  const warnings = []
  const { ecs } = buildEcs({ existingTargetGroup: true, deleteFails: true })
  ecs.log.warn = (details, msg) => warnings.push({ details, msg })

  // The service is already gone by this point. Throwing would tell the caller
  // the version is still up, which is worse than a group left behind.
  await ecs.deleteController('my-cluster', 'my-app-v1')

  assert.strictEqual(warnings.length, 1)
  assert.match(warnings[0].msg, /quota/)
  assert.strictEqual(warnings[0].details.targetGroupArn, TG_ARN)
})

test('the target group name fits the ALB limit and stays unique', async () => {
  const long = 'a-very-long-application-name-that-exceeds-the-limit-v1'
  const { ecs, elbMock } = buildEcs()
  await ecs.applyWorkload('my-cluster', buildSpec({ name: long }))

  const name = elbMock.commandCalls(CreateTargetGroupCommand)[0].args[0].input.Name
  assert.ok(name.length <= 32, `${name} is ${name.length} characters`)
  assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/)

  // Two names identical up to the cutoff must not share a target group, which
  // would route both versions to the same tasks.
  const other = buildEcs()
  await other.ecs.applyWorkload('my-cluster', buildSpec({ name: long.replace(/v1$/, 'v2') }))
  const otherName = other.elbMock.commandCalls(CreateTargetGroupCommand)[0].args[0].input.Name
  assert.notStrictEqual(name, otherName)
})

// --- Names, addressing and teardown ---

function withCloudMap (ecs, { existingService = null } = {}) {
  const discovery = mockClient(ServiceDiscoveryClient)
  discovery.on(GetNamespaceCommand).resolves({ Namespace: { Id: 'ns-1', Name: 'plt.local' } })
  discovery.on(ListDiscoveryServicesCommand).resolves({
    Services: existingService ? [{ Id: 'srv-1', Name: existingService }] : []
  })
  discovery.on(CreateDiscoveryServiceCommand).resolves({ Service: { Arn: 'arn:sd/srv-1' } })
  discovery.on(ListInstancesCommand).resolves({ Instances: [] })
  discovery.on(DeregisterInstanceCommand).resolves({})
  discovery.on(DeleteDiscoveryServiceCommand).resolves({})
  ecs.discoveryClient = discovery
  ecs.config.PLT_ECS_CLOUD_MAP_NAMESPACE_ID = 'ns-1'
  return discovery
}

test('a version label with dots becomes a valid ECS name', async () => {
  // `my-app-v1.2.3` is a valid Kubernetes name and a rejected ECS one: service
  // names, task-definition families and container names take letters, numbers,
  // underscores and hyphens only.
  const { ecs, ecsMock, elbMock } = buildEcs()

  const result = await ecs.applyWorkload('my-cluster', buildSpec({ name: 'my-app-v1.2.3' }))

  // The digest disambiguates it from a literal `my-app-v1-2-3`; see the
  // collision test below.
  const expected = 'my-app-v1-2-3-4f878d'
  assert.strictEqual(result.name, expected)
  const create = ecsMock.commandCalls(CreateServiceCommand)[0].args[0].input
  assert.strictEqual(create.serviceName, expected)
  assert.strictEqual(create.loadBalancers[0].containerName, expected)

  const td = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input
  assert.strictEqual(td.family, expected)
  assert.strictEqual(td.containerDefinitions[0].name, expected)

  for (const input of [create, td, elbMock.commandCalls(CreateTargetGroupCommand)[0].args[0].input]) {
    assert.ok(!JSON.stringify(input).includes('v1.2.3'), 'no dotted name may reach AWS')
  }
})

test('applyWorkload reports where the workload can be reached', async () => {
  const { ecs } = buildEcs()
  withCloudMap(ecs)

  const result = await ecs.applyWorkload('my-cluster', buildSpec())

  // ICC builds workflow handler URLs from this. On Kubernetes it can derive the
  // address from the service name; on ECS there is no such convention.
  assert.deepStrictEqual(result.endpoint, { hostname: 'my-app-v1.plt.local', port: 3042 })
})

test('service discovery reports the Cloud Map name when it differs from the ECS service name', async () => {
  const { ecs, ecsMock } = buildEcs({ listenerArn: null })
  ecs.config.PLT_ECS_CLOUD_MAP_NAMESPACE_ID = 'ns-1'

  const tagging = mockClient(ResourceGroupsTaggingAPIClient)
  tagging.on(GetResourcesCommand).resolves({
    ResourceTagMappingList: [{ ResourceARN: 'arn:aws:ecs:us-east-1:1:service/my-cluster/demo-my-app-v1' }]
  })
  ecs.taggingClient = tagging

  ecsMock.on(DescribeServicesCommand).resolves({
    services: [{
      serviceName: 'demo-my-app-v1',
      serviceRegistries: [{ registryArn: 'arn:aws:servicediscovery:us-east-1:1:service/srv-1' }],
      loadBalancers: [{ containerPort: 3042 }],
      tags: [{ key: 'app.kubernetes.io/name', value: 'my-app' }]
    }]
  })

  const discovery = mockClient(ServiceDiscoveryClient)
  discovery.on(GetNamespaceCommand).resolves({ Namespace: { Name: 'plt.local' } })
  discovery.on(GetServiceCommand).resolves({ Service: { Name: 'v-my-app-v1-a1b2c3' } })
  ecs.discoveryClient = discovery

  const [service] = await ecs.getServicesByLabels('my-cluster', { 'app.kubernetes.io/name': 'my-app' })

  assert.strictEqual(service.name, 'demo-my-app-v1')
  assert.strictEqual(service.hostname, 'v-my-app-v1-a1b2c3.plt.local')
})

test('without Cloud Map there is no endpoint to report', async () => {
  const { ecs } = buildEcs()
  const result = await ecs.applyWorkload('my-cluster', buildSpec())
  assert.ok(!('endpoint' in result))
})

test('deleting a workload removes its Cloud Map service and pull secret too', async () => {
  const { ecs } = buildEcs({ existingTargetGroup: true })
  const discovery = withCloudMap(ecs, { existingService: 'my-app-v1' })
  const secrets = mockClient(SecretsManagerClient)
  secrets.on(DeleteSecretCommand).resolves({})
  ecs.secretsClient = secrets

  await ecs.deleteController('my-cluster', 'my-app-v1')

  // One version per release: anything left behind accumulates for the lifetime
  // of the application.
  assert.strictEqual(discovery.commandCalls(DeleteDiscoveryServiceCommand)[0].args[0].input.Id, 'srv-1')
  assert.strictEqual(secrets.commandCalls(DeleteSecretCommand)[0].args[0].input.SecretId, 'my-app-v1-pull')
})

test('a workload with no pull secret is deleted without complaint', async () => {
  const warnings = []
  const { ecs } = buildEcs({ existingTargetGroup: true })
  withCloudMap(ecs)
  const secrets = mockClient(SecretsManagerClient)
  const missing = new Error('Secrets Manager can\'t find the specified secret.')
  missing.name = 'ResourceNotFoundException'
  secrets.on(DeleteSecretCommand).rejects(missing)
  ecs.secretsClient = secrets
  ecs.log.warn = (details, msg) => warnings.push(msg)

  await ecs.deleteController('my-cluster', 'my-app-v1')

  assert.deepStrictEqual(warnings, [], 'only private images have a secret; its absence is normal')
})

test('a dotted name is normalised on the way out too', async () => {
  const { ecs, ecsMock } = buildEcs({ existingTargetGroup: true })
  withCloudMap(ecs)
  ecs.secretsClient = mockClient(SecretsManagerClient)

  await ecs.deleteController('my-cluster', 'my-app-v1.2.3')

  assert.strictEqual(
    ecsMock.commandCalls(DeleteServiceCommand)[0].args[0].input.service,
    'my-app-v1-2-3-4f878d'
  )
})

test('a name that had to be changed carries a digest of the original', async () => {
  // Normalisation and truncation are both lossy: without this, `v1.2.3` and
  // `v1-2-3` become one service, and so does any pair sharing 255 characters.
  const dotted = buildEcs()
  const hyphened = buildEcs()
  await dotted.ecs.applyWorkload('my-cluster', buildSpec({ name: 'my-app-v1.2.3' }))
  await hyphened.ecs.applyWorkload('my-cluster', buildSpec({ name: 'my-app-v1-2-3' }))

  const nameOf = h => h.ecsMock.commandCalls(CreateServiceCommand)[0].args[0].input.serviceName
  assert.notStrictEqual(nameOf(dotted), nameOf(hyphened))
  assert.strictEqual(nameOf(hyphened), 'my-app-v1-2-3', 'a name needing no change is left alone')
  assert.match(nameOf(dotted), /^my-app-v1-2-3-[0-9a-f]{6}$/)

  const long = buildEcs()
  await long.ecs.applyWorkload('my-cluster', buildSpec({ name: 'a'.repeat(300) }))
  assert.ok(nameOf(long).length <= 255)
})

test('Cloud Map instances are deregistered before the service is deleted', async () => {
  // Cloud Map refuses to delete a service while an instance is registered, and
  // ECS deregisters them asynchronously, so deleting straight afterwards loses
  // that race almost every time.
  const { ecs } = buildEcs({ existingTargetGroup: true })
  const discovery = withCloudMap(ecs, { existingService: 'my-app-v1' })
  discovery.on(ListInstancesCommand).resolves({ Instances: [{ Id: 'task-1' }, { Id: 'task-2' }] })
  ecs.secretsClient = mockClient(SecretsManagerClient)

  await ecs.deleteController('my-cluster', 'my-app-v1')

  assert.deepStrictEqual(
    discovery.commandCalls(DeregisterInstanceCommand).map(c => c.args[0].input.InstanceId),
    ['task-1', 'task-2']
  )
  assert.strictEqual(discovery.commandCalls(DeleteDiscoveryServiceCommand).length, 1)
})

test('a Cloud Map service still in use is retried, not abandoned', async () => {
  const { ecs } = buildEcs({ existingTargetGroup: true })
  const discovery = withCloudMap(ecs, { existingService: 'my-app-v1' })
  ecs.secretsClient = mockClient(SecretsManagerClient)

  const inUse = new Error('The service cannot be deleted because it contains registered instances')
  inUse.name = 'ResourceInUse'
  discovery.on(DeleteDiscoveryServiceCommand).rejectsOnce(inUse).resolves({})

  await ecs.deleteController('my-cluster', 'my-app-v1')

  assert.strictEqual(discovery.commandCalls(DeleteDiscoveryServiceCommand).length, 2,
    'deregistration is itself asynchronous, so the first attempt can still be refused')
})

test('the pull secret is deleted outright so the version can be redeployed', async () => {
  const { ecs } = buildEcs({ existingTargetGroup: true })
  withCloudMap(ecs)
  const secrets = mockClient(SecretsManagerClient)
  secrets.on(DeleteSecretCommand).resolves({})
  ecs.secretsClient = secrets

  await ecs.deleteController('my-cluster', 'my-app-v1')

  // A scheduled deletion reserves the name for its recovery window, during
  // which the secret can be neither created nor updated -- so redeploying the
  // same version would fail for 30 days.
  assert.strictEqual(
    secrets.commandCalls(DeleteSecretCommand)[0].args[0].input.ForceDeleteWithoutRecovery,
    true
  )
})

// CreateSecret reports a secret scheduled for deletion as
// InvalidRequestException, not ResourceExistsException -- and a forced deletion
// is asynchronous, so the name can still be refused for a moment after
// machinist removed it. Redeploying a version is exactly when both land.

test('a secret scheduled for deletion is restored, as CreateSecret reports it', async () => {
  const { ecs } = buildEcs()
  const secrets = mockClient(SecretsManagerClient)
  const scheduled = new Error('You can\'t create this secret because a secret with this name is already scheduled for deletion.')
  scheduled.name = 'InvalidRequestException'
  secrets.on(CreateSecretCommand).rejects(scheduled)
  secrets.on(RestoreSecretCommand).resolves({})
  secrets.on(PutSecretValueCommand).resolves({ ARN: 'arn:secret/1' })
  ecs.secretsClient = secrets

  await ecs.applyWorkload('my-cluster', buildSpec({ pullSecret: { username: 'u', password: 'p' } }))

  assert.strictEqual(secrets.commandCalls(RestoreSecretCommand)[0].args[0].input.SecretId, 'my-app-v1-pull')
  assert.strictEqual(secrets.commandCalls(PutSecretValueCommand).length, 1)
})

test('a forced deletion still in flight is waited out, not failed', async () => {
  const { ecs } = buildEcs()
  const secrets = mockClient(SecretsManagerClient)
  const inFlight = new Error('You can\'t perform this operation on the secret because it was deleted.')
  inFlight.name = 'InvalidRequestException'
  const gone = new Error('Secrets Manager can\'t find the specified secret.')
  gone.name = 'ResourceNotFoundException'
  // Refused twice while the deletion completes, then the name is free again.
  secrets.on(CreateSecretCommand).rejectsOnce(inFlight).rejectsOnce(inFlight).resolves({ ARN: 'arn:secret/1' })
  secrets.on(RestoreSecretCommand).rejects(gone)
  ecs.secretsClient = secrets

  await ecs.applyWorkload('my-cluster', buildSpec({ pullSecret: { username: 'u', password: 'p' } }))

  assert.strictEqual(secrets.commandCalls(CreateSecretCommand).length, 3)
})

test('an existing secret takes the new value', async () => {
  const { ecs } = buildEcs()
  const secrets = mockClient(SecretsManagerClient)
  const exists = new Error('The operation failed because the secret already exists.')
  exists.name = 'ResourceExistsException'
  secrets.on(CreateSecretCommand).rejects(exists)
  secrets.on(PutSecretValueCommand).resolves({ ARN: 'arn:secret/1' })
  ecs.secretsClient = secrets

  await ecs.applyWorkload('my-cluster', buildSpec({ pullSecret: { username: 'u', password: 'p' } }))

  assert.strictEqual(secrets.commandCalls(PutSecretValueCommand).length, 1)
  assert.strictEqual(secrets.commandCalls(RestoreSecretCommand).length, 0)
})

test('a secret that never becomes writable fails the deploy', async () => {
  // Better than deploying a workload that cannot pull its image.
  const { ecs } = buildEcs()
  const secrets = mockClient(SecretsManagerClient)
  const stuck = new Error('marked for deletion')
  stuck.name = 'InvalidRequestException'
  secrets.on(CreateSecretCommand).rejects(stuck)
  secrets.on(RestoreSecretCommand).rejects(stuck)
  ecs.secretsClient = secrets

  await assert.rejects(
    () => ecs.applyWorkload('my-cluster', buildSpec({ pullSecret: { username: 'u', password: 'p' } })),
    err => err.name === 'InvalidRequestException'
  )
})

test('an instance ECS is already deregistering does not abandon the delete', async () => {
  // DuplicateRequest means the operation is already in flight, which is the
  // outcome wanted. It used to escape and skip the deletion entirely.
  const { ecs } = buildEcs({ existingTargetGroup: true })
  const discovery = withCloudMap(ecs, { existingService: 'my-app-v1' })
  discovery.on(ListInstancesCommand).resolves({ Instances: [{ Id: 'task-1' }] })
  const duplicate = new Error('Another operation for this instance is in progress')
  duplicate.name = 'DuplicateRequest'
  discovery.on(DeregisterInstanceCommand).rejects(duplicate)
  ecs.secretsClient = mockClient(SecretsManagerClient)

  await ecs.deleteController('my-cluster', 'my-app-v1')

  assert.strictEqual(discovery.commandCalls(DeleteDiscoveryServiceCommand).length, 1)
})

test('Cloud Map listings are paginated', async () => {
  // One namespace holds a service per version of every application, and a page
  // is 100, so the workload is not on the first page for long.
  const { ecs } = buildEcs({ existingTargetGroup: true })
  const discovery = withCloudMap(ecs)
  discovery.on(ListDiscoveryServicesCommand)
    .resolvesOnce({ Services: [{ Id: 'other', Name: 'someone-else' }], NextToken: 'page-2' })
    .resolves({ Services: [{ Id: 'srv-1', Name: 'my-app-v1' }] })
  discovery.on(ListInstancesCommand)
    .resolvesOnce({ Instances: [{ Id: 'task-1' }], NextToken: 'page-2' })
    .resolves({ Instances: [{ Id: 'task-2' }] })
  ecs.secretsClient = mockClient(SecretsManagerClient)

  await ecs.deleteController('my-cluster', 'my-app-v1')

  assert.deepStrictEqual(
    discovery.commandCalls(DeregisterInstanceCommand).map(c => c.args[0].input.InstanceId),
    ['task-1', 'task-2']
  )
  assert.strictEqual(discovery.commandCalls(DeleteDiscoveryServiceCommand)[0].args[0].input.Id, 'srv-1',
    'the service was found on the second page')
})
