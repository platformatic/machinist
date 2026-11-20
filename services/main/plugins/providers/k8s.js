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

// The ReplicaSet controller removes first the pods with the lowest deletion cost, among those which run: see
// https://kubernetes.io/docs/concepts/workloads/controllers/replicaset/#pod-deletion-cost. It is a preference, not a
// guarantee, and only the controllers which scale through a ReplicaSet follow it.
const DELETION_COST_ANNOTATION = 'controller.kubernetes.io/pod-deletion-cost'
const LOWEST_DELETION_COST = '-2147483648'
// Marks the pods whose deletion cost was set here, so that it is cleared from those which were not removed
const REMOVE_FIRST_ANNOTATION = 'machinist.platformatic.dev/remove-first'
// The deletion cost a marked pod had before, when it had one
const PREVIOUS_COST_ANNOTATION = 'machinist.platformatic.dev/previous-deletion-cost'
// On the controller, while some of its pods can be marked: a change of the count which names no machine then takes
// the marks back first, and one of a controller which never had any costs nothing more than before.
//
// Two requests which name machines for the same controller at once are not kept apart here: each edits the pods, and
// they can undo each other. Whoever names machines, i.e. ICC, sends one such request at a time for a controller.
const MARKED_PODS_ANNOTATION = 'machinist.platformatic.dev/remove-first-pods'
// A pod changed by somebody else while it is being marked or unmarked is read again, this many times
const ANNOTATE_ATTEMPTS = 3
// And so is the controller, when a write of it is refused
const WRITE_ATTEMPTS = 5
const STEERABLE_KINDS = ['Deployment', 'ReplicaSet']

// Whether a pod is controlled by one of the owners, by UID
function ownedBy (pod, owners) {
  return pod.metadata?.ownerReferences?.some(owner => owner.controller && owners.has(owner.uid)) === true
}

// What to write on a pod, as the annotations of a patch or null when it is as it should be, and whether the pod is
// then preferred for removal.
//
// - To remove: it gets the lowest cost and the mark, and the cost it had is kept aside. Marked already, it is preferred
//   only while its cost is still the lowest: one changed since belongs to whoever changed it, the pod is not
//   preferred, and the mark is dropped.
// - Not to remove, and marked: the mark is dropped, and the cost it had is given back, unless it was changed since.
function removalPatch (pod, wanted) {
  const annotations = pod.metadata?.annotations ?? {}
  const marked = annotations[REMOVE_FIRST_ANNOTATION] === 'true'
  const cost = annotations[DELETION_COST_ANNOTATION]
  const unmark = { [REMOVE_FIRST_ANNOTATION]: null, [PREVIOUS_COST_ANNOTATION]: null }

  if (!wanted) {
    if (!marked) {
      return { patch: null, preferred: false }
    }

    if (cost === LOWEST_DELETION_COST) {
      unmark[DELETION_COST_ANNOTATION] = annotations[PREVIOUS_COST_ANNOTATION] ?? null
    }

    return { patch: unmark, preferred: false }
  }

  // A pod which is terminating is on its way out already
  if (pod.metadata?.deletionTimestamp) {
    return { patch: null, preferred: false }
  }

  if (marked) {
    return cost === LOWEST_DELETION_COST ? { patch: null, preferred: true } : { patch: unmark, preferred: false }
  }

  const mark = { [DELETION_COST_ANNOTATION]: LOWEST_DELETION_COST, [REMOVE_FIRST_ANNOTATION]: 'true' }

  if (cost !== undefined) {
    mark[PREVIOUS_COST_ANNOTATION] = cost
  }

  return { patch: mark, preferred: true }
}

// The selector of a controller as the labelSelector of a list, with its expressions: the labels alone can match the
// pods of another controller. Empty without a selector, or with an operator which is not known.
function labelSelectorOf (selector) {
  const parts = []

  for (const [key, value] of Object.entries(selector?.matchLabels ?? {})) {
    parts.push(`${key}=${value}`)
  }

  for (const { key, operator, values = [] } of selector?.matchExpressions ?? []) {
    if (operator === 'In') {
      parts.push(`${key} in (${values.join(',')})`)
    } else if (operator === 'NotIn') {
      parts.push(`${key} notin (${values.join(',')})`)
    } else if (operator === 'Exists') {
      parts.push(key)
    } else if (operator === 'DoesNotExist') {
      parts.push(`!${key}`)
    } else {
      return ''
    }
  }

  return parts.join(',')
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

  // remove is optional: the machines to remove first when the count is lowered. The answer then has `removal`, which
  // tells whether the preference was set: the count is changed in any case.
  async updateControllerReplicas (namespace, name, replicaCount, providerMetadata, remove) {
    const { kind, apiVersion } = this.#requireCoordinates(providerMetadata)
    const controllerPath = this.#createControllerPath(namespace, name, apiVersion, kind)
    // The controller as it was last read or written, and whether its pods were looked at, see #preferRemoval()
    const state = { raw: await this.#getRawController(namespace, name, apiVersion, kind), looked: false, marked: false }
    const named = Array.isArray(remove) && remove.length > 0
    let removal = null

    if (named) {
      removal = await this.#preferRemoval(namespace, state, kind, replicaCount, remove, controllerPath)
    } else if (state.raw.metadata?.annotations?.[MARKED_PODS_ANNOTATION] === 'true' && replicaCount !== state.raw.spec?.replicas) {
      // The pods an earlier request marked and which are still there must not be the ones this change removes. Not
      // when the count stays as it is: the controller can still be choosing the pod to remove for that request, and
      // the marks are what it chooses by.
      await this.#preferRemoval(namespace, state, kind, replicaCount, [], controllerPath)
    }

    let updated

    if (state.looked) {
      // Looking at the pods took time, in which the controller can have been deployed again: only the count and the
      // mark are written, and never the controller as it was read, which would bring its old pods back
      updated = await this.#patchController(controllerPath, state.raw, {
        metadata: { annotations: { [MARKED_PODS_ANNOTATION]: state.marked ? 'true' : null } },
        spec: { replicas: replicaCount }
      })
    } else {
      state.raw.spec.replicas = replicaCount
      updated = await this.apiClient.request(controllerPath, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.raw)
      })
    }

    const controller = {
      name: updated.metadata?.name,
      replicas: updated.spec?.replicas,
      labels: updated.metadata?.labels ?? {},
      providerMetadata: { kind, apiVersion }
    }

    if (removal) {
      controller.removal = removal
    }

    return controller
  }

  // Writes some fields of a controller, on the version of it which was read. Kubernetes writes the controller often,
  // with its status, and the write is then refused: it is made again on the controller read again, as long as it is
  // the same one, by UID, with the count the decision was taken on. One deleted and created again under the same
  // name, or scaled by somebody else meanwhile, is not written: the refusal goes to the caller.
  async #patchController (controllerPath, raw, patch) {
    let current = raw

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.apiClient.request(controllerPath, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/merge-patch+json' },
          body: JSON.stringify({ ...patch, metadata: { ...patch.metadata, resourceVersion: current.metadata.resourceVersion } })
        })
      } catch (err) {
        if (err.statusCode !== 409 || attempt >= WRITE_ATTEMPTS - 1) {
          throw err
        }

        current = await this.apiClient.request(controllerPath)

        // Scaled by somebody else, even to the count this write asks for, Kubernetes can have chosen the pods to
        // remove before those of this request were marked
        if (current.metadata?.uid !== raw.metadata?.uid || current.spec?.replicas !== raw.spec?.replicas) {
          throw err
        }
      }
    }
  }

  // Gives the lowest deletion cost to the pods to remove first, before the count of their controller is lowered, and
  // takes it back from the pods marked by an earlier request which are still there, i.e. were not removed: they would
  // otherwise be preferred at the next scale down. With no pod to remove, it only takes the marks back. Only the pods
  // the controller owns are touched: two controllers can select pods with the same labels, and a pod of the other
  // one, with its mark, is left alone. Whatever fails here, the count is changed all the same, and the answer says
  // that the removal was not steered.
  //
  // state.raw is the controller, replaced here when it is written; state.looked tells that the pods were looked at,
  // so that the count is then written with #patchController(); state.marked whether some pods can be marked after it.
  async #preferRemoval (namespace, state, kind, replicaCount, remove, controllerPath) {
    let raw = state.raw

    if (remove.length > 0 && !(replicaCount < raw.spec?.replicas)) {
      return { steered: false, machines: [], reason: 'not-a-scale-down' }
    }

    if (!STEERABLE_KINDS.includes(kind)) {
      return { steered: false, machines: [], reason: 'unsupported-controller' }
    }

    const labelSelector = labelSelectorOf(raw.spec?.selector)

    // Without a selector the list would be every pod of the namespace
    if (!labelSelector) {
      return { steered: false, machines: [], reason: 'no-selector' }
    }

    const machines = []

    // The controller remembers that some of its pods can be marked before any is: if the count cannot be written
    // afterwards, the marks are still found, and taken back, by a later change of the count
    try {
      state.marked = raw.metadata?.annotations?.[MARKED_PODS_ANNOTATION] === 'true'

      if (remove.length > 0 && !state.marked) {
        raw = state.raw = await this.#patchController(controllerPath, raw, { metadata: { annotations: { [MARKED_PODS_ANNOTATION]: 'true' } } })
        state.marked = true
      }

      state.looked = true
    } catch (err) {
      this.log.warn({ err, namespace, controller: raw.metadata?.name }, 'Unable to choose the pods to remove first')
      return { steered: false, machines: [], reason: 'failed' }
    }

    try {
      const query = `labelSelector=${encodeURIComponent(labelSelector)}`
      const owners = await this.#podOwners(namespace, raw, kind, query)
      const { items } = await this.apiClient.request(`/api/v1/namespaces/${namespace}/pods?${query}`)

      for (const pod of items ?? []) {
        if (!ownedBy(pod, owners)) {
          continue
        }

        if (await this.#markPod(namespace, pod, remove.includes(pod.metadata.name), owners)) {
          machines.push(pod.metadata.name)
        }
      }
    } catch (err) {
      this.log.warn({ err, namespace, controller: raw.metadata?.name }, 'Unable to choose the pods to remove first')
      return { steered: false, machines: [], reason: 'failed' }
    }

    // With no pod marked anymore, the controller forgets it, with the count
    state.marked = machines.length > 0

    return machines.length > 0 ? { steered: true, machines } : { steered: false, machines, reason: 'machines-not-found' }
  }

  // Marks a pod to remove first, or takes the mark back from one which is not to remove anymore. Returns whether the
  // pod is preferred, i.e. is to remove and has the lowest deletion cost. The pod is written as it was read, with its
  // resourceVersion: one changed meanwhile is read again and decided again, so that a cost somebody else just set is
  // neither overwritten nor kept aside in place of the right one. Read again, it must still be the same pod, owned
  // by the controller: one which was replaced, orphaned or adopted meanwhile is left alone.
  async #markPod (namespace, pod, wanted, owners) {
    const uid = pod.metadata.uid

    for (let attempt = 0; ; attempt++) {
      const { patch, preferred } = removalPatch(pod, wanted)

      if (!patch) {
        return preferred
      }

      try {
        await this.apiClient.request(`/api/v1/namespaces/${namespace}/pods/${pod.metadata.name}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
          body: JSON.stringify({ metadata: { resourceVersion: pod.metadata.resourceVersion, annotations: patch } })
        })

        return preferred
      } catch (err) {
        if (err.statusCode !== 409 || attempt >= ANNOTATE_ATTEMPTS - 1) {
          throw err
        }

        pod = await this.apiClient.request(`/api/v1/namespaces/${namespace}/pods/${pod.metadata.name}`)

        if (pod.metadata?.uid !== uid || !ownedBy(pod, owners)) {
          return false
        }
      }
    }
  }

  // The UIDs of the controllers which own the pods of a controller directly: the ReplicaSet itself, or the
  // ReplicaSets of a Deployment
  async #podOwners (namespace, raw, kind, query) {
    const uid = raw.metadata?.uid

    if (kind === 'ReplicaSet') {
      return new Set(uid ? [uid] : [])
    }

    const owners = new Set()
    const { items } = await this.apiClient.request(`/apis/apps/v1/namespaces/${namespace}/replicasets?${query}`)

    for (const replicaSet of items ?? []) {
      if (uid && replicaSet.metadata?.ownerReferences?.some(owner => owner.controller && owner.uid === uid)) {
        owners.add(replicaSet.metadata.uid)
      }
    }

    return owners
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
