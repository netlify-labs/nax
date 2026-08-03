// Checks that the resolved Netlify auth token can access the linked site.
// Returns verdict objects; never throws, so callers decide to warn or block.
const { readLinkedSiteId } = require('./init')
const {
  DEFAULT_NETLIFY_API_URL,
  preflightNetlifyAccess,
} = require('nax-agent-runner-sdk')

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
 * @param {{
 *   projectRoot?: string,
 *   siteId?: string,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   fetch?: typeof fetch,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   userAgent?: string,
 *   onTelemetry?: (event: import('nax-agent-runner-sdk').AuthTelemetryEvent) => void,
 *   onRequestFailure?: (event: {
 *     kind: 'http_failure'|'network_error',
 *     method: string,
 *     apiPath: string,
 *     status?: number,
 *     attempt: number,
 *     maxAttempts: number,
 *     retrying: boolean,
 *     errorName?: string,
 *   }) => void,
 * }} [options]
 * @returns {Promise<NetlifyAccessVerdict>}
 */
async function checkNetlifyAccess({
  projectRoot = process.cwd(),
  siteId: requestedSiteId = '',
  env = process.env,
  home,
  fetch: fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_NETLIFY_API_URL,
  timeoutMs = 5000,
  userAgent,
  onTelemetry,
  onRequestFailure,
} = {}) {
  const siteId = String(requestedSiteId || readLinkedSiteId(projectRoot, env)).trim()
  if (!siteId) {
    return verdict('no_site', 'No linked Netlify site found. Run `nax init` or set NETLIFY_SITE_ID.')
  }

  const result = await preflightNetlifyAccess({
    fetch: fetchImpl,
    env,
    siteId,
    baseUrl,
    timeoutMs,
    ...(home === undefined ? {} : { home }),
    ...(userAgent === undefined ? {} : { userAgent }),
    onTelemetry: (event) => {
      onTelemetry?.(event)
      if (!onRequestFailure) return
      if (event.kind === 'httpFailure') {
        onRequestFailure({
          kind: 'http_failure',
          method: event.method,
          apiPath: event.pathname,
          status: event.status,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          retrying: event.retrying,
        })
      } else if (event.kind === 'networkError') {
        onRequestFailure({
          kind: 'network_error',
          method: event.method,
          apiPath: event.pathname,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          retrying: false,
          errorName: event.errorName,
        })
      }
    },
  })
  if (result.ok) {
    const account = result.accountEmail ? { email: result.accountEmail } : null
    return {
      ok: true,
      code: 'ok',
      message: result.accountEmail
        ? `Logged in as ${result.accountEmail} with access to site ${result.site.name || siteId}.`
        : `Netlify token has access to site ${result.site.name || siteId}.`,
      account,
      site: {
        id: siteId,
        name: result.site.name,
        accountSlug: result.site.accountSlug,
      },
    }
  }
  if (result.code === 'missing-token') {
    return verdict('no_token', 'No Netlify auth token found. Run `netlify login` or set NETLIFY_AUTH_TOKEN.')
  }
  if (result.code === 'invalid-token' || result.code === 'expired-token') {
    return verdict('bad_token', 'Netlify auth token is invalid or expired. Run `netlify login`.')
  }
  if (result.code === 'under-scoped') {
    const account = result.accountEmail ? { email: result.accountEmail } : null
    return {
      ...verdict('no_access', accessDeniedMessage({
        email: result.accountEmail,
        siteId,
      })),
      account,
    }
  }
  const failureStatus = 'status' in result ? result.status : undefined
  return verdict(
    'network_error',
    failureStatus === undefined
      ? `Could not reach the Netlify API to verify access to site ${siteId}. Continuing without verification.`
      : `Could not verify access to site ${siteId}; the Netlify API returned ${failureStatus}. Continuing without verification.`,
  )
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
 * @param {Parameters<typeof checkNetlifyAccess>[0] & { warn?: (message: string) => void }} [options]
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
