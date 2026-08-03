const {
  utf8ByteLength,
} = require('../prompts/offload')

function promptIntro() {
  return [
    'Use the existing conversation context when available.',
    'If prior details are missing or incomplete, use the attached source workflow context before acting.',
  ].join('\n')
}

/**
 * @param {{
 *   contextPackage?: { markdown?: string, artifactCount?: number },
 *   runId?: string,
 *   stepId?: string,
 *   options?: import('../../types').JsonMap,
 *   writeBlob?: (input: { ref: import('../../types').BlobRef, payload: string }) => Promise<unknown> | unknown,
 * }} [input]
 */
async function prepareFollowupContextDelivery({
  contextPackage = {},
} = {}) {
  const markdown = String(contextPackage.markdown || '').trim()
  const artifactCount = Number(contextPackage.artifactCount || 0)
  if (!markdown || artifactCount === 0) {
    return {
      delivery: 'none',
      artifactCount: 0,
      promptContext: '',
      bytes: 0,
    }
  }

  const intro = promptIntro()
  const inlineText = [intro, '', markdown].join('\n')
  const inlineBytes = utf8ByteLength(inlineText)
  return {
    delivery: 'sdk',
    artifactCount,
    promptContext: inlineText,
    bytes: inlineBytes,
  }
}

module.exports = {
  prepareFollowupContextDelivery,
  promptIntro,
}
