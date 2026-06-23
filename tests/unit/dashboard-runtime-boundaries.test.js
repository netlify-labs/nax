const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { isInsideDir, openLocalFile } = require('../../src/dashboard/runtime/local-files')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-dashboard-runtime-'))
}

test('dashboard local file opener only opens paths under the project root', async () => {
  const projectRoot = tmpRoot()
  const openedPaths = []
  const filePath = path.join(projectRoot, 'summary.md')
  fs.writeFileSync(filePath, '# Summary\n')

  const opened = await openLocalFile(filePath, {
    projectRoot,
    openModule: (target) => openedPaths.push(target),
  })
  const realFilePath = fs.realpathSync(filePath)

  assert.equal(opened, realFilePath)
  assert.deepEqual(openedPaths, [realFilePath])
  assert.equal(isInsideDir(projectRoot, filePath), true)
  assert.equal(isInsideDir(projectRoot, path.join(projectRoot, '..', 'outside.md')), false)
  await assert.rejects(openLocalFile(path.join(projectRoot, '..', 'outside.md'), { projectRoot, openModule: () => {} }), {
    statusCode: 403,
    code: 'forbidden_path',
  })
})

test('dashboard local file opener rejects symlink escapes', async () => {
  const projectRoot = tmpRoot()
  const outsideDir = tmpRoot()
  const outsidePath = path.join(outsideDir, 'outside.md')
  const symlinkPath = path.join(projectRoot, 'linked-outside.md')
  fs.writeFileSync(outsidePath, '# Outside\n')
  fs.symlinkSync(outsidePath, symlinkPath)

  await assert.rejects(openLocalFile(symlinkPath, {
    projectRoot,
    openModule: () => {
      throw new Error('openModule should not be called')
    },
  }), {
    statusCode: 403,
    code: 'forbidden_path',
  })
})

test('portable dashboard API modules do not import local runtime or root modules directly', () => {
  const apiDir = path.resolve(__dirname, '../../src/dashboard/api')
  const forbiddenRootModules = new Set([
    '../../followup-context',
    '../../followup-delivery',
    '../../followup-persistence',
    '../../followup-plan',
    '../../handoff-runner',
    '../../human-review',
    '../../local-runner',
    '../../netlify-blobs',
    '../../runner-event-log',
    '../../workflow-runner',
  ])
  const files = fs.readdirSync(apiDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => path.join(apiDir, file))
  const violations = []

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const imports = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1])
    for (const imported of imports) {
      if (forbiddenRootModules.has(imported)) violations.push(`${path.basename(file)} -> ${imported}`)
    }
  }

  assert.deepEqual(violations, [])
})
