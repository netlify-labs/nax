/**
 * @typedef {'agent-runner' | 'dev-server' | 'netlify-build' | 'local' | 'forced' | 'disabled'} DetectLabel
 *
 * @typedef {{
 *   active: boolean,
 *   label: DetectLabel,
 *   reason: string,
 *   markers: string[],
 * }} Detection
 */

/** Variables whose presence (never their values) is recorded for diagnostics. */
const MARKER_NAMES = [
  'NETLIFY',
  'CONTEXT',
  'BUILD_ID',
  'DEPLOY_ID',
  'DEPLOY_URL',
  'DEPLOY_PRIME_URL',
  'NETLIFY_BUILD_BASE',
  'NETLIFY_AGENT_RUNNER_ID',
  'NETLIFY_AGENT_RUNNER_SESSION_ID',
  'NETLIFY_DEV_SERVER',
  'NETLIFY_DEV_SERVER_ID',
  'NETLIFY_PREVIEW_SERVER',
  'NETLIFY_AGENT_INIT',
]

/** @param {unknown} value */
function isTruthy(value) {
  return value === true || value === 'true' || value === '1'
}

/** @param {unknown} value */
function isFalsy(value) {
  return value === false || value === 'false' || value === '0'
}

/**
 * Decides whether setup should run.
 *
 * Agent runner setup installs dependencies with NETLIFY=true and CONTEXT=dev-server,
 * with BUILD_ID and DEPLOY_ID set but without NETLIFY_AGENT_RUNNER_ID, which only
 * exists in the agent's own shell. Deploy builds never use CONTEXT=dev-server.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ local?: boolean }} [options]
 * @returns {Detection}
 */
function detect(env = process.env, { local = false } = {}) {
  const markers = MARKER_NAMES.filter((name) => env[name] !== undefined)
  const override = env.NETLIFY_AGENT_INIT

  if (isFalsy(override)) {
    return { active: false, label: 'disabled', reason: 'NETLIFY_AGENT_INIT=0', markers }
  }
  if (local || isTruthy(override)) {
    return { active: true, label: 'forced', reason: local ? '--local' : 'NETLIFY_AGENT_INIT=1', markers }
  }
  if (env.NETLIFY_AGENT_RUNNER_ID) {
    return { active: true, label: 'agent-runner', reason: 'NETLIFY_AGENT_RUNNER_ID is set', markers }
  }

  const isNetlify = isTruthy(env.NETLIFY)
  if (isNetlify && env.CONTEXT === 'dev-server') {
    return { active: true, label: 'dev-server', reason: 'NETLIFY=true and CONTEXT=dev-server', markers }
  }
  if (isNetlify) {
    return {
      active: false,
      label: 'netlify-build',
      reason: `NETLIFY=true and CONTEXT=${env.CONTEXT || '(unset)'}`,
      markers,
    }
  }
  return { active: false, label: 'local', reason: 'NETLIFY is not set', markers }
}

module.exports = {
  MARKER_NAMES,
  detect,
  isFalsy,
  isTruthy,
}
