const packageJson = require('../../package.json')

const ARTIFACT_SCHEMA_VERSION = 1
const PACKAGE_NAME = String(packageJson.name || 'netlify-agent-executor')
const PACKAGE_VERSION = String(packageJson.version || '0.0.0')

/**
 * Metadata stamped onto durable nax JSON artifacts.
 * @returns {{ schemaVersion: number, generatedBy: { name: string, version: string } }}
 */
function artifactMeta() {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    generatedBy: {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
    },
  }
}

module.exports = {
  ARTIFACT_SCHEMA_VERSION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  artifactMeta,
}
