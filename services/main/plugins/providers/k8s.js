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

// TODO(mzugm): only latest verions of k8s are supported, need to add support for older versions
class K8s {
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
    this.log.debug('Initializing generic K8s plugin')
  }

  async eventStream (namespace) {
    const stream = await this.apiClient.stream(`/apis/events.k8s.io/v1/namespaces/${namespace}/events?watch=1`)
    stream.on('error', () => console.log('error on stream'))
    return stream
  }

  async getPod (namespace, podId) {
    const pod = await this.apiClient.request(`/api/v1/namespaces/${namespace}/pods/${podId}`)

    const owner = pod.metadata?.ownerReferences?.find(ref => ref.controller)
    if (owner) {
      pod.controller = await this.getController(
        namespace,
        owner.name,
        owner.apiVersion,
        owner.kind
      )
    }

    const output = this.#formatPod(pod)

    return output
  }

  async getPods (namespace, labels = {}) {
    const labelSelector = querystring.stringify(labels)
    const endpoint = `/api/v1/namespaces/${namespace}/pods?labelSelector=${labelSelector}`
    const { items } = await this.apiClient.request(endpoint)

    return (await Promise.all(items
      .map(async pod => {
        const owner = pod.metadata?.ownerReferences?.find(ref => ref.controller)
        this.log.debug({ pod, owner }, 'getPods')
        if (owner) {
          pod.controller = await this.getController(
            namespace,
            owner.name,
            owner.apiVersion,
            owner.kind
          )
        }

        return pod
      })))
      .map(this.#formatPod)
  }

  async getServices (namespace, labels) {
    if (Object.keys(labels).length === 0) {
      // TODO custom error
      throw new Error('Labels cannot be empty')
    }

    const { items: services } = await this.apiClient.request(`/api/v1/namespaces/${namespace}/services`)

    return services.filter(service => {
      const selector = service.spec?.selector
      if (!selector) return false

      return Object.entries(selector).every(([key, value]) => {
        return labels[key] === value
      })
    })
  }

  async getServicesByLabels (namespace, labels) {
    const parts = []
    for (const [k, v] of Object.entries(labels)) {
      parts.push(`${k}=${v}`)
    }
    const labelSelector = parts.join(',')
    const path = `/api/v1/namespaces/${namespace}/services?labelSelector=${labelSelector}`
    const { items } = await this.apiClient.request(path)
    return items
  }

  async getIngressRoutes (namespace, serviceNames) {
    if (serviceNames.length === 0) {
      // TODO custom error
      throw new Error('Must provide a service list')
    }

    const ingresses = await this.apiClient.request(`/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses`)
    const matchingRules = []

    for (const ingress of ingresses.items) {
      if (!ingress.spec?.rules) continue

      for (const rule of ingress.spec.rules) {
        if (!rule.http?.paths) continue

        for (const path of rule.http.paths) {
          if (serviceNames.includes(path.backend.service.name)) {
            matchingRules.push(rule)
          }
        }
      }
    }

    return matchingRules
  }

  async updateController (namespace, { kind, apiVersion, name }, replicaCount) {
    let controller = await this.getController(namespace, name, apiVersion, kind)

    // Update replica count, should be available on:
    // ReplicationController, ReplicaSet, Deployment, StatefulSet
    controller.spec.replicas = replicaCount

    const controllerPath = this.#createControllerPath(namespace, name, apiVersion, kind)
    controller = await this.apiClient.request(controllerPath, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(controller)
    })

    return controller
  }

  /**
   * Get the highest controller in the chain
   *
   * First, load the resource information
   * Then, checks for any controller in the ownerReferences
   * Finally, repeats process using the found controller until no more parents
   * are found
   */
  async getController (namespace, name, apiVersion, kind) {
    this.log.debug({ namespace, name, apiVersion, kind }, 'Getting controlller')
    const controllerPath = this.#createControllerPath(namespace, name, apiVersion, kind)
    this.log.debug({ controllerPath })
    const controller = await this.apiClient.request(controllerPath)

    // Add in the controller name to have a similar schema across ownerRef and
    // controller resources
    if (!controller.name) {
      controller.name = name
    }

    const owners = controller.metadata?.ownerReferences ?? []

    // There can only be one controller in a list of owners
    // See "ownerReferences" in https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/object-meta/
    const parentController = owners.find(owner => owner.controller)
    this.log.debug({ parentController, owners, controller }, 'Preparing to search for parent')
    if (parentController) {
      try {
        return this.getController(
          namespace,
          parentController.name,
          parentController.apiVersion,
          parentController.kind
        )
      } catch (err) {
        this.log.warn({ err }, 'Unable to get parent controller')
        return controller
      }
    }

    return controller
  }

  #formatPod (pod) {
    const output = {
      id: pod.metadata?.name,
      status: pod.status?.phase,
      privateIp: pod.status?.podIP,
      startTime: pod.status?.startTime,
      labels: pod.metadata?.labels ?? {},
      controller: pod.controller
    }

    // TODO(20250501) - There is only one container 99% of the time but it is an
    // array so this could be a future bug
    if (pod.spec.containers.length > 0) {
      output.image = pod.spec.containers[0].image
      output.resources = pod.spec.containers[0].resources
    }

    return output
  }

  #createControllerPath (namespace, name, apiVersion, kind) {
    const kindPart = pluralize(kind.toLowerCase())
    const root = apiVersion.split('/').length > 1
      ? `/apis/${apiVersion}`
      : `/api/${apiVersion}`
    this.log.debug({ kindPart, root }, 'Pathing variables')
    return `${root}/namespaces/${namespace}/${kindPart}/${name}`
  }

  async setMachineLabels (machineId, namespace, labels) {
    this.log.debug(`Setting labels for machine ${machineId}: ${JSON.stringify(labels)}`)
    await this.apiClient.request(`/api/v1/namespaces/${namespace}/pods/${machineId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/strategic-merge-patch+json'
      },
      body: JSON.stringify({ metadata: { labels } })
    })
  }
}

async function plugin (fastify, opts) {
  if (fastify.appConfig.PLT_K8S_PROVIDER !== 'k8s') return
  fastify.log.info({
    PROVIDER: fastify.appConfig.PLT_K8S_PROVIDER,
    INGRESS: fastify.appConfig.PLT_K8S_INGRESS_CONTROLLER
  }, 'Using generic Kubernetes plugin')

  const appConfig = fastify.validateOptions(opts, SCHEMA)

  const caContent = (await readFile(appConfig.PLT_K8S_CA_PATH, 'utf8')).trim()
  const authType = appConfig.PLT_K8S_AUTH_TYPE
  let token, clientCert, clientKey
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
  fastify.decorate('k8s', k8s)
}

module.exports = fp(plugin, {
  name: 'k8s',
  dependencies: ['app-configuration']
})

module.exports.K8s = K8s
module.exports.schema = SCHEMA
