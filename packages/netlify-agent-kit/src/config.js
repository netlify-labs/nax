const fs = require('node:fs')
const path = require('node:path')

const { PRESETS } = require('./presets')

const CONFIG_FILE = 'netlify-agent.json'
const PACKAGE_KEY = 'netlifyAgent'

/**
 * @typedef {{ env: string }} AuthRef
 * @typedef {{ name: string, link: string[] }} ToolSpec
 * @typedef {{ from: string, path?: string, names?: string[], registry?: string, auth?: AuthRef }} SkillSpec
 * @typedef {{ command: string, cwd?: string }} RunSpec
 * @typedef {{ repo: string, ref?: string, path?: string, auth?: AuthRef }} RepositorySpec
 * @typedef {{ env: string, prefix?: string }} EnvValueRef
 * @typedef {{
 *   command?: string,
 *   args?: string[],
 *   url?: string,
 *   type?: string,
 *   env?: Record<string, string | EnvValueRef>,
 *   headers?: Record<string, string | EnvValueRef>,
 * }} McpServerSpec
 *
 * @typedef {{
 *   tools?: ToolSpec[],
 *   skills?: SkillSpec[],
 *   run?: RunSpec[],
 *   guide?: string[],
 * }} PresetResult
 *
 * @typedef {{
 *   description: string | null,
 *   presets: Record<string, Record<string, string>>,
 *   secrets: string[],
 *   repositories: RepositorySpec[],
 *   tools: ToolSpec[],
 *   skills: SkillSpec[],
 *   run: RunSpec[],
 *   mcpServers: Record<string, McpServerSpec>,
 *   experimental: { mcpServers: boolean },
 *   strict: boolean,
 *   guide: string[],
 * }} AgentConfig
 *
 * @typedef {{
 *   config: AgentConfig | null,
 *   source: string | null,
 *   errors: string[],
 *   warnings: string[],
 * }} LoadedConfig
 */

const KNOWN_KEYS = new Set([
  '$schema',
  'description',
  'secrets',
  'repositories',
  'tools',
  'skills',
  'run',
  'mcpServers',
  'experimental',
  'strict',
])

/**
 * Reads netlify-agent.json, falling back to package.json#netlifyAgent.
 * @param {string} cwd
 * @returns {{ raw: Record<string, unknown> | null, source: string | null, error?: string }}
 */
function readRawConfig(cwd) {
  const file = path.join(cwd, CONFIG_FILE)
  if (fs.existsSync(file)) {
    try {
      return { raw: JSON.parse(fs.readFileSync(file, 'utf8')), source: CONFIG_FILE }
    } catch (error) {
      return { raw: null, source: CONFIG_FILE, error: `${CONFIG_FILE} is not valid JSON: ${error.message}` }
    }
  }
  const pkgFile = path.join(cwd, 'package.json')
  if (!fs.existsSync(pkgFile)) return { raw: null, source: null }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    if (pkg && typeof pkg[PACKAGE_KEY] === 'object' && pkg[PACKAGE_KEY] !== null) {
      return { raw: pkg[PACKAGE_KEY], source: `package.json#${PACKAGE_KEY}` }
    }
    return { raw: null, source: null }
  } catch (error) {
    return { raw: null, source: 'package.json', error: `package.json is not valid JSON: ${error.message}` }
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {string} version */
function isExactVersion(version) {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)
}

/** @param {string} ref */
function isPinnedRef(ref) {
  return /^[0-9a-f]{7,40}$/i.test(ref) || /^v?\d+(\.\d+){0,2}([-.+][0-9A-Za-z.-]+)?$/.test(ref)
}

/**
 * Splits "npm:@scope/name@1.2.3" into its package and version.
 * @param {string} from
 * @returns {{ name: string, version: string } | null}
 */
function parseNpmSpec(from) {
  const match = /^npm:((?:@[^/@]+\/)?[^@]+)@(.+)$/.exec(from)
  return match ? { name: match[1], version: match[2] } : null
}

/**
 * Splits "github:owner/repo#ref".
 * @param {string} from
 * @returns {{ owner: string, repo: string, ref: string } | null}
 */
function parseGitHubSpec(from) {
  const match = /^github:([^/#]+)\/([^/#]+)#(.+)$/.exec(from)
  return match ? { owner: match[1], repo: match[2], ref: match[3] } : null
}

/**
 * @param {unknown} auth
 * @param {string} where
 * @param {string[]} errors
 * @returns {AuthRef | undefined}
 */
function normalizeAuth(auth, where, errors) {
  if (auth === undefined) return undefined
  if (!isPlainObject(auth) || typeof auth.env !== 'string' || !auth.env) {
    errors.push(`${where}.auth must be { "env": "VARIABLE_NAME" }`)
    return undefined
  }
  return { env: auth.env }
}

/**
 * Validates raw config and expands presets. A preset is a top-level key named after
 * it, for example { "hyperframes": { "version": "0.8.217", "dir": "video" } }.
 * @param {Record<string, unknown>} raw
 * @param {string} source
 * @returns {LoadedConfig}
 */
function normalizeConfig(raw, source) {
  const errors = []
  const warnings = []

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key) && !PRESETS[key]) {
      warnings.push(`unknown key "${key}" in ${source} (ignored). Presets: ${Object.keys(PRESETS).join(', ')}`)
    }
  }

  /** @type {AgentConfig} */
  const config = {
    description: typeof raw.description === 'string' ? raw.description : null,
    presets: {},
    secrets: [],
    repositories: [],
    tools: [],
    skills: [],
    run: [],
    mcpServers: {},
    experimental: { mcpServers: false },
    strict: raw.strict === true,
    guide: [],
  }

  for (const [name, preset] of Object.entries(PRESETS)) {
    const options = raw[name]
    if (options === undefined) continue
    if (!isPlainObject(options)) {
      errors.push(`"${name}" must be an object, for example { "version": "0.8.217" }`)
      continue
    }
    try {
      const result = preset.expand(/** @type {Record<string, string>} */ (options))
      config.presets[name] = /** @type {Record<string, string>} */ (options)
      config.tools.push(...(result.tools || []))
      config.skills.push(...(result.skills || []))
      config.run.push(...(result.run || []))
      config.guide.push(...(result.guide || []))
    } catch (error) {
      errors.push(error.message)
    }
  }

  if (raw.secrets !== undefined) {
    if (!Array.isArray(raw.secrets) || raw.secrets.some((name) => typeof name !== 'string' || !name)) {
      errors.push('secrets must be a list of environment variable names')
    } else {
      config.secrets.push(...raw.secrets)
    }
  }

  if (raw.repositories !== undefined) {
    if (!Array.isArray(raw.repositories)) {
      errors.push('repositories must be a list')
    } else {
      raw.repositories.forEach((entry, index) => {
        const where = `repositories[${index}]`
        if (!isPlainObject(entry) || typeof entry.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(entry.repo)) {
          errors.push(`${where}.repo must be "owner/name"`)
          return
        }
        const ref = typeof entry.ref === 'string' && entry.ref ? entry.ref : undefined
        if (!ref) warnings.push(`${where} (${entry.repo}) has no "ref"; pin a tag or SHA so agents see the same code every run`)
        config.repositories.push({
          repo: entry.repo,
          ref,
          path: typeof entry.path === 'string' && entry.path ? entry.path : undefined,
          auth: normalizeAuth(entry.auth, where, errors),
        })
      })
    }
  }

  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) {
      errors.push('tools must be a list')
    } else {
      raw.tools.forEach((entry, index) => {
        if (typeof entry === 'string') {
          config.tools.push({ name: entry, link: [] })
        } else if (isPlainObject(entry) && typeof entry.name === 'string') {
          const link = Array.isArray(entry.link) ? entry.link.filter((item) => typeof item === 'string') : []
          config.tools.push({ name: entry.name, link })
        } else {
          errors.push(`tools[${index}] must be a tool name or { "name": "...", "link": [...] }`)
        }
      })
    }
  }

  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) {
      errors.push('skills must be a list')
    } else {
      raw.skills.forEach((entry, index) => {
        const where = `skills[${index}]`
        if (!isPlainObject(entry) || typeof entry.from !== 'string' || !entry.from) {
          errors.push(`${where}.from is required`)
          return
        }
        if (entry.names !== undefined && (!Array.isArray(entry.names) || entry.names.some((name) => typeof name !== 'string'))) {
          errors.push(`${where}.names must be a list of skill folder names`)
          return
        }
        config.skills.push({
          from: entry.from,
          path: typeof entry.path === 'string' ? entry.path : undefined,
          names: Array.isArray(entry.names) ? entry.names : undefined,
          registry: typeof entry.registry === 'string' ? entry.registry : undefined,
          auth: normalizeAuth(entry.auth, where, errors),
        })
      })
    }
  }

  config.skills.forEach((skill, index) => {
    const where = `skills[${index}] (${skill.from})`
    if (skill.from.startsWith('npm:')) {
      const spec = parseNpmSpec(skill.from)
      if (!spec) errors.push(`${where}: use "npm:<package>@<exact version>"`)
      else if (!isExactVersion(spec.version)) warnings.push(`${where}: pin an exact version instead of "${spec.version}"`)
    } else if (skill.from.startsWith('github:')) {
      const spec = parseGitHubSpec(skill.from)
      if (!spec) errors.push(`${where}: use "github:<owner>/<repo>#<tag or sha>"`)
      else if (!isPinnedRef(spec.ref)) warnings.push(`${where}: "${spec.ref}" looks like a branch; pin a tag or SHA`)
    } else if (!skill.from.startsWith('./') && !skill.from.startsWith('../') && !path.isAbsolute(skill.from)) {
      errors.push(`${where}: "from" must start with npm:, github:, or ./`)
    }
  })

  if (raw.run !== undefined) {
    if (!Array.isArray(raw.run)) {
      errors.push('run must be a list')
    } else {
      raw.run.forEach((entry, index) => {
        if (typeof entry === 'string' && entry.trim()) config.run.push({ command: entry })
        else if (isPlainObject(entry) && typeof entry.command === 'string' && entry.command.trim()) {
          config.run.push({ command: entry.command, cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined })
        } else {
          errors.push(`run[${index}] must be a command or { "command": "...", "cwd": "..." }`)
        }
      })
    }
  }

  if (raw.mcpServers !== undefined) {
    if (!isPlainObject(raw.mcpServers)) errors.push('mcpServers must be an object keyed by server name')
    else config.mcpServers = /** @type {Record<string, McpServerSpec>} */ (raw.mcpServers)
  }

  if (isPlainObject(raw.experimental)) {
    config.experimental.mcpServers = raw.experimental.mcpServers === true
  }
  if (Object.keys(config.mcpServers).length > 0 && !config.experimental.mcpServers) {
    warnings.push('mcpServers is experimental and is ignored unless "experimental": { "mcpServers": true } is set')
  }

  config.tools = dedupe(config.tools, (tool) => tool.name, (a, b) => ({ name: a.name, link: [...new Set([...a.link, ...b.link])] }))
  config.skills = dedupe(config.skills, (skill) => `${skill.from}::${skill.path || ''}::${(skill.names || []).join(',')}`)
  config.run = dedupe(config.run, (entry) => `${entry.cwd || '.'}::${entry.command}`)

  return { config, source, errors, warnings }
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} key
 * @param {(a: T, b: T) => T} [merge]
 * @returns {T[]}
 */
function dedupe(items, key, merge) {
  /** @type {Map<string, T>} */
  const seen = new Map()
  for (const item of items) {
    const k = key(item)
    const existing = seen.get(k)
    seen.set(k, existing && merge ? merge(existing, item) : existing || item)
  }
  return [...seen.values()]
}

/**
 * @param {string} cwd
 * @returns {LoadedConfig}
 */
function loadConfig(cwd) {
  const { raw, source, error } = readRawConfig(cwd)
  if (error) return { config: null, source, errors: [error], warnings: [] }
  if (!raw) return { config: null, source: null, errors: [], warnings: [] }
  if (!isPlainObject(raw)) return { config: null, source, errors: [`${source} must be an object`], warnings: [] }
  return normalizeConfig(raw, source)
}

module.exports = {
  CONFIG_FILE,
  PACKAGE_KEY,
  isExactVersion,
  isPinnedRef,
  loadConfig,
  normalizeConfig,
  parseGitHubSpec,
  parseNpmSpec,
}
