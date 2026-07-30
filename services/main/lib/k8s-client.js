'use strict'

const { readFile } = require('node:fs/promises')
const { setTimeout } = require('node:timers/promises')
const { request, Agent } = require('undici')
const { k8sError } = require('../errors')

class K8sClient {
  #dispatcher
  #tokenPath
  #apiUrl
  #log

  constructor (config) {
    const {
      authType,
      allowSelfSignedCert,
      clientCert,
      clientKey,
      caCert,
      tokenPath,
      apiUrl,
      log
    } = config

    this.#log = log

    const tls = {
      ca: [caCert],
      rejectUnauthorized: !allowSelfSignedCert
    }

    if (authType === 'client-cert') {
      tls.key = clientKey
      tls.cert = clientCert
    } else {
      this.#tokenPath = tokenPath
    }

    this.#apiUrl = apiUrl

    this.#dispatcher = new Agent({
      connect: tls,
      allowH2: true,
      clientTtl: 60000
    })
  }

  // Re-read on every call rather than caching: kubelet rotates the projected
  // service account token in place (bound tokens expire, e.g. ~24h on EKS 1.35+),
  // and this process can outlive that window. The file is on a tmpfs-backed
  // volume, so the read is effectively free.
  async #getAuthHeaders () {
    if (!this.#tokenPath) return {}
    const token = (await readFile(this.#tokenPath, 'utf8')).trim()
    return { Authorization: `Bearer ${token}` }
  }

  async request (path, overrides = {}, retryCount = 0) {
    const opts = {
      ...overrides,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'platformatic/machinist/v3.0.0',
        ...(await this.#getAuthHeaders()),
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
        this.#log?.error({
          error: err.message,
          code: err.code,
          path,
          method: opts.method || 'GET',
          retryCount,
          retryDelayMs: delay
        }, 'K8s API connection error (HTTP/2 GOAWAY), retrying')

        await setTimeout(delay)
        return this.request(path, overrides, retryCount + 1)
      }

      if (isSocketError) {
        this.#log?.error({
          error: err.message,
          code: err.code,
          path,
          method: opts.method || 'GET',
          retryCount
        }, 'K8s API connection error (HTTP/2 GOAWAY) - max retries exceeded')
      }

      throw err
    }
  }

  async stream (path, signal, headers = {}) {
    const opts = {
      headers: {
        Accept: 'application/json;stream=watch',
        'User-Agent': 'platformatic/machinist/v3.0.0',
        ...(await this.#getAuthHeaders()),
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
