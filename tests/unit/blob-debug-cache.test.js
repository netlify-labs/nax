const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { safeBlobFileName, writeLocalBlobDebugPayload, workflowBlobDebugDir } = require('../../src/storage/local/blob-debug-cache')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-blob-debug-cache-'))
}

test('writeLocalBlobDebugPayload mirrors payload and metadata under workflow blobs dir', () => {
  const projectRoot = tmpRoot()
  const runState = {
    runId: 'run-1',
    projectRoot,
    dir: path.join(projectRoot, '.nax', 'workflows', 'run-1'),
  }
  const stepState = { id: 'synthesize' }
  const out = writeLocalBlobDebugPayload({
    runState,
    stepState,
    ref: {
      store: 'nax-run-1',
      key: 'synthesize-codex-full-prompt',
      marker: 'ctx-1',
      sentinel: 'blob-1',
    },
    payload: 'NAX-BLOB-SENTINEL blob-1\n\nFull prompt body',
    kind: 'full-prompt',
    projectRoot,
  })

  assert.equal(out.localPath, '.nax/workflows/run-1/blobs/synthesize-codex-full-prompt.md')
  assert.equal(out.localMetadataPath, '.nax/workflows/run-1/blobs/synthesize-codex-full-prompt.json')
  assert.equal(out.localBytes, Buffer.byteLength('NAX-BLOB-SENTINEL blob-1\n\nFull prompt body', 'utf8'))
  assert.equal(fs.readFileSync(path.join(projectRoot, out.localPath), 'utf8'), 'NAX-BLOB-SENTINEL blob-1\n\nFull prompt body\n')
  const metadata = JSON.parse(fs.readFileSync(path.join(projectRoot, out.localMetadataPath), 'utf8'))
  assert.equal(metadata.kind, 'full-prompt')
  assert.equal(metadata.stepId, 'synthesize')
  assert.equal(metadata.payloadBytes, out.localBytes)
})

test('safeBlobFileName keeps blob debug files inside the cache directory', () => {
  assert.equal(safeBlobFileName('../bad/key'), 'bad-key')
  assert.equal(workflowBlobDebugDir({ runState: { runId: 'r' }, projectRoot: '/repo' }), '/repo/.nax/workflows/r/blobs')
})
