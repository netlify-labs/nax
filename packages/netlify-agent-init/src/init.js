const fs = require('node:fs')
const path = require('node:path')

const { renderAgentsSection, upsertSection } = require('./agents-md')
const { PACKAGE_KEY, SCHEMA_VERSION, normalizeConfig } = require('./config')
const { version } = require('../package.json')

const COMMAND = 'netlify-agent-init'

/**
 * Chains our command onto an existing postinstall, guarded so installs that skip
 * devDependencies don't fail.
 * @param {string | undefined} existing
 */
function buildPostinstall(existing) {
  if (!existing || !existing.trim()) return `${COMMAND} || exit 0`
  if (existing.includes(COMMAND)) return existing
  return `${existing} && (${COMMAND} || exit 0)`
}

/**
 * Plans the init changes without writing them.
 * @param {{ cwd: string, presets?: Record<string, Record<string, string>> }} options
 * @returns {{
 *   packageJsonPath: string,
 *   packageJson: Record<string, unknown>,
 *   agentsPath: string,
 *   agentsContent: string,
 *   warnings: string[],
 *   errors: string[],
 *   isNewPackage: boolean,
 * }}
 */
function planInit({ cwd, presets = {} }) {
  const packageJsonPath = path.join(cwd, 'package.json')
  const isNewPackage = !fs.existsSync(packageJsonPath)
  /** @type {Record<string, unknown> & { scripts?: Record<string, string>, devDependencies?: Record<string, string>, private?: boolean }} */
  const pkg = isNewPackage
    ? { name: path.basename(cwd), private: true }
    : JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const warnings = []
  if (!isNewPackage && pkg.private !== true) {
    warnings.push('package.json is not "private": true. If this package is published, its postinstall would run in every downstream install.')
  }

  const current = pkg[PACKAGE_KEY]
  /** @type {Record<string, unknown> & { presets?: Record<string, Record<string, string>> }} */
  const existingConfig = current && typeof current === 'object' && !Array.isArray(current)
    ? /** @type {Record<string, unknown>} */ (current)
    : {}
  const nextConfig = {
    schemaVersion: SCHEMA_VERSION,
    ...existingConfig,
    presets: { ...(existingConfig.presets || {}), ...presets },
  }
  const normalized = normalizeConfig(nextConfig, `package.json#${PACKAGE_KEY}`)

  pkg.scripts = { ...(pkg.scripts || {}), postinstall: buildPostinstall(pkg.scripts?.postinstall) }
  pkg.devDependencies = { ...(pkg.devDependencies || {}), [COMMAND]: `^${version}` }
  pkg[PACKAGE_KEY] = nextConfig

  const agentsPath = path.join(cwd, 'AGENTS.md')
  const currentAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : ''
  const agentsContent = normalized.config
    ? upsertSection(currentAgents, renderAgentsSection(normalized.config))
    : currentAgents

  return {
    packageJsonPath,
    packageJson: pkg,
    agentsPath,
    agentsContent,
    warnings: [...warnings, ...normalized.warnings],
    errors: normalized.errors,
    isNewPackage,
  }
}

/**
 * Writes the planned changes.
 * @param {ReturnType<typeof planInit>} plan
 */
function applyInit(plan) {
  fs.writeFileSync(plan.packageJsonPath, JSON.stringify(plan.packageJson, null, 2) + '\n')
  fs.writeFileSync(plan.agentsPath, plan.agentsContent)
}

module.exports = {
  applyInit,
  buildPostinstall,
  planInit,
}
