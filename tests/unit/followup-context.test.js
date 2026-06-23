const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  FollowupContextError,
  buildFollowupContextPackage,
  resolveFollowupArtifacts,
} = require('../../src/workflows/followups/context')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-followup-context-'))
}

function writeArtifact(projectRoot, relativePath, text) {
  const filePath = path.join(projectRoot, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, text)
  return filePath
}

function detailsForArtifacts(artifacts) {
  return { followupArtifacts: artifacts }
}

test('follow-up context package preserves selected artifacts as labelled sections', () => {
  const projectRoot = tmpRoot()
  const summaryPath = writeArtifact(projectRoot, '.nax/workflows/run-1/artifacts/summary.md', '# Summary\n\nWorkflow result.\n')
  const codexPath = writeArtifact(projectRoot, '.nax/workflows/run-1/artifacts/steps/01-review/agent-runners/codex.md', '# Codex\n\nFinding.\n')
  const details = detailsForArtifacts([
    {
      id: 'workflow-summary:summary.md',
      kind: 'workflow-summary',
      label: 'Workflow summary',
      path: '.nax/workflows/run-1/artifacts/summary.md',
      absolutePath: summaryPath,
      sizeBytes: fs.statSync(summaryPath).size,
      defaultSelected: true,
      advanced: false,
      source: {},
    },
    {
      id: 'agent-result:review:runner-1:session-1:codex.md',
      kind: 'agent-result',
      label: 'Review · codex result',
      path: '.nax/workflows/run-1/artifacts/steps/01-review/agent-runners/codex.md',
      absolutePath: codexPath,
      sizeBytes: fs.statSync(codexPath).size,
      defaultSelected: false,
      advanced: false,
      source: { stepId: 'review', runnerId: 'runner-1', sessionId: 'session-1' },
    },
  ])

  const context = buildFollowupContextPackage({
    projectRoot,
    details,
    artifacts: [
      { id: 'workflow-summary:summary.md', kind: 'workflow-summary' },
      { id: 'agent-result:review:runner-1:session-1:codex.md', kind: 'agent-result' },
    ],
  })

  assert.equal(context.artifactCount, 2)
  assert.match(context.markdown, /## Artifact: Workflow summary/)
  assert.match(context.markdown, /Source: \.nax\/workflows\/run-1\/artifacts\/summary\.md/)
  assert.match(context.markdown, /Workflow result/)
  assert.match(context.markdown, /---/)
  assert.match(context.markdown, /## Artifact: Review · codex result/)
  assert.match(context.markdown, /Finding/)
  assert.equal(context.totalBytes, Buffer.byteLength(context.markdown, 'utf8'))
})

test('follow-up artifact resolver dedupes selected artifacts', () => {
  const projectRoot = tmpRoot()
  const summaryPath = writeArtifact(projectRoot, '.nax/workflows/run-1/artifacts/summary.md', '# Summary\n')
  const details = detailsForArtifacts([{
    id: 'workflow-summary:summary.md',
    kind: 'workflow-summary',
    label: 'Workflow summary',
    path: '.nax/workflows/run-1/artifacts/summary.md',
    absolutePath: summaryPath,
    sizeBytes: fs.statSync(summaryPath).size,
    defaultSelected: true,
    advanced: false,
    source: {},
  }])

  const artifacts = resolveFollowupArtifacts({
    projectRoot,
    details,
    artifacts: [
      { id: 'workflow-summary:summary.md', kind: 'workflow-summary' },
      { id: 'workflow-summary:summary.md', kind: 'workflow-summary' },
    ],
  })

  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].markdown, '# Summary\n')
})

test('follow-up artifact resolver rejects unknown artifact ids', () => {
  const projectRoot = tmpRoot()

  assert.throws(
    () => resolveFollowupArtifacts({
      projectRoot,
      details: detailsForArtifacts([]),
      artifacts: [{ id: 'missing', kind: 'workflow-summary' }],
    }),
    /** @param {unknown} error */
    (error) => {
      assert.equal(error instanceof FollowupContextError, true)
      if (!(error instanceof FollowupContextError)) return false
      assert.equal(error.code, 'unknown_artifact')
      return true
    },
  )
})

test('follow-up artifact resolver rejects paths outside .nax', () => {
  const projectRoot = tmpRoot()
  fs.mkdirSync(path.join(projectRoot, '.nax'), { recursive: true })
  const outsidePath = writeArtifact(projectRoot, 'outside.md', '# Outside\n')
  const details = detailsForArtifacts([{
    id: 'outside',
    kind: 'workflow-summary',
    label: 'Outside',
    path: 'outside.md',
    absolutePath: outsidePath,
    sizeBytes: fs.statSync(outsidePath).size,
    defaultSelected: false,
    advanced: false,
    source: {},
  }])

  assert.throws(
    () => resolveFollowupArtifacts({
      projectRoot,
      details,
      artifacts: [{ id: 'outside', kind: 'workflow-summary' }],
    }),
    /** @param {unknown} error */
    (error) => {
      assert.equal(error instanceof FollowupContextError, true)
      if (!(error instanceof FollowupContextError)) return false
      assert.equal(error.code, 'unsafe_artifact_path')
      return true
    },
  )
})

test('follow-up artifact resolver rejects symlink escapes from .nax', () => {
  const projectRoot = tmpRoot()
  const targetPath = writeArtifact(projectRoot, 'outside.md', '# Outside\n')
  const linkPath = path.join(projectRoot, '.nax', 'workflows', 'run-1', 'artifacts', 'outside-link.md')
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(targetPath, linkPath)
  const details = detailsForArtifacts([{
    id: 'outside-link',
    kind: 'workflow-summary',
    label: 'Outside link',
    path: '.nax/workflows/run-1/artifacts/outside-link.md',
    absolutePath: linkPath,
    sizeBytes: 0,
    defaultSelected: false,
    advanced: false,
    source: {},
  }])

  assert.throws(
    () => resolveFollowupArtifacts({
      projectRoot,
      details,
      artifacts: [{ id: 'outside-link', kind: 'workflow-summary' }],
    }),
    /** @param {unknown} error */
    (error) => {
      assert.equal(error instanceof FollowupContextError, true)
      if (!(error instanceof FollowupContextError)) return false
      assert.equal(error.code, 'unsafe_artifact_path')
      return true
    },
  )
})
