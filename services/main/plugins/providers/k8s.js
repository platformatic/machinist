'use strict'

const { readFile } = require('node:fs/promises')
const querystring = require('fast-querystring')
const fp = require('fastify-plugin')
const pluralize = require('pluralize')
const K8sClient = require('../../lib/k8s-client')

const SCHEMA = {
  type: 'object',
  properties: {
    PLT_K8S_AUTH_TYPE: { enum: ['token', 'client-cert'], default: 'token' },
    PLT_K8S_CA_PATH: { type: 'string', default: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt' },
    PLT_K8S_TOKEN_PATH: { type: 'string', default: '/var/run/secrets/kubernetes.io/serviceaccount/token' },
    PLT_K8S_REST_API_URL: { type: 'string', default: 'https://kubernetes.default.svc' },
    PLT_K8S_ALLOW_SELFSIGNED_CERT: { type: 'boolean', default: false },
    PLT_K8S_CLIENT_CERT: { type: 'string' },
    PLT_K8S_CLIENT_KEY: { type: 'string' }
  }
}

// Try these K8s API groups in order when resolving a controller by name
const CONTROLLER_TYPES = [
  { apiVersion: 'apps/v1', kind: 'Deployment' },
  { apiVersion: 'apps/v1', kind: 'StatefulSet' },
  { apiVersion: 'apps/v1', kind: 'ReplicaSet' },
  { apiVersion: 'v1', kind: 'ReplicationController' }
]

class K8s {
  #controllerCache = new Map()

  constructor ({ config, log, caContent, token, authType, clientCreds }) {
    this.log = log
    this.config = config
    this.apiClient = new K8sClient({
      authType,
      allowSelfSignedCert: config.PLT_K8S_ALLOW_SELFSIGNED_CERT,
      clientCert: clientCreds.cert,
      clientKey: clientCreds.key,
      caCert: caContent,
      bearerToken: token,
      apiUrl: config.PLT_K8S_REST_API_URL,
      log
    })
  }

  async init () {
    this.log.debug('Initializing K8s provider')
  }

  // ── Machine operations ──

  async getMachine (scope, machineId) {
    const pod = await this.apiClient.request(`/api/v1/namespaces/${scope}/pods/${machineId}`)

    const owner = pod.metadata?.ownerReferences?.find(ref => ref.controller)
    if (owner) {
      pod._resolvedController = await this.#resolveTopController(
        scope, owner.name, owner.apiVersion, owner.kind
      )
    }

    return this.#formatMachine(pod)
  }

  async getMachines (scope, labels = {}) {
    const labelSelector = querystring.stringify(labels)
    const endpoint = `/api/v1/namespaces/${scope}/pods?labelSelector=${labelSelector}`
    const { items } = await this.apiClient.request(endpoint)

    return Promise.all(items.map(async pod => {
      const owner = pod.metadata?.ownerReferences?.find(ref => ref.controller)
      if (owner) {
        pod._resolvedController = await this.#resolveTopController(
          scope, owner.name, owner.apiVersion, owner.kind
        )
      }
      return this.#formatMachine(pod)
    }))
  }

  async setMachineLabels (scope, machineId, labels) {
    await this.apiClient.request(`/api/v1/namespaces/${scope}/pods/${machineId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/strategic-merge-patch+json'
      },
      body: JSON.stringify({ metadata: { labels } })
    })
  }

  // ── Controller operations ──

  async getControllers (scope, machineId) {
    let machines = []
    if (machineId) {
      machines.push(await this.getMachine(scope, machineId))
    } else {
      machines = await this.getMachines(scope)
    }

    const controllersMap = {}

    for (const machine of machines) {
      if (!machine.controller) continue

      const name = machine.controller.name

      if (controllersMap[name]) {
        controllersMap[name].machines.push(machine)
      } else {
        const { apiVersion, kind } = await this.#resolveControllerCoordinates(scope, name)
        const raw = await this.#getRawController(scope, name, apiVersion, kind)
        controllersMap[name] = {
          name,
          replicas: raw.spec?.replicas,
          labels: raw.metadata?.labels ?? {},
          machines: [machine]
        }
      }
    }

    return Object.values(controllersMap)
  }

  async getController (scope, name) {
    const { apiVersion, kind } = await this.#resolveControllerCoordinates(scope, name)
    const raw = await this.#getRawController(scope, name, apiVersion, kind)

    const matchLabels = raw.spec?.selector?.matchLabels || {}
    const machines = await this.getMachines(scope, matchLabels)

    return {
      name,
      replicas: raw.spec?.replicas,
      labels: raw.metadata?.labels ?? {},
      machines
    }
  }

  async updateControllerReplicas (scope, name, replicaCount) {
    const { apiVersion, kind } = await this.#resolveControllerCoordinates(scope, name)
    const raw = await this.#getRawController(scope, name, apiVersion, kind)

    raw.spec.replicas = replicaCount

    const controllerPath = this.#createControllerPath(scope, name, apiVersion, kind)
    const updated = await this.apiClient.request(controllerPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(raw)
    })

    return {
      name: updated.metadata?.name,
      replicas: updated.spec?.replicas,
      labels: updated.metadata?.labels ?? {}
    }
  }

  async deleteController (scope, name) {
    const { apiVersion, kind } = await this.#resolveControllerCoordinates(scope, name)
    const controllerPath = this.#createControllerPath(scope, name, apiVersion, kind)
    return this.apiClient.request(controllerPath, { method: 'DELETE' })
  }

  // ── Service operations ──

  async getServicesByLabels (scope, labels) {
    const parts = []
    for (const [k, v] of Object.entries(labels)) {
      parts.push(`${k}=${v}`)
    }
    const labelSelector = parts.join(',')
    const path = `/api/v1/namespaces/${scope}/services?labelSelector=${labelSelector}`
    const { items } = await this.apiClient.request(path)
    return items.map(this.#formatServiceEndpoint)
  }

  async deleteService (scope, name) {
    const path = `/api/v1/namespaces/${scope}/services/${name}`
    return this.apiClient.request(path, { method: 'DELETE' })
  }

  // ── Skew protection (K8s only) ──

  async listGateways (scope) {
    const path = `/apis/gateway.networking.k8s.io/v1/namespaces/${scope}/gateways`
    const { items } = await this.apiClient.request(path)
    return items
  }

  async applyHTTPRoute (scope, httpRoute) {
    const name = httpRoute.metadata.name
    const basePath = `/apis/gateway.networking.k8s.io/v1/namespaces/${scope}/httproutes`

    let existing
    try {
      existing = await this.apiClient.request(`${basePath}/${name}`)
    } catch (err) {
      if (err.statusCode !== 404) throw err
    }

    if (existing) {
      httpRoute.metadata.resourceVersion = existing.metadata.resourceVersion
      return this.apiClient.request(`${basePath}/${name}`, {
        method: 'PUT',
        body: JSON.stringify(httpRoute)
      })
    }

    return this.apiClient.request(basePath, {
      method: 'POST',
      body: JSON.stringify(httpRoute)
    })
  }

  async deleteHTTPRoute (scope, name) {
    const path = `/apis/gateway.networking.k8s.io/v1/namespaces/${scope}/httproutes/${name}`
    return this.apiClient.request(path, { method: 'DELETE' })
  }

  // ── Private helpers ──

  #formatMachine (pod) {
    const output = {
      id: pod.metadata?.name,
      status: pod.status?.phase,
      startTime: pod.status?.startTime,
      labels: pod.metadata?.labels ?? {}
    }

    if (pod._resolvedController) {
      output.controller = { name: pod._resolvedController.metadata?.name || pod._resolvedController.name }
    }

    if (pod.spec.containers.length > 0) {
      output.image = pod.spec.containers[0].image
      output.resources = pod.spec.containers[0].resources
    }

    return output
  }

  #formatServiceEndpoint (svc) {
    return {
      name: svc.metadata?.name,
      labels: svc.metadata?.labels ?? {},
      ports: (svc.spec?.ports || []).map(p => ({
        port: p.port,
        protocol: p.protocol
      }))
    }
  }

  /**
   * Recursively walks ownerReferences to find the top-level controller.
   * Caches the result for subsequent lookups.
   */
  async #resolveTopController (scope, name, apiVersion, kind) {
    const controllerPath = this.#createControllerPath(scope, name, apiVersion, kind)
    const controller = await this.apiClient.request(controllerPath)

    if (!controller.name) {
      controller.name = name
    }

    // Cache the coordinates
    this.#controllerCache.set(`${scope}/${name}`, { apiVersion, kind })

    const owners = controller.metadata?.ownerReferences ?? []
    const parentController = owners.find(owner => owner.controller)

    if (parentController) {
      try {
        return this.#resolveTopController(
          scope, parentController.name, parentController.apiVersion, parentController.kind
        )
      } catch (err) {
        this.log.warn({ err }, 'Unable to get parent controller')
        return controller
      }
    }

    return controller
  }

  /**
   * Resolves (apiVersion, kind) for a controller name.
   * Checks cache first, then tries common K8s API groups.
   */
  async #resolveControllerCoordinates (scope, name) {
    const cached = this.#controllerCache.get(`${scope}/${name}`)
    if (cached) return cached

    for (const { apiVersion, kind } of CONTROLLER_TYPES) {
      try {
        const path = this.#createControllerPath(scope, name, apiVersion, kind)
        await this.apiClient.request(path)
        const coords = { apiVersion, kind }
        this.#controllerCache.set(`${scope}/${name}`, coords)
        return coords
      } catch (err) {
        if (err.statusCode === 404) continue
        throw err
      }
    }

    const err = new Error(`Controller not found: ${name} in scope ${scope}`)
    err.statusCode = 404
    throw err
  }

  async #getRawController (scope, name, apiVersion, kind) {
    const path = this.#createControllerPath(scope, name, apiVersion, kind)
    return this.apiClient.request(path)
  }

  #createControllerPath (scope, name, apiVersion, kind) {
    const kindPart = pluralize(kind.toLowerCase())
    const root = apiVersion.split('/').length > 1
      ? `/apis/${apiVersion}`
      : `/api/${apiVersion}`
    return `${root}/namespaces/${scope}/${kindPart}/${name}`
  }
}

async function plugin (fastify, opts) {
  if (fastify.appConfig.PLT_PROVIDER !== 'k8s') return
  fastify.log.info({ PROVIDER: fastify.appConfig.PLT_PROVIDER }, 'Using K8s provider')

  const appConfig = fastify.validateOptions(opts, SCHEMA)

  const caContent = (await readFile(appConfig.PLT_K8S_CA_PATH, 'utf8')).trim()
  const authType = appConfig.PLT_K8S_AUTH_TYPE
  let token, clientKey, clientCert
  if (authType === 'token') {
    token = (await readFile(appConfig.PLT_K8S_TOKEN_PATH, 'utf8')).trim()
  } else {
    clientKey = Buffer.from(appConfig.PLT_K8S_CLIENT_KEY, 'base64').toString()
    clientCert = Buffer.from(appConfig.PLT_K8S_CLIENT_CERT, 'base64').toString()
  }

  const k8s = new K8s({
    caContent,
    token,
    authType,
    clientCreds: { key: clientKey, cert: clientCert },
    config: appConfig,
    log: fastify.log
  })

  await k8s.init()
  fastify.decorate('provider', k8s)
}

module.exports = fp(plugin, {
  name: 'provider',
  dependencies: ['app-configuration']
})

module.exports.K8s = K8s
module.exports.schema = SCHEMA
