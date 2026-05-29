const fs = require('fs')
const path = require('path')
const configorama = require('configorama')
const { loadPromptFile } = require('./prompts')

const FLOWS_DIR = path.join(__dirname, '..', 'flows')
const FLOW_FILE_NAMES = ['flow.yml', 'flow.yaml', 'flow.json', 'flow.toml']
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

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return []
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

function normalizeFlow(raw, { id, dir, file }) {
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

async function loadFlow(id, { flowsDir = FLOWS_DIR } = {}) {
  const flowDir = path.join(flowsDir, id)
  const flowFile = findFlowFile(flowDir)
  if (!flowFile) {
    const available = (await listFlows({ flowsDir })).map((flow) => flow.id).join(', ') || 'none'
    throw new Error(`Unknown flow "${id}". Available flows: ${available}`)
  }

  const raw = await configorama(flowFile)
  return normalizeFlow(raw, { id, dir: flowDir, file: flowFile })
}

async function listFlows({ flowsDir = FLOWS_DIR } = {}) {
  if (!fs.existsSync(flowsDir)) return []
  const entries = fs.readdirSync(flowsDir, { withFileTypes: true })
  const flows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(flowsDir, entry.name)
    const file = findFlowFile(dir)
    if (!file) continue
    const raw = await configorama(file)
    flows.push(normalizeFlow(raw, { id: entry.name, dir, file }))
  }
  return flows.sort((a, b) => {
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
  FLOWS_DIR,
  FLOW_FILE_NAMES,
  FLOW_PICKER_ORDER,
  WAIT_FOR_AGENT_RESULTS,
  findFlowFile,
  listFlows,
  loadFlow,
  loadStepPrompt,
  normalizeFlow,
}
