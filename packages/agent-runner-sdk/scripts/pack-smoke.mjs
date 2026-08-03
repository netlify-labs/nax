import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { smokePackageSpec } from './consumer-smoke.mjs'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratchRoot = mkdtempSync(join(tmpdir(), 'nax-agent-runner-sdk-pack-'))
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
  assert.equal(
    packed.files.some((file) => file.path === 'dist/index.d.cts'),
    true,
  )
  for (const path of [
    'README.md',
    'CHANGELOG.md',
    'examples/eventbridge-resume.ts',
    'examples/run-outcome.ts',
    'examples/tsconfig.json',
  ]) {
    assert.equal(
      packed.files.some((file) => file.path === path),
      true,
      `${path} must be included in the npm artifact`,
    )
  }
  const tarball = join(packRoot, packed.filename)

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'nax-agent-runner-sdk')
  assert.equal(manifest.engines.node, '>=18')
  smokePackageSpec(tarball, { expectedVersion: manifest.version })
} finally {
  rmSync(scratchRoot, { recursive: true, force: true })
}
