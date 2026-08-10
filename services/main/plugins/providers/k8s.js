'use strict'

const { readFile } = require('node:fs/promises')
const fp = require('fastify-plugin')
const pluralize = require('pluralize')
const K8sClient = require('../../lib/k8s-client')
const errors = require('../../errors')

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

class K8s {
  constructor ({ config, log, caContent, tokenPath, authType, clientCreds }) {
    this.log = log
    this.config = config
    this.apiClient = new K8sClient({
      authType,
      allowSelfSignedCert: config.PLT_K8S_ALLOW_SELFSIGNED_CERT,
      clientCert: clientCreds.cert,
      clientKey: clientCreds.key,
      caCert: caContent,
      tokenPath,
      apiUrl: config.PLT_K8S_REST_API_URL,
      log
    })
  }

  async init () {
    this.log.debug('Initializing K8s provider')
  }

  // ── Machine operations ──

  async getMachine (namespace, machineId) {
    const pod = await this.apiClient.request(`/api/v1/namespaces/${namespace}/pods/${machineId}`)

    const owner = pod.metadata?.ownerReferences?.find(ref => ref.controller)
    if (owner) {
      pod._resolvedController = await this.#resolveTopController(
        namespace, owner.name, owner.apiVersion, owner.kind
      )
    }

    return this.#formatMachine(pod)
  }

  async getMachines (namespace, labels = {}) {
    // k8s labelSelector is comma-separated. querystring.stringify joins with `&`,
    // which splits every label after the first off into ignored query params, so
    // only the first label actually filters. Join with `,` like getServicesByLabels.
    const labelSelector = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',')
    const endpoint = `/api/v1/namespaces/${namespace}/pods?labelSelector=${labelSelector}`
    const { items } = await this.apiClient.request(endpoint)

    return Promise.all(items.map(async pod => {
      const owner = pod.metadata?.ownerReferences?.find(ref => ref.controller)
      if (owner) {
        pod._resolvedController = await this.#resolveTopController(
          namespace, owner.name, owner.apiVersion, owner.kind
        )
      }
      return this.#formatMachine(pod)
    }))
  }

  async setMachineLabels (namespace, machineId, labels) {
    await this.apiClient.request(`/api/v1/namespaces/${namespace}/pods/${machineId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/strategic-merge-patch+json'
      },
      body: JSON.stringify({ metadata: { labels } })
    })
  }

  // ── Controller operations ──

  async getControllers (namespace, machineId) {
    let machines = []
    if (machineId) {
      machines.push(await this.getMachine(namespace, machineId))
    } else {
      machines = await this.getMachines(namespace)
    }

    const controllersMap = {}

    for (const machine of machines) {
      if (!machine.controller) continue

      const { name, kind, apiVersion } = machine.controller

      if (controllersMap[name]) {
        controllersMap[name].machines.push(machine)
      } else {
        const raw = await this.#getRawController(namespace, name, apiVersion, kind)
        controllersMap[name] = {
          name,
          replicas: raw.spec?.replicas,
          labels: raw.metadata?.labels ?? {},
          providerMetadata: { kind, apiVersion },
          machines: [machine]
        }
      }
    }

    return Object.values(controllersMap)
  }

  async getController (namespace, name, providerMetadata) {
    const { kind, apiVersion } = this.#requireCoordinates(providerMetadata)
    const raw = await this.#getRawController(namespace, name, apiVersion, kind)

    const matchLabels = raw.spec?.selector?.matchLabels || {}
    const machines = await this.getMachines(namespace, matchLabels)

    return {
      name,
      replicas: raw.spec?.replicas,
      labels: raw.metadata?.labels ?? {},
      providerMetadata: { kind, apiVersion },
      machines
    }
  }

  async updateControllerReplicas (namespace, name, replicaCount, providerMetadata) {
    const { kind, apiVersion } = this.#requireCoordinates(providerMetadata)
    const raw = await this.#getRawController(namespace, name, apiVersion, kind)

    raw.spec.replicas = replicaCount

    const controllerPath = this.#createControllerPath(namespace, name, apiVersion, kind)
    const updated = await this.apiClient.request(controllerPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(raw)
    })

    return {
      name: updated.metadata?.name,
      replicas: updated.spec?.replicas,
      labels: updated.metadata?.labels ?? {},
      providerMetadata: { kind, apiVersion }
    }
  }

  async deleteController (namespace, name, providerMetadata) {
    const { kind, apiVersion } = this.#requireCoordinates(providerMetadata)
    const controllerPath = this.#createControllerPath(namespace, name, apiVersion, kind)
    return this.apiClient.request(controllerPath, { method: 'DELETE' })
  }

  // ── Service operations ──

  async getServicesByLabels (namespace, labels) {
    const parts = []
    for (const [k, v] of Object.entries(labels)) {
      parts.push(`${k}=${v}`)
    }
    const labelSelector = parts.join(',')
    const path = `/api/v1/namespaces/${namespace}/services?labelSelector=${labelSelector}`
    const { items } = await this.apiClient.request(path)
    return items.map(this.#formatServiceEndpoint)
  }

  async deleteService (namespace, name) {
    const path = `/api/v1/namespaces/${namespace}/services/${name}`
    return this.apiClient.request(path, { method: 'DELETE' })
  }

  // ── Skew protection (K8s only) ──

  async listGateways (namespace) {
    const path = `/apis/gateway.networking.k8s.io/v1/namespaces/${namespace}/gateways`
    const { items } = await this.apiClient.request(path)
    return items
  }

  // Kubernetes renders the plan into an HTTPRoute inside ICC and applies that,
  // so it never receives a plan. Declared so the route returns a clear 501
  // rather than a TypeError if one is ever sent here.
  async applyRoutePlan () {
    throw new errors.NotImplementedByProvider('Route plan (applyRoutePlan)', 'k8s')
  }

  async applyHTTPRoute (namespace, httpRoute) {
    const name = httpRoute.metadata.name
    const basePath = `/apis/gateway.networking.k8s.io/v1/namespaces/${namespace}/httproutes`

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

  async getHTTPRoute (namespace, name) {
    const path = `/apis/gateway.networking.k8s.io/v1/namespaces/${namespace}/httproutes/${name}`
    try {
      return await this.apiClient.request(path)
    } catch (err) {
      if (err.statusCode === 404) return null
      throw err
    }
  }

  async deleteHTTPRoute (namespace, name) {
    const path = `/apis/gateway.networking.k8s.io/v1/namespaces/${namespace}/httproutes/${name}`
    return this.apiClient.request(path, { method: 'DELETE' })
  }

  // ── Workload creation (K8s only) ──

  // Idempotent create-or-update of a Deployment, mirroring applyHTTPRoute: GET
  // the resource, swallow only 404, PUT with the existing resourceVersion when
  // it exists, else POST.
  async applyDeployment (namespace, deployment) {
    const name = deployment.metadata.name
    const basePath = `/apis/apps/v1/namespaces/${namespace}/deployments`

    let existing
    try {
      existing = await this.apiClient.request(`${basePath}/${name}`)
    } catch (err) {
      if (err.statusCode !== 404) throw err
    }

    if (existing) {
      deployment.metadata.resourceVersion = existing.metadata.resourceVersion
      return this.apiClient.request(`${basePath}/${name}`, {
        method: 'PUT',
        body: JSON.stringify(deployment)
      })
    }

    return this.apiClient.request(basePath, {
      method: 'POST',
      body: JSON.stringify(deployment)
    })
  }

  // Idempotent create-or-update of a Service. spec.clusterIP is immutable — a PUT
  // that changes it is rejected — so echo the existing clusterIP (and
  // resourceVersion) back onto the update body.
  async applyService (namespace, service) {
    const name = service.metadata.name
    const basePath = `/api/v1/namespaces/${namespace}/services`

    let existing
    try {
      existing = await this.apiClient.request(`${basePath}/${name}`)
    } catch (err) {
      if (err.statusCode !== 404) throw err
    }

    if (existing) {
      service.metadata.resourceVersion = existing.metadata.resourceVersion
      service.spec = service.spec || {}
      service.spec.clusterIP = existing.spec.clusterIP
      return this.apiClient.request(`${basePath}/${name}`, {
        method: 'PUT',
        body: JSON.stringify(service)
      })
    }

    return this.apiClient.request(basePath, {
      method: 'POST',
      body: JSON.stringify(service)
    })
  }

  // Idempotent create-or-update of an image-pull Secret via server-side apply: a
  // single PATCH, no read-before-write. This deliberately avoids GET on secrets
  // (which would let the SA read every secret's contents in the namespace); SSA
  // needs only create + patch. fieldManager marks ICC as the owner and force
  // takes ownership of any conflicting fields. The manifest carries apiVersion +
  // kind, as SSA requires.
  // Kubernetes takes fully rendered manifests on /controllers, /services and
  // /secrets instead, because a Deployment is self-contained (ECS-SUPPORT.md D1).
  async applyWorkload () {
    throw new errors.NotImplementedByProvider('Neutral workload spec (applyWorkload)', 'k8s')
  }

  async applySecret (namespace, secret) {
    const name = secret.metadata.name
    const path = `/api/v1/namespaces/${namespace}/secrets/${name}?fieldManager=icc&force=true`
    return this.apiClient.request(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/apply-patch+yaml' },
      body: JSON.stringify(secret)
    })
  }

  // ── Private helpers ──

  #formatMachine (pod) {
    const output = {
      id: pod.metadata?.name,
      status: pod.status?.phase,
      startTime: pod.status?.startTime,
      labels: pod.metadata?.labels ?? {}
    }

    // Include kind/apiVersion alongside name so getControllers can build
    // providerMetadata without re-fetching. Fastify response schemas strip
    // the extra fields when serializing the public Machine.
    if (pod._resolvedController) {
      output.controller = {
        name: pod._resolvedController.metadata?.name || pod._resolvedController.name,
        kind: pod._resolvedController.kind,
        apiVersion: pod._resolvedController.apiVersion
      }
    }

    if (pod.spec?.containers?.length > 0) {
      output.image = pod.spec.containers[0].image
      output.resources = pod.spec.containers[0].resources
    }

    // The content-addressed digest Kubernetes resolved for the running image.
    const imageID = pod.status?.containerStatuses?.[0]?.imageID
    if (imageID) {
      output.imageDigest = imageID.replace(/^docker-pullable:\/\//, '')
    }

    // The kubelet's Ready verdict -- what gates the pod's inclusion in the Service
    // endpoints, i.e. whether the gateway can route to it.
    const readyCond = pod.status?.conditions?.find(c => c.type === 'Ready')
    output.ready = readyCond?.status === 'True'

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
   * The kind/apiVersion at each level comes from the ownerReference itself
   * (K8s populates it for free), so no discovery is needed here.
   */
  async #resolveTopController (namespace, name, apiVersion, kind) {
    const controllerPath = this.#createControllerPath(namespace, name, apiVersion, kind)
    const controller = await this.apiClient.request(controllerPath)

    if (!controller.name) {
      controller.name = name
    }

    const owners = controller.metadata?.ownerReferences ?? []
    const parentController = owners.find(owner => owner.controller)

    if (parentController) {
      try {
        return this.#resolveTopController(
          namespace, parentController.name, parentController.apiVersion, parentController.kind
        )
      } catch (err) {
        this.log.warn({ err }, 'Unable to get parent controller')
        return controller
      }
    }

    return controller
  }

  /**
   * Validates the providerMetadata sent by the caller.
   *
   * The K8s provider needs (kind, apiVersion) to build the right API path —
   * Deployments, StatefulSets, etc. live at different URLs. Callers obtain
   * these on first discovery (via getControllers walking ownerReferences) and
   * are expected to persist + round-trip them on every subsequent call.
   *
   * Missing them is a programming error, not something we silently recover from.
   */
  #requireCoordinates (providerMetadata) {
    if (!providerMetadata || !providerMetadata.kind || !providerMetadata.apiVersion) {
      throw new Error('K8s provider requires providerMetadata with `kind` and `apiVersion`')
    }
    return { kind: providerMetadata.kind, apiVersion: providerMetadata.apiVersion }
  }

  async #getRawController (namespace, name, apiVersion, kind) {
    const path = this.#createControllerPath(namespace, name, apiVersion, kind)
    return this.apiClient.request(path)
  }

  #createControllerPath (namespace, name, apiVersion, kind) {
    const kindPart = pluralize(kind.toLowerCase())
    const root = apiVersion.split('/').length > 1
      ? `/apis/${apiVersion}`
      : `/api/${apiVersion}`
    return `${root}/namespaces/${namespace}/${kindPart}/${name}`
  }
}

async function plugin (fastify, opts) {
  if (fastify.appConfig.PLT_PROVIDER !== 'k8s') return
  fastify.log.info({ PROVIDER: fastify.appConfig.PLT_PROVIDER }, 'Using K8s provider')

  const appConfig = fastify.validateOptions(opts, SCHEMA)

  const caContent = (await readFile(appConfig.PLT_K8S_CA_PATH, 'utf8')).trim()
  const authType = appConfig.PLT_K8S_AUTH_TYPE
  let clientKey, clientCert
  if (authType === 'token') {
    // Fail fast at startup if the token file is missing or unreadable. The
    // value itself is re-read per request by K8sClient (see #getAuthHeaders)
    // rather than cached here, since kubelet rotates it in place roughly
    // every hour and this process can easily outlive that window.
    await readFile(appConfig.PLT_K8S_TOKEN_PATH, 'utf8')
  } else {
    clientKey = Buffer.from(appConfig.PLT_K8S_CLIENT_KEY, 'base64').toString()
    clientCert = Buffer.from(appConfig.PLT_K8S_CLIENT_CERT, 'base64').toString()
  }

  const k8s = new K8s({
    caContent,
    tokenPath: appConfig.PLT_K8S_TOKEN_PATH,
    authType,
    clientCreds: { key: clientKey, cert: clientCert },
    config: appConfig,
    log: fastify.log
  })

  await k8s.init()
  fastify.decorate('provider', k8s)
}

module.exports = fp(plugin, {
  name: 'provider-k8s',
  dependencies: ['app-configuration']
})

module.exports.K8s = K8s
module.exports.schema = SCHEMA
