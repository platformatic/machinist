'use strict'

const { setTimeout } = require('node:timers/promises')
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
  DescribeTaskDefinitionCommand,
  CreateServiceCommand
} = require('@aws-sdk/client-ecs')
const {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand
} = require('@aws-sdk/client-resource-groups-tagging-api')
const {
  ElasticLoadBalancingV2Client,
  DescribeListenersCommand,
  DescribeRulesCommand,
  DescribeTagsCommand,
  CreateRuleCommand,
  DeleteRuleCommand,
  DescribeTargetHealthCommand,
  CreateTargetGroupCommand,
  DescribeTargetGroupsCommand,
  DeleteTargetGroupCommand,
  DescribeLoadBalancersCommand
} = require('@aws-sdk/client-elastic-load-balancing-v2')
const {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
  RestoreSecretCommand
} = require('@aws-sdk/client-secrets-manager')
const {
  ServiceDiscoveryClient,
  CreateServiceCommand: CreateDiscoveryServiceCommand,
  ListServicesCommand: ListDiscoveryServicesCommand,
  DeleteServiceCommand: DeleteDiscoveryServiceCommand,
  ListInstancesCommand,
  DeregisterInstanceCommand,
  GetNamespaceCommand,
  GetServiceCommand
} = require('@aws-sdk/client-servicediscovery')
const albRules = require('../../lib/alb-rules')
const { createHash } = require('node:crypto')
const errors = require('../../errors')

const SCHEMA = {
  type: 'object',
  properties: {
    PLT_ECS_REGION: { type: 'string' },
    PLT_ECS_CLUSTER: { type: 'string' },
    // The ALB listener ICC routes through, provisioned by the deployment's own
    // CDK stack rather than by machinist (ECS-SUPPORT.md D2). Optional: without
    // it there is no gateway to discover and routing stays off, which mirrors a
    // Kubernetes cluster with no Gateway resource.
    PLT_ECS_LISTENER_ARN: { type: 'string' },
    // Base backoff between attempts when a concurrent reconcile takes the
    // priorities we allocated. Kept small on purpose: the retry window is time
    // during which this application has no rules on the listener, because each
    // attempt deletes before it creates.
    PLT_ECS_PRIORITY_RETRY_BASE_MS: { type: 'number', default: 100 },
    // Backoff while a resource AWS is deleting asynchronously becomes usable
    // again: a Cloud Map service whose instances are still deregistering, and a
    // secret name still held by a forced deletion.
    PLT_ECS_CLEANUP_RETRY_BASE_MS: { type: 'number', default: 500 },
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

// ALB target group names are capped at 32 characters, alphanumeric and hyphens,
// and may not start or end with one. Service names obey none of that, so the
// name is truncated and disambiguated with a digest of the original: two
// versions whose names differ only past the cutoff must not land on one target
// group, which would route both to the same tasks.
function targetGroupName (serviceName) {
  const digest = createHash('sha256').update(serviceName).digest('hex').slice(0, 6)
  const safe = serviceName.replace(/[^a-zA-Z0-9-]/g, '-').replace(/^-+/, '')
  return `${safe.slice(0, 25).replace(/-+$/, '')}-${digest}`
}

// ECS service names, task-definition families and container names allow letters,
// numbers, underscores and hyphens -- and not dots. A semantic version label
// produces `my-app-v1.2.3`, which is a perfectly valid Kubernetes name and a
// rejected ECS one. They are also capped at 255 characters.
//
// Normalised here rather than upstream: the Kubernetes names are already in use,
// and changing how they are built would rename live Deployments and orphan them.
// Every name ICC later holds for an ECS workload comes back from this provider,
// so normalising at the boundary keeps both sides consistent.
//
// A name that had to be changed carries a digest of the original, because both
// normalisation and truncation are lossy: `v1.2.3` and `v1-2-3` would otherwise
// become one service, and so would any two names sharing their first 255
// characters. Names that need no change are left exactly as they are, which is
// every name ICC generates today.
// Cloud Map deletion budget: the instances are deregistered directly, so this
// only covers the propagation delay rather than waiting out an ECS drain.
const DISCOVERY_DELETE_ATTEMPTS = 4

// A forced secret deletion is asynchronous, so recreating the same name can be
// refused for a moment afterwards.
const SECRET_ATTEMPTS = 4
const BOOTSTRAP_PURPOSE_TAG = 'plt.dev/purpose'
const BOOTSTRAP_PURPOSE_VALUE = 'bootstrap'

function ecsName (name) {
  const original = String(name)
  const safe = original.replace(/[^a-zA-Z0-9_-]/g, '-')
  if (safe === original && safe.length <= 255) return safe

  const digest = createHash('sha256').update(original).digest('hex').slice(0, 6)
  return `${safe.slice(0, 248)}-${digest}`
}

class Ecs {
  #cluster
  #listenerArn
  #vpcId = null
  #cloudMapNamespace = null
  #cloudMapServiceNames = new Map()
  #portsByTaskDefinition = new Map()
  #routeApplyTails = new Map()
  #retryBaseMs
  #cleanupRetryBaseMs
  #warnedNoListener = false

  constructor ({ config, log }) {
    this.log = log
    this.config = config
    this.#cluster = config.PLT_ECS_CLUSTER

    this.#listenerArn = config.PLT_ECS_LISTENER_ARN || null
    this.#retryBaseMs = config.PLT_ECS_PRIORITY_RETRY_BASE_MS ?? 100
    this.#cleanupRetryBaseMs = config.PLT_ECS_CLEANUP_RETRY_BASE_MS ?? 500

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
    this.elbClient = new ElasticLoadBalancingV2Client(clientConfig)
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

    const serviceLabels = await this.#serviceLabelsFor(namespace, tasks)
    return this.#formatMachine(tasks[0], serviceLabels.get(this.#serviceNameOf(tasks[0])))
  }

  async getMachines (namespace, labels = {}) {
    const hasLabels = Object.keys(labels).length > 0

    let taskArns
    if (hasLabels) {
      taskArns = await this.#findResourcesByTags('ecs:task', labels)
      // An empty result usually means the tags are on the services rather than
      // that nothing matches: ECS does not propagate tags to tasks unless the
      // service opts in with `propagateTags`, whose default is NONE. Look there
      // before concluding the application has no machines.
      if (taskArns.length === 0) {
        taskArns = await this.#taskArnsForTaggedServices(namespace, labels)
      }
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
    const serviceName = ecsName(name)

    await this.ecsClient.send(new DeleteServiceCommand({
      cluster: namespace,
      service: serviceName,
      force: true
    }))

    // Everything applyWorkload created for this version goes with it. One
    // version deploys per release, so anything left behind accumulates for as
    // long as the application exists.
    await this.#deleteTargetGroup(serviceName)
    await this.#deleteDiscoveryService(serviceName)
    await this.#deletePullSecret(serviceName)
  }

  // The Cloud Map service registered for this workload.
  //
  // Cloud Map refuses to delete a service while any instance is still
  // registered, and ECS deregisters the task instances asynchronously after its
  // own service is deleted -- so the obvious "delete it straight after" loses
  // that race almost every time. The instances are deregistered here first,
  // which is safe because the ECS service that owned them is already gone, and
  // the delete is then retried while that propagates.
  async #deleteDiscoveryService (serviceName) {
    const namespaceId = this.config.PLT_ECS_CLOUD_MAP_NAMESPACE_ID
    if (!namespaceId) return

    try {
      const found = await this.#findDiscoveryService(namespaceId, serviceName)
      if (!found) return

      await this.#deregisterInstances(found.Id)

      for (let attempt = 1; attempt <= DISCOVERY_DELETE_ATTEMPTS; attempt++) {
        try {
          await this.discoveryClient.send(new DeleteDiscoveryServiceCommand({ Id: found.Id }))
          return
        } catch (err) {
          // Deregistration is itself asynchronous, so the service can still
          // read as in use for a moment after the instances are gone.
          if (err.name !== 'ResourceInUse' || attempt === DISCOVERY_DELETE_ATTEMPTS) throw err
          await setTimeout(this.#cleanupRetryBaseMs * 2 ** (attempt - 1))
          await this.#deregisterInstances(found.Id)
        }
      }
    } catch (err) {
      // Reported rather than thrown, as with the target group: the ECS service
      // is already gone, and failing here would tell the caller the version is
      // still up.
      this.log.warn({
        err, serviceName
      }, 'could not delete the Cloud Map service; it will remain registered until removed')
    }
  }

  async #deregisterInstances (serviceId) {
    for (const instance of await this.#listInstances(serviceId)) {
      try {
        await this.discoveryClient.send(new DeregisterInstanceCommand({
          ServiceId: serviceId, InstanceId: instance.Id
        }))
      } catch (err) {
        // ECS is deregistering the same instance: the operation is already in
        // flight, which is the outcome wanted. Anything else abandons the
        // delete, and this used to escape and do exactly that.
        if (err.name === 'DuplicateRequest' || err.name === 'InstanceNotFound') continue
        throw err
      }
    }
  }

  // The registry credentials secret, if this workload was deployed from a
  // private image.
  //
  // Deleted outright rather than scheduled. A scheduled deletion keeps the name
  // reserved for its recovery window -- 30 days by default -- and a secret in
  // that state can be neither created nor updated, so redeploying the same
  // version would fail for a month. The recovery window buys nothing here
  // either: the credentials arrive with each deploy request, so ICC can always
  // write the secret again.
  async #deletePullSecret (serviceName) {
    try {
      await this.secretsClient.send(new DeleteSecretCommand({
        SecretId: `${serviceName}-pull`,
        ForceDeleteWithoutRecovery: true
      }))
    } catch (err) {
      // No secret is the normal case: only private images have one.
      if (err.name === 'ResourceNotFoundException') return
      this.log.warn({ err, serviceName }, 'could not delete the image pull secret')
    }
  }

  // The version's target group goes with the version. Target groups per load
  // balancer is 100 and is not adjustable, so one leaked per expired version is
  // what eventually stops the cluster from being able to deploy at all.
  async #deleteTargetGroup (serviceName) {
    if (!this.#listenerArn) return

    const targetGroupArn = await this.#findTargetGroup(targetGroupName(serviceName))
    if (!targetGroupArn) return

    try {
      // Usually ICC has already removed the route plan. This also covers a
      // deployment that failed or was deleted before registration: its
      // bootstrap rule is still the association that would make AWS reject
      // DeleteTargetGroup. Only ICC-owned rules pointing at this exact group
      // are touched; customer rules on the shared listener remain intact.
      const { mine } = await this.#partitionRules()
      for (const rule of mine.filter(rule => this.#ruleTargets(rule, targetGroupArn))) {
        await this.elbClient.send(new DeleteRuleCommand({ RuleArn: rule.RuleArn }))
      }
      await this.elbClient.send(new DeleteTargetGroupCommand({ TargetGroupArn: targetGroupArn }))
    } catch (err) {
      // A target group still referenced by a listener rule cannot be deleted.
      // Routing is torn down before the workload, so reaching here means that
      // removal did not land. Reported rather than thrown: the service is
      // already gone, and failing now would leave the caller believing the
      // version is still up. The group is tagged, so it can be swept.
      this.log.warn({
        err, serviceName, targetGroupArn
      }, 'could not delete the version target group; it will count against the per-load-balancer quota until removed')
    }
  }

  #ruleTargets (rule, targetGroupArn) {
    return (rule.Actions ?? []).some(action =>
      action.TargetGroupArn === targetGroupArn ||
      (action.ForwardConfig?.TargetGroups ?? []).some(group => group.TargetGroupArn === targetGroupArn)
    )
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
        result.push(await this.#formatServiceEndpoint(svc))
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
    spec = { ...spec, name: ecsName(spec.name) }

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

    // Attached here or never: adding `loadBalancers` to a running service is an
    // UpdateService that restarts its tasks, which on a draining version would
    // destroy exactly the sessions skew protection exists to preserve. Creation
    // is the only moment it is free (ECS-SUPPORT.md D5, skew plan F2).
    const targetGroup = await this.#ensureTargetGroup(spec)
    const loadBalancer = targetGroup
      ? {
          targetGroupArn: targetGroup.targetGroupArn,
          containerName: targetGroup.containerName,
          containerPort: targetGroup.containerPort
        }
      : null

    let service
    try {
      const created = await this.ecsClient.send(new CreateServiceCommand({
        cluster: namespace,
        serviceName: spec.name,
        taskDefinition: taskDefinitionArn,
        desiredCount,
        launchType: 'FARGATE',
        networkConfiguration: this.#networkConfiguration(),
        ...(registries.length > 0 ? { serviceRegistries: registries } : {}),
        ...(loadBalancer ? { loadBalancers: [loadBalancer] } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        propagateTags: 'SERVICE',
        enableECSManagedTags: true
      }))
      service = created.service
    } catch (err) {
      // The bootstrap rule exists only to satisfy CreateService's ALB
      // validation. If creation fails, remove it before the new target group;
      // otherwise the rule pins the group and AWS refuses to delete it.
      await this.#rollbackTargetGroupBootstrap(targetGroup)
      throw err
    }

    return {
      name: service.serviceName,
      taskDefinitionArn,
      created: true,
      // Absent rather than undefined when nothing is routed, so a deployment
      // without a listener returns exactly what it returned before.
      ...(loadBalancer ? { targetGroupArn: loadBalancer.targetGroupArn } : {}),
      // Where the workload can be reached from inside the VPC. ICC needs an
      // address to register workflow handlers at, and on ECS there is no
      // name-based convention to fall back on as there is on Kubernetes.
      ...(await this.#endpointOf(spec, registries))
    }
  }

  // One target group per version, which is what makes the version addressable
  // by a listener rule. applyRoutePlan reads it back off the service, so a
  // workload created without one cannot be routed to at all.
  //
  // Skipped when no listener is configured: without somewhere to attach the
  // rules, a target group per version would only consume the per-load-balancer
  // quota, which is 100 and cannot be raised.
  async #ensureTargetGroup (spec) {
    if (!this.#listenerArn) return null

    const appPort = spec.ports?.app ?? 3042
    const name = targetGroupName(spec.name)

    const existing = await this.#findTargetGroup(name)
    if (existing) {
      const bootstrapRuleArn = await this.#createTargetGroupBootstrap(spec, existing)
      return {
        targetGroupArn: existing,
        containerName: spec.name,
        containerPort: appPort,
        bootstrapRuleArn,
        targetGroupCreated: false
      }
    }

    // The health check mirrors the Kubernetes readiness probe rather than the
    // container health check: this is what decides whether the ALB will send
    // the version traffic. Checking the wrong port would mark every target
    // unhealthy and applyRoutePlan would then refuse to route to it.
    const metricsPort = spec.ports?.metrics ?? 9090
    const healthCheckPort = spec.healthCheck?.port === 'metrics' ? String(metricsPort) : 'traffic-port'

    const { TargetGroups } = await this.elbClient.send(new CreateTargetGroupCommand({
      Name: name,
      Protocol: 'HTTP',
      Port: appPort,
      VpcId: await this.#loadBalancerVpcId(),
      TargetType: 'ip',
      HealthCheckProtocol: 'HTTP',
      HealthCheckPath: spec.healthCheck?.readyPath ?? '/',
      HealthCheckPort: healthCheckPort,
      // The ALB defaults are 30s x 5, so a version would sit unroutable for two
      // and a half minutes after its tasks are already serving -- and routing
      // waits for a healthy target, so that is added to every deployment. These
      // are still well above the 5s minimum.
      HealthCheckIntervalSeconds: 10,
      HealthCheckTimeoutSeconds: 5,
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 2,
      Tags: [
        { Key: albRules.MANAGED_BY_TAG, Value: albRules.MANAGED_BY_VALUE },
        ...(spec.appName ? [{ Key: albRules.APPLICATION_TAG, Value: spec.appName }] : []),
        ...(spec.labels?.['plt.dev/version']
          ? [{ Key: albRules.VERSION_TAG, Value: spec.labels['plt.dev/version'] }]
          : [])
      ]
    }))

    const targetGroupArn = TargetGroups[0].TargetGroupArn
    this.log.info({ name, targetGroupArn, service: spec.name }, 'created a target group for the version')

    let bootstrapRuleArn
    try {
      bootstrapRuleArn = await this.#createTargetGroupBootstrap(spec, targetGroupArn)
    } catch (err) {
      // A group that was never associated cannot be useful to this workload,
      // and leaving it behind consumes the hard per-load-balancer quota.
      try {
        await this.elbClient.send(new DeleteTargetGroupCommand({ TargetGroupArn: targetGroupArn }))
      } catch (cleanupErr) {
        this.log.error({ err: cleanupErr, targetGroupArn },
          'failed to remove a target group after its bootstrap rule could not be created')
      }
      throw err
    }

    return {
      targetGroupArn,
      containerName: spec.name,
      containerPort: appPort,
      bootstrapRuleArn,
      targetGroupCreated: true
    }
  }

  // ECS refuses CreateService when its target group is not already associated
  // with a load balancer. The actual query/header/default rules cannot exist
  // yet: ICC only learns about the version after its first task starts and
  // registers. This deliberately unmatchable rule bridges that ordering gap.
  // It uses the normal ownership tags, so applyRoutePlan's first full resync
  // deletes it and installs the real rules.
  async #createTargetGroupBootstrap (spec, targetGroupArn) {
    const appName = spec.appName ?? spec.labels?.['app.kubernetes.io/name'] ?? spec.name
    const versionId = spec.labels?.['plt.dev/version']
    const hostname = spec.labels?.['plt.dev/hostname']
    const token = createHash('sha256').update(`${spec.name}:${targetGroupArn}`).digest('hex').slice(0, 16)
    const conditions = [
      ...(hostname
        ? [{ Field: 'host-header', HostHeaderConfig: { Values: [hostname] } }]
        : []),
      {
        Field: 'http-header',
        HttpHeaderConfig: { HttpHeaderName: 'x-platformatic-bootstrap', Values: [token] }
      }
    ]

    const MAX_ATTEMPTS = 3
    let lastError
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { Rules } = await this.elbClient.send(new DescribeRulesCommand({
        ListenerArn: this.#listenerArn
      }))
      const priority = albRules.allocatePriorityBase(1,
        (Rules ?? []).filter(rule => !rule.IsDefault).map(rule => rule.Priority))

      try {
        const { Rules: created } = await this.elbClient.send(new CreateRuleCommand({
          ListenerArn: this.#listenerArn,
          Priority: priority,
          Conditions: conditions,
          Actions: [{ Type: 'forward', TargetGroupArn: targetGroupArn }],
          Tags: [
            ...albRules.tagsFor({ appName }, versionId),
            { Key: BOOTSTRAP_PURPOSE_TAG, Value: BOOTSTRAP_PURPOSE_VALUE }
          ]
        }))
        const ruleArn = created?.[0]?.RuleArn
        if (!ruleArn) throw new Error('ALB did not return the bootstrap listener rule ARN')
        this.log.info({ appName, versionId, targetGroupArn, ruleArn },
          'associated a version target group with the listener for ECS service creation')
        return ruleArn
      } catch (err) {
        if (err.name !== 'PriorityInUseException') throw err
        lastError = err
        if (attempt < MAX_ATTEMPTS) {
          const backoff = this.#retryBaseMs * (2 ** (attempt - 1))
          const jittered = Math.round(backoff * (0.5 + Math.random()))
          if (jittered > 0) await setTimeout(jittered)
        }
      }
    }
    throw lastError
  }

  async #rollbackTargetGroupBootstrap (targetGroup) {
    if (!targetGroup) return

    if (targetGroup.bootstrapRuleArn) {
      try {
        await this.elbClient.send(new DeleteRuleCommand({ RuleArn: targetGroup.bootstrapRuleArn }))
      } catch (err) {
        this.log.error({ err, ruleArn: targetGroup.bootstrapRuleArn },
          'failed to remove an ECS target-group bootstrap rule after service creation failed')
      }
    }
    if (targetGroup.targetGroupCreated) {
      try {
        await this.elbClient.send(new DeleteTargetGroupCommand({ TargetGroupArn: targetGroup.targetGroupArn }))
      } catch (err) {
        this.log.error({ err, targetGroupArn: targetGroup.targetGroupArn },
          'failed to remove a target group after service creation failed')
      }
    }
  }

  async #findTargetGroup (name) {
    try {
      const { TargetGroups } = await this.elbClient.send(new DescribeTargetGroupsCommand({ Names: [name] }))
      return TargetGroups?.[0]?.TargetGroupArn ?? null
    } catch (err) {
      // The only way to ask "does this exist" is to look and be told no.
      if (err.name === 'TargetGroupNotFoundException') return null
      throw err
    }
  }

  // A target group must sit in the same VPC as the load balancer that fronts
  // it, so the load balancer is the authority on which one that is. Read once:
  // the listener does not move.
  async #loadBalancerVpcId () {
    if (this.#vpcId) return this.#vpcId

    const { Listeners } = await this.elbClient.send(new DescribeListenersCommand({
      ListenerArns: [this.#listenerArn]
    }))
    const loadBalancerArn = Listeners?.[0]?.LoadBalancerArn
    if (!loadBalancerArn) throw new errors.ListenerNotConfigured()

    const { LoadBalancers } = await this.elbClient.send(new DescribeLoadBalancersCommand({
      LoadBalancerArns: [loadBalancerArn]
    }))
    this.#vpcId = LoadBalancers?.[0]?.VpcId
    return this.#vpcId
  }

  // The reachable address of a workload this provider just created.
  async #endpointOf (spec, registries) {
    if (!registries.length) return {}

    const namespaceName = await this.#cloudMapNamespaceName()
    if (!namespaceName) return {}

    return { endpoint: { hostname: `${spec.name}.${namespaceName}`, port: spec.ports?.app ?? 3042 } }
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

    // A name that is going away is the awkward case, and it has two shapes.
    // CreateSecret reports a secret scheduled for deletion as
    // InvalidRequestException rather than ResourceExistsException, and a forced
    // deletion is itself asynchronous, so the name can stay unusable for a
    // moment after machinist has removed it -- which is exactly the window a
    // redeploy of the same version lands in.
    let lastError = null

    for (let attempt = 1; attempt <= SECRET_ATTEMPTS; attempt++) {
      try {
        const { ARN } = await this.secretsClient.send(new CreateSecretCommand({
          Name: name, SecretString: secretString
        }))
        return ARN
      } catch (err) {
        if (err.name === 'ResourceExistsException') {
          const arn = await this.#writeExistingSecret(name, secretString)
          if (arn) return arn
          lastError = err
        } else if (err.name === 'InvalidRequestException') {
          // Either scheduled for deletion, which a restore fixes, or mid-way
          // through a forced one, where only waiting does.
          const arn = await this.#restoreSecret(name, secretString)
          if (arn) return arn
          lastError = err
        } else {
          throw err
        }
      }

      if (attempt < SECRET_ATTEMPTS) await setTimeout(this.#cleanupRetryBaseMs * 2 ** (attempt - 1))
    }

    throw lastError
  }

  // An existing secret takes the new value. If it is scheduled for deletion the
  // write is refused too, so that is the same restore path.
  async #writeExistingSecret (name, secretString) {
    try {
      const { ARN } = await this.secretsClient.send(new PutSecretValueCommand({
        SecretId: name, SecretString: secretString
      }))
      return ARN
    } catch (err) {
      if (err.name !== 'InvalidRequestException') throw err
      return this.#restoreSecret(name, secretString)
    }
  }

  // Returns null rather than throwing when the secret cannot be restored: the
  // caller retries, because a forced deletion in flight resolves on its own.
  async #restoreSecret (name, secretString) {
    try {
      await this.secretsClient.send(new RestoreSecretCommand({ SecretId: name }))
      const { ARN } = await this.secretsClient.send(new PutSecretValueCommand({
        SecretId: name, SecretString: secretString
      }))
      return ARN
    } catch (err) {
      if (err.name === 'ResourceNotFoundException' || err.name === 'InvalidRequestException') return null
      throw err
    }
  }

  // Cloud Map gives app tasks a stable in-VPC DNS name, which is how ICC
  // addresses workflow handlers on ECS (ECS-SUPPORT.md D3).
  // Cloud Map returns at most 100 per page, and one namespace holds a service
  // per version of every application, so the page the workload is on is not the
  // first for long.
  async #findDiscoveryService (namespaceId, serviceName) {
    let NextToken
    do {
      const page = await this.discoveryClient.send(new ListDiscoveryServicesCommand({
        Filters: [{ Name: 'NAMESPACE_ID', Values: [namespaceId], Condition: 'EQ' }],
        NextToken
      }))
      const found = page.Services?.find(s => s.Name === serviceName)
      if (found) return found
      NextToken = page.NextToken
    } while (NextToken)
    return null
  }

  async #listInstances (serviceId) {
    const instances = []
    let NextToken
    do {
      const page = await this.discoveryClient.send(new ListInstancesCommand({
        ServiceId: serviceId, NextToken
      }))
      instances.push(...(page.Instances ?? []))
      NextToken = page.NextToken
    } while (NextToken)
    return instances
  }

  async #resolveServiceRegistries (spec) {
    const namespaceId = this.config.PLT_ECS_CLOUD_MAP_NAMESPACE_ID
    if (!namespaceId) return []

    const found = await this.#findDiscoveryService(namespaceId, spec.name)
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
  // The ECS analogue of a Gateway is the shared ALB listener, and the analogue
  // of an HTTPRoute is the set of listener rules on it. ICC sends a neutral
  // route plan rather than an HTTPRoute, because ALB rules need the listener and
  // target-group ARNs that only this provider holds.
  //
  // See ecs-skew-protection-plan.md (D2, D3).

  // The load balancer name inside a listener ARN, which has the shape
  // arn:...:listener/app/<lb-name>/<lb-id>/<listener-id>. Used only as a
  // human-readable name for the discovered gateway.
  #loadBalancerNameOf (listenerArn) {
    const parts = String(listenerArn).split('/')
    return parts.length > 2 ? parts[2] : listenerArn
  }

  async listGateways (namespace) {
    // Reaching here at all means something is asking where to route: ICC only
    // discovers gateways when skew protection is enabled. On Kubernetes an
    // absent Gateway is a legitimate operator choice, but on ECS an unset
    // listener at this point is almost always the deployment stack failing to
    // pass its ALB listener ARN through, and the symptom -- routing silently
    // does nothing -- gives no clue. Say so, once, rather than at debug level.
    if (!this.#listenerArn) {
      if (!this.#warnedNoListener) {
        this.#warnedNoListener = true
        this.log.warn(
          'PLT_ECS_LISTENER_ARN is not set, so no gateway can be reported and version routing will not be applied. ' +
          'It should carry the ALB listener ARN from the deployment stack outputs.'
        )
      }
      return []
    }

    let listener
    try {
      const { Listeners } = await this.elbClient.send(new DescribeListenersCommand({
        ListenerArns: [this.#listenerArn]
      }))
      listener = Listeners?.[0]
    } catch (err) {
      this.log.error({ err, listenerArn: this.#listenerArn }, 'configured ALB listener could not be described')
      throw err
    }

    if (!listener) {
      this.log.error({ listenerArn: this.#listenerArn }, 'configured ALB listener does not exist')
      return []
    }

    return [{
      metadata: {
        name: this.#loadBalancerNameOf(listener.ListenerArn),
        namespace
      },
      providerMetadata: {
        listenerArn: listener.ListenerArn,
        loadBalancerArn: listener.LoadBalancerArn,
        port: listener.Port,
        protocol: listener.Protocol
      }
    }]
  }

  async applyHTTPRoute () {
    // ICC renders HTTPRoutes only for Kubernetes; this provider takes the
    // neutral plan instead. See applyRoutePlan.
    throw new errors.NotImplementedByProvider('Skew protection (applyHTTPRoute)', 'ecs')
  }

  // ── Route plan (E4, E5) ──

  // A version's target group, read off the ECS service that serves it.
  //
  // Discovered rather than created: attaching a target group is an UpdateService
  // on `loadBalancers`, which restarts the service's tasks. Doing that to a
  // draining version would destroy the pinned sessions skew protection exists to
  // preserve, so attachment is only free at creation time. See plan F2/D5.
  async #targetGroupArnFor (namespace, serviceName) {
    const { services, failures } = await this.ecsClient.send(new DescribeServicesCommand({
      cluster: namespace,
      services: [serviceName]
    }))

    if (failures?.length > 0 || !services?.length) {
      throw new errors.TargetGroupNotFound(serviceName, failures?.[0]?.reason || 'service not found')
    }

    const arn = services[0].loadBalancers?.[0]?.targetGroupArn
    if (!arn) {
      throw new errors.TargetGroupNotFound(serviceName, 'the service is not attached to a target group')
    }
    return arn
  }

  // Target groups for every version named in the plan, keyed by version id.
  async #targetGroupsFor (namespace, plan) {
    const byVersion = new Map()
    for (const rule of plan.rules) {
      if (byVersion.has(rule.versionId)) continue
      byVersion.set(rule.versionId, await this.#targetGroupArnFor(namespace, rule.backend.serviceName))
    }
    return byVersion
  }

  // Whether a target group has at least one healthy target. A rule pointing at
  // an empty target group answers 503 rather than falling through to the active
  // version, which is worse than not having the rule at all.
  async #hasHealthyTarget (targetGroupArn) {
    try {
      const { TargetHealthDescriptions } = await this.elbClient.send(new DescribeTargetHealthCommand({
        TargetGroupArn: targetGroupArn
      }))
      return (TargetHealthDescriptions || []).some(t => t.TargetHealth?.State === 'healthy')
    } catch (err) {
      this.log.error({ err, targetGroupArn }, 'could not read target health')
      return false
    }
  }

  // Applies the plan as a full resync: delete every rule ICC owns for this
  // application on the listener, then create exactly the desired set.
  //
  // A resync rather than a diff because the rules churn on a timer -- a version
  // expiring re-emits a plan with no deploy and no operator involved -- so an
  // interleaved apply must still converge. Deleting first makes the sequence
  // idempotent, one of the two properties `kubectl apply` has for free.
  //
  // It does NOT make it order-independent: a resync converges on whatever plan it
  // carries, so an older plan arriving late would reinstate a drained version.
  // That is what the ordering check below refuses -- by generation where either
  // side has one, by emittedAt only as a fallback; see plan D6. The cost is a short window with no pinning rules, during which
  // pinned requests fall through to the active version; that is strictly better
  // than the 503 a half-applied diff produces. See plan D6.
  async applyRoutePlan (namespace, plan) {
    const key = `${this.#listenerArn}\u0000${plan.appName}`
    const previous = this.#routeApplyTails.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    this.#routeApplyTails.set(key, tail)

    await previous
    try {
      return await this.#applyRoutePlan(namespace, plan)
    } finally {
      release()
      if (this.#routeApplyTails.get(key) === tail) this.#routeApplyTails.delete(key)
    }
  }

  // A full resync is a read/check/delete/create sequence, not an atomic AWS
  // operation. Serialize it per listener/application within this task so two
  // requests cannot both pass the generation check against the same rule set.
  // Separate Machinist tasks are not serialized by a shared lock; their applies
  // are ordered by the generation stamped on the listener rules instead.
  async #applyRoutePlan (namespace, plan) {
    if (!this.#listenerArn) {
      throw new errors.ListenerNotConfigured()
    }

    const targetGroups = await this.#targetGroupsFor(namespace, plan)

    // Preflight every target group BEFORE touching the listener. The resync
    // deletes the live rules and then recreates them, so a default rule whose
    // target group cannot serve would replace a working route with one that
    // answers 503 -- and report success. Checked first, and the whole apply is
    // refused rather than half-applied.
    const healthByVersion = new Map()
    for (const [versionId, targetGroupArn] of targetGroups) {
      healthByVersion.set(versionId, await this.#hasHealthyTarget(targetGroupArn))
    }

    const defaultRule = plan.rules.find(rule => rule.match.kind === 'default')
    if (defaultRule && !healthByVersion.get(defaultRule.versionId)) {
      throw new errors.ActiveTargetGroupUnhealthy(plan.appName, defaultRule.versionId)
    }

    // Pinning rules are different: one unhealthy draining version costs only its
    // own pinning, and those requests fall through to the active version, which
    // preflight has just confirmed can serve them.
    const usable = { ...plan, rules: [] }
    for (const rule of plan.rules) {
      if (rule.match.kind === 'default' || healthByVersion.get(rule.versionId)) {
        usable.rules.push(rule)
      } else {
        this.log.warn({
          appName: plan.appName,
          versionId: rule.versionId
        }, 'target group has no healthy target; omitting its pinning rule')
      }
    }

    // Priorities are allocated against what the listener actually holds, so two
    // applications cannot land on the same numbers and the customer's own rules
    // are respected. Our current rules are excluded from the occupied set: they
    // are freed by the deletes below, and reusing them keeps a stable
    // application on stable priorities across reconciles.
    //
    // Reading occupancy and creating are not atomic, so two reconciles running
    // at once can allocate the same free block and the loser gets
    // PriorityInUse -- after it has already deleted its own rules, which would
    // leave that application with no routing at all. Retry on that error only,
    // removing anything this attempt created first so the listener never keeps
    // a half-applied plan.
    const MAX_ATTEMPTS = 3
    let lastError = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { mine, others } = await this.#partitionRules(plan.appName)

      // Refuse to move the listener backwards. Plans churn on a timer and are
      // also emitted from request paths on any ICC replica, so two can be in
      // flight at once; a resync carrying an older plan would otherwise delete
      // the current rules and reinstate a superseded active version.
      //
      // This must FAIL, not skip. ICC treats only a thrown error as a failed
      // apply, so a success would let it confirm a version whose route was never
      // installed, or tear down a backend the listener is still serving -- the
      // control plane and the ALB would then disagree with nothing to reconcile
      // them. Failing leaves the version in pending-apply, and the checker
      // retries with a freshly built plan.
      //
      if (!albRules.isPlanCurrent(plan, mine)) {
        // Report whichever ordering actually decided it. The generation is the
        // real one; the clock is only consulted when neither side has a
        // generation, so leading with a timestamp would point a reader at a value
        // that had no bearing on the rejection.
        const appliedGeneration = albRules.latestGeneration(mine)
        const byGeneration = appliedGeneration !== null || Number.isFinite(plan.generation)
        const incoming = byGeneration ? plan.generation : plan.emittedAt
        const applied = byGeneration ? appliedGeneration : albRules.latestEmittedAt(mine)

        this.log.warn({
          appName: plan.appName,
          orderedBy: byGeneration ? 'generation' : 'emittedAt',
          incoming: incoming ?? null,
          applied
        }, 'refusing a stale route plan; the listener already carries a newer one')
        throw new errors.StaleRoutePlan(
          plan.appName,
          `${byGeneration ? 'generation' : 'emittedAt'} ${incoming ?? 'absent'}`,
          String(applied)
        )
      }

      // A workload creates its bootstrap rule before it can register with ICC,
      // so a concurrent reconcile still carries the old plan. Preserve
      // bootstrap rules for versions absent from that plan; deleting one in
      // this window makes ECS reject the pending CreateService. Once the
      // version appears in the plan, this resync replaces its bootstrap rule
      // with the real route like every other owned rule.
      const plannedVersions = new Set(plan.rules.map(rule => rule.versionId))
      const preserved = mine.filter(rule =>
        this.#isBootstrapRule(rule) && !plannedVersions.has(this.#ruleTag(rule, albRules.VERSION_TAG)))
      const replaced = mine.filter(rule => !preserved.includes(rule))
      const desired = albRules.renderRules(usable, targetGroups, {
        priorityBase: albRules.allocatePriorityBase(
          usable.rules.length,
          [...others, ...preserved].map(rule => rule.Priority)
        )
      })

      for (const rule of replaced) {
        await this.elbClient.send(new DeleteRuleCommand({ RuleArn: rule.RuleArn }))
      }

      const created = []
      try {
        for (const rule of desired) {
          const { Rules } = await this.elbClient.send(new CreateRuleCommand({
            ListenerArn: this.#listenerArn,
            Priority: rule.Priority,
            Conditions: rule.Conditions,
            Actions: rule.Actions,
            Tags: rule.Tags
          }))
          created.push(Rules?.[0]?.RuleArn)
        }

        this.log.info({
          appName: plan.appName,
          deleted: replaced.length,
          created: created.length,
          attempt
        }, 'route plan resynced onto the ALB listener')

        return { appName: plan.appName, deleted: replaced.length, created: created.length }
      } catch (err) {
        if (err.name !== 'PriorityInUseException') throw err
        lastError = err

        // Undo this attempt before re-reading, or its rules would be counted as
        // occupied and push the next allocation further along for no reason.
        for (const arn of created.filter(Boolean)) {
          await this.elbClient.send(new DeleteRuleCommand({ RuleArn: arn }))
            .catch((cleanupErr) => this.log.error({ err: cleanupErr, arn },
              'failed to remove a rule created by a losing attempt'))
        }

        // Back off before re-reading, with jitter. Without it two reconciles
        // retry in lockstep and can chase each other up the priority range,
        // each taking the block the other just allocated, until both give up.
        // Jitter is what breaks the lockstep; the exponential part keeps a
        // busy listener from being hammered.
        //
        // Deliberately short: every attempt deletes this application's rules
        // before creating, so the whole retry sequence is time it is unrouted.
        // Bounded attempts times a small base is the trade being made here.
        if (attempt < MAX_ATTEMPTS) {
          const backoff = this.#retryBaseMs * (2 ** (attempt - 1))
          const jittered = Math.round(backoff * (0.5 + Math.random()))
          this.log.warn({
            appName: plan.appName,
            attempt,
            backoffMs: jittered
          }, 'listener priorities were taken by a concurrent reconcile; backing off and reallocating')
          if (jittered > 0) await setTimeout(jittered)
        }
      }
    }

    throw lastError
  }

  // Every non-default rule on the listener, split into the ones ICC owns for this
  // application and everything else. Both halves are needed: `mine` is what the
  // resync deletes, `others` is what its priorities must avoid.
  async #partitionRules (appName) {
    const { Rules } = await this.elbClient.send(new DescribeRulesCommand({
      ListenerArn: this.#listenerArn
    }))

    // The default listener rule cannot be tagged or deleted, and is never ours.
    const candidates = (Rules || []).filter(rule => rule.RuleArn && !rule.IsDefault)
    if (candidates.length === 0) return { mine: [], others: [] }

    const tagsByArn = new Map()
    // DescribeTags accepts at most 20 resource ARNs per call.
    for (let i = 0; i < candidates.length; i += 20) {
      const batch = candidates.slice(i, i + 20)
      const { TagDescriptions } = await this.elbClient.send(new DescribeTagsCommand({
        ResourceArns: batch.map(r => r.RuleArn)
      }))
      for (const desc of (TagDescriptions || [])) {
        tagsByArn.set(desc.ResourceArn, desc.Tags || [])
      }
    }

    const mine = []
    const others = []
    for (const rule of candidates) {
      const tagged = { ...rule, Tags: tagsByArn.get(rule.RuleArn) || [] }
      ;(albRules.isManagedRule(tagged, appName) ? mine : others).push(tagged)
    }
    return { mine, others }
  }

  // Rules on the listener that ICC owns for this application. Identified by tag,
  // so rules the customer manages on the same listener are never removed.
  //
  // Two calls, not one: DescribeRules does NOT return tags -- an elbv2 Rule is
  // only { RuleArn, Priority, Conditions, Actions, IsDefault, Transforms } -- so
  // tags have to be fetched separately with DescribeTags and merged back.
  async #managedRulesFor (appName) {
    const { mine } = await this.#partitionRules(appName)
    return mine
  }

  #ruleTag (rule, key) {
    return (rule.Tags ?? []).find(tag => tag.Key === key)?.Value
  }

  #isBootstrapRule (rule) {
    return this.#ruleTag(rule, BOOTSTRAP_PURPOSE_TAG) === BOOTSTRAP_PURPOSE_VALUE
  }

  // The live routing for an application, expressed in the same plan vocabulary
  // ICC sends. Reconstructed from the listener rules ICC owns rather than from a
  // stored copy, so it reflects what is actually serving traffic.
  //
  // Returns null when the application has no rules at all, which is how the
  // caller distinguishes "never routed" from "routed to something else".
  async getHTTPRoute (namespace, name) {
    if (!this.#listenerArn) return null

    // The bootstrap association is infrastructure, not part of the live route
    // plan. Reporting it as a header rule would make a pre-registration
    // version appear routed when it is not.
    const rules = (await this.#managedRulesFor(name)).filter(rule => !this.#isBootstrapRule(rule))
    if (rules.length === 0) return null

    // ALB returns rules in priority order within a listener; the plan's own
    // order is priority order too, so this round-trips.
    const planRules = rules.map(rule => ({
      versionId: this.#ruleTag(rule, albRules.VERSION_TAG),
      match: { kind: this.#matchKindOf(rule) }
    }))

    return { appName: name, rules: planRules }
  }

  // Which plan match a live rule came from, read back off its conditions.
  #matchKindOf (rule) {
    const fields = new Set((rule.Conditions || []).map(c => c.Field))
    if (fields.has('query-string')) return 'queryParam'
    if (fields.has('http-header')) return 'header'
    return 'default'
  }

  // Removes every rule ICC owns for the application, leaving the listener and
  // anything the customer manages on it untouched.
  async deleteHTTPRoute (namespace, name) {
    if (!this.#listenerArn) return {}

    const rules = await this.#managedRulesFor(name)
    for (const rule of rules) {
      await this.elbClient.send(new DeleteRuleCommand({ RuleArn: rule.RuleArn }))
    }

    this.log.info({ appName: name, deleted: rules.length }, 'removed ICC-managed listener rules')
    return { appName: name, deleted: rules.length }
  }

  // K8s image-pull secrets have no ECS analog: ECS pulls private images via a
  // task-definition repositoryCredentials (a Secrets Manager ARN), set when the
  // task is registered, not as a standalone resource.
  async applySecret () {
    throw new errors.NotImplementedByProvider('Image pull secret (applySecret)', 'ecs')
  }

  // ── Private helpers ──

  // `fallbackLabels` are the parent service's tags, used when the task carries
  // none. ECS does not propagate tags to tasks unless the service opts in with
  // `propagateTags`, whose default is NONE, so a task with no tags is the normal
  // case rather than an error. Without this the caller sees a machine with no
  // labels at all and version detection silently finds nothing.
  #formatMachine (task, fallbackLabels = null) {
    const taskLabels = this.#tagsToLabels(task.tags)
    const output = {
      id: this.#shortTaskId(task.taskArn),
      status: task.lastStatus,
      startTime: task.startedAt?.toISOString(),
      labels: Object.keys(taskLabels).length > 0 ? taskLabels : (fallbackLabels ?? {})
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

  async #formatServiceEndpoint (svc) {
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

    // Neither source has a port for the common case: a Cloud Map A-record
    // registration carries only its registryArn, and a service with no load
    // balancer has no containerPort either. The task definition always knows,
    // and a caller with no port cannot build a URL, so ask it.
    if (ports.length === 0 && svc.taskDefinition) {
      for (const port of await this.#containerPortsOf(svc.taskDefinition)) {
        ports.push({ port, protocol: 'TCP' })
      }
    }

    return {
      name: svc.serviceName,
      // Where this service can actually be reached from inside the VPC, which
      // is the ECS analogue of a Kubernetes service's cluster DNS name. Callers
      // that build URLs (workflow handler registration) need an address, and
      // there is nothing name-based to fall back to as there is on Kubernetes.
      ...(await this.#cloudMapHostname(svc)),
      labels: this.#tagsToLabels(svc.tags),
      ports
    }
  }

  // The DNS name Cloud Map gives a service: `<service>.<namespace>`. Null when
  // the service has no registry, which is a deployment without Cloud Map
  // configured rather than an error.
  async #cloudMapHostname (svc) {
    if (!svc.serviceRegistries?.length) return {}

    const namespaceName = await this.#cloudMapNamespaceName()
    if (!namespaceName) return {}

    const registryArn = svc.serviceRegistries[0]?.registryArn
    const serviceId = registryArn?.split('/').at(-1)
    if (!serviceId) return {}

    let serviceName = this.#cloudMapServiceNames.get(serviceId)
    if (!serviceName) {
      try {
        const { Service } = await this.discoveryClient.send(new GetServiceCommand({ Id: serviceId }))
        serviceName = Service?.Name
        if (serviceName) this.#cloudMapServiceNames.set(serviceId, serviceName)
      } catch (err) {
        this.log.error({ err, serviceId }, 'could not read the Cloud Map service')
        return {}
      }
    }

    return serviceName ? { hostname: `${serviceName}.${namespaceName}` } : {}
  }

  async #cloudMapNamespaceName () {
    const namespaceId = this.config.PLT_ECS_CLOUD_MAP_NAMESPACE_ID
    if (!namespaceId) return null
    if (this.#cloudMapNamespace) return this.#cloudMapNamespace

    try {
      const { Namespace } = await this.discoveryClient.send(new GetNamespaceCommand({ Id: namespaceId }))
      this.#cloudMapNamespace = Namespace?.Name ?? null
    } catch (err) {
      this.log.error({ err, namespaceId }, 'could not read the Cloud Map namespace')
      this.#cloudMapNamespace = null
    }
    return this.#cloudMapNamespace
  }

  // Container ports from a task definition, cached: a task definition revision
  // is immutable, so this is read once per revision however many services or
  // reconciles ask for it.
  async #containerPortsOf (taskDefinitionArn) {
    if (this.#portsByTaskDefinition.has(taskDefinitionArn)) {
      return this.#portsByTaskDefinition.get(taskDefinitionArn)
    }

    let ports = []
    try {
      const { taskDefinition } = await this.ecsClient.send(new DescribeTaskDefinitionCommand({
        taskDefinition: taskDefinitionArn
      }))
      ports = (taskDefinition?.containerDefinitions ?? [])
        .flatMap(c => c.portMappings ?? [])
        .map(p => p.containerPort)
        .filter(Boolean)
    } catch (err) {
      this.log.error({ err, taskDefinitionArn }, 'could not read container ports from the task definition')
    }

    this.#portsByTaskDefinition.set(taskDefinitionArn, ports)
    return ports
  }

  // Tags of the services owning these tasks, keyed by service name. Used as the
  // label fallback in #formatMachine -- see the note there. Returns an empty map
  // when nothing can be resolved, so callers never have to special-case it.
  async #serviceLabelsFor (namespace, tasks) {
    const names = new Set()
    for (const task of tasks) {
      // Only for tasks that need it: a task carrying its own tags never reads
      // the service's, so resolving them would be a wasted API call per batch.
      if (task.tags?.length > 0) continue
      const name = this.#serviceNameOf(task)
      if (name) names.add(name)
    }
    if (names.size === 0) return new Map()

    const byName = new Map()
    const all = [...names]
    // DescribeServices accepts max 10 at a time.
    for (let i = 0; i < all.length; i += 10) {
      const batch = all.slice(i, i + 10)
      try {
        const { services } = await this.ecsClient.send(new DescribeServicesCommand({
          cluster: namespace,
          services: batch,
          include: ['TAGS']
        }))
        for (const svc of (services || [])) {
          byName.set(svc.serviceName, this.#tagsToLabels(svc.tags))
        }
      } catch (err) {
        // A missing or unreadable service must not fail machine listing: the
        // tasks are still real and their own tags may well be enough.
        this.log.debug({ err, batch }, 'could not resolve service tags for label fallback')
      }
    }
    return byName
  }

  // Task ARNs of the services carrying these tags. The discovery half of the
  // propagateTags fallback: without it, an application whose tags live only on
  // its services looks like an application with no machines at all.
  async #taskArnsForTaggedServices (namespace, labels) {
    const serviceArns = await this.#findResourcesByTags('ecs:service', labels)
    if (serviceArns.length === 0) return []

    const taskArns = []
    for (const serviceArn of serviceArns) {
      const name = serviceArn.split('/').pop()
      taskArns.push(...await this.#listAllTaskArns(namespace, name))
    }
    return taskArns
  }

  #serviceNameOf (task) {
    return task.group?.startsWith('service:')
      ? task.group.substring('service:'.length)
      : null
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

      const serviceLabels = await this.#serviceLabelsFor(namespace, tasks || [])
      for (const task of (tasks || [])) {
        machines.push(this.#formatMachine(task, serviceLabels.get(this.#serviceNameOf(task))))
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
