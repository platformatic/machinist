'use strict'

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
      allowH2: true
    })
  }

  async request (path, overrides = {}) {
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

    // TODO use URL
    const { statusCode, body } = await request(`${this.#apiUrl}${path}`, opts)
    if (statusCode > 299) {
      const err = await body.text()
      throw k8sError({ statusCode, response: err })
    }

    return body.json()
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

    // TODO use URL
    const response = await request(`${this.#apiUrl}${path}`, opts)
    if (response.statusCode > 299) {
      const err = await response.body.json()
      throw k8sError({ statusCode: response.status, response: err })
    }
    return response.body
  }
}

module.exports = K8sClient
