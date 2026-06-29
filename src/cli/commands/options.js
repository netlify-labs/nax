/**
 * Normalized CLI options shared across command handlers.
 * @typedef {import('../../types').JsonMap & {
 *   agent?: string,
 *   allProviders?: boolean,
 *   allSkills?: boolean,
 *   artifact?: string,
 *   cost?: boolean,
 *   create?: boolean,
 *   dry?: boolean,
 *   dryRun?: boolean,
 *   filter?: string,
 *   flow?: string,
 *   force?: boolean,
 *   githubActions?: boolean,
 *   netlifySiteId?: string,
 *   projectRoot?: string,
 *   provider?: string[],
 *   quiet?: boolean,
 *   repo?: string,
 *   runner?: string,
 *   session?: string,
 *   siteId?: string,
 *   siteName?: string,
 *   skill?: string[],
 *   skipSecrets?: boolean,
 *   step?: string,
 *   transport?: string,
 *   where?: string,
 *   workflow?: string,
 *   yes?: boolean,
 * }} CliOptions
 *
 * Commander command subset used by option normalization.
 * @typedef {{
 *   parent?: CommanderOptionSource | null,
 *   opts?: () => CliOptions,
 *   getOptionValueSource?: (name: string) => string | undefined,
 * }} CommanderOptionSource
 */

/**
 * Commander repeatable option collector.
 * @param {string} value
 * @param {string[]} [previous]
 * @returns {string[]}
 */
function collectOption(value, previous) {
  return [...(Array.isArray(previous) ? previous : []), value]
}

/**
 * Resolves Commander option wrappers to plain option values.
 * @param {CliOptions | CommanderOptionSource | null | undefined} value
 * @returns {CliOptions | null | undefined}
 */
function commandOptions(value) {
  return value && typeof value.opts === 'function' ? value.opts() : value
}

/**
 * Checks whether Commander received an option from a non-default source.
 * @param {CommanderOptionSource | null | undefined} command
 * @param {string} name
 * @returns {boolean}
 */
function optionWasSet(command, name) {
  if (!command || typeof command.getOptionValueSource !== 'function') return false
  const source = command.getOptionValueSource(name)
  return Boolean(source && source !== 'default')
}

/**
 * Normalizes hidden and legacy option aliases to the durable option names.
 * @param {CliOptions} resolved
 * @returns {CliOptions}
 */
function normalizeOptionAliases(resolved) {
  if (resolved.dry && resolved.dryRun !== true) {
    resolved.dryRun = true
  }
  if (resolved.siteId && !resolved.netlifySiteId) {
    resolved.netlifySiteId = resolved.siteId
  }
  if (resolved.force && resolved.yes !== true) {
    resolved.yes = true
  }
  if (resolved.where && (!resolved.transport || resolved.transport === 'auto')) {
    resolved.transport = resolved.where
  }
  if (resolved.cost === true) {
    process.env.NAX_INCLUDE_COST = '1'
  }
  return resolved
}

/**
 * Merges local command options with explicitly provided parent options.
 * @param {CommanderOptionSource} command
 * @param {CliOptions} options
 * @returns {CliOptions}
 */
function mergeCommandOptions(command, options) {
  const local = commandOptions(options) || {}
  const parentCommand = command?.parent
  const parent = parentCommand && typeof parentCommand.opts === 'function' ? parentCommand.opts() : {}
  const resolved = {
    ...parent,
    ...local,
  }

  for (const key of Object.keys(parent)) {
    if (optionWasSet(parentCommand, key) && !optionWasSet(command, key)) {
      resolved[key] = parent[key]
    }
  }

  return normalizeOptionAliases(resolved)
}

/**
 * Resolves a command action's options with Commander parent inheritance.
 * @param {CliOptions} options
 * @param {CommanderOptionSource} [command]
 * @returns {CliOptions}
 */
function actionOptions(options, command) {
  if (command && typeof command.opts === 'function') {
    return mergeCommandOptions(command, command.opts())
  }
  return normalizeOptionAliases(commandOptions(options) || {})
}

module.exports = {
  actionOptions,
  collectOption,
  commandOptions,
  mergeCommandOptions,
  normalizeOptionAliases,
  optionWasSet,
}
