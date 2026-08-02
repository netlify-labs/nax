import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { smokePackageSpec } from './consumer-smoke.mjs'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
)
const packageSpec = process.argv[2] ?? 'agent-runner-sdk@next'

smokePackageSpec(packageSpec, {
  expectedVersion: manifest.version,
  scratchPrefix: 'agent-runner-sdk-published-',
})
