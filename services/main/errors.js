'use strict'

const createError = require('@fastify/error')

module.exports.ApiKeyGeneration = createError('MCHNST_API_KEY_GENERATION', 'New API key generation failed for org: %s', 500)
module.exports.CannotDestroyMachine = createError('MCHNST_CANNOT_DESTROY', 'Provider unable to destroy machine: %s', 500)
module.exports.CannotStartMachine = createError('MCHNST_CANNOT_START', 'Provider unable to start machine: %s', 500)
module.exports.CannotStopMachine = createError('MCHNST_CANNOT_STOP', 'Provider unable to stop machine: %s', 500)
module.exports.ConfigError = createError('MCHNST_CONFIG_ERROR', 'Configuration error: %s', 500)
module.exports.DownstreamUnauthorized = createError('MCHNST_DOWNSTREAM_UNAUTH', 'Could not authenticate with downstream service: %s', 500)
module.exports.DuplicateMachine = createError('MCHNST_DUPLICATE_MACHINE', '%s', 400)
module.exports.Forbidden = createError('MCHNST_AUTH_FORBIDDEN', 'Forbidden: %s', 403)
module.exports.GithubRequestFailed = createError('MCHNST_GITHUB_REQUEST_FAILED', '%s', 500)
module.exports.MachineNotStarted = createError('MCHNST_MACHINE_NOT_STARTED', 'Unable to verify machine started: %s', 500)
module.exports.MachineNotStopped = createError('MCHNST_MACHINE_NOT_STOPPED', 'Unable to verify machine stopped: %s', 500)
module.exports.MetadataUnavailable = createError('MCHNST_META_UNAVAILABLE', 'Unable to query metadata from instance: %s', 500)
module.exports.MissingApplication = createError('MCHNST_MISSING_APP', 'Machine cannot be started because application does not exist: %s', 400)
module.exports.MissingMachine = createError('MCHNST_MISSING_MACHINE', 'Machine does not exist: %s', 404)
module.exports.NonExistentHost = createError('MCHNST_NONEXISTENT_HOST', 'Host does not exist: %s', 404)
module.exports.NonExistentHpa = createError('MCHNST_NONEXISTENT_HPA', 'HPA does not exist: %s', 404)
module.exports.NonExistentIngress = createError('MCHNST_NONEXISTENT_INGRESS', 'Ingress does not exist: %s', 404)
module.exports.NonExistentVolume = createError('MCHNST_NONEXISTENT_VOLUME', 'Volume does not exist: %s', 404)
module.exports.UnknownProvider = createError('MCHNST_UNKNOWN_PROVIDER', 'Unknown provider: %s', 400)
module.exports.VolumeAttached = createError('MCHNST_VOLUME_ATTACHED', '%s', 400)
module.exports.VolumeCannotBeReplaced = createError('MCHNST_VOLUME_CANNOT_REPLACE', 'Volume cannot be replaced: %s', 400)
module.exports.VolumeRemoved = createError('MCHNST_VOLUME_REMOVED', 'Requested volume no longer exists: %s', 400)
module.exports.ZioUpdateConfig = createError('MCHNST_ZIO_UPDATE_CONFIG', 'Changing Zio config failed: %s', 500)
module.exports.ZioUpdateKey = createError('MCHNST_ZIO_UPDATE_API_KEY', 'Setting API key on ZIO failed: %s', 500)

const providerError = providerName => ({ statusCode, response }) => {
  const err = createError(
    `MCHNST_${providerName.toUpperCase()}_ERROR`,
    /* c8 ignore next */
    response.message || `Unknown ${providerName} error`,
    statusCode
  )()
  err.response = response
  return err
}

module.exports.k8sError = providerError('k8s')
