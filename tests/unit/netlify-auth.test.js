const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const {
  netlifyCliConfigCandidates,
  readNetlifyCliToken,
} = require('../../src/integrations/netlify/auth')
const {
  readNetlifyCliToken: readTokenFromCompatibilityExport,
} = require('../../src/integrations/netlify/init')

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeConfig(filePath, token, userId = 'u1') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify({
    userId,
    users: {
      u1: { auth: { token } },
    },
  }))
}

test('Netlify auth adapter resolves env before config and preserves init compatibility', () => {
  const home = tempRoot('nax-auth-home-')
  const configPath = path.join(
    home,
    'Library',
    'Preferences',
    'netlify',
    'config.json',
  )
  writeConfig(configPath, 'token-from-config')

  const options = {
    env: { NETLIFY_AUTH_TOKEN: 'token-from-env' },
    home,
  }
  assert.deepEqual(readNetlifyCliToken(options), {
    token: 'token-from-env',
    source: 'NETLIFY_AUTH_TOKEN',
  })
  assert.deepEqual(
    readTokenFromCompatibilityExport(options),
    readNetlifyCliToken(options),
  )
  assert.equal(readNetlifyCliToken({ env: {}, home }).token, 'token-from-config')
})

test('Netlify auth adapter supports XDG, Windows, and legacy config paths', () => {
  const cases = [
    {
      platform: 'linux',
      envName: 'XDG_CONFIG_HOME',
      pathFor: (root) => path.join(root, 'netlify', 'config.json'),
    },
    {
      platform: 'win32',
      envName: 'APPDATA',
      pathFor: (root) => path.join(
        root,
        'netlify',
        'Config',
        'config.json',
      ),
    },
  ]

  for (const [index, entry] of cases.entries()) {
    const home = tempRoot(`nax-auth-home-${index}-`)
    const configRoot = tempRoot(`nax-auth-config-${index}-`)
    const configPath = entry.pathFor(configRoot)
    writeConfig(configPath, `token-${index}`)
    const env = { [entry.envName]: configRoot }
    assert.deepEqual(
      readNetlifyCliToken({
        env,
        home,
        platform: /** @type {NodeJS.Platform} */ (entry.platform),
      }),
      { token: `token-${index}`, source: configPath },
    )
  }

  const legacyHome = tempRoot('nax-auth-legacy-')
  const legacyPath = path.join(legacyHome, '.netlify', 'config.json')
  writeConfig(legacyPath, 'legacy-token')
  assert.equal(
    readNetlifyCliToken({
      env: {},
      home: legacyHome,
      platform: 'linux',
    }).token,
    'legacy-token',
  )
})

test('Netlify auth adapter skips corrupt configs and never adopts another user', () => {
  const home = tempRoot('nax-auth-corrupt-')
  const [first, second] = netlifyCliConfigCandidates({
    env: {},
    home,
    platform: 'linux',
  })
  fs.mkdirSync(path.dirname(first), { recursive: true })
  fs.writeFileSync(first, '{')
  writeConfig(second, 'later-token')
  assert.deepEqual(
    readNetlifyCliToken({ env: {}, home, platform: 'linux' }),
    { token: 'later-token', source: second },
  )

  writeConfig(second, 'other-user-token', 'missing')
  assert.deepEqual(
    readNetlifyCliToken({ env: {}, home, platform: 'linux' }),
    { token: '', source: '' },
  )
})

test('NETLIFY_AGENT_RUNNER_TOKEN is not an auth alias', () => {
  assert.deepEqual(
    readNetlifyCliToken({
      env: { NETLIFY_AGENT_RUNNER_TOKEN: 'unsupported' },
      home: tempRoot('nax-auth-no-alias-'),
    }),
    { token: '', source: '' },
  )
})
