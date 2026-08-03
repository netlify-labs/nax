const test = require('node:test')
const assert = require('node:assert/strict')

const {
  prepareFollowupContextDelivery,
} = require('../../src/workflows/followups/delivery')

test('follow-up context delivery returns empty metadata for empty context', () => {
  const delivery = prepareFollowupContextDelivery({
    contextPackage: { markdown: '', artifactCount: 0 },
  })

  assert.equal(delivery.delivery, 'none')
  assert.equal(delivery.promptContext, '')
  assert.equal(delivery.artifactCount, 0)
})

test('follow-up context delivery passes small context to SDK planning', () => {
  const delivery = prepareFollowupContextDelivery({
    contextPackage: { markdown: '## Artifact: Summary\n\nSmall result.', artifactCount: 1 },
  })

  assert.equal(delivery.delivery, 'sdk')
  assert.equal(delivery.artifactCount, 1)
  assert.match(delivery.promptContext, /Use the existing conversation context/)
  assert.match(delivery.promptContext, /Small result/)
})

test('follow-up context delivery passes oversized semantic context to SDK planning', () => {
  const delivery = prepareFollowupContextDelivery({
    contextPackage: {
      markdown: `## Artifact: Big\n\n${'large context '.repeat(200)}`,
      artifactCount: 1,
    },
  })

  assert.equal(delivery.delivery, 'sdk')
  assert.match(delivery.promptContext, /large context/)
  assert.equal(delivery.bytes, Buffer.byteLength(delivery.promptContext, 'utf8'))
})

test('follow-up context delivery no longer requires a presentation-layer blob writer', () => {
  const delivery = prepareFollowupContextDelivery({
    contextPackage: {
      markdown: `## Artifact: Big\n\n${'large context '.repeat(200)}`,
      artifactCount: 1,
    },
  })

  assert.equal(delivery.delivery, 'sdk')
  assert.match(delivery.promptContext, /large context/)
})
