/**
 * Netlify runtime classification derived from process environment markers.
 * @typedef {{
 *   label: string,
 *   isNetlify: boolean,
 *   isNetlifyBuild: boolean,
 *   isAgentRunner: boolean,
 *   reason: string,
 * }} NetlifyRuntimeClassification
 */

/** @param {unknown} value @returns {boolean} */
function isTruthy(value) {
  return value === true || value === 'true' || value === '1'
}

/** @param {NodeJS.ProcessEnv} [env] @returns {NetlifyRuntimeClassification} */
function classifyNetlifyRuntime(env = process.env) {
  const isNetlify = isTruthy(env.NETLIFY)
  const context = env.CONTEXT || ''
  const hasBuildMetadata = Boolean(env.BUILD_ID || env.DEPLOY_ID || env.DEPLOY_URL || env.DEPLOY_PRIME_URL)

  if (!isNetlify) {
    return {
      label: 'local',
      isNetlify: false,
      isNetlifyBuild: false,
      isAgentRunner: false,
      reason: 'NETLIFY is not set',
    }
  }

  if (hasBuildMetadata) {
    return {
      label: 'netlify-build',
      isNetlify: true,
      isNetlifyBuild: true,
      isAgentRunner: false,
      reason: `NETLIFY=true with build/deploy metadata and CONTEXT=${context || '(unset)'}`,
    }
  }

  if (context === 'dev-server') {
    return {
      label: 'agent-runner',
      isNetlify: true,
      isNetlifyBuild: false,
      isAgentRunner: true,
      reason: 'NETLIFY=true, CONTEXT=dev-server, and build/deploy metadata is empty',
    }
  }

  return {
    label: 'netlify-build',
    isNetlify: true,
    isNetlifyBuild: true,
    isAgentRunner: false,
    reason: `NETLIFY=true without agent-runner markers and CONTEXT=${context || '(unset)'}`,
  }
}

/** @param {NodeJS.ProcessEnv} [env] @returns {boolean} */
function isNetlifyAgentRunner(env = process.env) {
  return classifyNetlifyRuntime(env).isAgentRunner
}

module.exports = {
  classifyNetlifyRuntime,
  isNetlifyAgentRunner,
  isTruthy,
}
