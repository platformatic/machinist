'use strict'

const { suite, test } = require('node:test')
const assert = require('node:assert/strict')
const {
  convertResourceValueToBytes,
  identifyCpuValueType,
  identifyDataValueType
} = require('../plugins/providers/value-normalizer')

suite('identify different CPU value types', s => {
  test('quantity', t => {
    assert.deepStrictEqual(identifyCpuValueType('700m'), {
      value: 700,
      type: 'Quantity'
    })
  })

  test('integer', t => {
    assert.deepStrictEqual(identifyCpuValueType('1'), {
      value: 1,
      type: 'Plain'
    })
    assert.deepStrictEqual(identifyCpuValueType(1), {
      value: 1,
      type: 'Plain'
    })
  })

  test('float', t => {
    assert.deepStrictEqual(identifyCpuValueType('0.5'), {
      value: 0.5,
      type: 'Plain'
    })
    assert.deepStrictEqual(identifyCpuValueType(0.5), {
      value: 0.5,
      type: 'Plain'
    })
  })
})

suite('identify different memory/storage value types', s => {
  test('quantity', t => {
    assert.deepStrictEqual(identifyDataValueType('700m'), {
      value: 700,
      type: 'Quantity'
    })
  })

  test('metric values', t => {
    const suffixes = ['Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei']

    for (const suffix of suffixes) {
      assert(identifyDataValueType(`700${suffix}`), {
        value: 700,
        type: suffix
      })
    }
  })

  test('binary values', t => {
    const suffixes = ['K', 'M', 'G', 'T', 'P', 'E']

    for (const suffix of suffixes) {
      assert(identifyDataValueType(`700${suffix}`), {
        value: 700,
        type: suffix
      })
    }
  })
})

test('convert to bytes', (t) => {
  assert.strictEqual(convertResourceValueToBytes({ value: 5, type: 'Mi' }), 5 * 1024 ** 2, '5Mi -> 5242880 bytes')
  assert.strictEqual(convertResourceValueToBytes({ value: 5, type: 'M' }), 5 * 1000 ** 2, '5M -> 5000000 bytes')
  assert.strictEqual(convertResourceValueToBytes({ value: 1000, type: 'Quantity' }), 1, '1000m -> 1 byte')
  assert.strictEqual(convertResourceValueToBytes({ value: 1, type: 'Ki' }), 1024, '1Ki -> 1024 bytes')
  assert.strictEqual(convertResourceValueToBytes({ value: 2, type: 'Gi' }), 2 * 1024 ** 3, '2Gi -> 2199023255552 bytes')
  assert.strictEqual(convertResourceValueToBytes({ value: 3, type: 'T' }), 3 * 1000 ** 4, '3T -> 30000000000 bytes')
})
