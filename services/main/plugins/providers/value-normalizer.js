'use strict'

/// Kubernetes uses a few formats when it comes to numeric values, specifically
/// for CPU, storage, and memory.
/// CPU will use an integer, float, or Quantity
/// Memory and storage will use a Quantity, or more commonly byte count using a
/// metric postfix or a binary postfix. For example, megabytes (M) or mebibytes (Mi)
///
/// Kubernetes does not normalize these to the same output value type so whatever
/// is provided as input is used as output. This module provides functions for
/// identifying and normalizing so that values can be acted upon.

module.exports.identifyCpuValueType = function identifyCpuValueType (value) {
  if (typeof value === 'string' && value.endsWith('m')) {
    const quantityValue = parseFloat(value.slice(0, -1))
    return {
      value: quantityValue,
      type: 'Quantity'
    }
  } else if (typeof value === 'string' || typeof value === 'number') {
    const numValue = Number(value)
    if (!isNaN(numValue)) {
      return {
        value: numValue,
        type: 'Plain'
      }
    }
  }

  return { error: 'Invalid value type' }
}

module.exports.identifyDataValueType = function identifyDataValueType (value) {
  const metricSuffixes = ['Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei']
  const binarySuffixes = ['K', 'M', 'G', 'T', 'P', 'E']

  // match the numeric part and suffix
  const match = value.match(/^(\d+(\.\d+)?)([a-zA-Z]*)$/)
  if (!match) {
    throw new Error(`Invalid data value format: ${value}`)
  }

  const numValue = parseFloat(match[1])
  const suffix = match[3]

  let type

  if (suffix === 'm') {
    type = 'Quantity'
  } else if (metricSuffixes.includes(suffix)) {
    type = suffix
  } else if (binarySuffixes.includes(suffix)) {
    type = suffix
  } else {
    throw new Error(`Unknown suffix: ${suffix}`)
  }

  return { value: numValue, type }
}

const RESOURCE_TYPE_MULTIPLIERS = {
  Quantity: 1 / 1000,
  Ki: 1024 ** 1,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
  K: 1000 ** 1,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  E: 1000 ** 6
}

module.exports.convertResourceValueToBytes = function (resource) {
  const multiplier = RESOURCE_TYPE_MULTIPLIERS[resource.type]
  return resource.value * multiplier
}
