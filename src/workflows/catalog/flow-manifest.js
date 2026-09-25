// Builds a versioned, location-independent manifest of what a flow will execute.
// Its sha256 digest pins plans and runs to the exact flow definition and prompt bytes.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const FLOW_MANIFEST_VERSION = 1

/** Step fields that change what a run does; paths and diagnostics are excluded. */
const MANIFEST_STEP_FIELDS = [
  'id',
  'title',
  'description',
  'prompt',
  'type',
  'action',
  'submit',
  'waitFor',
  'input',
  'agents',
  'lineup',
  'models',
  'efforts',
  'review',
  'autoArchive',
  'isArchivable',
]

/** Flow default fields that change what a run does. */
const MANIFEST_DEFAULT_FIELDS = ['transport', 'agents', 'lineup', 'models', 'efforts', 'notify']

/**
 * @typedef {{
 *   manifestVersion: number,
 *   flowId: string,
 *   title: string,
 *   defaults: Record<string, unknown>,
 *   steps: Array<Record<string, unknown>>,
 *   prompts: Array<{ stepId: string, sha256: string }>,
 *   findings: unknown,
 * }} FlowManifest
 * @typedef {{ readFile?: (filePath: string) => Buffer }} FlowManifestOptions
 */

/** @param {string | Buffer} value */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * Returns a copy with object keys sorted recursively so JSON output is canonical.
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value)
    return Object.fromEntries(Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalValue(record[key])]))
  }
  return value
}

/** @param {Record<string, unknown>} source @param {string[]} fields */
function pick(source, fields) {
  return Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]))
}

/**
 * Builds the manifest for a normalized flow, hashing each referenced prompt file's bytes.
 * @param {import('../../types').WorkflowFlow} flow
 * @param {FlowManifestOptions} [options]
 * @returns {FlowManifest}
 */
function flowManifest(flow, { readFile = (filePath) => fs.readFileSync(filePath) } = {}) {
  const steps = Array.isArray(flow.steps) ? flow.steps : []
  const prompts = steps
    .filter((step) => step.prompt)
    .map((step) => {
      const promptPath = path.resolve(String(flow.dir || ''), String(step.prompt))
      let bytes
      try {
        bytes = readFile(promptPath)
      } catch (_error) {
        bytes = Buffer.from('')
      }
      return { stepId: String(step.id || ''), sha256: sha256(bytes) }
    })
  return {
    manifestVersion: FLOW_MANIFEST_VERSION,
    flowId: String(flow.id || ''),
    title: String(flow.title || ''),
    defaults: pick(/** @type {Record<string, unknown>} */ (flow.defaults || {}), MANIFEST_DEFAULT_FIELDS),
    steps: steps.map((step) => pick(/** @type {Record<string, unknown>} */ (step), MANIFEST_STEP_FIELDS)),
    prompts,
    findings: /** @type {Record<string, unknown>} */ (flow).findings ?? null,
  }
}

/**
 * sha256 of the canonical JSON manifest for a flow.
 * @param {import('../../types').WorkflowFlow} flow
 * @param {FlowManifestOptions} [options]
 * @returns {string}
 */
function flowDigest(flow, options = {}) {
  return sha256(JSON.stringify(canonicalValue(flowManifest(flow, options))))
}

module.exports = {
  FLOW_MANIFEST_VERSION,
  flowDigest,
  flowManifest,
}
