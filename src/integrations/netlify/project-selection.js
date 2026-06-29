const path = require('path')
const { spawnSync } = require('child_process')
const {
  detectJavascriptWorkspace,
  listNetlifyFilterCandidates,
} = require('./local-runner')

/**
 * Normalized CLI options with Netlify target fields.
 * @typedef {import('../../cli/commands/options').CliOptions & {
 *   configSource?: string,
 *   netlifyConfig?: string,
 *   netlifySiteSource?: string,
 *   flowsDir?: string[],
 *   flowsDirs?: string[],
 * }} NetlifyCliOptions
 *
 * Netlify project/config candidate discovered in the current repository.
 * @typedef {{
 *   source?: string,
 *   dir?: string,
 *   configDir?: string,
 *   filter?: string,
 *   siteId?: string,
 *   stateSource?: string,
 * }} NetlifyConfigCandidate
 *
 * JavaScript workspace package-manager details.
 * @typedef {{
 *   name?: string,
 * }} WorkspacePackageManager
 *
 * JavaScript workspace detection result.
 * @typedef {{
 *   isWorkspace?: boolean,
 *   packageManager?: WorkspacePackageManager,
 * }} WorkspaceDetection
 *
 * Function that detects workspace package-manager shape for one project.
 * @typedef {(input: {
 *   projectRoot?: string,
 *   projectDir?: string,
 * }) => WorkspaceDetection | Promise<WorkspaceDetection>} WorkspaceDetector
 *
 * Result shape returned by Netlify project target resolution.
 * @typedef {{
 *   siteId?: string,
 *   siteSource?: string,
 *   configSource?: string,
 *   filter?: string,
 * }} NetlifyProjectTarget
 *
 * Clack select dependency subset used by interactive Netlify selection.
 * @typedef {{
 *   select: (input: {
 *     message: string,
 *     options: Array<{
 *       value?: string,
 *       label: string,
 *       hint: string,
 *     }>,
 *   }) => Promise<string | symbol>,
 *   isCancel: (value: string | symbol) => boolean,
 * }} ClackSelectApi
 *
 * Context for Netlify config distance sorting.
 * @typedef {{
 *   projectRoot?: string,
 *   invocationDir?: string,
 * }} NetlifyConfigDistanceContext
 *
 * Inputs for choosing a Netlify filter/config option.
 * @typedef {{
 *   projectRoot?: string,
 *   invocationDir?: string,
 *   options?: NetlifyCliOptions,
 *   detectWorkspace?: WorkspaceDetector,
 *   loadClack?: () => Promise<ClackSelectApi>,
 * }} ChooseNetlifyFilterInput
 */

let clackModulePromise

/**
 * Lazily loads Clack for interactive Netlify project selection.
 * @returns {Promise<ClackSelectApi>}
 */
async function defaultLoadClack() {
  clackModulePromise = clackModulePromise || import('@clack/prompts')
  return clackModulePromise
}

/**
 * Finds the current Git repository root.
 * @param {string} [cwd]
 * @returns {string}
 */
function gitRepositoryRoot(cwd = process.cwd()) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  })
  if (result.status !== 0) return ''
  return result.stdout.trim()
}

/**
 * Resolves the project root from an explicit option, git root, or cwd.
 * @param {string | null | undefined} optionRoot
 * @param {{ cwd?: string }} [context]
 * @returns {string}
 */
function resolveProjectRoot(optionRoot, { cwd = process.cwd() } = {}) {
  if (optionRoot) return path.resolve(optionRoot)
  return gitRepositoryRoot(cwd) || path.resolve(cwd)
}

/**
 * Prints the chosen Netlify filter when it came from project metadata.
 * @param {{ filter?: string, source?: string }} resolved
 * @returns {void}
 */
function maybeReportNetlifyFilter(resolved) {
  if (!resolved?.filter) return
  if (resolved.source && resolved.source !== 'option') {
    console.log(`Netlify app filter: ${resolved.filter} (from ${resolved.source})`)
  }
}

/**
 * Prints the chosen Netlify site id and source.
 * @param {NetlifyCliOptions} [options]
 * @returns {void}
 */
function maybeReportNetlifySite(options = {}) {
  if (!options.netlifySiteId) return
  const source = options.netlifySiteSource ? ` (${options.netlifySiteSource})` : ''
  console.log(`Netlify site ID: ${options.netlifySiteId}${source}`)
}

/**
 * Prints the selected Netlify config path when one was resolved.
 * @param {NetlifyCliOptions} [options]
 * @returns {void}
 */
function maybeReportNetlifyConfig(options = {}) {
  if (!options.netlifyConfig) return
  console.log(`Netlify config: ${options.netlifyConfig}`)
}

/**
 * Merges resolved Netlify target fields back into CLI options.
 * @param {NetlifyCliOptions} [options]
 * @param {NetlifyProjectTarget} [target]
 * @returns {NetlifyCliOptions}
 */
function netlifyOptionsFromTarget(options = {}, target = {}) {
  return {
    ...options,
    ...(target.siteId ? { netlifySiteId: target.siteId } : {}),
    ...(target.siteSource ? { netlifySiteSource: target.siteSource } : {}),
    ...(target.configSource ? { netlifyConfig: target.configSource } : {}),
    ...(target.filter ? { filter: target.filter } : {}),
  }
}

/**
 * Resolves the directory that owns the selected Netlify config.
 * @param {string} projectRoot
 * @param {NetlifyCliOptions} [options]
 * @returns {string}
 */
function configDirForNetlifyOptions(projectRoot, options = {}) {
  const source = String(options.netlifyConfig || options.configSource || '').trim()
  if (!source) return projectRoot
  const configPath = path.isAbsolute(source) ? source : path.join(projectRoot, source)
  return path.basename(configPath) === 'netlify.toml' ? path.dirname(configPath) : configPath
}

/**
 * Formats one Netlify project picker label.
 * @param {NetlifyConfigCandidate} [candidate]
 * @returns {string}
 */
function netlifyProjectChoiceLabel(candidate = {}) {
  const dir = candidate.dir || candidate.source || 'netlify.toml'
  if (candidate.siteId) return `${dir} (${candidate.siteId})`
  return dir
}

/**
 * Formats one Netlify project picker hint.
 * @param {NetlifyConfigCandidate} candidate
 * @param {WorkspaceDetection} [workspaceDetection]
 * @returns {string}
 */
function netlifyConfigChoiceHint(candidate, workspaceDetection = {}) {
  if (candidate.filter) return `uses --filter ${candidate.filter}`
  if (workspaceDetection.isWorkspace === false) return candidate.source ? `config ${candidate.source}` : ''
  return 'no single --filter found in build command'
}

/**
 * Computes relative distance from invocation directory to a Netlify config.
 * @param {NetlifyConfigCandidate} [candidate]
 * @param {NetlifyConfigDistanceContext} [context]
 * @returns {number}
 */
function netlifyConfigDistance(candidate = {}, { projectRoot, invocationDir } = {}) {
  if (!projectRoot || !invocationDir || !candidate.configDir) return 0
  const configDir = path.resolve(candidate.configDir)
  const cwd = path.resolve(invocationDir)
  const relativeFromConfig = path.relative(configDir, cwd)
  if (!relativeFromConfig) return 0
  if (!relativeFromConfig.startsWith('..') && !path.isAbsolute(relativeFromConfig)) {
    return relativeFromConfig.split(path.sep).filter(Boolean).length
  }
  const relativeFromCwd = path.relative(cwd, configDir)
  if (!relativeFromCwd.startsWith('..') && !path.isAbsolute(relativeFromCwd)) {
    return 100 + relativeFromCwd.split(path.sep).filter(Boolean).length
  }
  return 1000 + path.relative(path.resolve(projectRoot), configDir).split(path.sep).filter(Boolean).length
}

/**
 * Sorts Netlify config choices by proximity, inferred filter, then source.
 * @param {NetlifyConfigCandidate[]} [candidates]
 * @param {NetlifyConfigDistanceContext} [context]
 * @returns {NetlifyConfigCandidate[]}
 */
function sortNetlifyConfigChoices(candidates = [], context = {}) {
  return [...candidates].sort((a, b) => {
    const distance = netlifyConfigDistance(a, context) - netlifyConfigDistance(b, context)
    if (distance !== 0) return distance
    if (Boolean(a.filter) !== Boolean(b.filter)) return a.filter ? -1 : 1
    return String(a.source || '').localeCompare(String(b.source || ''))
  })
}

/**
 * Formats a non-interactive ambiguity error for multiple Netlify configs.
 * @param {NetlifyConfigCandidate[]} [candidates]
 * @returns {string}
 */
function formatNetlifyConfigAmbiguity(candidates = []) {
  const lines = sortNetlifyConfigChoices(candidates).map((candidate) => {
    const suffix = candidate.filter ? ` -> --filter ${candidate.filter}` : ' -> no single --filter found'
    return `- ${candidate.source}${suffix}`
  })
  return [
    'Multiple netlify.toml files were found. Pass --filter <app> or run in a TTY and choose one:',
    ...lines,
  ].join('\n')
}

/**
 * Formats the error for selecting an unfilterable config in a workspace.
 * @param {string | symbol} selectedSource
 * @param {WorkspaceDetection} [workspaceDetection]
 * @returns {string}
 */
function formatNetlifyWorkspaceFilterError(selectedSource, workspaceDetection = {}) {
  const packageManager = workspaceDetection.packageManager?.name
    ? ` (${workspaceDetection.packageManager.name} workspace detected)`
    : ''
  return [
    `Selected ${String(selectedSource)} is in a JavaScript workspace${packageManager}, but its build command does not contain exactly one --filter value.`,
    'Pass --filter <app> explicitly or add a single package-manager filter to the Netlify build command.',
  ].join(' ')
}

/**
 * Resolves Netlify filter/config options from discovered project configs.
 * @param {ChooseNetlifyFilterInput} [input]
 * @returns {Promise<NetlifyCliOptions>}
 */
async function chooseNetlifyFilterOption({
  projectRoot,
  invocationDir = process.cwd(),
  options = {},
  detectWorkspace = detectJavascriptWorkspace,
  loadClack = defaultLoadClack,
} = {}) {
  if (options.filter) return options
  const candidates = listNetlifyFilterCandidates(projectRoot)
  if (candidates.length === 0) return options
  if (candidates.length === 1) {
    const [selected] = candidates
    return {
      ...options,
      ...(selected.filter ? { filter: selected.filter, netlifyConfig: selected.source } : {}),
      ...(selected.siteId ? { netlifySiteId: selected.siteId, netlifySiteSource: selected.stateSource } : {}),
    }
  }
  const workspaceDetection = await detectWorkspace({ projectRoot, projectDir: projectRoot })

  if (!process.stdin.isTTY || options.yes) {
    const uniqueFilters = [...new Set(candidates.map((candidate) => candidate.filter).filter(Boolean))]
    if (uniqueFilters.length === 1) {
      const selected = candidates.find((candidate) => candidate.filter === uniqueFilters[0])
      return {
        ...options,
        filter: uniqueFilters[0],
        netlifyConfig: selected?.source || '',
        ...(selected?.siteId ? { netlifySiteId: selected.siteId, netlifySiteSource: selected.stateSource } : {}),
      }
    }
    if (!workspaceDetection.isWorkspace) return options
    throw new Error(formatNetlifyConfigAmbiguity(candidates))
  }

  const clack = await loadClack()
  const choices = sortNetlifyConfigChoices(candidates, { projectRoot, invocationDir })
  const selectedSource = await clack.select({
    message: 'Multiple Netlify projects detected. Choose where to run Agent Runner.',
    options: choices.map((candidate) => ({
      value: candidate.source,
      label: netlifyProjectChoiceLabel(candidate),
      hint: netlifyConfigChoiceHint(candidate, workspaceDetection),
    })),
  })
  if (clack.isCancel(selectedSource)) process.exit(0)
  const selected = candidates.find((candidate) => candidate.source === selectedSource)
  if (!selected?.filter) {
    if (!workspaceDetection.isWorkspace) {
      return {
        ...options,
        netlifyConfig: String(selectedSource),
        ...(selected?.siteId ? { netlifySiteId: selected.siteId, netlifySiteSource: selected.stateSource } : {}),
      }
    }
    throw new Error(formatNetlifyWorkspaceFilterError(selectedSource, workspaceDetection))
  }
  return {
    ...options,
    filter: selected.filter,
    netlifyConfig: selected.source,
    ...(selected.siteId ? { netlifySiteId: selected.siteId, netlifySiteSource: selected.stateSource } : {}),
  }
}

module.exports = {
  chooseNetlifyFilterOption,
  configDirForNetlifyOptions,
  formatNetlifyConfigAmbiguity,
  formatNetlifyWorkspaceFilterError,
  gitRepositoryRoot,
  maybeReportNetlifyConfig,
  maybeReportNetlifyFilter,
  maybeReportNetlifySite,
  netlifyConfigChoiceHint,
  netlifyConfigDistance,
  netlifyOptionsFromTarget,
  netlifyProjectChoiceLabel,
  resolveProjectRoot,
  sortNetlifyConfigChoices,
}
