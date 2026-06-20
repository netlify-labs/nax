const test = require('node:test')
const assert = require('node:assert/strict')

const {
  FollowupDeliveryError,
  prepareFollowupContextDelivery,
} = require('../../src/followup-delivery')

test('follow-up context delivery returns none for empty context', async () => {
  const delivery = await prepareFollowupContextDelivery({
    contextPackage: { markdown: '', artifactCount: 0 },
    runId: 'run-1',
  })

  assert.equal(delivery.delivery, 'none')
  assert.equal(delivery.promptContext, '')
  assert.equal(delivery.artifactCount, 0)
})

test('follow-up context delivery inlines small context', async () => {
  const delivery = await prepareFollowupContextDelivery({
    contextPackage: { markdown: '## Artifact: Summary\n\nSmall result.', artifactCount: 1 },
    runId: 'run-1',
    options: { safePromptBytes: 2000 },
  })

  assert.equal(delivery.delivery, 'inline')
  assert.equal(delivery.artifactCount, 1)
  assert.match(delivery.promptContext, /Use the existing conversation context/)
  assert.match(delivery.promptContext, /Small result/)
})

test('follow-up context delivery offloads oversized context to blob', async () => {
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

  assert.equal(delivery.delivery, 'blob')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].ref.store, 'nax-run-big')
  assert.equal(writes[0].ref.key, 'followup-prior-results')
  assert.match(writes[0].payload, /NAX-BLOB-SENTINEL/)
  assert.match(writes[0].payload, /large context/)
  assert.match(delivery.promptContext, /blobs:get nax-run-big followup-prior-results/)
  assert.equal(delivery.promptContext.includes(writes[0].ref.sentinel), false)
  assert.ok(delivery.offloadedBytes > delivery.bytes)
})

test('follow-up context delivery fails oversized context without blob writer', async () => {
  await assert.rejects(
    () => prepareFollowupContextDelivery({
      contextPackage: {
        markdown: `## Artifact: Big\n\n${'large context '.repeat(200)}`,
        artifactCount: 1,
      },
      runId: 'run-big',
      options: { safePromptBytes: 500 },
    }),
    /** @param {any} error */
    (error) => {
      assert.equal(error instanceof FollowupDeliveryError, true)
      assert.equal(error.code, 'context_too_large')
      assert.match(error.message, /above the safe prompt budget/)
      return true
    },
  )
})
