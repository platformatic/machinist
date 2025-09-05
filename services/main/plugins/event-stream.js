'use strict'

const { pipeline, Writable } = require('node:stream')
const fp = require('fastify-plugin')
const { request, interceptors, getGlobalDispatcher } = require('undici')
const split2 = require('split2')

async function plugin (app) {
  if (app.appConfig.PLT_DISABLE_EVENT_EXPORT) return

  const dispatcher = getGlobalDispatcher().compose(
    interceptors.retry({
      methods: ['GET', 'POST'],
      maxRetries: 3,
      maxTimeout: 5000
    })
  )

  {
    const url = app.appConfig.PLT_LOG_PROXY_URL + '/'
    const { body } = await request(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      },
      dispatcher
    })

    // We care the other side is up and running
    // so we just dump the body.
    await body.dump()
  }

  async function storeEvents (events, labels) {
    const url = app.appConfig.PLT_LOG_PROXY_URL + '/events'
    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ labels, events }),
      dispatcher
    })

    if (statusCode !== 200 && statusCode !== 204) {
      const error = await body.text()
      app.log.error({ statusCode, error }, 'Failed to store events')
    }
  }

  class EventStream extends Writable {
    _writev (chunks, callback) {
      const lines = chunks.map(c => c.chunk.toString())
      const groupedEvents = lines.reduce((acc, line) => {
        const parsed = JSON.parse(line)
        const { metadata, regarding } = parsed.object || {}

        const labels = {
          eventType: parsed.type,
          name: regarding?.name || metadata?.name,
          resource: regarding?.kind
        }
        const key = Object.values(labels).join('')

        if (acc[key]) acc[key].events.push(line)
        else acc[key] = { events: [line], labels }

        return acc
      }, {})

      app.log.debug({ groupedEvents }, 'Grouped events')

      Promise.all(Object.values(groupedEvents).map(({ events, labels }) => {
        return storeEvents(events, labels)
      })).then(() => process.nextTick(callback), (err) => {
        app.log.error(err)
        process.nextTick(callback, err)
      })
    }
  }

  let splitStream
  async function startStreaming () {
    splitStream = split2()
    const eventStream = new EventStream()
    const k8sEvents = await app.k8s.eventStream(app.appConfig.PLT_K8S_INSTALLED_NAMESPACE)

    pipeline(k8sEvents, splitStream, eventStream, err => {
      if (err) {
        app.log.error(err, 'Failed to stream events')
        if (process.env.NODE_ENV !== 'test') {
          // If this fails, the server will gracefully restart
          startStreaming()
        }
      }
    })
  }

  await startStreaming()

  app.addHook('onClose', async () => {
    // TODO(mcollina): we should wait for the pipeline to close correctly,
    // shut down the source
    splitStream.end()
  })
}

module.exports = fp(plugin, {
  name: 'event-export',
  dependencies: ['app-configuration', 'k8s']
})
