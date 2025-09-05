'use strict'

// Representations of the different MetricSpec
// https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.30/#metricspec-v2-autoscaling

class MetricSource {
  constructor (id) {
    this.id = id
  }

  valueToQuantity (value, valueType) {
    // This value is called a "quantity": https://kubernetes.io/docs/reference/glossary/?all=true#term-quantity
    switch (valueType) {
      case 'ms':
        return `${value}m`
      case 'bytes':
        return `${value * 1000}m`
      case 'percent':
        return `${value * 10}m`
      default:
        throw new Error(`No support for '${valueType}'`)
    }
  }

  toMarker (name, value, type) {
    return { id: this.id, name, targetValue: value, targetType: type }
  }
}

class PodMetricSource extends MetricSource {
  constructor (id, name, query, value, valueType) {
    super(id)

    this.name = name
    this.value = value
    this.valueType = valueType
    this.query = query
  }

  /**
   {
     "metric":{
      "type":"Pods",
      "pods":{
        "metric":{
          "name":"plt_svc_memory_use",
          "selector":{"matchLabels":{"instance":"plt-46d1bb7e","namespace":"platformatic"}}
        },
        "target":{
          "type":"AverageValue",
          "averageValue":"1207959552m"
        }
      }
    }
    }
   */
  toMetricSource (labels = {}) {
    const metric = { name: this.query }
    if (Object.keys(labels).length > 0) {
      metric.selector = { matchLabels: labels }
    }

    return {
      type: 'Pods',
      pods: {
        metric,
        target: {
          type: 'AverageValue',
          averageValue: super.valueToQuantity(this.value, this.valueType)
        }
      }
    }
  }

  toMarker () {
    return super.toMarker(this.name, this.value, this.valueType)
  }
}
module.exports.PodMetricSource = PodMetricSource

class ResourceMetricSource extends MetricSource {
  constructor (id, name, targetType, value, valueType) {
    super(id)
    this.name = name
    this.value = value
    this.valueType = valueType
    this.targetType = targetType
  }

  toMetricSource () {
    let targetType
    let targetValue = this.value

    switch (this.targetType) {
      case 'Utilization':
        targetType = 'averageUtilization'
        break
      case 'AverageValue':
        targetType = 'averageValue'
        targetValue = super.valueToQuantity(this.value, this.valueType)
        break
      case 'Value':
      default:
        targetType = 'value'
        targetValue = super.valueToQuantity(this.value, this.valueType)
    }

    return {
      type: 'Resource',
      resource: {
        name: this.name.toLowerCase(),
        target: {
          type: this.targetType,
          [targetType]: targetValue
        }
      }
    }
  }

  toMarker () {
    return super.toMarker(this.name, this.value, this.valueType)
  }
}
module.exports.ResourceMetricSource = ResourceMetricSource

module.exports.parseMemoryMetric = function parseMemoryMetric (metricSource) {
  const metricName = 'plt_svc_memory_use'
  const metricValue = parseInt(metricSource.pods?.target?.averageValue?.replace('m', ''))

  return new PodMetricSource(
    'memory',
    'Memory',
    metricName,
    metricValue,
    'bytes'
  )
}
