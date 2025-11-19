'use strict'

const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { buildServer } = require('@platformatic/service')
const Fastify = require('fastify')
const { clusterConnectionDetail } = require('./helper')

process.env.NODE_ENV = 'test'

async function startLogProxy () {
  const logProxy = Fastify({
    keepAliveTimeout: 1,
    forceCloseConnections: true
  })

  let sometimesError = 0

  logProxy.decorate('events', {})

  logProxy.post('/events', async (req) => {
    const { labels, events } = req.body
    sometimesError += 1

    if (sometimesError % 2 === 0) throw new Error('uhoh hotdog')

    const { eventType, applicationId, name, resource } = labels
    if (!applicationId || !eventType || !name || !resource) {
      throw new Error('Missing required labels')
    }

    const key = `${eventType}:${name}:${resource}:${applicationId}`
    logProxy.events[key] = logProxy.events[key] || []
    logProxy.events[key].push(...events)

    return { success: true }
  })

  await logProxy.listen({ port: 0 })
  return logProxy
}

test('bootup', async (t) => {
  const logProxyServer = await startLogProxy()
  const ipv4Details = logProxyServer.addresses().find(addr => addr.family === 'IPv4')

  const clusterDetail = clusterConnectionDetail()
  const credsDir = mkdtempSync(path.join(tmpdir(), 'plt-machinist-test-'))
  const certPath = path.join(credsDir, 'ca.crt')
  writeFileSync(certPath, clusterDetail.caCert)

  const pluginOpt = {
    PLT_DEPLOY_IMAGE: 'blah',
    PLT_LOG_PROXY_URL: `http://${ipv4Details.address}:${ipv4Details.port}`,
    PLT_CONTROL_PLANE_URL: 'http://core.local/control-plane',
    PLT_COMPENDIUM_URL: 'http://core.local/compendium',
    PLT_RISK_ENGINE_URL: 'http://risk-engine.local',
    PLT_RISK_MANAGER_URL: 'http://risk-manager.local',
    PLT_COMPLIANCE_URL: 'http://compliance.local',
    PLT_TRAFFICANTE_URL: 'http://trafficante.local',
    PLT_CRON_URL: 'http://cron.local',
    PLT_MACHINIST_DEFAULT_VOLUME_SIZE_GB: 3,
    PLT_MACHINIST_GITHUB_TOKEN: 'abc',
    PLT_DEFAULT_MACHINE_MEMORY_MB: 256,
    PLT_DEFAULT_MACHINE_CPU_COUNT: 1,
    PLT_K8S_PROVIDER: 'k8s',
    PLT_K8S_ALLOW_SELFSIGNED_CERT: true,
    PLT_K8S_MACHINE_WAIT_TIMEOUT_MS: 1000,
    PLT_DISABLE_EVENT_EXPORT: false,
    PLT_DEPLOY_IMAGE_PULL_SECRET_NAME: 'image-pull-secrets',
    PLT_K8S_CA_PATH: certPath,
    PLT_K8S_REST_API_URL: clusterDetail.server,
    PLT_K8S_AUTH_TYPE: 'client-cert',
    PLT_K8S_CLIENT_CERT: clusterDetail.clientCert,
    PLT_K8S_CLIENT_KEY: clusterDetail.clientKey,
    envAllowList: [
      'PLT_RESTART_MACHINE',
      'PLT_MACHINIST_LOGGER_LEVEL'
    ]
  }

  const server = await buildServer({
    server: {
      hostname: '127.0.0.1',
      port: 0,
      logger: { level: 'silent' }
    },
    plugins: {
      paths: [
        {
          path: path.resolve(__dirname, '..', 'plugin.js'),
          options: pluginOpt
        }
      ]
    }
  })

  t.after(() => {
    logProxyServer.close()
    server.close()
  })

  await assert.doesNotReject(server.start())
})
