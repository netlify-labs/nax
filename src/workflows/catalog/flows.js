const fs = require('fs')
const path = require('path')
const configorama = require('configorama')
const JSON5 = require('json5')
const { loadPromptFile } = require('./prompts')
const { HUMAN_REVIEW_ACTION, HUMAN_REVIEW_SUBMIT, HUMAN_REVIEW_WAIT_FOR, isHumanReviewStep } = require('../human-review')
const {
  normalizeProviderEffortMap,
  normalizeProviderModelMap,
  resolveAgentRunConfig,
} = require('../../core/agents/configuration')
const { resolveLineup } = require('../../core/agents/instances')
const { FINDINGS_ADAPTER_IDS, TRANSPORT_ALIASES } = require('../../core/constants')

const FLOWS_DIR = path.join(__dirname, '..', '..', '..', 'workflows')
const DEFAULT_PROJECT_FLOWS_DIRS = ['.github/nax-flows']
const CONFIG_FILE_EXTENSIONS = ['json', 'yml', 'yaml', 'toml', 'js', 'cjs', 'mjs', 'ts', 'mts', 'cts']
const FLOW_FILE_EXTENSIONS = ['yml', 'yaml', 'json', 'toml', 'js', 'cjs', 'mjs', 'ts', 'mts', 'cts']
const NAX_CONFIG_FILE_NAMES = CONFIG_FILE_EXTENSIONS.map((extension) => `nax.config.${extension}`)
const FLOW_FILE_NAMES = FLOW_FILE_EXTENSIONS.map((extension) => `flow.${extension}`)
const WAIT_FOR_AGENT_RESULTS = 'agent-results'
const ALLOWED_STEP_ACTIONS = ['issue', 'comment', HUMAN_REVIEW_ACTION]
const ALLOWED_STEP_SUBMITS = ['new-run', 'follow-up', HUMAN_REVIEW_SUBMIT]
const ALLOWED_INPUT_RESULTS = ['all', 'selected', 'peers']
/**
 * @typedef {{ stepId: string, code: string, message: string, hint: string }} FlowDiagnostic
 * @typedef {{ errors: FlowDiagnostic[], warnings: FlowDiagnostic[] }} FlowValidation
 * @typedef {import('../../types').WorkflowFlow} WorkflowFlow
 * @typedef {{ safeMode: true, allowedFileRoots: string[], configDir?: string }} SafeConfigoramaOptions
 * @typedef {{
 *   projectRoot?: string,
 *   flowsDir?: string | string[],
 *   flowsDirs?: string | string[],
 *   env?: NodeJS.ProcessEnv,
 * }} FlowLoadOptions
 * @typedef {{
 *   type?: string,
 *   dir?: string,
 *   configuredPath?: string,
 *   priority?: number,
 * }} FlowSource
 */
const FLOW_PICKER_ORDER = [
  'review',
  'human-review-example',
  'ideas',
  'do-next',
  'security-audit',
  'performance-audit',
  'analytics-audit',
  'seo-audit',
  'accessibility-audit',
  'mobile-responsiveness',
  'e2e-tests',
  'unit-tests',
  'documentation',
  'error-handling',
  'ux-copy-polish',
]

/**
 * @param {string} filePath
 * @returns {SafeConfigoramaOptions}
 */
function safeConfigOptions(filePath) {
  return {
    safeMode: true,
    allowedFileRoots: [path.dirname(filePath)],
    configDir: path.dirname(filePath),
  }
}

const STATIC_MODULE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts'])

/**
 * Parse a JavaScript or TypeScript config whose complete module body is a
 * static object export. JSON5 provides object-literal conveniences without
 * evaluating project code.
 *
 * @param {string} source
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function parseStaticModuleConfig(source, filePath) {
  const withoutBom = source.replace(/^\uFEFF/, '').trim()
  const match = withoutBom.match(/^(?:module\.exports\s*=\s*|export\s+default\s+)([\s\S]+?)\s*;?\s*$/)
  if (!match) {
    throw new Error(
      `Dynamic executable config is blocked in safe mode: ${filePath}. ` +
      'Use a single static "module.exports = { ... }" or "export default { ... }" object export.',
    )
  }

  let objectSource = match[1].trim()
  objectSource = objectSource.replace(/\s+(?:as\s+const|satisfies\s+[A-Za-z_$][\w$<>,.[\] |&]*)\s*$/u, '').trim()
  if (!objectSource.startsWith('{') || !objectSource.endsWith('}')) {
    throw new Error(
      `Dynamic executable config is blocked in safe mode: ${filePath}. ` +
      'The exported value must be a static object literal.',
    )
  }

  try {
    const parsed = JSON5.parse(objectSource)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the exported value is not an object')
    }
    return parsed
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Dynamic executable config is blocked in safe mode: ${filePath}. ` +
      `Only JSON5-compatible static object exports are allowed (${reason}).`,
    )
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<WorkflowFlow>}
 */
async function loadConfigFile(filePath) {
  if (STATIC_MODULE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    const staticConfig = parseStaticModuleConfig(fs.readFileSync(filePath, 'utf8'), filePath)
    const resolved = await configorama(staticConfig, safeConfigOptions(filePath))
    return resolved && typeof resolved === 'object' && !Array.isArray(resolved) ? resolved : {}
  }
  const config = await configorama(filePath, safeConfigOptions(filePath))
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {}
}

function findFlowFile(flowDir) {
  for (const name of FLOW_FILE_NAMES) {
    const filePath = path.join(flowDir, name)
    if (fs.existsSync(filePath)) return filePath
  }
  return null
}

function uniqueValues(values = []) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const normalized = String(value || '').trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return []
}

/** @param {string} message @returns {Error & { code: string }} */
function lineupError(message) {
  return Object.assign(new Error(message), { code: 'invalid_lineup_entry' })
}

/**
 * Normalize a workflow lineup (string-or-object entries). String entries are providers;
 * object entries carry { agent, model?|models?, effort?|efforts?, label? } and are preserved
 * for the instance resolver. A CSV string is split into provider entries.
 * @param {unknown} value
 * @returns {Array<string | Record<string, unknown>>}
 */
function normalizeLineup(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean)
  }
  if (!Array.isArray(value)) return []
  /** @type {Array<string | Record<string, unknown>>} */
  const out = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim()
      if (trimmed) out.push(trimmed)
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const obj = /** @type {Record<string, unknown>} */ (entry)
      if (!String(obj.agent || '').trim()) {
        throw lineupError(`Lineup entry object must have an "agent"; got ${JSON.stringify(entry)}.`)
      }
      out.push(obj)
    } else {
      throw lineupError(`Lineup entry must be a provider string or object; got ${JSON.stringify(entry)}.`)
    }
  }
  return out
}

/**
 * Provider ids in lineup order (deduped) — the back-compat `agents` list derived from a lineup.
 * @param {Array<string | Record<string, unknown>>} lineup
 * @returns {string[]}
 */
function providersFromLineup(lineup) {
  const seen = new Set()
  /** @type {string[]} */
  const out = []
  for (const entry of lineup) {
    const agent = typeof entry === 'string' ? entry : String(entry.agent || '')
    if (agent && !seen.has(agent)) {
      seen.add(agent)
      out.push(agent)
    }
  }
  return out
}

/**
 * @param {unknown} value
 * @param {'models' | 'efforts'} field
 * @param {string} configPath
 * @returns {Record<string, string>}
 */
function normalizeAgentConfigurationMap(value, field, configPath) {
  try {
    return field === 'models'
      ? normalizeProviderModelMap(value)
      : normalizeProviderEffortMap(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    /** @type {Error & { code?: string }} */
    const configurationError = new Error(`${configPath}: ${message}`)
    configurationError.code = 'invalid_agent_configuration'
    throw configurationError
  }
}

function normalizeFlowDirs(value) {
  if (Array.isArray(value)) return uniqueValues(value.map(String))
  if (typeof value !== 'string' || !value.trim()) return []
  return uniqueValues(value.split(',').map((item) => item.trim()))
}

function normalizeEnvFlowDirs(env = process.env) {
  const raw = String(env.NAX_FLOWS_DIRS || env.NAX_FLOWS_DIR || '').trim()
  if (!raw) return []
  const separator = raw.includes(',') ? ',' : path.delimiter
  return uniqueValues(raw.split(separator).map((item) => item.trim()))
}

function resolveProjectPath(projectRoot, value) {
  if (path.isAbsolute(value)) return path.normalize(value)
  return path.resolve(projectRoot, value)
}

async function readNaxConfig(projectRoot) {
  if (!projectRoot) return {}
  for (const name of NAX_CONFIG_FILE_NAMES) {
    const filePath = path.join(projectRoot, name)
    if (!fs.existsSync(filePath)) continue
    return loadConfigFile(filePath)
  }
  return {}
}

/**
 * Project flow directory resolution options.
 * @typedef {{
 *   projectRoot?: string,
 *   flowsDir?: string | string[],
 *   flowsDirs?: string | string[],
 *   env?: NodeJS.ProcessEnv,
 * }} ProjectFlowDirsOptions
 */

/** @param {ProjectFlowDirsOptions} param0 */
async function projectFlowDirs({ projectRoot, flowsDir, flowsDirs, env = process.env } = {}) {
  const root = projectRoot ? path.resolve(projectRoot) : ''
  if (!root) return []

  const explicitDirs = [
    ...normalizeFlowDirs(flowsDirs),
    ...normalizeFlowDirs(flowsDir),
  ]
  if (explicitDirs.length > 0) return uniqueValues(explicitDirs).map((dir) => resolveProjectPath(root, dir))

  const envDirs = normalizeEnvFlowDirs(env)
  if (envDirs.length > 0) return envDirs.map((dir) => resolveProjectPath(root, dir))

  const config = await readNaxConfig(root)
  const configDirs = [
    ...normalizeFlowDirs(config.flowsDirs),
    ...normalizeFlowDirs(config.flowsDir),
  ]
  const selected = configDirs.length > 0 ? configDirs : DEFAULT_PROJECT_FLOWS_DIRS
  return uniqueValues(selected).map((dir) => resolveProjectPath(root, dir))
}

function sourceLabel(source = {}) {
  if (source.type === 'bundled') return 'bundled'
  if (source.configuredPath) return `project ${source.configuredPath}`
  if (source.type === 'project') return 'project'
  return source.type || 'custom'
}

async function flowSources(options = {}) {
  const legacyDirs = normalizeFlowDirs(options.flowsDir)
  if (legacyDirs.length > 0 && !options.projectRoot && !options.flowsDirs) {
    return [{
      type: 'custom',
      dir: path.resolve(legacyDirs[0]),
      configuredPath: legacyDirs[0],
      priority: 0,
    }]
  }

  const sources = []
  if (options.projectRoot) {
    const root = path.resolve(options.projectRoot)
    const dirs = await projectFlowDirs({
      projectRoot: root,
      flowsDir: options.flowsDir,
      flowsDirs: options.flowsDirs,
      env: options.env,
    })
    dirs.forEach((dir, index) => {
      sources.push({
        type: 'project',
        dir,
        configuredPath: path.relative(root, dir) || '.',
        priority: index,
      })
    })
  }

  sources.push({
    type: 'bundled',
    dir: FLOWS_DIR,
    configuredPath: 'bundled',
    priority: sources.length,
  })
  return sources
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

/** @param {WorkflowFlow} raw */
function isFlowDisabled(raw) {
  return normalizeBoolean(raw.disabled, false)
}

function flowDiagnostic({ stepId = '', code, message, hint = '' }) {
  return { stepId, code, message, hint }
}

function formatAllowed(values = []) {
  return values.map((value) => `"${value}"`).join(', ')
}

function promptPathForStep(flow, step) {
  return path.resolve(flow.dir, String(step.prompt || ''))
}

function validateFlowStructure(flow, { existsSync = fs.existsSync } = {}) {
  const errors = []
  const warnings = []
  const steps = Array.isArray(flow.steps) ? flow.steps : []
  const stepIds = new Map()
  const defaults = flow.defaults || {}

  if (Object.prototype.hasOwnProperty.call(defaults, 'agentConfig')) {
    errors.push(flowDiagnostic({
      code: 'invalid_agent_config_wrapper',
      message: 'defaults.agentConfig is not supported.',
      hint: 'Use first-class defaults.models and defaults.efforts maps.',
    }))
  }

  const declaredTransport = String(defaults.transport || 'auto')
  const knownTransport = Object.prototype.hasOwnProperty.call(TRANSPORT_ALIASES, declaredTransport)
  if (!knownTransport) {
    errors.push(flowDiagnostic({
      code: 'invalid_default_transport',
      message: `defaults.transport "${declaredTransport}" is not a supported transport.`,
      hint: `Use one of: ${formatAllowed(Object.keys(TRANSPORT_ALIASES))}.`,
    }))
  }
  const lineupTransport = knownTransport ? TRANSPORT_ALIASES[/** @type {keyof typeof TRANSPORT_ALIASES} */ (declaredTransport)] : 'auto'

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const stepId = String(step.id || `step-${index + 1}`)
    if (stepIds.has(stepId)) {
      errors.push(flowDiagnostic({
        stepId,
        code: 'duplicate_step_id',
        message: `Step id "${stepId}" is used more than once in flow "${flow.id}".`,
        hint: 'Give each step a unique id.',
      }))
    } else {
      stepIds.set(stepId, index)
    }
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const stepId = String(step.id || `step-${index + 1}`)
    const humanReview = isHumanReviewStep(step)
    if (step.submit === 'follow-up' && step.lineupDeclared === true) {
      warnings.push(flowDiagnostic({
        stepId,
        code: 'deprecated_followup_lineup',
        message: `Step "${stepId}" declares agents even though follow-up steps inherit their lineup from the first input step. The declaration is ignored.`,
        hint: 'Remove agents from this follow-up step.',
      }))
    }
    if (Object.prototype.hasOwnProperty.call(step, 'agentConfig')) {
      errors.push(flowDiagnostic({
        stepId,
        code: 'invalid_agent_config_wrapper',
        message: `steps[${index}].agentConfig is not supported.`,
        hint: 'Use first-class step.models and step.efforts maps.',
      }))
    }
    if (!humanReview && !step.prompt) {
      errors.push(flowDiagnostic({
        stepId,
        code: 'missing_prompt',
        message: `Step "${stepId}" is missing a prompt path.`,
        hint: 'Set step.prompt to a prompt file relative to the flow directory.',
      }))
    } else if (!humanReview) {
      const resolvedPrompt = promptPathForStep(flow, step)
      if (!existsSync(resolvedPrompt)) {
        errors.push(flowDiagnostic({
          stepId,
          code: 'missing_prompt_file',
          message: `Step "${stepId}" prompt file does not exist: ${resolvedPrompt}`,
          hint: 'Create the prompt file or update step.prompt.',
        }))
      } else if (readTextIfPossible(resolvedPrompt).trim() === '') {
        warnings.push(flowDiagnostic({
          stepId,
          code: 'empty_prompt_file',
          message: `Step "${stepId}" prompt file is empty: ${resolvedPrompt}`,
          hint: 'Write the step instructions into the prompt file; an agent run with no instructions does nothing useful.',
        }))
      }
    }

    if (!ALLOWED_STEP_ACTIONS.includes(step.action)) {
      errors.push(flowDiagnostic({
        stepId,
        code: 'invalid_action',
        message: `Step "${stepId}" has unsupported action "${step.action}".`,
        hint: `Allowed actions: ${formatAllowed(ALLOWED_STEP_ACTIONS)}.`,
      }))
    }

    if (!ALLOWED_STEP_SUBMITS.includes(step.submit)) {
      errors.push(flowDiagnostic({
        stepId,
        code: 'invalid_submit',
        message: `Step "${stepId}" has unsupported submit "${step.submit}".`,
        hint: `Allowed submit modes: ${formatAllowed(ALLOWED_STEP_SUBMITS)}.`,
      }))
    }

    const allowedWaitFor = humanReview ? HUMAN_REVIEW_WAIT_FOR : WAIT_FOR_AGENT_RESULTS
    if (step.waitFor !== allowedWaitFor) {
      errors.push(flowDiagnostic({
        stepId,
        code: 'invalid_wait_for',
        message: `Step "${stepId}" has unsupported waitFor "${step.waitFor}".`,
        hint: humanReview ? 'Human review steps use waitFor "human-review".' : 'Only "agent-results" is supported.',
      }))
    }

    if (step.input !== undefined && !Array.isArray(step.input)) {
      errors.push(flowDiagnostic({
        stepId,
        code: 'invalid_input',
        message: `Step "${stepId}" input must be an array.`,
        hint: 'Use input entries like { step: "previous-step", results: "all" }.',
      }))
      continue
    }

    if (step.submit === 'follow-up') {
      const firstSource = (step.input || []).find((entry) => entry && entry.step)
      if (!firstSource) {
        errors.push(flowDiagnostic({
          stepId,
          code: 'followup_without_input',
          message: `Follow-up step "${stepId}" has no input step to continue from.`,
          hint: 'Add `input: [{ step: <earlier-step-id>, results: all }]` or change `submit` to `new-run`.',
        }))
      } else {
        const sourceIndex = stepIds.get(String(firstSource.step).trim())
        const sourceStep = sourceIndex === undefined ? null : steps[sourceIndex]
        const sourceHasAgents = sourceStep && (sourceStep.submit === 'follow-up' || (sourceStep.agents || []).length > 0)
        if (sourceStep && (isHumanReviewStep(sourceStep) || !sourceHasAgents)) {
          errors.push(flowDiagnostic({
            stepId,
            code: 'followup_source_not_agent_step',
            message: `Follow-up step "${stepId}" continues from "${firstSource.step}", which runs no agents.`,
            hint: 'Point the first input at an earlier step that runs agents, or change `submit` to `new-run`.',
          }))
        }
      }
    }

    for (const input of step.input || []) {
      const sourceStepId = String(input?.step || '').trim()
      if (!sourceStepId) {
        errors.push(flowDiagnostic({
          stepId,
          code: 'missing_input_step',
          message: `Step "${stepId}" has an input entry without a step id.`,
          hint: 'Set input[].step to an earlier step id.',
        }))
        continue
      }
      if (!stepIds.has(sourceStepId)) {
        errors.push(flowDiagnostic({
          stepId,
          code: 'unknown_input_step',
          message: `Step "${stepId}" references unknown input step "${sourceStepId}".`,
          hint: `Known steps: ${[...stepIds.keys()].join(', ') || 'none'}.`,
        }))
        continue
      }
      const sourceIndex = stepIds.get(sourceStepId)
      if (sourceIndex === index) {
        errors.push(flowDiagnostic({
          stepId,
          code: 'self_input_step',
          message: `Step "${stepId}" cannot use itself as an input source.`,
          hint: 'Reference an earlier step.',
        }))
      } else if (sourceIndex > index) {
        errors.push(flowDiagnostic({
          stepId,
          code: 'future_input_step',
          message: `Step "${stepId}" references later input step "${sourceStepId}".`,
          hint: 'Inputs can only reference earlier steps.',
        }))
      }
      const results = String(input?.results || 'all')
      if (!ALLOWED_INPUT_RESULTS.includes(results)) {
        errors.push(flowDiagnostic({
          stepId,
          code: 'invalid_input_results',
          message: `Step "${stepId}" input from "${sourceStepId || 'unknown'}" has unsupported results mode "${results}".`,
          hint: `Allowed results modes: ${formatAllowed(ALLOWED_INPUT_RESULTS)}.`,
        }))
      }
    }

    const configuredAgents = new Set([
      ...Object.keys(defaults.models || {}),
      ...Object.keys(defaults.efforts || {}),
      ...Object.keys(step.models || {}),
      ...Object.keys(step.efforts || {}),
    ])
    for (const agent of configuredAgents) {
      try {
        resolveAgentRunConfig(agent, {
          defaults: {
            models: defaults.models,
            efforts: defaults.efforts,
          },
          step: {
            models: step.models,
            efforts: step.efforts,
          },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(flowDiagnostic({
          stepId,
          code: /** @type {{ code?: string }} */ (error)?.code || 'invalid_agent_configuration',
          message: `steps[${index}] configuration for "${agent}" is invalid: ${message}`,
          hint: 'Use a model owned by the provider and an effort supported by that model, or set both to auto.',
        }))
      }
    }
    if (!humanReview) {
      try {
        const resolved = resolveLineup(Array.isArray(step.lineup) ? step.lineup : step.agents || [], {
          requestedTransport: lineupTransport,
          models: { ...(defaults.models || {}), ...(step.models || {}) },
          efforts: { ...(defaults.efforts || {}), ...(step.efforts || {}) },
        })
        for (const warning of resolved.warnings || []) {
          const typedWarning = /** @type {{ code?: string, message?: string }} */ (warning)
          warnings.push(flowDiagnostic({
            stepId,
            code: typedWarning.code || 'lineup_warning',
            message: typedWarning.message || String(warning),
            hint: typedWarning.code === 'catalog_passthrough'
              ? 'Check the model id spelling; unknown ids are passed to the Agent Runner, which rejects unsupported models at submit.'
              : 'Review this step\'s model and effort configuration.',
          }))
        }
      } catch (error) {
        const typed = /** @type {{ code?: string, message?: string }} */ (error)
        const code = typed.code === 'github_transport_unsupported' && lineupTransport === 'github'
          ? 'transport_lineup_conflict'
          : typed.code || 'invalid_lineup'
        const hint = code === 'step_instance_limit'
          ? 'Reduce the models/efforts fan-out or split the work into another step.'
          : code === 'duplicate_instance'
            ? 'Vary the model or effort for repeated providers, or remove the duplicate entry.'
            : code === 'github_transport_unsupported' || code === 'transport_lineup_conflict'
              ? 'Use the Netlify API transport for pinned models, efforts, or multiple instances from one provider.'
              : 'Review this step\'s agent lineup, model, and effort configuration.'
        errors.push(flowDiagnostic({
          stepId,
          code,
          message: typed.message || `Step "${stepId}" has an invalid agent lineup.`,
          hint,
        }))
      }
    }
  }

  const findingsError = findingsDeclarationError(flow.findings, steps)
  if (findingsError) errors.push(findingsError)

  warnings.push(...unusedPromptFileWarnings(flow, steps))
  return { errors, warnings }
}

/**
 * Normalizes the optional `findings: { step, adapter }` flow key.
 * @param {unknown} value
 * @returns {{ step: string, adapter: string } | null}
 */
function normalizeFindingsDeclaration(value) {
  if (value === undefined || value === null) return null
  const record = value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {}
  return { step: String(record.step || '').trim(), adapter: String(record.adapter || '').trim() }
}

/**
 * Validates a normalized findings declaration against the flow's steps and registered adapters.
 * @param {{ step: string, adapter: string } | null | undefined} findings
 * @param {import('../../types').WorkflowStep[]} steps
 * @returns {FlowDiagnostic | null}
 */
function findingsDeclarationError(findings, steps) {
  if (!findings) return null
  const hint = `Set findings.step to an agent step id and findings.adapter to one of: ${formatAllowed(FINDINGS_ADAPTER_IDS)}.`
  if (!FINDINGS_ADAPTER_IDS.includes(findings.adapter)) {
    return flowDiagnostic({ code: 'invalid_findings_source', message: `findings.adapter "${findings.adapter}" is not a registered findings adapter.`, hint })
  }
  const step = steps.find((candidate) => String(candidate.id || '') === findings.step)
  if (!step) {
    return flowDiagnostic({ code: 'invalid_findings_source', message: `findings.step "${findings.step}" does not match any step.`, hint })
  }
  if (isHumanReviewStep(step)) {
    return flowDiagnostic({ stepId: findings.step, code: 'invalid_findings_source', message: `findings.step "${findings.step}" is a human-review step, which produces no agent results.`, hint })
  }
  return null
}

/** @param {string} filePath @returns {string} */
function readTextIfPossible(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (_error) {
    return ' '
  }
}

/**
 * Warns about files in the flow's prompts/ directory that no step references.
 * @param {WorkflowFlow} flow
 * @param {import('../../types').WorkflowStep[]} steps
 * @returns {FlowDiagnostic[]}
 */
function unusedPromptFileWarnings(flow, steps) {
  if (!flow.dir) return []
  const promptsDir = path.join(flow.dir, 'prompts')
  if (!fs.existsSync(promptsDir)) return []
  const referenced = new Set(steps.filter((step) => step.prompt).map((step) => promptPathForStep(flow, step)))
  return fs.readdirSync(promptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !referenced.has(path.join(promptsDir, entry.name)))
    .map((entry) => flowDiagnostic({
      code: 'unused_prompt_file',
      message: `Prompt file prompts/${entry.name} is not referenced by any step.`,
      hint: `Reference prompts/${entry.name} from a step's prompt field, or delete it if it is left over.`,
    }))
}

/** @param {{ flow?: { id?: string }, errors?: FlowDiagnostic[], warnings?: FlowDiagnostic[] }} [param0] */
function formatFlowValidation({ flow = {}, errors = [], warnings = [] } = {}) {
  const lines = []
  if (errors.length > 0) {
    lines.push(`Flow "${flow?.id || 'unknown'}" is invalid:`)
    for (const error of errors) {
      const scope = error.stepId ? `step "${error.stepId}"` : 'flow'
      lines.push(`- ${scope}: ${error.message}`)
      if (error.hint) lines.push(`  Hint: ${error.hint}`)
    }
  }
  if (warnings.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`Flow "${flow?.id || 'unknown'}" has warnings:`)
    for (const warning of warnings) {
      const scope = warning.stepId ? `step "${warning.stepId}"` : 'flow'
      lines.push(`- ${scope}: ${warning.message}`)
      if (warning.hint) lines.push(`  Hint: ${warning.hint}`)
    }
  }
  return lines.join('\n')
}

function assertValidFlowStructure(flow, options = {}) {
  const validation = validateFlowStructure(flow, options)
  if (validation.errors.length > 0) {
    /** @type {Error & { code?: string, validation?: FlowValidation }} */
    const error = new Error(formatFlowValidation({ flow, ...validation }))
    error.code = 'invalid_flow'
    error.validation = validation
    throw error
  }
  return validation
}

/**
 * Normalized flow metadata from a flow source.
 * @typedef {{
 *   id: string,
 *   dir: string,
 *   file: string,
 *   source?: FlowSource,
 * }} NormalizeFlowMetadata
 */

/** @param {WorkflowFlow} raw @param {NormalizeFlowMetadata} param1 */
function normalizeFlow(raw, { id, dir, file, source = {} }) {
  const flowId = String(raw.id || id || path.basename(dir))
  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {}
  const steps = Array.isArray(raw.steps) ? raw.steps : []
  if (Object.prototype.hasOwnProperty.call(defaults, 'agentConfig')) {
    /** @type {Error & { code?: string }} */
    const error = new Error('defaults.agentConfig is not supported. Use first-class defaults.models and defaults.efforts maps.')
    error.code = 'invalid_agent_config_wrapper'
    throw error
  }
  const defaultModels = normalizeAgentConfigurationMap(defaults.models, 'models', 'defaults.models')
  const defaultEfforts = normalizeAgentConfigurationMap(defaults.efforts, 'efforts', 'defaults.efforts')
  const defaultLineup = normalizeLineup(defaults.agents)
  if (steps.length === 0) {
    throw new Error(`Flow "${flowId}" has no steps in ${file}`)
  }

  const flow = {
    id: flowId,
    title: raw.title || flowId,
    description: raw.description || '',
    findings: normalizeFindingsDeclaration(raw.findings),
    dir,
    file,
    source: source.type || 'bundled',
    sourceDir: source.dir || dir,
    sourceLabel: sourceLabel(source),
    sourcePriority: Number.isFinite(source.priority) ? source.priority : 0,
    defaults: {
      transport: defaults.transport || 'auto',
      notify: defaults.notify === true,
      agents: providersFromLineup(defaultLineup),
      lineup: defaultLineup,
      models: defaultModels,
      efforts: defaultEfforts,
    },
    options: raw.options && typeof raw.options === 'object' ? raw.options : {},
    steps: steps.map((step, index) => {
      if (Object.prototype.hasOwnProperty.call(step, 'agentConfig')) {
        /** @type {Error & { code?: string }} */
        const error = new Error(`steps[${index}].agentConfig is not supported. Use first-class step.models and step.efforts maps.`)
        error.code = 'invalid_agent_config_wrapper'
        throw error
      }
      const stepId = String(step.id || `step-${index + 1}`)
      const action = String(step.action || step.type || 'issue')
      const humanReview = action === HUMAN_REVIEW_ACTION
      const waitFor = String(step.waitFor || (humanReview ? HUMAN_REVIEW_WAIT_FOR : WAIT_FOR_AGENT_RESULTS))
      const ownLineup = normalizeLineup(step.agents)
      const stepLineup = humanReview ? [] : (ownLineup.length > 0 ? ownLineup : defaultLineup)
      return {
        id: stepId,
        title: step.title || stepId,
        description: step.description || '',
        prompt: step.prompt,
        type: step.type || (humanReview ? HUMAN_REVIEW_ACTION : ''),
        action,
        submit: step.submit || (humanReview ? HUMAN_REVIEW_SUBMIT : 'new-run'),
        agents: providersFromLineup(stepLineup),
        lineup: stepLineup,
        lineupDeclared: ownLineup.length > 0,
        models: normalizeAgentConfigurationMap(step.models, 'models', `steps[${index}].models`),
        efforts: normalizeAgentConfigurationMap(step.efforts, 'efforts', `steps[${index}].efforts`),
        input: step.input === undefined ? [] : step.input,
        waitFor,
        review: step.review && typeof step.review === 'object' ? step.review : null,
        autoArchive: normalizeBoolean(step.autoArchive, null),
        isArchivable: normalizeBoolean(step.isArchivable, true),
      }
    }),
  }
  const validation = assertValidFlowStructure(flow)
  if (validation.warnings.length > 0) flow.warnings = validation.warnings
  return flow
}

/**
 * A shadowed lower-priority flow candidate.
 * @typedef {{ dir: string, file: string, source: FlowSource, status: FlowEntryStatus }} ShadowedFlowCandidate
 * @typedef {'valid' | 'invalid' | 'load-failed'} FlowEntryStatus
 * @typedef {{ code: 'flow_load_failed', message: string }} FlowLoadError
 * @typedef {{
 *   status: FlowEntryStatus,
 *   id: string,
 *   dir: string,
 *   file: string,
 *   source: FlowSource,
 *   flow?: WorkflowFlow,
 *   validation: FlowValidation,
 *   loadError?: FlowLoadError,
 *   stepIds: string[],
 *   shadowed: ShadowedFlowCandidate[],
 * }} FlowEntry
 */

/**
 * Loads one flow directory into a discovery candidate, isolating load and validation failures.
 * Returns null for directories without a flow file and for disabled flows, which never shadow.
 * @param {FlowSource} source
 * @param {string} dirName
 * @returns {Promise<FlowEntry | null>}
 */
async function loadFlowCandidate(source, dirName) {
  const dir = path.join(source.dir, dirName)
  const file = findFlowFile(dir)
  if (!file) return null
  /** @type {WorkflowFlow} */
  let raw
  try {
    raw = await loadConfigFile(file)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 'load-failed',
      id: dirName,
      dir,
      file,
      source,
      validation: { errors: [], warnings: [] },
      loadError: { code: 'flow_load_failed', message },
      stepIds: [],
      shadowed: [],
    }
  }
  if (isFlowDisabled(raw)) return null
  const id = String(raw.id || dirName)
  const stepIds = (Array.isArray(raw.steps) ? raw.steps : []).map((step, index) => String(step?.id || `step-${index + 1}`))
  try {
    const flow = normalizeFlow(raw, { id: dirName, dir, file, source })
    if (raw.id && String(raw.id) !== dirName) {
      flow.warnings = [...(flow.warnings || []), flowDiagnostic({
        code: 'flow_id_mismatch',
        message: `Flow id "${raw.id}" differs from its directory name "${dirName}".`,
        hint: `Rename the directory to "${raw.id}" or remove the id field so the directory name is used.`,
      })]
    }
    return {
      status: 'valid',
      id: flow.id,
      dir,
      file,
      source,
      flow,
      validation: { errors: [], warnings: flow.warnings || [] },
      stepIds,
      shadowed: [],
    }
  } catch (error) {
    const coded = /** @type {Error & { code?: string, validation?: FlowValidation }} */ (error)
    const validation = coded.validation || {
      errors: [flowDiagnostic({ code: coded.code || 'invalid_flow', message: coded.message || String(error) })],
      warnings: [],
    }
    return { status: 'invalid', id, dir, file, source, validation, stepIds, shadowed: [] }
  }
}

/**
 * Discovers every flow candidate across sources and resolves one winning entry per id.
 * Sources are visited in priority order; the first candidate for an id wins even when invalid,
 * and lower-priority candidates are recorded as shadowed rather than activated.
 * @param {FlowLoadOptions} [options]
 * @returns {Promise<FlowEntry[]>}
 */
async function discoverFlowEntries(options = {}) {
  const sources = await flowSources(options)
  /** @type {Map<string, FlowEntry>} */
  const winners = new Map()
  for (const source of sources) {
    if (!fs.existsSync(source.dir)) continue
    const dirNames = fs.readdirSync(source.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const dirName of dirNames) {
      const candidate = await loadFlowCandidate(source, dirName)
      if (!candidate) continue
      const winner = winners.get(candidate.id)
      if (winner) {
        winner.shadowed.push({ dir: candidate.dir, file: candidate.file, source: candidate.source, status: candidate.status })
        continue
      }
      winners.set(candidate.id, candidate)
    }
  }
  return [...winners.values()]
}

/**
 * Builds the error thrown when a flow entry cannot be loaded.
 * @param {FlowEntry} entry
 * @returns {Error & { code: string, statusCode: number, validation?: FlowValidation, details: Record<string, unknown> }}
 */
function flowEntryError(entry) {
  if (entry.status === 'load-failed') {
    const message = `Flow "${entry.id}" could not be loaded from ${entry.file}: ${entry.loadError?.message || 'unknown error'}`
    return Object.assign(new Error(message), {
      code: 'flow_load_failed',
      statusCode: 422,
      details: { flowId: entry.id, file: entry.file, message: entry.loadError?.message || '' },
    })
  }
  const message = formatFlowValidation({ flow: { id: entry.id }, ...entry.validation })
  return Object.assign(new Error(message), {
    code: 'invalid_flow',
    statusCode: 422,
    validation: entry.validation,
    details: {
      flowId: entry.id,
      file: entry.file,
      diagnostics: entry.validation.errors,
      warnings: entry.validation.warnings,
    },
  })
}

/** @param {string} id @param {FlowLoadOptions} [options] */
async function loadFlow(id, options = {}) {
  const entries = await discoverFlowEntries(options)
  const entry = entries.find((candidate) => candidate.id === id)
  if (!entry) {
    const valid = entries.filter((candidate) => candidate.status === 'valid').map((candidate) => candidate.id)
    const invalid = entries.filter((candidate) => candidate.status !== 'valid').map((candidate) => candidate.id)
    const available = valid.join(', ') || 'none'
    const invalidText = invalid.length > 0 ? `. Invalid flows: ${invalid.join(', ')}` : ''
    throw new Error(`Unknown flow "${id}". Available flows: ${available}${invalidText}`)
  }
  if (entry.status !== 'valid' || !entry.flow) throw flowEntryError(entry)
  return entry.flow
}

/**
 * Summary of a winning flow entry that cannot run, for list surfaces.
 * @typedef {{ id: string, file: string, status: FlowEntryStatus, invalid: true, errorCount: number, diagnostics: FlowDiagnostic[] }} InvalidFlowSummary
 */

/** @param {FlowEntry} entry @returns {InvalidFlowSummary} */
function invalidFlowSummary(entry) {
  const diagnostics = entry.status === 'load-failed'
    ? [flowDiagnostic({ code: 'flow_load_failed', message: entry.loadError?.message || 'Flow file could not be loaded.' })]
    : entry.validation.errors
  return { id: entry.id, file: entry.file, status: entry.status, invalid: true, errorCount: diagnostics.length, diagnostics }
}

/**
 * Discovers flows once and splits winners into runnable flows and invalid summaries.
 * @param {FlowLoadOptions} [options]
 * @returns {Promise<{ flows: WorkflowFlow[], invalid: InvalidFlowSummary[], entries: FlowEntry[] }>}
 */
async function listFlowCatalog(options = {}) {
  const entries = await discoverFlowEntries(options)
  const flows = sortFlows(entries
    .filter((entry) => entry.status === 'valid' && entry.flow)
    .map((entry) => /** @type {WorkflowFlow} */ (entry.flow)))
  const invalid = entries.filter((entry) => entry.status !== 'valid').map(invalidFlowSummary)
  return { flows, invalid, entries }
}

/** @param {FlowLoadOptions} [options] */
async function listFlows(options = {}) {
  return (await listFlowCatalog(options)).flows
}

/** @param {WorkflowFlow[]} flows */
function sortFlows(flows) {
  return flows.sort((a, b) => {
    if (a.sourcePriority !== b.sourcePriority) return a.sourcePriority - b.sourcePriority
    const aIndex = FLOW_PICKER_ORDER.indexOf(a.id)
    const bIndex = FLOW_PICKER_ORDER.indexOf(b.id)
    if (aIndex !== -1 || bIndex !== -1) {
      if (aIndex === -1) return 1
      if (bIndex === -1) return -1
      return aIndex - bIndex
    }
    return a.title.localeCompare(b.title)
  })
}

function loadStepPrompt(flow, step) {
  if (!step.prompt) {
    throw new Error(`Flow "${flow.id}" step "${step.id}" is missing a prompt path`)
  }
  const promptPath = path.resolve(flow.dir, step.prompt)
  return loadPromptFile(promptPath)
}

module.exports = {
  ALLOWED_INPUT_RESULTS,
  ALLOWED_STEP_ACTIONS,
  ALLOWED_STEP_SUBMITS,
  DEFAULT_PROJECT_FLOWS_DIRS,
  FLOWS_DIR,
  FLOW_FILE_NAMES,
  FLOW_PICKER_ORDER,
  HUMAN_REVIEW_WAIT_FOR,
  NAX_CONFIG_FILE_NAMES,
  WAIT_FOR_AGENT_RESULTS,
  assertValidFlowStructure,
  discoverFlowEntries,
  flowEntryError,
  invalidFlowSummary,
  listFlowCatalog,
  findFlowFile,
  flowSources,
  formatFlowValidation,
  isFlowDisabled,
  isHumanReviewStep,
  listFlows,
  loadFlow,
  loadStepPrompt,
  normalizeFlow,
  normalizeLineup,
  providersFromLineup,
  parseStaticModuleConfig,
  projectFlowDirs,
  validateFlowStructure,
}
