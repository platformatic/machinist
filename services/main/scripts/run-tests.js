'use strict'

const { spawnSync } = require('node:child_process')

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function runScript (script) {
  const result = spawnSync(pnpm, [script], { stdio: 'inherit' })

  if (result.error) throw result.error

  if (result.status !== 0) {
    const error = new Error(`pnpm ${script} failed`)
    error.exitCode = result.status ?? 1
    throw error
  }
}

let exitCode = 0

try {
  runScript('test:setup')

  // Both suites run even if the first fails, so one broken test does not hide
  // the state of the other. test:e2e:ecs is separate because it needs the
  // emulator stack from docker-compose.yml, which test:setup brings up.
  for (const suite of ['test:unit', 'test:e2e:ecs']) {
    try {
      runScript(suite)
    } catch (error) {
      if (exitCode === 0) exitCode = error.exitCode ?? 1
    }
  }
} catch (error) {
  exitCode = error.exitCode ?? 1
} finally {
  try {
    runScript('test:teardown')
  } catch (error) {
    if (exitCode === 0) exitCode = error.exitCode ?? 1
  }
}

process.exitCode = exitCode
