const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  acpSessionPath,
  loadAcpSession,
  saveAcpSession,
} = require('../../src/integrations/acp/session-store')

/** @returns {string} */
function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-acp-store-'))
}

/**
 * @param {string} projectRoot
 * @returns {import('../../src/integrations/acp/session-store').AcpSessionRecord}
 */
function record(projectRoot) {
  return {
    version: 1,
    sessionId: 'nax-1234',
    cwd: projectRoot,
    projectRoot,
    siteId: 'site-1',
    branch: 'main',
    config: { agent: 'claude', model: 'auto', effort: 'auto', changes: 'apply' },
    handle: null,
    transcript: [],
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
  }
}

test('saves and loads a session record under the project .nax directory', () => {
  const projectRoot = tempProject()
  const saved = record(projectRoot)
  saveAcpSession(saved)
  assert.equal(acpSessionPath(projectRoot, 'nax-1234'), path.join(projectRoot, '.nax', 'acp-sessions', 'nax-1234.json'))
  assert.deepEqual(loadAcpSession(projectRoot, 'nax-1234'), saved)
})

test('saving ignores .nax in git so session records never land in the workspace diff', () => {
  const projectRoot = tempProject()
  saveAcpSession(record(projectRoot))
  assert.match(fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8'), /^\.nax\/$/m)
})

test('loading an unknown session returns null', () => {
  assert.equal(loadAcpSession(tempProject(), 'nax-missing'), null)
})

test('session ids that could escape the sessions directory are rejected', () => {
  const projectRoot = tempProject()
  assert.throws(() => acpSessionPath(projectRoot, '../state'), /Invalid ACP session id/)
  assert.throws(() => loadAcpSession(projectRoot, 'a/b'), /Invalid ACP session id/)
  assert.throws(() => saveAcpSession({ ...record(projectRoot), sessionId: '' }), /Invalid ACP session id/)
})
