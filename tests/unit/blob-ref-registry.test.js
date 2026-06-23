// @ts-nocheck
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  addRunBlobRef,
  appendBlobRef,
  blobRefId,
  compactBlobRefs,
  cleanupRunBlobRefs,
  latestBlobRefs,
  readBlobRefs,
  registryPath,
  sweepBlobRefs,
} = require('../../src/storage/local/blob-ref-registry')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-blob-registry-'))
}

test('appendBlobRef writes append-only refs and latestBlobRefs keeps newest status', () => {
  const root = tmpRoot()
  const ref = { id: 'run:s:k', runId: 'run', store: 's', key: 'k', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' }

  appendBlobRef(root, ref)
  appendBlobRef(root, { ...ref, status: 'cleaned', updatedAt: '2026-01-01T00:01:00.000Z' })

  assert.equal(fs.existsSync(registryPath(root)), true)
  assert.equal(readBlobRefs(root).length, 2)
  assert.deepEqual(latestBlobRefs(root), [{ ...ref, status: 'cleaned', updatedAt: '2026-01-01T00:01:00.000Z' }])
})

test('addRunBlobRef mirrors refs to run state, step state, and registry', () => {
  const root = tmpRoot()
  const runState = { runId: 'run-1', projectRoot: root }
  const stepState = { id: 'synthesize' }
  const ref = addRunBlobRef(runState, stepState, {
    store: 'nax-run-1',
    key: 'synthesize-prior-results',
    marker: 'ctx',
    sentinel: 'blob',
    kind: 'prior-results',
    localPath: '.nax/workflows/run-1/blobs/synthesize-prior-results.md',
    localMetadataPath: '.nax/workflows/run-1/blobs/synthesize-prior-results.json',
    localBytes: 123,
  })

  assert.equal(ref.id, blobRefId(ref))
  assert.equal(ref.kind, 'prior-results')
  assert.equal(ref.localPath, '.nax/workflows/run-1/blobs/synthesize-prior-results.md')
  assert.equal(ref.localBytes, 123)
  assert.equal(runState.blobRefs.length, 1)
  assert.equal(stepState.blobRefs.length, 1)
  assert.equal(readBlobRefs(root).length, 1)
})

test('cleanupRunBlobRefs deletes active refs and marks failures pending cleanup', () => {
  const root = tmpRoot()
  const runState = {
    projectRoot: root,
    blobRefs: [
      { id: 'ok', runId: 'run', store: 's', key: 'ok', status: 'active', cleanupAttempts: 0 },
      { id: 'bad', runId: 'run', store: 's', key: 'bad', status: 'active', cleanupAttempts: 1 },
    ],
  }
  const deleted = []

  const results = cleanupRunBlobRefs({
    runState,
    projectRoot: root,
    siteId: 'site',
    token: 'tok',
    env: {},
    deleteBlob({ store, key, siteId, token }) {
      deleted.push({ store, key, siteId, token })
      if (key === 'bad') throw new Error('temporary delete failure')
    },
  })

  assert.deepEqual(deleted.map((item) => item.key), ['ok', 'bad'])
  assert.equal(results[0].ok, true)
  assert.equal(results[0].ref.status, 'cleaned')
  assert.equal(results[1].ok, false)
  assert.equal(results[1].ref.status, 'pending-cleanup')
  assert.equal(results[1].ref.cleanupAttempts, 2)
  assert.equal(runState.blobRefs.find((ref) => ref.id === 'bad').status, 'pending-cleanup')
})

test('cleanupRunBlobRefs updates nested step and run blob refs', () => {
  const root = tmpRoot()
  const ref = { id: 'ok', runId: 'run', store: 's', key: 'ok', status: 'active', cleanupAttempts: 0, localPath: 'blob.md' }
  const runState = {
    projectRoot: root,
    blobRefs: [ref],
    steps: [{
      id: 'synthesize',
      blobRefs: [ref],
      promptBlobRef: ref,
      runs: [{
        blobRef: ref,
        promptDelivery: { blobRef: ref },
      }],
    }],
  }

  cleanupRunBlobRefs({
    runState,
    projectRoot: root,
    siteId: 'site',
    token: 'tok',
    env: {},
    deleteBlob() {},
  })

  assert.equal(runState.blobRefs[0].status, 'cleaned')
  assert.equal(runState.steps[0].blobRefs[0].status, 'cleaned')
  assert.equal(runState.steps[0].promptBlobRef.status, 'cleaned')
  assert.equal(runState.steps[0].runs[0].blobRef.status, 'cleaned')
  assert.equal(runState.steps[0].runs[0].promptDelivery.blobRef.status, 'cleaned')
  assert.equal(runState.steps[0].runs[0].blobRef.localPath, 'blob.md')
})

test('sweepBlobRefs dry-runs stale active refs and pending cleanup refs', () => {
  const root = tmpRoot()
  appendBlobRef(root, { id: 'old', runId: 'run', store: 's', key: 'old', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' })
  appendBlobRef(root, { id: 'recent', runId: 'run', store: 's', key: 'recent', status: 'active', createdAt: '2026-01-02T23:00:00.000Z' })
  appendBlobRef(root, { id: 'pending', runId: 'run', store: 's', key: 'pending', status: 'pending-cleanup', createdAt: '2026-01-02T23:50:00.000Z' })

  const results = sweepBlobRefs({
    projectRoot: root,
    ttlHours: 24,
    now: new Date('2026-01-03T00:00:00.000Z'),
    dryRun: true,
    deleteBlob() {
      throw new Error('dry run should not delete')
    },
  })

  assert.deepEqual(results.map((result) => result.ref.key).sort(), ['old', 'pending'])
  assert.equal(results.every((result) => result.dryRun === true), true)
})

test('sweepBlobRefs deletes eligible refs when forced and records failures', () => {
  const root = tmpRoot()
  appendBlobRef(root, { id: 'ok', runId: 'run', store: 's', key: 'ok', status: 'pending-cleanup', createdAt: '2026-01-01T00:00:00.000Z' })
  appendBlobRef(root, { id: 'bad', runId: 'run', store: 's', key: 'bad', status: 'pending-cleanup', createdAt: '2026-01-01T00:00:00.000Z' })

  const results = sweepBlobRefs({
    projectRoot: root,
    ttlHours: 0,
    now: new Date('2026-01-03T00:00:00.000Z'),
    dryRun: false,
    deleteBlob({ key }) {
      if (key === 'bad') throw new Error('still unavailable')
    },
  })

  assert.equal(results.find((result) => result.ref.key === 'ok').ref.status, 'cleaned')
  assert.equal(results.find((result) => result.ref.key === 'bad').ref.status, 'pending-cleanup')
  assert.equal(latestBlobRefs(root).find((ref) => ref.key === 'ok').status, 'cleaned')
})

test('compactBlobRefs rewrites registry to latest record per blob id', () => {
  const root = tmpRoot()
  appendBlobRef(root, { id: 'one', runId: 'run', store: 's', key: 'one', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' })
  appendBlobRef(root, { id: 'one', runId: 'run', store: 's', key: 'one', status: 'cleaned', updatedAt: '2026-01-01T00:01:00.000Z' })
  appendBlobRef(root, { id: 'two', runId: 'run', store: 's', key: 'two', status: 'pending-cleanup', createdAt: '2026-01-01T00:02:00.000Z' })

  const compacted = compactBlobRefs(root)

  assert.deepEqual(compacted.map((ref) => `${ref.id}:${ref.status}`).sort(), ['one:cleaned', 'two:pending-cleanup'])
  assert.equal(readBlobRefs(root).length, 2)
})
