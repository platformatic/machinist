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
  TagResourceCommand
} = require('@aws-sdk/client-ecs')
const {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand
} = require('@aws-sdk/client-resource-groups-tagging-api')

const SCHEMA = {
  type: 'object',
  properties: {
    PLT_ECS_REGION: { type: 'string' },
    PLT_ECS_CLUSTER: { type: 'string' }
  },
  required: ['PLT_ECS_REGION', 'PLT_ECS_CLUSTER']
}

class Ecs {
  #ecs
  #tagging
  #cluster

  constructor ({ config, log }) {
    this.log = log
    this.config = config
    this.#cluster = config.PLT_ECS_CLUSTER

    const clientConfig = { region: config.PLT_ECS_REGION }
    this.#ecs = new ECSClient(clientConfig)
    this.#tagging = new ResourceGroupsTaggingAPIClient(clientConfig)
  }

  async init () {
    this.log.debug('Initializing ECS provider')
  }

  // ── Machine operations ──

  async getMachine (scope, machineId) {
    const { tasks, failures } = await this.#ecs.send(new DescribeTasksCommand({
      cluster: scope,
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

  async getMachines (scope, labels = {}) {
    const hasLabels = Object.keys(labels).length > 0

    let taskArns
    if (hasLabels) {
      taskArns = await this.#findResourcesByTags('ecs:task', labels)
      if (taskArns.length === 0) return []
    } else {
      taskArns = await this.#listAllTaskArns(scope)
      if (taskArns.length === 0) return []
    }

    return this.#describeTasksBatched(scope, taskArns)
  }

  async setMachineLabels (scope, machineId, labels) {
    // machineId could be a short ID — resolve to full ARN
    const arn = await this.#resolveTaskArn(scope, machineId)

    const tags = Object.entries(labels).map(([key, value]) => ({
      key, value
    }))

    await this.#ecs.send(new TagResourceCommand({
      resourceArn: arn,
      tags
    }))
  }

  // ── Controller operations ──

  async getControllers (scope, machineId) {
    if (machineId) {
      const machine = await this.getMachine(scope, machineId)
      if (!machine.controller) return []

      const controller = await this.getController(scope, machine.controller.name)
      return [controller]
    }

    // List all services in the cluster
    const serviceArns = await this.#listAllServiceArns(scope)
    if (serviceArns.length === 0) return []

    const controllers = []
    // DescribeServices accepts max 10 at a time
    for (let i = 0; i < serviceArns.length; i += 10) {
      const batch = serviceArns.slice(i, i + 10)
      const { services } = await this.#ecs.send(new DescribeServicesCommand({
        cluster: scope,
        services: batch,
        include: ['TAGS']
      }))

      for (const svc of services) {
        if (svc.status !== 'ACTIVE') continue
        controllers.push({
          name: svc.serviceName,
          replicas: svc.desiredCount,
          labels: this.#tagsToLabels(svc.tags)
        })
      }
    }

    return controllers
  }

  async getController (scope, name) {
    const { services, failures } = await this.#ecs.send(new DescribeServicesCommand({
      cluster: scope,
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
    const taskArns = await this.#listAllTaskArns(scope, name)
    let machines = []
    if (taskArns.length > 0) {
      machines = await this.#describeTasksBatched(scope, taskArns)
    }

    return {
      name: svc.serviceName,
      replicas: svc.desiredCount,
      labels: this.#tagsToLabels(svc.tags),
      machines
    }
  }

  async updateControllerReplicas (scope, name, replicaCount) {
    const { service } = await this.#ecs.send(new UpdateServiceCommand({
      cluster: scope,
      service: name,
      desiredCount: replicaCount
    }))

    return {
      name: service.serviceName,
      replicas: service.desiredCount,
      labels: this.#tagsToLabels(service.tags)
    }
  }

  async deleteController (scope, name) {
    await this.#ecs.send(new DeleteServiceCommand({
      cluster: scope,
      service: name,
      force: true
    }))
  }

  // ── Service operations ──

  async getServicesByLabels (scope, labels) {
    const serviceArns = await this.#findResourcesByTags('ecs:service', labels)
    if (serviceArns.length === 0) return []

    const result = []
    for (let i = 0; i < serviceArns.length; i += 10) {
      const batch = serviceArns.slice(i, i + 10)
      const { services } = await this.#ecs.send(new DescribeServicesCommand({
        cluster: scope,
        services: batch,
        include: ['TAGS']
      }))

      for (const svc of services) {
        result.push(this.#formatServiceEndpoint(svc))
      }
    }

    return result
  }

  async deleteService (scope, name) {
    // In ECS, the "service" and the "controller" are the same resource.
    // deleteController already handles this. This method exists for
    // interface compatibility — e.g., when icc-3 deletes a K8s Service
    // (networking resource) separately from a Deployment.
    // For ECS it's a no-op since deleteController already removed everything.
    this.log.debug({ scope, name }, 'deleteService is a no-op for ECS (handled by deleteController)')
  }

  // ── Skew protection ──
  // TODO(ecs): Design provider-agnostic traffic routing abstraction.
  // K8s uses Gateway API (listGateways, applyHTTPRoute, deleteHTTPRoute).
  // ECS equivalent: ALB listener rules with weighted target groups.

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

  async #resolveTaskArn (scope, machineId) {
    // If already an ARN, return as-is
    if (machineId.startsWith('arn:')) return machineId

    // Otherwise describe to get the full ARN
    const { tasks } = await this.#ecs.send(new DescribeTasksCommand({
      cluster: scope,
      tasks: [machineId]
    }))

    if (!tasks?.length) {
      const err = new Error(`Task not found: ${machineId}`)
      err.statusCode = 404
      throw err
    }

    return tasks[0].taskArn
  }

  async #listAllTaskArns (scope, serviceName) {
    const allArns = []
    let nextToken

    do {
      const params = { cluster: scope, maxResults: 100, nextToken }
      if (serviceName) params.serviceName = serviceName

      const result = await this.#ecs.send(new ListTasksCommand(params))
      allArns.push(...(result.taskArns || []))
      nextToken = result.nextToken
    } while (nextToken)

    return allArns
  }

  async #listAllServiceArns (scope) {
    const allArns = []
    let nextToken

    do {
      const result = await this.#ecs.send(new ListServicesCommand({
        cluster: scope,
        maxResults: 100,
        nextToken
      }))
      allArns.push(...(result.serviceArns || []))
      nextToken = result.nextToken
    } while (nextToken)

    return allArns
  }

  async #describeTasksBatched (scope, taskArns) {
    const machines = []

    // DescribeTasks accepts max 100 at a time
    for (let i = 0; i < taskArns.length; i += 100) {
      const batch = taskArns.slice(i, i + 100)
      const { tasks } = await this.#ecs.send(new DescribeTasksCommand({
        cluster: scope,
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
      const result = await this.#tagging.send(new GetResourcesCommand({
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
  name: 'provider',
  dependencies: ['app-configuration']
})

module.exports.Ecs = Ecs
module.exports.schema = SCHEMA
