import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
)
const sourcePath = resolve(packageRoot, 'src', 'auth', 'request.ts')
const source = readFileSync(sourcePath, 'utf8')
const next = source.replace(
  /export const AGENT_RUNNER_SDK_VERSION = '[^']+' as const/,
  `export const AGENT_RUNNER_SDK_VERSION = '${manifest.version}' as const`,
)

if (next === source && !source.includes(
  `AGENT_RUNNER_SDK_VERSION = '${manifest.version}'`,
)) {
  throw new Error('Could not locate the SDK version declaration.')
}
writeFileSync(sourcePath, next)
