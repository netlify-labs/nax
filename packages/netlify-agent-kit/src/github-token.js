/** Checked in order when a GitHub source doesn't name its own variable. */
const DEFAULT_GITHUB_TOKEN_ENVS = ['NETLIFY_AGENT_KIT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']

/**
 * @typedef {{ env: string }} AuthRef
 * @typedef {{ name: string, value: string } | null} ResolvedToken
 */

/**
 * @param {AuthRef | undefined} auth
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ token: ResolvedToken, tried: string[] }}
 */
function resolveGitHubToken(auth, env = process.env) {
  const tried = auth?.env ? [auth.env] : DEFAULT_GITHUB_TOKEN_ENVS
  for (const name of tried) {
    if (env[name]) return { token: { name, value: env[name] }, tried }
  }
  return { token: null, tried }
}

module.exports = {
  DEFAULT_GITHUB_TOKEN_ENVS,
  resolveGitHubToken,
}
