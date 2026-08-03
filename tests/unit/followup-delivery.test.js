const test = require('node:test')
const assert = require('node:assert/strict')

const {
  prepareFollowupContextDelivery,
} = require('../../src/workflows/followups/delivery')

test('follow-up context delivery returns none for empty context', async () => {
  const delivery = await prepareFollowupContextDelivery({
    contextPackage: { markdown: '', artifactCount: 0 },
    runId: 'run-1',
  })

  assert.equal(delivery.delivery, 'none')
  assert.equal(delivery.promptContext, '')
  assert.equal(delivery.artifactCount, 0)
})

test('follow-up context delivery passes small context to SDK planning', async () => {
  const delivery = await prepareFollowupContextDelivery({
    contextPackage: { markdown: '## Artifact: Summary\n\nSmall result.', artifactCount: 1 },
    runId: 'run-1',
    options: { safePromptBytes: 2000 },
  })

  assert.equal(delivery.delivery, 'sdk')
  assert.equal(delivery.artifactCount, 1)
  assert.match(delivery.promptContext, /Use the existing conversation context/)
  assert.match(delivery.promptContext, /Small result/)
})

test('follow-up context delivery passes oversized semantic context to SDK planning', async () => {
  const writes = []
  const delivery = await prepareFollowupContextDelivery({
    contextPackage: {
      markdown: `## Artifact: Big\n\n${'large context '.repeat(200)}`,
      artifactCount: 1,
    },
    runId: 'run-big',
    stepId: 'followup',
    options: { safePromptBytes: 500 },
    writeBlob: (write) => writes.push(write),
  })

  assert.equal(delivery.delivery, 'sdk')
  assert.equal(writes.length, 0)
  assert.match(delivery.promptContext, /large context/)
  assert.equal(delivery.bytes, Buffer.byteLength(delivery.promptContext, 'utf8'))
})

test('follow-up context delivery no longer requires a presentation-layer blob writer', async () => {
  const delivery = await prepareFollowupContextDelivery({
    contextPackage: {
      markdown: `## Artifact: Big\n\n${'large context '.repeat(200)}`,
      artifactCount: 1,
    },
    runId: 'run-big',
    options: { safePromptBytes: 500 },
  })

  assert.equal(delivery.delivery, 'sdk')
  assert.match(delivery.promptContext, /large context/)
})
