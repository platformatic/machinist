'use strict'

const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { create } = require('@platformatic/service')
const { clusterConnectionDetail } = require('./helper')

process.env.NODE_ENV = 'test'

test('bootup', async (t) => {
  const clusterDetail = clusterConnectionDetail()
  const credsDir = mkdtempSync(path.join(tmpdir(), 'plt-machinist-test-'))
  const certPath = path.join(credsDir, 'ca.crt')
  writeFileSync(certPath, clusterDetail.caCert)

  const pluginOpt = {
    PLT_PROVIDER: 'k8s',
    PLT_K8S_ALLOW_SELFSIGNED_CERT: true,
    PLT_K8S_CA_PATH: certPath,
    PLT_K8S_REST_API_URL: clusterDetail.server,
    PLT_K8S_AUTH_TYPE: 'client-cert',
    PLT_K8S_CLIENT_CERT: clusterDetail.clientCert,
    PLT_K8S_CLIENT_KEY: clusterDetail.clientKey
  }

  const server = await create(path.resolve(__dirname, '..'), {
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
    server.stop()
  })

  await assert.doesNotReject(server.start())
})
