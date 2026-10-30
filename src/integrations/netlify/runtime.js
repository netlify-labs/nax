const { detect, isTruthy } = require('netlify-agent-kit')

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

/**
 * Classifies the environment with netlify-agent-kit's detection. Agent runner setup
 * has BUILD_ID and DEPLOY_ID set, so build metadata alone doesn't mean a deploy build.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NetlifyRuntimeClassification}
 */
function classifyNetlifyRuntime(env = process.env) {
  const detection = detect(env)
  const isNetlify = isTruthy(env.NETLIFY)
  if (detection.active) {
    return { label: 'agent-runner', isNetlify, isNetlifyBuild: false, isAgentRunner: true, reason: detection.reason }
  }
  const isNetlifyBuild = detection.label === 'netlify-build'
  return {
    label: isNetlifyBuild ? 'netlify-build' : 'local',
    isNetlify,
    isNetlifyBuild,
    isAgentRunner: false,
    reason: detection.reason,
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
