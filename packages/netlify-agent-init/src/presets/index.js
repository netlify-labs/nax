const { hyperframesPreset } = require('./hyperframes')

/** @type {Record<string, (options: Record<string, string>) => import('../config').PresetResult>} */
const PRESETS = {
  hyperframes: hyperframesPreset,
}

module.exports = { PRESETS }
