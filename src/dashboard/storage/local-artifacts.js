const { buildRunDetails } = require('../shared/run-details')
const { buildFollowupContextPackage } = require('../../workflows/followups/context')

/**
 * @typedef {{
 *   projectRoot: string,
 * }} LocalArtifactStoreOptions
 *
 * @typedef {{
 *   details?: Record<string, unknown>,
 *   artifacts?: Array<Record<string, unknown>>,
 * }} LocalFollowupContextInput
 */

/** @param {LocalArtifactStoreOptions} options */
function createLocalArtifactStore({ projectRoot }) {
  return {
    buildRunDetails(runState, { flow = null } = {}) {
      return buildRunDetails(runState, { flow })
    },
    /** @param {LocalFollowupContextInput} [input] */
    createFollowupContextPackage({ details, artifacts } = {}) {
      return buildFollowupContextPackage({
        projectRoot,
        details,
        artifacts,
      })
    },
  }
}

module.exports = {
  createLocalArtifactStore,
}
