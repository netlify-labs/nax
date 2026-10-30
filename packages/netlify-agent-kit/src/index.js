// @ts-check
const { applyAdd, planAdd } = require('./add')
const { loadConfig } = require('./config')
const { detect, isTruthy } = require('./detect')
const { install } = require('./install')
const { formatStatus, status } = require('./status')

module.exports = {
  applyAdd,
  detect,
  formatStatus,
  install,
  isTruthy,
  loadConfig,
  planAdd,
  status,
}
