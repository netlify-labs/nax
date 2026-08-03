import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const tsc = join(
  packageRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
)

export function smokePackageSpec(
  packageSpec,
  {
    expectedVersion,
    scratchPrefix = 'nax-agent-runner-sdk-consumer-',
  },
) {
  const scratchRoot = mkdtempSync(join(tmpdir(), scratchPrefix))

  try {
    for (const moduleType of ['module', 'commonjs']) {
      const consumerRoot = join(scratchRoot, moduleType)
      mkdirSync(consumerRoot)
      writeFileSync(
        join(consumerRoot, 'package.json'),
        `${JSON.stringify({ private: true, type: moduleType }, null, 2)}\n`,
      )
      execFileSync(
        'npm',
        [
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          packageSpec,
        ],
        { cwd: consumerRoot, stdio: 'pipe' },
      )

      const source = moduleType === 'module'
        ? "import { AGENT_RUNNER_SDK_HANDLE_VERSION } from 'nax-agent-runner-sdk'\nif (AGENT_RUNNER_SDK_HANDLE_VERSION !== 1) process.exit(1)\n"
        : "const { AGENT_RUNNER_SDK_HANDLE_VERSION } = require('nax-agent-runner-sdk')\nif (AGENT_RUNNER_SDK_HANDLE_VERSION !== 1) process.exit(1)\n"
      const entrypoint = join(consumerRoot, 'smoke.js')
      writeFileSync(entrypoint, source)
      execFileSync(process.execPath, [entrypoint], {
        cwd: consumerRoot,
        stdio: 'pipe',
      })

      if (moduleType !== 'module') continue

      const installedRoot = join(
        consumerRoot,
        'node_modules',
        'nax-agent-runner-sdk',
      )
      const installedManifest = JSON.parse(
        readFileSync(join(installedRoot, 'package.json'), 'utf8'),
      )
      assert.equal(installedManifest.name, 'nax-agent-runner-sdk')
      assert.equal(installedManifest.version, expectedVersion)
      assert.equal(installedManifest.engines.node, '>=18')

      for (const path of [
        'README.md',
        'CHANGELOG.md',
        'examples/eventbridge-resume.ts',
        'examples/run-outcome.ts',
        'examples/tsconfig.json',
      ]) {
        assert.equal(
          existsSync(join(installedRoot, path)),
          true,
          `${path} must be present in the installed package`,
        )
      }

      execFileSync(
        tsc,
        ['-p', join(installedRoot, 'examples', 'tsconfig.json')],
        { cwd: consumerRoot, stdio: 'pipe' },
      )
    }
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true })
  }
}
