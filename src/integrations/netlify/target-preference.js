// Persists the dashboard's chosen Agent Runner target per project so a selected
// Netlify site survives dashboard reloads and restarts.
const fs = require('node:fs')
const path = require('node:path')

const PREFERENCE_FILE = 'dashboard-target.json'

/** @param {string} projectRoot */
function preferencePath(projectRoot) {
  return path.join(path.resolve(projectRoot), '.nax', PREFERENCE_FILE)
}

/**
 * @typedef {{ siteId: string, filter?: string, source?: string }} TargetPreference
 */

/**
 * Reads the saved target preference, or null when none/invalid.
 * @param {string} projectRoot
 * @returns {TargetPreference | null}
 */
function readTargetPreference(projectRoot) {
  try {
    const raw = fs.readFileSync(preferencePath(projectRoot), 'utf8')
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || typeof value.siteId !== 'string' || !value.siteId) return null
    return {
      siteId: value.siteId,
      ...(typeof value.filter === 'string' && value.filter ? { filter: value.filter } : {}),
      ...(typeof value.source === 'string' && value.source ? { source: value.source } : {}),
    }
  } catch (_error) {
    return null
  }
}

/**
 * Saves the chosen target preference. Best-effort; returns whether it persisted.
 * @param {string} projectRoot
 * @param {TargetPreference} preference
 * @returns {boolean}
 */
function writeTargetPreference(projectRoot, preference) {
  try {
    const filePath = preferencePath(projectRoot)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const body = {
      siteId: preference.siteId,
      ...(preference.filter ? { filter: preference.filter } : {}),
      ...(preference.source ? { source: preference.source } : {}),
    }
    fs.writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`)
    return true
  } catch (_error) {
    return false
  }
}

/**
 * Clears any saved target preference.
 * @param {string} projectRoot
 */
function clearTargetPreference(projectRoot) {
  try {
    fs.unlinkSync(preferencePath(projectRoot))
  } catch (_error) {
    // Absent is fine.
  }
}

module.exports = { clearTargetPreference, preferencePath, readTargetPreference, writeTargetPreference }
