const fs = require('fs')
const path = require('path')
const configorama = require('configorama')
const { loadPromptFile } = require('./prompts')

const FLOWS_DIR = path.join(__dirname, '..', 'flows')
const DEFAULT_PROJECT_FLOWS_DIRS = ['.github/nax-flows']
const CONFIG_FILE_EXTENSIONS = ['json', 'yml', 'yaml', 'toml', 'js', 'cjs', 'mjs', 'ts', 'mts', 'cts']
const FLOW_FILE_EXTENSIONS = ['yml', 'yaml', 'json', 'toml', 'js', 'cjs', 'mjs', 'ts', 'mts', 'cts']
const NAX_CONFIG_FILE_NAMES = CONFIG_FILE_EXTENSIONS.map((extension) => `nax.config.${extension}`)
const FLOW_FILE_NAMES = FLOW_FILE_EXTENSIONS.map((extension) => `flow.${extension}`)
const WAIT_FOR_AGENT_RESULTS = 'agent-results'
const FLOW_PICKER_ORDER = [
  'review',
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
    const config = await configorama(filePath)
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  }
  return {}
}

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

function normalizeFlow(raw, { id, dir, file, source = {} }) {
  const flowId = String(raw.id || id || path.basename(dir))
  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {}
  const steps = Array.isArray(raw.steps) ? raw.steps : []
  if (steps.length === 0) {
    throw new Error(`Flow "${flowId}" has no steps in ${file}`)
  }

  return {
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
      const waitFor = String(step.waitFor || WAIT_FOR_AGENT_RESULTS)
      if (waitFor !== WAIT_FOR_AGENT_RESULTS) {
        throw new Error(`Flow "${flowId}" step "${stepId}" has unsupported waitFor "${waitFor}". Only "agent-results" is supported.`)
      }
      return {
        id: stepId,
        title: step.title || stepId,
        description: step.description || '',
        prompt: step.prompt,
        action: step.action || 'issue',
        submit: step.submit || 'new-run',
        agents: normalizeList(step.agents).length > 0 ? normalizeList(step.agents) : normalizeList(defaults.agents),
        input: Array.isArray(step.input) ? step.input : [],
        waitFor,
        autoArchive: normalizeBoolean(step.autoArchive, null),
        isArchivable: normalizeBoolean(step.isArchivable, true),
      }
    }),
  }
}

async function loadFlow(id, options = {}) {
  const flows = await listFlows(options)
  const flow = flows.find((candidate) => candidate.id === id)
  if (!flow) {
    const available = flows.map((candidate) => candidate.id).join(', ') || 'none'
    throw new Error(`Unknown flow "${id}". Available flows: ${available}`)
  }
  return flow
}

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
      const raw = await configorama(file)
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
  DEFAULT_PROJECT_FLOWS_DIRS,
  FLOWS_DIR,
  FLOW_FILE_NAMES,
  FLOW_PICKER_ORDER,
  NAX_CONFIG_FILE_NAMES,
  WAIT_FOR_AGENT_RESULTS,
  findFlowFile,
  flowSources,
  listFlows,
  loadFlow,
  loadStepPrompt,
  normalizeFlow,
  projectFlowDirs,
}
