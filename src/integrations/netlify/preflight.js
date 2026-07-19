// Checks that the resolved Netlify auth token can access the linked site.
// Returns verdict objects; never throws, so callers decide to warn or block.
const { readLinkedSiteId, readNetlifyCliToken } = require('./init')
const { DEFAULT_BASE_URL, redactToken } = require('./api-client')

/**
 * @typedef {{
 *   ok: boolean,
 *   code: 'ok'|'no_token'|'no_site'|'bad_token'|'no_access'|'network_error',
 *   message: string,
 *   account: { email: string } | null,
 *   site: { id: string, name: string, accountSlug: string } | null,
 * }} NetlifyAccessVerdict
 */

/** @param {{ email?: string, siteId?: string }} param0 */
function accessDeniedMessage({ email, siteId } = {}) {
  const who = email ? `Logged in as ${email}, but that account` : 'Your Netlify login'
  return `${who} can't access site ${siteId || '(unknown)'}. You may be on the wrong Netlify account — run \`netlify status\` to check or \`netlify login\` to switch.`
}

/**
 * @param {{ projectRoot?: string, env?: NodeJS.ProcessEnv, home?: string, fetch?: typeof fetch, baseUrl?: string, timeoutMs?: number }} [options]
 * @returns {Promise<NetlifyAccessVerdict>}
 */
async function checkNetlifyAccess({
  projectRoot = process.cwd(),
  env = process.env,
  home,
  fetch: fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 5000,
} = {}) {
  const { token } = readNetlifyCliToken({ env, ...(home ? { home } : {}) })
  if (!token) {
    return verdict('no_token', 'No Netlify auth token found. Run `netlify login` or set NETLIFY_AUTH_TOKEN.')
  }
  const siteId = readLinkedSiteId(projectRoot, env)
  if (!siteId) {
    return verdict('no_site', 'No linked Netlify site found. Run `nax init` or set NETLIFY_SITE_ID.')
  }

  /** @param {string} path */
  async function get(path) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let body = {}
    try {
      body = JSON.parse(text)
    } catch {
      body = {}
    }
    return { status: response.status, ok: response.ok, body }
  }

  try {
    const user = await get('/user')
    if (user.status === 401) {
      return verdict('bad_token', 'Netlify auth token is invalid or expired. Run `netlify login`.')
    }
    const email = user.ok ? String(user.body.email || '') : ''
    const account = email ? { email } : null

    const site = await get(`/sites/${encodeURIComponent(siteId)}`)
    if (site.status === 404 || site.status === 403) {
      return { ...verdict('no_access', accessDeniedMessage({ email, siteId })), account }
    }
    if (!site.ok) {
      return { ...verdict('network_error', `Could not verify access to site ${siteId} (Netlify API returned ${site.status}).`), account }
    }
    return {
      ok: true,
      code: 'ok',
      message: email ? `Logged in as ${email} with access to site ${String(site.body.name || siteId)}.` : `Netlify token has access to site ${String(site.body.name || siteId)}.`,
      account,
      site: {
        id: siteId,
        name: String(site.body.name || ''),
        accountSlug: String(site.body.account_slug || ''),
      },
    }
  } catch (error) {
    const detail = redactToken(token, error?.message || String(error))
    return verdict('network_error', `Could not reach the Netlify API to verify access (${detail}). Continuing without verification.`)
  }
}

/**
 * @param {NetlifyAccessVerdict['code']} code
 * @param {string} message
 * @returns {NetlifyAccessVerdict}
 */
function verdict(code, message) {
  return { ok: false, code, message, account: null, site: null }
}

/**
 * Blocks a run when the token verifiably cannot access the linked site;
 * ambiguous verdicts (offline, missing config) only warn so runs can proceed.
 * @param {{ projectRoot?: string, env?: NodeJS.ProcessEnv, home?: string, fetch?: typeof fetch, warn?: (message: string) => void }} [options]
 * @returns {Promise<NetlifyAccessVerdict>}
 */
async function enforceRunPreflight({ warn = console.warn, ...options } = {}) {
  const result = await checkNetlifyAccess(options)
  if (result.code === 'bad_token' || result.code === 'no_access') {
    throw new Error(result.message)
  }
  if (!result.ok) warn(`Warning: ${result.message}`)
  return result
}

module.exports = {
  accessDeniedMessage,
  checkNetlifyAccess,
  enforceRunPreflight,
}
