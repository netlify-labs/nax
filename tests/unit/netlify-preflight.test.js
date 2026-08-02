// Tests for the Netlify access preflight verdicts: token/site resolution,
// account/site fitness via the API, and offline-tolerant failure codes.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { checkNetlifyAccess, accessDeniedMessage } = require('../../src/integrations/netlify/preflight')
const { DEFAULT_USER_AGENT } = require('../../src/integrations/netlify/api-client')

function tmpRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function linkedProjectRoot(siteId = 'site-123') {
  const root = tmpRoot('nax-preflight-project-')
  fs.mkdirSync(path.join(root, '.netlify'))
  fs.writeFileSync(path.join(root, '.netlify', 'state.json'), JSON.stringify({ siteId }))
  return root
}

/**
 * @typedef {{
 *   match: string,
 *   status?: number,
 *   body?: unknown,
 *   text?: string,
 *   error?: Error,
 * }} StubResponse
 */

/** @param {StubResponse[]} responses */
function stubFetch(responses) {
  const calls = []
  const fetchStub = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const match = responses.find((entry) => String(url).includes(entry.match))
    if (!match) throw new Error(`Unexpected fetch: ${url}`)
    if (match.error) throw match.error
    const status = match.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: async () => match.text === undefined
        ? JSON.stringify(match.body ?? {})
        : match.text,
    }
  }
  fetchStub.calls = calls
  return /** @type {typeof fetch & { calls: Array<{ url: string, options: RequestInit }> }} */ (/** @type {unknown} */ (fetchStub))
}

test('preflight returns ok with account and site details when token can access the site', async () => {
  const projectRoot = linkedProjectRoot('site-123')
  const fetchStub = stubFetch([
    { match: '/user', status: 200, body: { email: 'david@example.com' } },
    { match: '/sites/site-123', status: 200, body: { name: 'demo-site', account_slug: 'good-team' } },
  ])
  const verdict = await checkNetlifyAccess({
    projectRoot,
    env: { NETLIFY_AUTH_TOKEN: 'tok-1' },
    home: tmpRoot('nax-preflight-home-'),
    fetch: fetchStub,
  })

  assert.equal(verdict.ok, true)
  assert.equal(verdict.code, 'ok')
  assert.equal(verdict.account.email, 'david@example.com')
  assert.deepEqual(verdict.site, { id: 'site-123', name: 'demo-site', accountSlug: 'good-team' })
  assert.equal(fetchStub.calls.length, 2)
  const headers = /** @type {Record<string, string>} */ (fetchStub.calls[0].options.headers)
  assert.equal(headers.authorization, 'Bearer tok-1')
  assert.equal(headers['user-agent'], DEFAULT_USER_AGENT)
})

test('preflight continues from a non-401 user failure to the site lookup', async () => {
  const projectRoot = linkedProjectRoot('site-continue')
  const fetchStub = stubFetch([
    { match: '/user', status: 500, body: { error: 'temporary' } },
    {
      match: '/sites/site-continue',
      status: 200,
      body: { name: 'continued', account_slug: 'team' },
    },
  ])
  const verdict = await checkNetlifyAccess({
    projectRoot,
    env: { NETLIFY_AUTH_TOKEN: 'tok-1' },
    home: tmpRoot('nax-preflight-home-'),
    fetch: fetchStub,
  })

  assert.equal(verdict.ok, true)
  assert.equal(verdict.account, null)
  assert.equal(verdict.site.name, 'continued')
  assert.equal(fetchStub.calls.length, 2)
})

test('preflight guards empty, null, and non-JSON successful payloads', async () => {
  for (const text of ['', 'null', 'plain text']) {
    const projectRoot = linkedProjectRoot(`site-${text.length}`)
    const fetchStub = stubFetch([
      { match: '/user', status: 200, text },
      { match: '/sites/', status: 200, text },
    ])
    const verdict = await checkNetlifyAccess({
      projectRoot,
      env: { NETLIFY_AUTH_TOKEN: 'tok-1' },
      home: tmpRoot('nax-preflight-home-'),
      fetch: fetchStub,
    })

    assert.equal(verdict.ok, true)
    assert.equal(verdict.account, null)
    assert.equal(verdict.site.name, '')
    assert.equal(fetchStub.calls.length, 2)
  }
})

test('preflight maps other site HTTP failures without retrying', async () => {
  const projectRoot = linkedProjectRoot('site-error')
  const fetchStub = stubFetch([
    { match: '/user', status: 200, body: { email: 'david@example.com' } },
    { match: '/sites/site-error', status: 500, body: { error: 'down' } },
  ])
  const verdict = await checkNetlifyAccess({
    projectRoot,
    env: { NETLIFY_AUTH_TOKEN: 'tok-1' },
    home: tmpRoot('nax-preflight-home-'),
    fetch: fetchStub,
  })

  assert.equal(verdict.code, 'network_error')
  assert.match(verdict.message, /returned 500/)
  assert.equal(fetchStub.calls.length, 2)
})

test('preflight telemetry is value-free and observer-safe', async () => {
  const projectRoot = linkedProjectRoot('site-telemetry')
  const fetchStub = stubFetch([
    {
      match: '/user',
      status: 401,
      body: { error: 'response-secret' },
    },
  ])
  const events = []
  const verdict = await checkNetlifyAccess({
    projectRoot,
    env: { NETLIFY_AUTH_TOKEN: 'token-secret' },
    home: tmpRoot('nax-preflight-home-'),
    fetch: fetchStub,
    onRequestFailure: (event) => {
      events.push(event)
      throw new Error('observer-secret')
    },
  })

  assert.equal(verdict.code, 'bad_token')
  assert.equal(events.length, 1)
  assert.doesNotMatch(
    JSON.stringify(events),
    /token-secret|response-secret|observer-secret/,
  )
})

test('preflight checks an explicit run target instead of the root-linked site', async () => {
  const projectRoot = linkedProjectRoot('root-site')
  const fetchStub = stubFetch([
    { match: '/user', status: 200, body: { email: 'david@example.com' } },
    { match: '/sites/runner-site', status: 200, body: { name: 'runner-site-name', account_slug: 'good-team' } },
  ])
  const verdict = await checkNetlifyAccess({
    projectRoot,
    siteId: 'runner-site',
    env: { NETLIFY_AUTH_TOKEN: 'tok-1' },
    home: tmpRoot('nax-preflight-home-'),
    fetch: fetchStub,
  })

  assert.equal(verdict.ok, true)
  assert.equal(verdict.site.id, 'runner-site')
  assert.equal(verdict.site.name, 'runner-site-name')
  assert.equal(fetchStub.calls.some((call) => call.url.includes('/sites/root-site')), false)
})

test('preflight reports no_token without any network calls', async () => {
  const projectRoot = linkedProjectRoot()
  const fetchStub = stubFetch([])
  const verdict = await checkNetlifyAccess({
    projectRoot,
    env: {},
    home: tmpRoot('nax-preflight-home-'),
    fetch: fetchStub,
  })

  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'no_token')
  assert.match(verdict.message, /netlify login|NETLIFY_AUTH_TOKEN/)
  assert.equal(fetchStub.calls.length, 0)
})

test('preflight reports no_site without any network calls', async () => {
  const projectRoot = tmpRoot('nax-preflight-unlinked-')
  const fetchStub = stubFetch([])
  const verdict = await checkNetlifyAccess({
    projectRoot,
    env: { NETLIFY_AUTH_TOKEN: 'tok-1' },
    home: tmpRoot('nax-preflight-home-'),
    fetch: fetchStub,
  })

  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'no_site')
  assert.equal(fetchStub.calls.length, 0)
})

test('preflight reports bad_token when the user lookup returns 401', async () => {
  const projectRoot = linkedProjectRoot()
  const fetchStub = stubFetch([
    { match: '/user', status: 401, body: {} },
  ])
  const verdict = await checkNetlifyAccess({
    projectRoot,
    env: { NETLIFY_AUTH_TOKEN: 'tok-expired' },
    home: tmpRoot('nax-preflight-home-'),
    fetch: fetchStub,
  })

  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'bad_token')
  assert.match(verdict.message, /netlify login/)
})

test('preflight reports no_access when the site lookup returns 404 or 403', async () => {
  for (const status of [404, 403]) {
    const projectRoot = linkedProjectRoot('site-999')
    const fetchStub = stubFetch([
      { match: '/user', status: 200, body: { email: 'david@example.com' } },
      { match: '/sites/site-999', status, body: {} },
    ])
    const verdict = await checkNetlifyAccess({
      projectRoot,
      env: { NETLIFY_AUTH_TOKEN: 'tok-1' },
      home: tmpRoot('nax-preflight-home-'),
      fetch: fetchStub,
    })

    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, 'no_access')
    assert.match(verdict.message, /david@example\.com/)
    assert.match(verdict.message, /site-999/)
    assert.match(verdict.message, /wrong Netlify account/)
    assert.equal(verdict.account.email, 'david@example.com')
  }
})

test('preflight degrades to network_error when the API is unreachable', async () => {
  const projectRoot = linkedProjectRoot()
  const fetchStub = stubFetch([
    { match: '/user', error: new Error('getaddrinfo ENOTFOUND api.netlify.com') },
  ])
  const verdict = await checkNetlifyAccess({
    projectRoot,
    env: { NETLIFY_AUTH_TOKEN: 'tok-1' },
    home: tmpRoot('nax-preflight-home-'),
    fetch: fetchStub,
  })

  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'network_error')
})

test('preflight never leaks the token into verdict messages', async () => {
  const projectRoot = linkedProjectRoot()
  const fetchStub = stubFetch([
    { match: '/user', error: new Error('request failed with token tok-secret-999') },
  ])
  const verdict = await checkNetlifyAccess({
    projectRoot,
    env: { NETLIFY_AUTH_TOKEN: 'tok-secret-999' },
    home: tmpRoot('nax-preflight-home-'),
    fetch: fetchStub,
  })

  assert.equal(verdict.message.includes('tok-secret-999'), false)
})

test('accessDeniedMessage names account and site with switch guidance', () => {
  const withEmail = accessDeniedMessage({ email: 'david@example.com', siteId: 'site-1' })
  assert.match(withEmail, /david@example\.com/)
  assert.match(withEmail, /site-1/)
  assert.match(withEmail, /netlify login/)

  const withoutEmail = accessDeniedMessage({ siteId: 'site-1' })
  assert.match(withoutEmail, /site-1/)
  assert.match(withoutEmail, /netlify login/)
})

test('enforceRunPreflight throws on blocking verdicts and warns on ambiguous ones', async () => {
  const { enforceRunPreflight } = require('../../src/integrations/netlify/preflight')

  const blockedRoot = linkedProjectRoot('site-blocked')
  const blockedFetch = stubFetch([
    { match: '/user', status: 200, body: { email: 'david@example.com' } },
    { match: '/sites/site-blocked', status: 404, body: {} },
  ])
  await assert.rejects(
    () => enforceRunPreflight({ projectRoot: blockedRoot, env: { NETLIFY_AUTH_TOKEN: 'tok-1' }, home: tmpRoot('nax-preflight-home-'), fetch: blockedFetch }),
    /wrong Netlify account/,
  )

  const offlineRoot = linkedProjectRoot('site-offline')
  const warnings = []
  const offlineFetch = stubFetch([
    { match: '/user', error: new Error('ENOTFOUND api.netlify.com') },
  ])
  const offlineVerdict = await enforceRunPreflight({
    projectRoot: offlineRoot,
    env: { NETLIFY_AUTH_TOKEN: 'tok-1' },
    home: tmpRoot('nax-preflight-home-'),
    fetch: offlineFetch,
    warn: (message) => warnings.push(message),
  })
  assert.equal(offlineVerdict.code, 'network_error')
  assert.equal(warnings.length, 1)

  const okRoot = linkedProjectRoot('site-ok')
  const okWarnings = []
  const okFetch = stubFetch([
    { match: '/user', status: 200, body: { email: 'david@example.com' } },
    { match: '/sites/site-ok', status: 200, body: { name: 'demo', account_slug: 'team' } },
  ])
  const okVerdict = await enforceRunPreflight({
    projectRoot: okRoot,
    env: { NETLIFY_AUTH_TOKEN: 'tok-1' },
    home: tmpRoot('nax-preflight-home-'),
    fetch: okFetch,
    warn: (message) => okWarnings.push(message),
  })
  assert.equal(okVerdict.ok, true)
  assert.equal(okWarnings.length, 0)
})
