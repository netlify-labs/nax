// @ts-check
const { loadConfig } = require('./config')
const { detect, isTruthy } = require('./detect')
const { run } = require('./run')
const { setup } = require('./setup')
const { formatStatus, status } = require('./status')

module.exports = {
  detect,
  formatStatus,
  isTruthy,
  loadConfig,
  run,
  setup,
  status,
}
