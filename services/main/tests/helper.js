'use strict'

const path = require('node:path')
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { buildServer } = require('@platformatic/service')
const { Agent, MockAgent, setGlobalDispatcher } = require('undici')
const pluralize = require('pluralize')
const querystring = require('fast-querystring')
const YAML = require('yaml')
const K8sClient = require('../lib/k8s-client')

// This name should match the name `test:setup` and `test:teardown` in package.json
// k3d adds the `k3d-` prefix, which is saved in ~/.kube/config
const CLUSTER_CONTEXT_NAME = 'k3d-plt-machinist-test'

const defaultEnv = {
  PLT_MACHINIST_DEFAULT_VOLUME_SIZE_GB: 3,
  PLT_MACHINIST_VAULT_ADDR: 'http://vault.local',
  PLT_MACHINIST_VAULT_NAMESPACE: 'plt',
  PLT_MACHINIST_VAULT_ROLE_ID: 'role',
  PLT_MACHINIST_VAULT_SECRET_ID: 'secret',
  PLT_MACHINIST_CA_NAME: 'ca',
  PLT_MACHINIST_PKI_ROLE: 'pkirole',
  PLT_MACHINIST_COMMON_NAME: 'commonname',
  PLT_MACHINIST_DISABLE_MTLS_CLIENT: 'true',
  PLT_DEFAULT_MACHINE_MEMORY_MB: 256,
  PLT_DEFAULT_MACHINE_CPU_COUNT: 1,
  PLT_K8S_PROVIDER: 'k8s',
  PLT_K8S_REST_API_URL: 'http://k8s.api',
  PLT_K8S_ALLOW_SELFSIGNED_CERT: true,
  PLT_K8S_MACHINE_WAIT_TIMEOUT_MS: 1000,
  PLT_DISABLE_EVENT_EXPORT: true,
  PLT_K8S_NAMESPACE: 'default',
  PLT_LOG_PROXY_URL: 'http://localhost:3045'
}

function config (options) {
  return {
    server: {
      hostname: '127.0.0.1',
      port: 0,
      logger: { level: 'silent' }
    },
    plugins: {
      paths: [
        {
          path: path.resolve(__dirname, '..', 'plugin.js'),
          hotReload: false,
          options
        }
      ]
    }
  }
}

function setupPluginOpt (overrides = {}) {
  const pluginOpt = {
    ...defaultEnv,
    ...overrides
  }

  return pluginOpt
}

function clusterConnectionDetail () {
  let kubeconfigPath = path.join(process.env.HOME, '.kube/config')
  if (process.env.KUBECONFIG) kubeconfigPath = path.resolve(process.env.KUBECONFIG)
  const contents = readFileSync(kubeconfigPath)
  const kubeconfig = YAML.parse(contents.toString())

  const context = kubeconfig.contexts.find(ctx => ctx.name === CLUSTER_CONTEXT_NAME)
  if (!context) throw Error('Could not find cluster context details')

  const { cluster } = kubeconfig.clusters.find(cluster => cluster.name === context.context.cluster)
  const { user } = kubeconfig.users.find(user => user.name === context.context.user)

  return {
    caCert: cluster['certificate-authority-data'],
    clientCert: user['client-certificate-data'],
    clientKey: user['client-key-data'],
    server: cluster.server
  }
}
const clusterDetail = clusterConnectionDetail()

async function bootstrap (t, pluginOverrides = {}) {
  const credsDir = mkdtempSync(path.join(tmpdir(), 'plt-machinist-test-'))
  const certPath = path.join(credsDir, 'ca.crt')
  writeFileSync(certPath, clusterDetail.caCert)

  const pluginOpt = setupPluginOpt({
    PLT_K8S_CA_PATH: certPath,
    PLT_K8S_REST_API_URL: clusterDetail.server,
    PLT_K8S_AUTH_TYPE: 'client-cert',
    PLT_K8S_CLIENT_CERT: clusterDetail.clientCert,
    PLT_K8S_CLIENT_KEY: clusterDetail.clientKey,
    ...pluginOverrides
  })

  const agent = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 })
  const mockAgent = new MockAgent({ agent })
  setGlobalDispatcher(mockAgent)
  mockAgent.disableNetConnect()

  const serverConfig = config(pluginOpt)
  const server = await buildServer(serverConfig)
  await server.start()
  t.after(() => {
    server.close()
  })

  return {
    app: server,
    mockAgent,
    appConfig: pluginOpt
  }
}

function endpointFromKubeYaml (yamlDocument, method = 'POST') {
  const { kind, apiVersion, metadata } = yamlDocument

  let item = ''
  if (['GET', 'DELETE'].includes(method)) {
    item = `/${metadata.name}`
  }

  let prefix = 'api'
  if (apiVersion !== 'v1') prefix = pluralize(prefix)

  return `/${prefix}/${apiVersion}/namespaces/${defaultEnv.PLT_K8S_NAMESPACE}/${pluralize(kind.toLowerCase())}${item}`
}

async function yamller (filePath, method) {
  const client = new K8sClient({
    authType: 'client-cert',
    caCert: Buffer.from(clusterDetail.caCert, 'base64').toString(),
    clientCert: Buffer.from(clusterDetail.clientCert, 'base64').toString(),
    clientKey: Buffer.from(clusterDetail.clientKey, 'base64').toString(),
    apiUrl: clusterDetail.server
  })

  const yamlRaw = readFileSync(filePath)
  const requests = YAML
    .parseAllDocuments(yamlRaw.toString())
    .map(doc => doc.toJS())
    .map(doc => ({ body: JSON.stringify(doc), route: endpointFromKubeYaml(doc, method) }))

  await Promise.all(requests
    .map(({ body, route }) => {
      const opts = { method }
      if (!['GET', 'DELETE'].includes(method)) {
        opts.body = body
      }

      return client.request(route, opts)
    }))

  if (!['GET', 'DELETE'].includes(method)) {
    const waitOnResources = requests
      .map(({ body, route }) => {
        return client.stream(route)
      })
    await Promise.all(waitOnResources)
  }
}

function applyYaml (filePath) {
  return yamller(filePath, 'POST')
}

function removeYaml (filePath) {
  return yamller(filePath, 'DELETE')
}

function getPods (labels) {
  const labelSelector = querystring.stringify(labels)
  const endpoint = `/api/v1/namespaces/${defaultEnv.PLT_K8S_NAMESPACE}/pods?labelSelector=${labelSelector}`
  const client = new K8sClient({
    authType: 'client-cert',
    caCert: Buffer.from(clusterDetail.caCert, 'base64').toString(),
    clientCert: Buffer.from(clusterDetail.clientCert, 'base64').toString(),
    clientKey: Buffer.from(clusterDetail.clientKey, 'base64').toString(),
    apiUrl: clusterDetail.server
  })

  return client.request(endpoint, { method: 'GET' })
}

module.exports = {
  bootstrap,
  config,
  setupPluginOpt,
  defaultEnv,
  applyYaml,
  removeYaml,
  getPods,
  clusterConnectionDetail
}
