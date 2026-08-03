import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface NetlifyTokenResult {
  token: string
  source: string
}

export interface NetlifyCliConfigOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
}

export interface ResolveNetlifyTokenOptions extends NetlifyCliConfigOptions {
  token?: string
  constructorToken?: string
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * Returns Netlify CLI config candidates in compatibility order.
 *
 * The platform-specific paths mirror the config-directory subset of
 * env-paths('netlify', { suffix: '' }). macOS/Linux retain nax's historic
 * candidate order; Windows gains its native config path first.
 */
export function netlifyCliConfigCandidates({
  env = process.env,
  home = homedir(),
  platform = process.platform,
}: NetlifyCliConfigOptions = {}): string[] {
  const xdgConfigHome = env.XDG_CONFIG_HOME || join(home, '.config')
  const historic = [
    join(home, 'Library', 'Preferences', 'netlify', 'config.json'),
    join(xdgConfigHome, 'netlify', 'config.json'),
    join(home, '.netlify', 'config.json'),
  ]
  if (platform !== 'win32') return unique(historic)
  const windowsRoot = env.APPDATA || join(home, 'AppData', 'Roaming')
  return unique([
    join(windowsRoot, 'netlify', 'Config', 'config.json'),
    ...historic,
  ])
}

function tokenFromConfig(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ''
  }
  const config = value as Record<string, unknown>
  if (typeof config.userId !== 'string') return ''
  if (
    typeof config.users !== 'object'
    || config.users === null
    || Array.isArray(config.users)
  ) {
    return ''
  }
  const user = (config.users as Record<string, unknown>)[config.userId]
  if (typeof user !== 'object' || user === null || Array.isArray(user)) return ''
  const auth = (user as Record<string, unknown>).auth
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) return ''
  const token = (auth as Record<string, unknown>).token
  return typeof token === 'string' ? token : ''
}

export function readNetlifyCliToken(
  options: NetlifyCliConfigOptions = {},
): NetlifyTokenResult {
  const env = options.env ?? process.env
  if (env.NETLIFY_AUTH_TOKEN) {
    return {
      token: env.NETLIFY_AUTH_TOKEN,
      source: 'NETLIFY_AUTH_TOKEN',
    }
  }

  for (const filePath of netlifyCliConfigCandidates({ ...options, env })) {
    if (!existsSync(filePath)) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
      const token = tokenFromConfig(parsed)
      if (token) return { token, source: filePath }
    } catch {
      // Missing, unreadable, corrupt, and unfamiliar configs are skipped.
    }
  }
  return { token: '', source: '' }
}

export function resolveNetlifyToken({
  token,
  constructorToken,
  ...cliOptions
}: ResolveNetlifyTokenOptions = {}): NetlifyTokenResult {
  if (token) return { token, source: 'operation' }
  if (constructorToken) return { token: constructorToken, source: 'constructor' }
  return readNetlifyCliToken(cliOptions)
}
