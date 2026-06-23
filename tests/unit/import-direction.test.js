const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..')
const checkerPath = path.join(repoRoot, 'scripts', 'check-import-direction.js')

/**
 * @param {Record<string, string>} files
 * @returns {string}
 */
function fixtureRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-import-boundary-'))
  for (const [filePath, source] of Object.entries(files)) {
    const fullPath = path.join(root, filePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, source)
  }
  return root
}

/**
 * @param {string} root
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runChecker(root) {
  const result = spawnSync(process.execPath, [checkerPath], {
    cwd: repoRoot,
    env: { ...process.env, NAX_BOUNDARY_ROOT: root },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: result.status || 0,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

test('import direction checker rejects dashboard API imports of local runtime helpers', () => {
  const root = fixtureRoot({
    'src/dashboard/api/serializers.js': "const { isUnfinishedRun } = require('../../run-state')\nmodule.exports = { isUnfinishedRun }\n",
    'src/run-state.js': 'module.exports = { isUnfinishedRun: () => false }\n',
  })

  const result = runChecker(root)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /dashboard-api-runtime-import/)
})

test('import direction checker fails forbidden local runtime imports', () => {
  const root = fixtureRoot({
    'src/dashboard/api/local.js': "const fs = require('node:fs')\nmodule.exports = fs\n",
    'src/dashboard/web/src/browser.ts': "import path from 'node:path'\nexport const sep = path.sep\n",
    'src/core/run.js': "const git = require('../integrations/git/client')\nmodule.exports = git\n",
    'src/integrations/git/client.js': 'module.exports = {}\n',
    'src/new-flat-file.js': 'module.exports = {}\n',
  })

  const result = runChecker(root)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /dashboard-api-local-node-import/)
  assert.match(result.stderr, /dashboard-web-node-import/)
  assert.match(result.stderr, /core-runtime-import/)
  assert.match(result.stderr, /new-top-level-src-file/)
})
