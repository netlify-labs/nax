/**
 * Wraps terminal text in an ANSI color code unless color is disabled.
 * @param {number} code
 * @param {string} value
 * @returns {string}
 */
function ansiColor(code, value) {
  if (process.env.NO_COLOR && !process.env.FORCE_COLOR) return value
  return `\x1b[${code}m${value}\x1b[39m`
}

/**
 * Returns macOS-style terminal traffic lights for CLI box headings.
 * @returns {string}
 */
function terminalTrafficLights() {
  return [
    ansiColor(31, '●'),
    ansiColor(33, '●'),
    ansiColor(32, '●'),
  ].join(' ')
}

module.exports = {
  ansiColor,
  terminalTrafficLights,
}
