'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ResourceMetricSource, PodMetricSource } = require('../plugins/providers/metrics-source')

test('create Resource metric', async t => {
  const metric = new ResourceMetricSource('memory', 'Memory', 'Utilization', 98, 'percent')

  assert.deepStrictEqual(metric.toMetricSource(), {
    type: 'Resource',
    resource: {
      name: 'memory',
      target: {
        type: 'Utilization',
        averageUtilization: 98
      }
    }
  })

  assert.deepStrictEqual(metric.toMarker(), {
    id: 'memory',
    name: 'Memory',
    targetValue: 98,
    targetType: 'percent'
  })
})

test('create Pod metric', async t => {
  const metric = new PodMetricSource('requests', 'Request Latency', 'plt_svc_request_latency', 750, 'ms')

  assert.deepStrictEqual(metric.toMetricSource(), {
    type: 'Pods',
    pods: {
      metric: { name: 'plt_svc_request_latency' },
      target: {
        type: 'AverageValue',
        averageValue: '750m'
      }
    }
  })

  // With selector
  assert.deepStrictEqual(metric.toMetricSource({ namespace: 'platformatic' }), {
    type: 'Pods',
    pods: {
      metric: {
        name: 'plt_svc_request_latency',
        selector: {
          matchLabels: {
            namespace: 'platformatic'
          }
        }
      },
      target: {
        type: 'AverageValue',
        averageValue: '750m'
      }
    }
  })

  assert.deepStrictEqual(metric.toMarker(), {
    id: 'requests',
    name: 'Request Latency',
    targetValue: 750,
    targetType: 'ms'
  })
})

test('create Pod metric with percent', async t => {
  const metric = new PodMetricSource('elu', 'ELU', 'nodejs_eventloop_utilization', 90, 'percent')

  assert.deepStrictEqual(metric.toMetricSource(), {
    type: 'Pods',
    pods: {
      metric: { name: 'nodejs_eventloop_utilization' },
      target: {
        type: 'AverageValue',
        averageValue: '900m'
      }
    }
  })
})
