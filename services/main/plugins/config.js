'use strict'

const fp = require('fastify-plugin')
const Ajv = require('ajv')
const deepmerge = require('@fastify/deepmerge')({ all: true })

const baseSchema = {
  type: 'object',
  properties: {
    PLT_PROVIDER: { type: 'string', default: 'k8s' }
  }
}

function validateOptions (options, schema, ignoreBaseSchema = false) {
  const opts = { ...options, ...prefixOnly(process.env) }

  let compileSchema = schema
  if (!ignoreBaseSchema) {
    compileSchema = deepmerge(baseSchema, schema)
  }

  const ajv = new Ajv({ coerceTypes: true, useDefaults: true })
  const validate = ajv.compile(compileSchema)
  const valid = validate(opts)
  if (!valid) {
    const err = new Error('Invalid configuration options were passed to machinist')
    err.validationErrors = validate.errors
    throw err
  }

  return opts
}

function prefixOnly (env, prefix = 'PLT_') {
  return Object.keys(env).reduce((acc, key) => {
    if (key.startsWith(prefix)) acc[key] = env[key]
    return acc
  }, {})
}

async function plugin (fastify, options) {
  const ignoreBaseSchema = true
  const baseConfig = validateOptions(options, baseSchema, ignoreBaseSchema)

  fastify.decorate('appConfig', baseConfig)
  fastify.decorate('validateOptions', validateOptions)
}

module.exports = fp(plugin, { name: 'app-configuration' })
