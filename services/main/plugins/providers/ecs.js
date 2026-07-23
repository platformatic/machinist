'use strict'

const fp = require('fastify-plugin')
const {
  ECSClient,
  DescribeTasksCommand,
  ListTasksCommand,
  DescribeServicesCommand,
  ListServicesCommand,
  UpdateServiceCommand,
  DeleteServiceCommand,
  TagResourceCommand,
  RegisterTaskDefinitionCommand,
  CreateServiceCommand
} = require('@aws-sdk/client-ecs')
const {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand
} = require('@aws-sdk/client-resource-groups-tagging-api')
const {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand
} = require('@aws-sdk/client-secrets-manager')
const {
  ServiceDiscoveryClient,
  CreateServiceCommand: CreateDiscoveryServiceCommand,
  ListServicesCommand: ListDiscoveryServicesCommand
} = require('@aws-sdk/client-servicediscovery')
const errors = require('../../errors')

const SCHEMA = {
  type: 'object',
  properties: {
    PLT_ECS_REGION: { type: 'string' },
    PLT_ECS_CLUSTER: { type: 'string' },
    PLT_ECS_ENDPOINT: { type: 'string' },
    // Infrastructure the CDK stack provisions and passes in; a task definition
    // cannot be rendered without it, which is why ICC sends a neutral spec and
    // this provider fills in the AWS context (ECS-SUPPORT.md D1).
    PLT_ECS_SUBNETS: { type: 'string' },
    PLT_ECS_SECURITY_GROUPS: { type: 'string' },
    PLT_ECS_EXECUTION_ROLE_ARN: { type: 'string' },
    PLT_ECS_TASK_ROLE_ARN: { type: 'string' },
    PLT_ECS_LOG_GROUP: { type: 'string' },
    // Cloud Map namespace for handler addressing (ECS-SUPPORT.md D3). Without
    // it services are created without a registry and are only reachable via a
    // load balancer.
    PLT_ECS_CLOUD_MAP_NAMESPACE_ID: { type: 'string' }
  },
  required: ['PLT_ECS_REGION', 'PLT_ECS_CLUSTER']
}

// Fargate only accepts fixed CPU values, each with a bounded memory range.
const FARGATE_CPU = [256, 512, 1024, 2048, 4096, 8192, 16384]
const FARGATE_MEMORY_RANGE = {
  256: [512, 2048],
  512: [1024, 4096],
  1024: [2048, 8192],
  2048: [4096, 16384],
  4096: [8192, 30720],
  8192: [16384, 61440],
  16384: [32768, 122880]
}

// '512Mi' / '1Gi' / '1024' -> MiB.
function toMiB (value) {
  const s = String(value).trim()
  const n = parseFloat(s)
  if (Number.isNaN(n)) return null
  if (s.endsWith('Gi')) return Math.round(n * 1024)
  if (s.endsWith('G')) return Math.round((n * 1000 ** 3) / 1024 ** 2)
  if (s.endsWith('Mi')) return Math.round(n)
  if (s.endsWith('M')) return Math.round((n * 1000 ** 2) / 1024 ** 2)
  if (s.endsWith('Ki')) return Math.round(n / 1024)
  return Math.round(n / 1024 ** 2)
}

// '500m' / '1' / '1.5' -> ECS CPU units, where 1024 is one vCPU.
function toCpuUnits (value) {
  const s = String(value).trim()
  const n = parseFloat(s)
  if (Number.isNaN(n)) return null
  return Math.round(s.endsWith('m') ? (n / 1000) * 1024 : n * 1024)
}

// Snap a requested cpu/memory pair onto the nearest valid Fargate combination,
// always rounding up so a workload never gets less than it asked for.
function toFargateSize (resources) {
  const wantCpu = toCpuUnits(resources?.limits?.cpu ?? resources?.requests?.cpu ?? '500m') ?? 512
  const wantMem = toMiB(resources?.limits?.memory ?? resources?.requests?.memory ?? '1Gi') ?? 1024

  for (const cpu of FARGATE_CPU) {
    if (cpu < wantCpu) continue
    const [minMem, maxMem] = FARGATE_MEMORY_RANGE[cpu]
    if (wantMem > maxMem) continue
    return { cpu: String(cpu), memory: String(Math.max(minMem, wantMem)) }
  }

  const largest = FARGATE_CPU[FARGATE_CPU.length - 1]
  return { cpu: String(largest), memory: String(FARGATE_MEMORY_RANGE[largest][1]) }
}

class Ecs {
  #cluster

  constructor ({ config, log }) {
    this.log = log
    this.config = config
    this.#cluster = config.PLT_ECS_CLUSTER

    const clientConfig = { region: config.PLT_ECS_REGION }
    // Unset in production; points at an AWS emulator in tests.
    if (config.PLT_ECS_ENDPOINT) {
      clientConfig.endpoint = config.PLT_ECS_ENDPOINT
    }
    // Public so tests can inject a fake, as the k8s provider does with apiClient.
    this.ecsClient = new ECSClient(clientConfig)
    this.taggingClient = new ResourceGroupsTaggingAPIClient(clientConfig)
    this.secretsClient = new SecretsManagerClient(clientConfig)
    this.discoveryClient = new ServiceDiscoveryClient(clientConfig)
  }

  async init () {
    this.log.debug('Initializing ECS provider')
  }

  // ── Machine operations ──

  async getMachine (namespace, machineId) {
    const { tasks, failures } = await this.ecsClient.send(new DescribeTasksCommand({
      cluster: namespace,
      tasks: [machineId],
      include: ['TAGS']
    }))

    if (failures?.length > 0 || !tasks?.length) {
      const reason = failures?.[0]?.reason || 'Task not found'
      const err = new Error(`Task not found: ${machineId} — ${reason}`)
      err.statusCode = 404
      throw err
    }

    return this.#formatMachine(tasks[0])
  }

  async getMachines (namespace, labels = {}) {
    const hasLabels = Object.keys(labels).length > 0

    let taskArns
    if (hasLabels) {
      taskArns = await this.#findResourcesByTags('ecs:task', labels)
      if (taskArns.length === 0) return []
    } else {
      taskArns = await this.#listAllTaskArns(namespace)
      if (taskArns.length === 0) return []
    }

    return this.#describeTasksBatched(namespace, taskArns)
  }

  async setMachineLabels (namespace, machineId, labels) {
    // machineId could be a short ID — resolve to full ARN
    const arn = await this.#resolveTaskArn(namespace, machineId)

    const tags = Object.entries(labels).map(([key, value]) => ({
      key, value
    }))

    await this.ecsClient.send(new TagResourceCommand({
      resourceArn: arn,
      tags
    }))
  }

  // ── Controller operations ──

  async getControllers (namespace, machineId) {
    if (machineId) {
      const machine = await this.getMachine(namespace, machineId)
      if (!machine.controller) return []

      const controller = await this.getController(namespace, machine.controller.name)
      return [controller]
    }

    // List all services in the cluster
    const serviceArns = await this.#listAllServiceArns(namespace)
    if (serviceArns.length === 0) return []

    const controllers = []
    // DescribeServices accepts max 10 at a time
    for (let i = 0; i < serviceArns.length; i += 10) {
      const batch = serviceArns.slice(i, i + 10)
      const { services } = await this.ecsClient.send(new DescribeServicesCommand({
        cluster: namespace,
        services: batch,
        include: ['TAGS']
      }))

      for (const svc of services) {
        if (svc.status !== 'ACTIVE') continue
        controllers.push({
          name: svc.serviceName,
          replicas: svc.desiredCount,
          labels: this.#tagsToLabels(svc.tags),
          providerMetadata: {}
        })
      }
    }

    return controllers
  }

  async getController (namespace, name) {
    const { services, failures } = await this.ecsClient.send(new DescribeServicesCommand({
      cluster: namespace,
      services: [name],
      include: ['TAGS']
    }))

    if (failures?.length > 0 || !services?.length) {
      const reason = failures?.[0]?.reason || 'Service not found'
      const err = new Error(`Controller not found: ${name} — ${reason}`)
      err.statusCode = 404
      throw err
    }

    const svc = services[0]

    // Get tasks belonging to this service
    const taskArns = await this.#listAllTaskArns(namespace, name)
    let machines = []
    if (taskArns.length > 0) {
      machines = await this.#describeTasksBatched(namespace, taskArns)
    }

    return {
      name: svc.serviceName,
      replicas: svc.desiredCount,
      labels: this.#tagsToLabels(svc.tags),
      providerMetadata: {},
      machines
    }
  }

  async updateControllerReplicas (namespace, name, replicaCount) {
    const { service } = await this.ecsClient.send(new UpdateServiceCommand({
      cluster: namespace,
      service: name,
      desiredCount: replicaCount
    }))

    return {
      name: service.serviceName,
      replicas: service.desiredCount,
      labels: this.#tagsToLabels(service.tags),
      providerMetadata: {}
    }
  }

  async deleteController (namespace, name) {
    await this.ecsClient.send(new DeleteServiceCommand({
      cluster: namespace,
      service: name,
      force: true
    }))
  }

  // ── Service operations ──

  async getServicesByLabels (namespace, labels) {
    const serviceArns = await this.#findResourcesByTags('ecs:service', labels)
    if (serviceArns.length === 0) return []

    const result = []
    for (let i = 0; i < serviceArns.length; i += 10) {
      const batch = serviceArns.slice(i, i + 10)
      const { services } = await this.ecsClient.send(new DescribeServicesCommand({
        cluster: namespace,
        services: batch,
        include: ['TAGS']
      }))

      for (const svc of services) {
        result.push(this.#formatServiceEndpoint(svc))
      }
    }

    return result
  }

  async deleteService (namespace, name) {
    // In ECS, the "service" and the "controller" are the same resource.
    // deleteController already handles this. This method exists for
    // interface compatibility — e.g., when icc-3 deletes a K8s Service
    // (networking resource) separately from a Deployment.
    // For ECS it's a no-op since deleteController already removed everything.
    this.log.debug({ namespace, name }, 'deleteService is a no-op for ECS (handled by deleteController)')
  }

  // ── Workload creation ──

  // Render ICC's provider-neutral workload spec into a task definition plus a
  // service. ECS collapses the k8s Deployment and Service into one resource, so
  // this replaces both applyDeployment and applyService (ECS-SUPPORT.md D4).
  async applyWorkload (namespace, spec) {
    const taskDefinitionArn = await this.#registerTaskDefinition(spec)
    const registries = await this.#resolveServiceRegistries(spec)
    const existing = await this.#findService(namespace, spec.name)

    const tags = Object.entries(spec.labels ?? {}).map(([key, value]) => ({ key, value }))
    const desiredCount = spec.minReplicas ?? 1

    if (existing) {
      // Registries and network config are fixed at creation; only the task
      // definition and the replica count can change on an update.
      const { service } = await this.ecsClient.send(new UpdateServiceCommand({
        cluster: namespace,
        service: spec.name,
        taskDefinition: taskDefinitionArn,
        desiredCount
      }))
      if (tags.length > 0) {
        await this.ecsClient.send(new TagResourceCommand({ resourceArn: service.serviceArn, tags }))
      }
      return { name: service.serviceName, taskDefinitionArn, created: false }
    }

    const { service } = await this.ecsClient.send(new CreateServiceCommand({
      cluster: namespace,
      serviceName: spec.name,
      taskDefinition: taskDefinitionArn,
      desiredCount,
      launchType: 'FARGATE',
      networkConfiguration: this.#networkConfiguration(),
      ...(registries.length > 0 ? { serviceRegistries: registries } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      propagateTags: 'SERVICE',
      enableECSManagedTags: true
    }))

    return { name: service.serviceName, taskDefinitionArn, created: true }
  }

  async #registerTaskDefinition (spec) {
    const { cpu, memory } = toFargateSize(spec.resources)
    const metricsPort = spec.ports?.metrics ?? 9090
    const appPort = spec.ports?.app ?? 3042

    const container = {
      name: spec.name,
      image: spec.image,
      essential: true,
      portMappings: [
        { containerPort: appPort, protocol: 'tcp', name: 'app' },
        { containerPort: metricsPort, protocol: 'tcp', name: 'metrics' }
      ],
      // K8s has three probes; ECS has one container health check. Readiness for
      // routing is the target group's own check, so this covers liveness.
      healthCheck: {
        command: ['CMD-SHELL', `curl -f http://localhost:${metricsPort}${spec.healthCheck?.livePath ?? '/status'} || exit 1`],
        interval: 15,
        timeout: 5,
        retries: 3,
        startPeriod: 30
      },
      environment: [...(spec.env ?? []), ...(spec.platformEnv ?? [])]
    }

    const credentialsArn = await this.#ensurePullCredentials(spec)
    if (credentialsArn) {
      container.repositoryCredentials = { credentialsParameter: credentialsArn }
    }

    if (this.config.PLT_ECS_LOG_GROUP) {
      container.logConfiguration = {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': this.config.PLT_ECS_LOG_GROUP,
          'awslogs-region': this.config.PLT_ECS_REGION,
          'awslogs-stream-prefix': spec.appName ?? spec.name
        }
      }
    }

    const { taskDefinition } = await this.ecsClient.send(new RegisterTaskDefinitionCommand({
      family: spec.name,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu,
      memory,
      ...(this.config.PLT_ECS_EXECUTION_ROLE_ARN ? { executionRoleArn: this.config.PLT_ECS_EXECUTION_ROLE_ARN } : {}),
      ...(this.config.PLT_ECS_TASK_ROLE_ARN ? { taskRoleArn: this.config.PLT_ECS_TASK_ROLE_ARN } : {}),
      containerDefinitions: [container]
    }))

    return taskDefinition.taskDefinitionArn
  }

  // K8s pulls private images with a dockerconfigjson Secret; ECS needs the
  // credentials in Secrets Manager and referenced from the task definition.
  async #ensurePullCredentials (spec) {
    if (!spec.pullSecret) return null

    const { username, password } = spec.pullSecret
    const name = `${spec.name}-pull`
    const secretString = JSON.stringify({ username, password })

    try {
      const { ARN } = await this.secretsClient.send(new CreateSecretCommand({ Name: name, SecretString: secretString }))
      return ARN
    } catch (err) {
      if (err.name !== 'ResourceExistsException') throw err
      const { ARN } = await this.secretsClient.send(new PutSecretValueCommand({ SecretId: name, SecretString: secretString }))
      return ARN
    }
  }

  // Cloud Map gives app tasks a stable in-VPC DNS name, which is how ICC
  // addresses workflow handlers on ECS (ECS-SUPPORT.md D3).
  async #resolveServiceRegistries (spec) {
    const namespaceId = this.config.PLT_ECS_CLOUD_MAP_NAMESPACE_ID
    if (!namespaceId) return []

    const { Services } = await this.discoveryClient.send(new ListDiscoveryServicesCommand({
      Filters: [{ Name: 'NAMESPACE_ID', Values: [namespaceId], Condition: 'EQ' }]
    }))

    const found = Services?.find(s => s.Name === spec.name)
    if (found) return [{ registryArn: found.Arn }]

    const { Service } = await this.discoveryClient.send(new CreateDiscoveryServiceCommand({
      Name: spec.name,
      NamespaceId: namespaceId,
      DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 60 }] }
    }))

    return [{ registryArn: Service.Arn }]
  }

  #networkConfiguration () {
    const subnets = (this.config.PLT_ECS_SUBNETS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const securityGroups = (this.config.PLT_ECS_SECURITY_GROUPS ?? '').split(',').map(s => s.trim()).filter(Boolean)

    if (subnets.length === 0) {
      throw new errors.ConfigError('PLT_ECS_SUBNETS is required to create an ECS service')
    }

    return {
      awsvpcConfiguration: {
        subnets,
        ...(securityGroups.length > 0 ? { securityGroups } : {}),
        assignPublicIp: 'DISABLED'
      }
    }
  }

  async #findService (namespace, name) {
    const { services } = await this.ecsClient.send(new DescribeServicesCommand({
      cluster: namespace,
      services: [name]
    }))
    return services?.find(s => s.status === 'ACTIVE') ?? null
  }

  // ── Skew protection ──
  //
  // K8s uses Gateway API (Gateway + HTTPRoute) for canary traffic routing.
  // ECS equivalent would be ALB listener rules with weighted target groups,
  // but this is not yet designed/implemented. Throw 501 so the caller sees
  // a clear "not supported" instead of a TypeError 500.
  //
  // TODO(ecs): Design provider-agnostic traffic routing abstraction.

  async listGateways () {
    throw new errors.NotImplementedByProvider('Skew protection (listGateways)', 'ecs')
  }

  async applyHTTPRoute () {
    throw new errors.NotImplementedByProvider('Skew protection (applyHTTPRoute)', 'ecs')
  }

  async getHTTPRoute () {
    throw new errors.NotImplementedByProvider('Skew protection (getHTTPRoute)', 'ecs')
  }

  async deleteHTTPRoute () {
    throw new errors.NotImplementedByProvider('Skew protection (deleteHTTPRoute)', 'ecs')
  }

  // K8s image-pull secrets have no ECS analog: ECS pulls private images via a
  // task-definition repositoryCredentials (a Secrets Manager ARN), set when the
  // task is registered, not as a standalone resource.
  async applySecret () {
    throw new errors.NotImplementedByProvider('Image pull secret (applySecret)', 'ecs')
  }

  // ── Private helpers ──

  #formatMachine (task) {
    const output = {
      id: this.#shortTaskId(task.taskArn),
      status: task.lastStatus,
      startTime: task.startedAt?.toISOString(),
      labels: this.#tagsToLabels(task.tags)
    }

    // Controller: parse from task.group ("service:<name>")
    if (task.group?.startsWith('service:')) {
      output.controller = { name: task.group.substring('service:'.length) }
    }

    // Image + resources from first container
    if (task.containers?.length > 0) {
      output.image = task.containers[0].image
      // The content-addressed digest ECS resolved for the running image
      // (DescribeTasks -> containers[].imageDigest), the analog of the k8s
      // provider's status.imageID.
      if (task.containers[0].imageDigest) {
        output.imageDigest = task.containers[0].imageDigest
      }
    }

    // Task-level resources (ECS has no requests/limits distinction)
    if (task.cpu || task.memory) {
      const resources = {}
      if (task.cpu || task.memory) {
        resources.limits = {
          cpu: task.cpu || '0',
          memory: task.memory || '0'
        }
        resources.requests = resources.limits
      }
      output.resources = resources
    }

    // ECS analog of the k8s pod Ready condition: RUNNING and not failing its health
    // check (healthStatus is UNKNOWN when no check is defined -> RUNNING is enough).
    output.ready = task.lastStatus === 'RUNNING' && task.healthStatus !== 'UNHEALTHY'

    return output
  }

  #formatServiceEndpoint (svc) {
    const ports = []

    // Extract port from load balancer config
    if (svc.loadBalancers?.length > 0) {
      for (const lb of svc.loadBalancers) {
        if (lb.containerPort) {
          ports.push({ port: lb.containerPort, protocol: 'TCP' })
        }
      }
    }

    // Extract port from service registries (Cloud Map)
    if (ports.length === 0 && svc.serviceRegistries?.length > 0) {
      for (const reg of svc.serviceRegistries) {
        if (reg.port) {
          ports.push({ port: reg.port, protocol: 'TCP' })
        }
      }
    }

    return {
      name: svc.serviceName,
      labels: this.#tagsToLabels(svc.tags),
      ports
    }
  }

  #tagsToLabels (tags) {
    if (!tags) return {}
    const labels = {}
    for (const { key, value } of tags) {
      labels[key] = value
    }
    return labels
  }

  #shortTaskId (taskArn) {
    // arn:aws:ecs:region:account:task/cluster/taskId → taskId
    const parts = taskArn.split('/')
    return parts[parts.length - 1]
  }

  async #resolveTaskArn (namespace, machineId) {
    // If already an ARN, return as-is
    if (machineId.startsWith('arn:')) return machineId

    // Otherwise describe to get the full ARN
    const { tasks } = await this.ecsClient.send(new DescribeTasksCommand({
      cluster: namespace,
      tasks: [machineId]
    }))

    if (!tasks?.length) {
      const err = new Error(`Task not found: ${machineId}`)
      err.statusCode = 404
      throw err
    }

    return tasks[0].taskArn
  }

  async #listAllTaskArns (namespace, serviceName) {
    const allArns = []
    let nextToken

    do {
      const params = { cluster: namespace, maxResults: 100, nextToken }
      if (serviceName) params.serviceName = serviceName

      const result = await this.ecsClient.send(new ListTasksCommand(params))
      allArns.push(...(result.taskArns || []))
      nextToken = result.nextToken
    } while (nextToken)

    return allArns
  }

  async #listAllServiceArns (namespace) {
    const allArns = []
    let nextToken

    do {
      const result = await this.ecsClient.send(new ListServicesCommand({
        cluster: namespace,
        maxResults: 100,
        nextToken
      }))
      allArns.push(...(result.serviceArns || []))
      nextToken = result.nextToken
    } while (nextToken)

    return allArns
  }

  async #describeTasksBatched (namespace, taskArns) {
    const machines = []

    // DescribeTasks accepts max 100 at a time
    for (let i = 0; i < taskArns.length; i += 100) {
      const batch = taskArns.slice(i, i + 100)
      const { tasks } = await this.ecsClient.send(new DescribeTasksCommand({
        cluster: namespace,
        tasks: batch,
        include: ['TAGS']
      }))

      for (const task of (tasks || [])) {
        machines.push(this.#formatMachine(task))
      }
    }

    return machines
  }

  async #findResourcesByTags (resourceType, labels) {
    const tagFilters = Object.entries(labels).map(([key, values]) => ({
      Key: key,
      Values: [values]
    }))

    const allArns = []
    let paginationToken

    do {
      const result = await this.taggingClient.send(new GetResourcesCommand({
        ResourceTypeFilters: [resourceType],
        TagFilters: tagFilters,
        ResourcesPerPage: 100,
        PaginationToken: paginationToken
      }))

      for (const mapping of (result.ResourceTagMappingList || [])) {
        allArns.push(mapping.ResourceARN)
      }

      paginationToken = result.PaginationToken
    } while (paginationToken)

    return allArns
  }
}

async function plugin (fastify, opts) {
  if (fastify.appConfig.PLT_PROVIDER !== 'ecs') return
  fastify.log.info({ PROVIDER: fastify.appConfig.PLT_PROVIDER }, 'Using ECS provider')

  const appConfig = fastify.validateOptions(opts, SCHEMA)

  const ecs = new Ecs({
    config: appConfig,
    log: fastify.log
  })

  await ecs.init()
  fastify.decorate('provider', ecs)
}

module.exports = fp(plugin, {
  name: 'provider-ecs',
  dependencies: ['app-configuration']
})

module.exports.Ecs = Ecs
module.exports.schema = SCHEMA
