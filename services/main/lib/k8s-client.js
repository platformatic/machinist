'use strict'

const { setTimeout } = require('node:timers/promises')
const { request, Agent } = require('undici')
const { k8sError } = require('../errors')

class K8sClient {
  #dispatcher
  #authHeaders = {}
  #apiUrl

  constructor (config) {
    const {
      authType,
      allowSelfSignedCert,
      clientCert,
      clientKey,
      caCert,
      bearerToken,
      apiUrl
    } = config

    const tls = {
      ca: [caCert],
      rejectUnauthorized: !allowSelfSignedCert
    }

    if (authType === 'client-cert') {
      tls.key = clientKey
      tls.cert = clientCert
    } else {
      this.#authHeaders = { Authorization: `Bearer ${bearerToken}` }
    }

    this.#apiUrl = apiUrl

    this.#dispatcher = new Agent({
      connect: tls,
      allowH2: true,
      clientTtl: 60000
    })
  }

  async request (path, overrides = {}, retryCount = 0) {
    // TODO may need to recreate dispatcher https://kubernetes.io/docs/concepts/security/service-accounts/#authenticating-credentials
    const opts = {
      ...overrides,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'platformatic/machinist/v3.0.0',
        ...this.#authHeaders,
        ...(overrides.headers || {})
      },
      dispatcher: this.#dispatcher
    }

    if (opts.method === 'DELETE') {
      delete opts.headers['Content-Type']
    }

    const url = new URL(path, this.#apiUrl)

    try {
      const { statusCode, body } = await request(url, opts)
      if (statusCode > 299) {
        const err = await body.text()
        throw k8sError({ statusCode, response: err })
      }

      return body.json()
    } catch (err) {
      const isSocketError = err.code === 'UND_ERR_SOCKET'
      const canRetry = retryCount < 3

      if (isSocketError && canRetry) {
        const delay = 100 * Math.pow(2, retryCount)
        console.error({
          message: 'K8s API connection error (HTTP/2 GOAWAY), retrying',
          error: err.message,
          code: err.code,
          path,
          method: opts.method || 'GET',
          retryCount,
          retryDelayMs: delay
        })

        await setTimeout(delay)
        return this.request(path, overrides, retryCount + 1)
      }

      if (isSocketError) {
        console.error({
          message: 'K8s API connection error (HTTP/2 GOAWAY) - max retries exceeded',
          error: err.message,
          code: err.code,
          path,
          method: opts.method || 'GET',
          retryCount
        })
      }

      throw err
    }
  }

  async stream (path, signal, headers = {}) {
    const opts = {
      headers: {
        Accept: 'application/json;stream=watch',
        'User-Agent': 'platformatic/machinist/v3.0.0',
        ...this.#authHeaders,
        ...headers
      },
      signal,
      bodyTimeout: 0,
      dispatcher: this.#dispatcher
    }

    const url = new URL(path, this.#apiUrl)
    const response = await request(url, opts)
    if (response.statusCode > 299) {
      const err = await response.body.json()
      throw k8sError({ statusCode: response.status, response: err })
    }
    return response.body
  }
}

module.exports = K8sClient
