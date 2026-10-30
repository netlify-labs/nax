const hyperframes = require('./hyperframes')

/**
 * @typedef {{
 *   expand: (options: Record<string, string>) => import('../config').PresetResult,
 *   detectOptions: (input: { cwd: string, options: Record<string, string>, runFile?: import('../process').RunFile }) => { options: Record<string, string>, notes: string[] },
 * }} Preset
 */

/** @type {Record<string, Preset>} */
const PRESETS = {
  hyperframes,
}

module.exports = { PRESETS }
