'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fastify = require('fastify')
const servicesRoutes = require('../routes/services')

// A provider can only tell ICC something the response schema declares: Fastify
// serialises against it and silently drops everything else. The ECS provider
// reports where a service is reachable (its Cloud Map name), and the schema not
// declaring `hostname` undid that between the provider and the wire -- with no
// error anywhere, because dropping an undeclared property is what serialisation
// is supposed to do.

async function build (t, endpoints) {
  const app = fastify({ logger: false })
  app.addSchema({
    $id: 'machinist',
    definitions: { namespace: { type: 'string' } }
  })
  app.decorate('provider', {
    getServicesByLabels: async () => endpoints
  })
  app.register(servicesRoutes)
  t.after(() => app.close())
  await app.ready()
  return app
}

test('a provider-reported hostname survives serialisation', async (t) => {
  const app = await build(t, [{
    name: 'myapp-v1',
    hostname: 'myapp-v1.plt.local',
    labels: { 'app.kubernetes.io/name': 'myapp' },
    ports: [{ port: 3042, protocol: 'TCP' }]
  }])

  const res = await app.inject({ method: 'GET', url: '/services/plt-cluster?labels=app.kubernetes.io%2Fname%3Dmyapp' })

  assert.strictEqual(res.statusCode, 200)
  const [service] = res.json()
  assert.strictEqual(service.hostname, 'myapp-v1.plt.local',
    'ICC builds workflow handler URLs from this; without it the address falls back to cluster DNS')
  assert.strictEqual(service.ports[0].port, 3042)
})

test('a provider with no hostname to report is unchanged', async (t) => {
  // Kubernetes does not report one: its cluster DNS name is derivable from the
  // service name and namespace, so there is nothing to carry.
  const app = await build(t, [{
    name: 'myapp-v1',
    labels: {},
    ports: [{ port: 3042, protocol: 'TCP' }]
  }])

  const res = await app.inject({ method: 'GET', url: '/services/default?labels=app.kubernetes.io%2Fname%3Dmyapp' })

  const [service] = res.json()
  assert.ok(!('hostname' in service))
})
