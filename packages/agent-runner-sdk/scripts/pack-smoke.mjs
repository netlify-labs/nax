import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratchRoot = mkdtempSync(join(tmpdir(), 'agent-runner-sdk-pack-'))
const packRoot = join(scratchRoot, 'pack')
mkdirSync(packRoot)

try {
  const packJson = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', packRoot],
    { cwd: packageRoot, encoding: 'utf8' },
  )
  const [packed] = JSON.parse(packJson)
  assert.equal(typeof packed?.filename, 'string')
  const tarball = join(packRoot, packed.filename)

  for (const moduleType of ['module', 'commonjs']) {
    const consumerRoot = join(scratchRoot, moduleType)
    mkdirSync(consumerRoot)
    writeFileSync(
      join(consumerRoot, 'package.json'),
      `${JSON.stringify({ private: true, type: moduleType }, null, 2)}\n`,
    )
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
      { cwd: consumerRoot, stdio: 'pipe' },
    )
    const source = moduleType === 'module'
      ? "import { AGENT_RUNNER_SDK_HANDLE_VERSION } from 'agent-runner-sdk'\nif (AGENT_RUNNER_SDK_HANDLE_VERSION !== 1) process.exit(1)\n"
      : "const { AGENT_RUNNER_SDK_HANDLE_VERSION } = require('agent-runner-sdk')\nif (AGENT_RUNNER_SDK_HANDLE_VERSION !== 1) process.exit(1)\n"
    const entrypoint = join(consumerRoot, 'smoke.js')
    writeFileSync(entrypoint, source)
    execFileSync(process.execPath, [entrypoint], { cwd: consumerRoot, stdio: 'pipe' })
  }

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'agent-runner-sdk')
  assert.equal(manifest.engines.node, '>=18')
} finally {
  rmSync(scratchRoot, { recursive: true, force: true })
}
