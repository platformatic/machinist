'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mockClient } = require('aws-sdk-client-mock')
const {
  ECSClient,
  RegisterTaskDefinitionCommand,
  CreateServiceCommand,
  UpdateServiceCommand,
  DescribeServicesCommand,
  TagResourceCommand
} = require('@aws-sdk/client-ecs')
const {
  SecretsManagerClient,
  CreateSecretCommand
} = require('@aws-sdk/client-secrets-manager')
const {
  ServiceDiscoveryClient,
  CreateServiceCommand: CreateDiscoveryServiceCommand,
  ListServicesCommand: ListDiscoveryServicesCommand
} = require('@aws-sdk/client-servicediscovery')
const { Ecs } = require('../plugins/providers/ecs')

const TASK_DEF_ARN = 'arn:aws:ecs:us-east-1:123456789012:task-definition/my-app-v1:1'
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-app-v1'

// The provider-neutral spec ICC produces (see icc3 buildWorkloadSpec).
function buildSpec (overrides = {}) {
  return {
    name: 'my-app-v1',
    appName: 'my-app',
    version: 'v1',
    deploymentVersion: 'v1',
    image: 'registry.example.com/my-app:1.0.0',
    hostname: 'my-app.example.com',
    isWorkflow: false,
    minReplicas: 2,
    maxReplicas: 5,
    pullSecret: null,
    ports: { app: 3042, metrics: 9090 },
    resources: { requests: { memory: '512Mi', cpu: '500m' }, limits: { memory: '1Gi', cpu: '750m' } },
    healthCheck: { readyPath: '/ready', livePath: '/status', port: 'metrics' },
    env: [{ name: 'FOO', value: 'bar' }],
    platformEnv: [{ name: 'PLT_DEPLOYMENT_VERSION', value: 'v1' }],
    labels: { 'app.kubernetes.io/name': 'my-app', 'plt.dev/version': 'v1' },
    ...overrides
  }
}

function buildEcs (config = {}) {
  const ecs = new Ecs({
    config: {
      PLT_ECS_REGION: 'us-east-1',
      PLT_ECS_CLUSTER: 'my-cluster',
      PLT_ECS_SUBNETS: 'subnet-a,subnet-b',
      PLT_ECS_SECURITY_GROUPS: 'sg-1',
      PLT_ECS_EXECUTION_ROLE_ARN: 'arn:aws:iam::123456789012:role/exec',
      PLT_ECS_LOG_GROUP: '/plt/apps',
      ...config
    },
    log: { debug () {}, info () {}, warn () {}, error () {} }
  })

  const ecsMock = mockClient(ECSClient)
  ecsMock.on(RegisterTaskDefinitionCommand).resolves({ taskDefinition: { taskDefinitionArn: TASK_DEF_ARN } })
  ecsMock.on(DescribeServicesCommand).resolves({ services: [] })
  ecsMock.on(CreateServiceCommand).resolves({ service: { serviceName: 'my-app-v1', serviceArn: SERVICE_ARN } })
  ecsMock.on(UpdateServiceCommand).resolves({ service: { serviceName: 'my-app-v1', serviceArn: SERVICE_ARN } })
  ecsMock.on(TagResourceCommand).resolves({})
  ecs.ecsClient = ecsMock

  const secretsMock = mockClient(SecretsManagerClient)
  secretsMock.on(CreateSecretCommand).resolves({ ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-app-v1-pull' })
  ecs.secretsClient = secretsMock

  const discoveryMock = mockClient(ServiceDiscoveryClient)
  discoveryMock.on(ListDiscoveryServicesCommand).resolves({ Services: [] })
  discoveryMock.on(CreateDiscoveryServiceCommand).resolves({ Service: { Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-1' } })
  ecs.discoveryClient = discoveryMock

  return { ecs, ecsMock, secretsMock, discoveryMock }
}

test('applyWorkload registers a Fargate task definition from the spec', async () => {
  const { ecs, ecsMock } = buildEcs()

  await ecs.applyWorkload('my-cluster', buildSpec())

  const [call] = ecsMock.commandCalls(RegisterTaskDefinitionCommand)
  const input = call.args[0].input

  assert.strictEqual(input.family, 'my-app-v1')
  assert.strictEqual(input.networkMode, 'awsvpc')
  assert.deepStrictEqual(input.requiresCompatibilities, ['FARGATE'])
  assert.strictEqual(input.executionRoleArn, 'arn:aws:iam::123456789012:role/exec')

  const container = input.containerDefinitions[0]
  assert.strictEqual(container.image, 'registry.example.com/my-app:1.0.0')
  assert.deepStrictEqual(container.portMappings.map(p => p.containerPort), [3042, 9090])
  assert.strictEqual(container.logConfiguration.options['awslogs-group'], '/plt/apps')
})

test('the three k8s probes collapse to one container health check on the metrics port', async () => {
  const { ecs, ecsMock } = buildEcs()

  await ecs.applyWorkload('my-cluster', buildSpec())

  const container = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input.containerDefinitions[0]
  assert.deepStrictEqual(container.healthCheck.command, [
    'CMD-SHELL', 'curl -f http://localhost:9090/status || exit 1'
  ])
  assert.strictEqual(container.healthCheck.startPeriod, 30)
})

test('caller env and ICC-injected env are both passed through, in that order', async () => {
  const { ecs, ecsMock } = buildEcs()

  await ecs.applyWorkload('my-cluster', buildSpec({
    isWorkflow: true,
    platformEnv: [
      { name: 'PLT_DEPLOYMENT_VERSION', value: 'v1' },
      { name: 'PLT_WORLD_APP_ID', value: 'my-app' }
    ]
  }))

  const container = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input.containerDefinitions[0]
  assert.deepStrictEqual(container.environment.map(e => e.name), [
    'FOO', 'PLT_DEPLOYMENT_VERSION', 'PLT_WORLD_APP_ID'
  ])
  // PLT_INSTANCE_ID needs the k8s downward API and has no reader on ECS.
  assert.ok(!container.environment.some(e => e.name === 'PLT_INSTANCE_ID'))
})

test('k8s resource quantities snap up to a valid Fargate cpu/memory pair', async () => {
  const cases = [
    // 750m cpu -> 768 units, snapped up to 1024; 1Gi memory -> the 2048 floor for that cpu.
    [{ limits: { cpu: '750m', memory: '1Gi' } }, { cpu: '1024', memory: '2048' }],
    [{ limits: { cpu: '250m', memory: '512Mi' } }, { cpu: '256', memory: '512' }],
    [{ limits: { cpu: '1', memory: '4Gi' } }, { cpu: '1024', memory: '4096' }],
    [{ limits: { cpu: '2', memory: '8Gi' } }, { cpu: '2048', memory: '8192' }]
  ]

  for (const [resources, expected] of cases) {
    const { ecs, ecsMock } = buildEcs()
    await ecs.applyWorkload('my-cluster', buildSpec({ resources }))
    const input = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input
    assert.deepStrictEqual({ cpu: input.cpu, memory: input.memory }, expected,
      `for ${JSON.stringify(resources)}`)
  }
})

test('a new workload creates a service with the spec labels as tags', async () => {
  const { ecs, ecsMock } = buildEcs()

  const result = await ecs.applyWorkload('my-cluster', buildSpec())

  const input = ecsMock.commandCalls(CreateServiceCommand)[0].args[0].input
  assert.strictEqual(input.serviceName, 'my-app-v1')
  assert.strictEqual(input.desiredCount, 2)
  assert.strictEqual(input.launchType, 'FARGATE')
  assert.deepStrictEqual(input.networkConfiguration.awsvpcConfiguration.subnets, ['subnet-a', 'subnet-b'])
  assert.deepStrictEqual(input.tags, [
    { key: 'app.kubernetes.io/name', value: 'my-app' },
    { key: 'plt.dev/version', value: 'v1' }
  ])
  assert.deepStrictEqual(result, { name: 'my-app-v1', taskDefinitionArn: TASK_DEF_ARN, created: true })
})

test('an existing workload is updated in place rather than recreated', async () => {
  const { ecs, ecsMock } = buildEcs()
  ecsMock.on(DescribeServicesCommand).resolves({
    services: [{ serviceName: 'my-app-v1', serviceArn: SERVICE_ARN, status: 'ACTIVE' }]
  })

  const result = await ecs.applyWorkload('my-cluster', buildSpec())

  assert.strictEqual(ecsMock.commandCalls(CreateServiceCommand).length, 0)
  const input = ecsMock.commandCalls(UpdateServiceCommand)[0].args[0].input
  assert.strictEqual(input.service, 'my-app-v1')
  assert.strictEqual(input.taskDefinition, TASK_DEF_ARN)
  assert.strictEqual(result.created, false)
})

test('a private image puts its credentials in Secrets Manager and references them', async () => {
  const { ecs, ecsMock, secretsMock } = buildEcs()

  await ecs.applyWorkload('my-cluster', buildSpec({
    pullSecret: { registry: 'registry.example.com', username: 'u', password: 'p' }
  }))

  const secretInput = secretsMock.commandCalls(CreateSecretCommand)[0].args[0].input
  assert.strictEqual(secretInput.Name, 'my-app-v1-pull')
  assert.deepStrictEqual(JSON.parse(secretInput.SecretString), { username: 'u', password: 'p' })

  const container = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input.containerDefinitions[0]
  assert.strictEqual(
    container.repositoryCredentials.credentialsParameter,
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-app-v1-pull'
  )
})

test('a public image registers no secret and no repositoryCredentials', async () => {
  const { ecs, ecsMock, secretsMock } = buildEcs()

  await ecs.applyWorkload('my-cluster', buildSpec())

  assert.strictEqual(secretsMock.commandCalls(CreateSecretCommand).length, 0)
  const container = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input.containerDefinitions[0]
  assert.strictEqual(container.repositoryCredentials, undefined)
})

test('a Cloud Map namespace registers the service for in-VPC DNS', async () => {
  const { ecs, ecsMock, discoveryMock } = buildEcs({ PLT_ECS_CLOUD_MAP_NAMESPACE_ID: 'ns-abc' })

  await ecs.applyWorkload('my-cluster', buildSpec())

  const created = discoveryMock.commandCalls(CreateDiscoveryServiceCommand)[0].args[0].input
  assert.strictEqual(created.Name, 'my-app-v1')
  assert.strictEqual(created.NamespaceId, 'ns-abc')

  const input = ecsMock.commandCalls(CreateServiceCommand)[0].args[0].input
  assert.deepStrictEqual(input.serviceRegistries, [
    { registryArn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-1' }
  ])
})

test('an existing Cloud Map service is reused instead of duplicated', async () => {
  const { ecs, discoveryMock } = buildEcs({ PLT_ECS_CLOUD_MAP_NAMESPACE_ID: 'ns-abc' })
  discoveryMock.on(ListDiscoveryServicesCommand).resolves({
    Services: [{ Name: 'my-app-v1', Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-existing' }]
  })

  await ecs.applyWorkload('my-cluster', buildSpec())

  assert.strictEqual(discoveryMock.commandCalls(CreateDiscoveryServiceCommand).length, 0)
})

test('without a Cloud Map namespace the service is created with no registry', async () => {
  const { ecs, ecsMock } = buildEcs()

  await ecs.applyWorkload('my-cluster', buildSpec())

  const input = ecsMock.commandCalls(CreateServiceCommand)[0].args[0].input
  assert.strictEqual(input.serviceRegistries, undefined)
})

test('creating a service without subnets fails with a configuration error', async () => {
  const { ecs } = buildEcs({ PLT_ECS_SUBNETS: '' })

  await assert.rejects(
    () => ecs.applyWorkload('my-cluster', buildSpec()),
    err => err.code === 'MCHNST_CONFIG_ERROR'
  )
})
