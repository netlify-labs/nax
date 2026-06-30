const fs = require('fs')
const path = require('path')
const configorama = require('configorama')
const { loadPromptFile } = require('./prompts')
const { HUMAN_REVIEW_ACTION, HUMAN_REVIEW_SUBMIT, HUMAN_REVIEW_WAIT_FOR, isHumanReviewStep } = require('../human-review')

const FLOWS_DIR = path.join(__dirname, '..', '..', '..', 'workflows')
const DEFAULT_PROJECT_FLOWS_DIRS = ['.github/nax-flows']
const CONFIG_FILE_EXTENSIONS = ['json', 'yml', 'yaml', 'toml', 'js', 'cjs', 'mjs', 'ts', 'mts', 'cts']
const FLOW_FILE_EXTENSIONS = ['yml', 'yaml', 'json', 'toml', 'js', 'cjs', 'mjs', 'ts', 'mts', 'cts']
const NAX_CONFIG_FILE_NAMES = CONFIG_FILE_EXTENSIONS.map((extension) => `nax.config.${extension}`)
const FLOW_FILE_NAMES = FLOW_FILE_EXTENSIONS.map((extension) => `flow.${extension}`)
const WAIT_FOR_AGENT_RESULTS = 'agent-results'
const ALLOWED_STEP_ACTIONS = ['issue', 'comment', HUMAN_REVIEW_ACTION]
const ALLOWED_STEP_SUBMITS = ['new-run', 'follow-up', HUMAN_REVIEW_SUBMIT]
/**
 * @typedef {{ stepId: string, code: string, message: string, hint: string }} FlowDiagnostic
 * @typedef {{ errors: FlowDiagnostic[], warnings: FlowDiagnostic[] }} FlowValidation
 * @typedef {import('../../types').WorkflowFlow} WorkflowFlow
 * @typedef {{ safeMode: true, allowedFileRoots: string[] }} SafeConfigoramaOptions
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
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<WorkflowFlow>}
 */
async function loadConfigFile(filePath) {
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
    }
  }

  return { errors, warnings }
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
  if (steps.length === 0) {
    throw new Error(`Flow "${flowId}" has no steps in ${file}`)
  }

  const flow = {
    id: flowId,
    title: raw.title || flowId,
    description: raw.description || '',
    dir,
    file,
    source: source.type || 'bundled',
    sourceDir: source.dir || dir,
    sourceLabel: sourceLabel(source),
    sourcePriority: Number.isFinite(source.priority) ? source.priority : 0,
    defaults: {
      transport: defaults.transport || 'auto',
      notify: defaults.notify === true,
      agents: normalizeList(defaults.agents),
    },
    options: raw.options && typeof raw.options === 'object' ? raw.options : {},
    steps: steps.map((step, index) => {
      const stepId = String(step.id || `step-${index + 1}`)
      const action = String(step.action || step.type || 'issue')
      const humanReview = action === HUMAN_REVIEW_ACTION
      const waitFor = String(step.waitFor || (humanReview ? HUMAN_REVIEW_WAIT_FOR : WAIT_FOR_AGENT_RESULTS))
      return {
        id: stepId,
        title: step.title || stepId,
        description: step.description || '',
        prompt: step.prompt,
        type: step.type || (humanReview ? HUMAN_REVIEW_ACTION : ''),
        action,
        submit: step.submit || (humanReview ? HUMAN_REVIEW_SUBMIT : 'new-run'),
        agents: humanReview ? [] : normalizeList(step.agents).length > 0 ? normalizeList(step.agents) : normalizeList(defaults.agents),
        input: step.input === undefined ? [] : step.input,
        waitFor,
        review: step.review && typeof step.review === 'object' ? step.review : null,
        autoArchive: normalizeBoolean(step.autoArchive, null),
        isArchivable: normalizeBoolean(step.isArchivable, true),
      }
    }),
  }
  assertValidFlowStructure(flow)
  return flow
}

/** @param {string} id @param {FlowLoadOptions} [options] */
async function loadFlow(id, options = {}) {
  const flows = await listFlows(options)
  const flow = flows.find((candidate) => candidate.id === id)
  if (!flow) {
    const available = flows.map((candidate) => candidate.id).join(', ') || 'none'
    throw new Error(`Unknown flow "${id}". Available flows: ${available}`)
  }
  return flow
}

/** @param {FlowLoadOptions} [options] */
async function listFlows(options = {}) {
  const sources = await flowSources(options)
  const flows = []
  const seenIds = new Set()
  for (const source of sources) {
    if (!fs.existsSync(source.dir)) continue
    const entries = fs.readdirSync(source.dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(source.dir, entry.name)
      const file = findFlowFile(dir)
      if (!file) continue
      const raw = await loadConfigFile(file)
      if (isFlowDisabled(raw)) continue
      const flow = normalizeFlow(raw, { id: entry.name, dir, file, source })
      if (seenIds.has(flow.id)) continue
      seenIds.add(flow.id)
      flows.push(flow)
    }
  }
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
  findFlowFile,
  flowSources,
  formatFlowValidation,
  isFlowDisabled,
  isHumanReviewStep,
  listFlows,
  loadFlow,
  loadStepPrompt,
  normalizeFlow,
  projectFlowDirs,
  validateFlowStructure,
}
