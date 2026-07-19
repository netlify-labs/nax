// Tests for the Netlify access preflight verdicts: token/site resolution,
// account/site fitness via the API, and offline-tolerant failure codes.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { checkNetlifyAccess, accessDeniedMessage } = require('../../src/integrations/netlify/preflight')

function tmpRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function linkedProjectRoot(siteId = 'site-123') {
  const root = tmpRoot('nax-preflight-project-')
  fs.mkdirSync(path.join(root, '.netlify'))
  fs.writeFileSync(path.join(root, '.netlify', 'state.json'), JSON.stringify({ siteId }))
  return root
}

function stubFetch(responses) {
  const calls = []
  const fetchStub = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const match = responses.find((entry) => String(url).includes(entry.match))
    if (!match) throw new Error(`Unexpected fetch: ${url}`)
    if (match.error) throw match.error
    return {
      ok: match.status >= 200 && match.status < 300,
      status: match.status,
      text: async () => JSON.stringify(match.body || {}),
    }
  }
  fetchStub.calls = calls
  return fetchStub
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
  assert.equal(fetchStub.calls[0].options.headers.authorization, 'Bearer tok-1')
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
