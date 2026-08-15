'use strict'

// Tier-2 check: drive the real Ecs provider against an AWS emulator, so the
// calls applyWorkload generates are validated by an actual API implementation
// rather than only by the aws-sdk-client-mock stubs in ecs-apply-workload.test.js.
//
// Opt-in, because it needs a running emulator:
//   docker run -d --rm -p 5111:5000 --name moto motoserver/moto
//   PLT_ECS_TEST_ENDPOINT=http://localhost:5111 npx borp tests/ecs-workload-emulator.test.js
//
// The emulator models the control plane only: no container ever runs, health
// checks never execute, and its tagging API is immediately consistent where the
// real one is not. It proves the requests are well formed, not that AWS behaves
// as expected.

const { test, before, describe } = require('node:test')
const assert = require('node:assert/strict')
const { ECSClient, CreateClusterCommand, DescribeTaskDefinitionCommand, DescribeServicesCommand } = require('@aws-sdk/client-ecs')
const { ServiceDiscoveryClient, CreatePrivateDnsNamespaceCommand, ListNamespacesCommand, ListServicesCommand } = require('@aws-sdk/client-servicediscovery')
const { EC2Client, CreateVpcCommand, CreateSubnetCommand, CreateSecurityGroupCommand } = require('@aws-sdk/client-ec2')
const { Ecs } = require('../plugins/providers/ecs')

const ENDPOINT = process.env.PLT_ECS_TEST_ENDPOINT
const CLUSTER = 'plt-emulator-test'

describe('ECS workload against an emulator', { skip: ENDPOINT ? false : 'set PLT_ECS_TEST_ENDPOINT to run' }, () => {
  const cfg = { region: 'us-east-1', endpoint: ENDPOINT }
  let namespaceId
  let subnetId
  let securityGroupId

  before(async () => {
    process.env.AWS_ACCESS_KEY_ID ??= 'test'
    process.env.AWS_SECRET_ACCESS_KEY ??= 'test'

    await new ECSClient(cfg).send(new CreateClusterCommand({ clusterName: CLUSTER }))

    // The emulator validates that the subnet exists, so provision real ones. It
    // also requires securityGroups on the network configuration, which real ECS
    // treats as optional, so provision one of those too.
    const ec2 = new EC2Client(cfg)
    const { Vpc } = await ec2.send(new CreateVpcCommand({ CidrBlock: '10.0.0.0/16' }))
    const { Subnet } = await ec2.send(new CreateSubnetCommand({ VpcId: Vpc.VpcId, CidrBlock: '10.0.1.0/24' }))
    subnetId = Subnet.SubnetId
    const { GroupId } = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: 'plt-emulator-sg', Description: 'emulator test', VpcId: Vpc.VpcId
    }))
    securityGroupId = GroupId

    const sd = new ServiceDiscoveryClient(cfg)
    const { Namespaces } = await sd.send(new ListNamespacesCommand({}))
    const existing = Namespaces?.find(n => n.Name === 'plt-emulator.local')
    if (existing) {
      namespaceId = existing.Id
    } else {
      await sd.send(new CreatePrivateDnsNamespaceCommand({ Name: 'plt-emulator.local', Vpc: Vpc.VpcId }))
      const { Namespaces: after } = await sd.send(new ListNamespacesCommand({}))
      namespaceId = after.find(n => n.Name === 'plt-emulator.local').Id
    }
  })

  function buildEcs () {
    return new Ecs({
      config: {
        PLT_ECS_REGION: 'us-east-1',
        PLT_ECS_CLUSTER: CLUSTER,
        PLT_ECS_ENDPOINT: ENDPOINT,
        PLT_ECS_SUBNETS: subnetId,
        PLT_ECS_SECURITY_GROUPS: securityGroupId,
        PLT_ECS_LOG_GROUP: '/plt/apps',
        PLT_ECS_CLOUD_MAP_NAMESPACE_ID: namespaceId
      },
      log: { debug () {}, info () {}, warn () {}, error () {} }
    })
  }

  function buildSpec (name, overrides = {}) {
    return {
      name,
      appName: 'my-app',
      version: 'v1',
      deploymentVersion: 'v1',
      image: 'registry.example.com/my-app:1.0.0',
      isWorkflow: true,
      minReplicas: 2,
      pullSecret: { registry: 'registry.example.com', username: 'u', password: 'p' },
      ports: { app: 3042, metrics: 9090 },
      resources: { limits: { memory: '1Gi', cpu: '750m' } },
      healthCheck: { readyPath: '/ready', livePath: '/status', port: 'metrics' },
      env: [{ name: 'FOO', value: 'bar' }],
      platformEnv: [
        { name: 'PLT_DEPLOYMENT_VERSION', value: 'v1' },
        { name: 'PLT_WORLD_APP_ID', value: 'my-app' }
      ],
      labels: { 'app.kubernetes.io/name': 'my-app', 'plt.dev/version': 'v1' },
      ...overrides
    }
  }

  test('AWS accepts the rendered task definition and service', async () => {
    const ecs = buildEcs()
    const name = 'emulator-create'

    const result = await ecs.applyWorkload(CLUSTER, buildSpec(name))
    assert.strictEqual(result.created, true)

    const client = new ECSClient(cfg)
    const { taskDefinition } = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: name }))
    assert.strictEqual(taskDefinition.cpu, '1024')
    assert.strictEqual(taskDefinition.memory, '2048')

    const container = taskDefinition.containerDefinitions[0]
    assert.deepStrictEqual(container.portMappings.map(p => p.containerPort), [3042, 9090])
    assert.match(container.healthCheck.command[1], /localhost:9090\/status/)
    assert.deepStrictEqual(container.environment.map(e => e.name), [
      'FOO', 'PLT_DEPLOYMENT_VERSION', 'PLT_WORLD_APP_ID'
    ])
    assert.ok(container.repositoryCredentials.credentialsParameter.startsWith('arn:aws:secretsmanager:'))
    assert.strictEqual(container.logConfiguration.options['awslogs-group'], '/plt/apps')

    const { services } = await client.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [name] }))
    assert.strictEqual(services[0].desiredCount, 2)
    assert.strictEqual(services[0].serviceRegistries.length, 1)
  })

  test('re-applying updates the existing service instead of duplicating it', async () => {
    const ecs = buildEcs()
    const name = 'emulator-update'

    await ecs.applyWorkload(CLUSTER, buildSpec(name))
    const again = await ecs.applyWorkload(CLUSTER, buildSpec(name, { minReplicas: 4 }))
    assert.strictEqual(again.created, false)

    const client = new ECSClient(cfg)
    const { services } = await client.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [name] }))
    assert.strictEqual(services[0].desiredCount, 4)

    // The Cloud Map service is reused, not registered a second time.
    const { Services } = await new ServiceDiscoveryClient(cfg).send(new ListServicesCommand({}))
    assert.strictEqual(Services.filter(s => s.Name === name).length, 1)
  })
})
