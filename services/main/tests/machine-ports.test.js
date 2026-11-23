'use strict'

// Unit tests for getMachinePorts: the K8s API and the ECS client are stubbed, no cluster is needed.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mockClient } = require('aws-sdk-client-mock')
const {
  ECSClient,
  DescribeTasksCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand
} = require('@aws-sdk/client-ecs')
const {
  ElasticLoadBalancingV2Client,
  DescribeTargetGroupsCommand,
  DescribeListenersCommand,
  DescribeRulesCommand
} = require('@aws-sdk/client-elastic-load-balancing-v2')
const { K8s } = require('../plugins/providers/k8s')
const { Ecs } = require('../plugins/providers/ecs')

const log = { debug () {}, info () {}, warn () {}, error () {} }

function buildK8s (pod, services) {
  const k8s = new K8s({
    config: {
      PLT_K8S_REST_API_URL: 'http://k8s.local',
      PLT_K8S_ALLOW_SELFSIGNED_CERT: true
    },
    log,
    caContent: '',
    tokenPath: 'test',
    authType: 'token',
    clientCreds: {}
  })

  k8s.apiClient.request = async (path) => {
    if (path === '/api/v1/namespaces/default/pods/pod-1') return pod
    if (path === '/api/v1/namespaces/default/services') return { items: services }
    throw new Error(`unexpected request ${path}`)
  }
  return k8s
}

function buildEcs (responses, elbResponses = []) {
  const ecs = new Ecs({
    config: { PLT_ECS_REGION: 'us-east-1', PLT_ECS_CLUSTER: 'my-cluster' },
    log
  })
  const ecsMock = mockClient(ECSClient)
  for (const [command, response] of responses) {
    ecsMock.on(command).resolves(response)
  }
  ecs.ecsClient = ecsMock

  const elbMock = mockClient(ElasticLoadBalancingV2Client)
  for (const [command, input, response] of elbResponses) {
    elbMock.on(command, input).resolves(response)
  }
  ecs.elbClient = elbMock
  return ecs
}

const pod = {
  metadata: { labels: { 'app.kubernetes.io/name': 'my-app', 'plt.dev/version': 'v1' } },
  spec: {
    containers: [{
      name: 'app',
      ports: [
        { name: 'app', containerPort: 3042 },
        { name: 'metrics', containerPort: 9090 }
      ]
    }]
  }
}

test('K8s#getMachinePorts maps the ports of the Services selecting the pod to the container ports', async () => {
  const k8s = buildK8s(pod, [
    {
      // Named target ports, resolved through the pod's container ports
      spec: {
        selector: { 'app.kubernetes.io/name': 'my-app' },
        ports: [
          { port: 80, targetPort: 'app' },
          { port: 9090, targetPort: 'metrics' }
        ]
      }
    },
    {
      // A numeric target port, and a port without targetPort (it defaults to port)
      spec: {
        selector: { 'app.kubernetes.io/name': 'my-app', 'plt.dev/version': 'v1' },
        ports: [{ port: 8080, targetPort: 3043 }, { port: 4000 }]
      }
    },
    {
      // Selects other pods
      spec: { selector: { 'app.kubernetes.io/name': 'other-app' }, ports: [{ port: 80, targetPort: 5000 }] }
    },
    {
      // No selector: endpoints managed by hand
      spec: { ports: [{ port: 80, targetPort: 6000 }] }
    }
  ])

  assert.deepStrictEqual(await k8s.getMachinePorts('default', 'pod-1'), [
    { port: 80, targetPort: 3042 },
    { port: 9090, targetPort: 9090 },
    { port: 8080, targetPort: 3043 },
    { port: 4000, targetPort: 4000 }
  ])
})

test('K8s#getMachinePorts skips a named target port the pod does not declare', async () => {
  const k8s = buildK8s(pod, [{
    spec: {
      selector: { 'app.kubernetes.io/name': 'my-app' },
      ports: [{ port: 80, targetPort: 'http' }, { port: 81, targetPort: 'app' }]
    }
  }])

  assert.deepStrictEqual(await k8s.getMachinePorts('default', 'pod-1'), [{ port: 81, targetPort: 3042 }])
})

test('K8s#getMachinePorts returns no ports when no Service selects the pod', async () => {
  const k8s = buildK8s(pod, [])
  assert.deepStrictEqual(await k8s.getMachinePorts('default', 'pod-1'), [])
})

const task = {
  taskArn: 'arn:aws:ecs:us-east-1:123456789:task/my-cluster/abc123',
  group: 'service:my-service',
  taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789:task-definition/my-app:1'
}

const taskDefinition = {
  containerDefinitions: [{
    portMappings: [{ containerPort: 3042 }, { containerPort: 9090 }]
  }]
}

const targetGroupArn = 'arn:aws:elasticloadbalancing:us-east-1:123456789:targetgroup/my-app/1'
const loadBalancerArn = 'arn:aws:elasticloadbalancing:us-east-1:123456789:loadbalancer/app/my-lb/1'

test('Ecs#getMachinePorts maps the listeners forwarding to the service target group to the container port', async () => {
  const forward = [{ Type: 'forward', TargetGroupArn: targetGroupArn }]
  const ecs = buildEcs([
    [DescribeTasksCommand, { tasks: [task], failures: [] }],
    [DescribeServicesCommand, {
      services: [{
        serviceName: 'my-service',
        loadBalancers: [{ targetGroupArn, containerPort: 3042 }],
        taskDefinition: task.taskDefinitionArn
      }]
    }]
  ], [
    [DescribeTargetGroupsCommand, {}, { TargetGroups: [{ LoadBalancerArns: [loadBalancerArn] }] }],
    [DescribeListenersCommand, {}, {
      Listeners: [
        // Forwards by its default action
        { ListenerArn: 'listener-443', Port: 443, DefaultActions: forward },
        // Forwards by a rule
        { ListenerArn: 'listener-80', Port: 80, DefaultActions: [{ Type: 'fixed-response' }] },
        // Does not forward to the target group
        { ListenerArn: 'listener-8080', Port: 8080, DefaultActions: [{ Type: 'fixed-response' }] }
      ]
    }],
    [DescribeRulesCommand, { ListenerArn: 'listener-80' }, { Rules: [{ Actions: forward }] }],
    [DescribeRulesCommand, { ListenerArn: 'listener-8080' }, { Rules: [{ Actions: [{ Type: 'redirect' }] }] }]
  ])

  assert.deepStrictEqual(await ecs.getMachinePorts('my-cluster', 'abc123'), [
    { port: 443, targetPort: 3042 },
    { port: 80, targetPort: 3042 }
  ])
})

test('Ecs#getMachinePorts has no port for a load balancer without listeners forwarding to it', async () => {
  const ecs = buildEcs([
    [DescribeTasksCommand, { tasks: [task], failures: [] }],
    [DescribeServicesCommand, {
      services: [{ serviceName: 'my-service', loadBalancers: [{ targetGroupArn, containerPort: 3042 }] }]
    }]
  ], [
    [DescribeTargetGroupsCommand, {}, { TargetGroups: [{ LoadBalancerArns: [] }] }]
  ])

  assert.deepStrictEqual(await ecs.getMachinePorts('my-cluster', 'abc123'), [{ port: null, targetPort: 3042 }])
})

test('Ecs#getMachinePorts maps the Cloud Map registries', async () => {
  const ecs = buildEcs([
    [DescribeTasksCommand, { tasks: [task], failures: [] }],
    [DescribeServicesCommand, {
      services: [{ serviceName: 'my-service', serviceRegistries: [{ port: 3042 }] }]
    }]
  ])

  assert.deepStrictEqual(await ecs.getMachinePorts('my-cluster', 'abc123'), [{ port: 3042, targetPort: 3042 }])
})

test('Ecs#getMachinePorts falls back to the task definition ports', async () => {
  const ecs = buildEcs([
    [DescribeTasksCommand, { tasks: [task], failures: [] }],
    [DescribeServicesCommand, {
      services: [{ serviceName: 'my-service', taskDefinition: task.taskDefinitionArn }]
    }],
    [DescribeTaskDefinitionCommand, { taskDefinition }]
  ])

  assert.deepStrictEqual(await ecs.getMachinePorts('my-cluster', 'abc123'), [
    { port: null, targetPort: 3042 },
    { port: null, targetPort: 9090 }
  ])
})

test('Ecs#getMachinePorts uses the task definition for a task outside a service', async () => {
  const ecs = buildEcs([
    [DescribeTasksCommand, { tasks: [{ ...task, group: 'family:my-app' }], failures: [] }],
    [DescribeTaskDefinitionCommand, { taskDefinition }]
  ])

  assert.deepStrictEqual(await ecs.getMachinePorts('my-cluster', 'abc123'), [
    { port: null, targetPort: 3042 },
    { port: null, targetPort: 9090 }
  ])
})

test('Ecs#getMachinePorts throws 404 for an unknown task', async () => {
  const ecs = buildEcs([
    [DescribeTasksCommand, { tasks: [], failures: [{ reason: 'MISSING' }] }]
  ])

  await assert.rejects(ecs.getMachinePorts('my-cluster', 'abc123'), (err) => err.statusCode === 404)
})
