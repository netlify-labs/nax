// @ts-nocheck
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  blobRefForStep,
  buildBlobPayload,
  buildFetchInstruction,
  buildInlineEssentials,
  classifyContextFetch,
  compactTextByBytes,
  runnerNetlifyCliCommand,
  safePromptBytes,
  utf8ByteLength,
} = require('../../src/workflows/prompts/offload')

test('compactTextByBytes respects UTF-8 byte limits', () => {
  const text = `alpha ${'x'.repeat(2000)} omega`
  const compacted = compactTextByBytes(text, 320, 'Prior Agent Results')

  assert.ok(utf8ByteLength(compacted) <= 320)
  assert.match(compacted, /Prior Agent Results compacted/)
})

test('safePromptBytes uses a conservative floor', () => {
  assert.equal(safePromptBytes({ safePromptBytes: 12 }), 1024)
  assert.equal(safePromptBytes({ safePromptBytes: 2000 }), 2000)
})

test('blob refs are deterministic and payload-specific', () => {
  const first = blobRefForStep({ runId: 'run-1', stepId: 'synthesize', payloadSeed: 'a' })
  const again = blobRefForStep({ runId: 'run-1', stepId: 'synthesize', payloadSeed: 'a' })
  const changedPayload = blobRefForStep({ runId: 'run-1', stepId: 'synthesize', payloadSeed: 'b' })

  assert.deepEqual(first, again)
  assert.equal(first.store, 'nax-run-1')
  assert.equal(first.key, 'synthesize-prior-results')
  assert.notEqual(first.sentinel, changedPayload.sentinel)
  assert.equal(first.marker, changedPayload.marker)
})

test('fetch instruction uses inherited token env and verification lines without auth argv', () => {
  const instruction = buildFetchInstruction({
    store: 'nax-run-1',
    key: 'synthesize-prior-results',
    marker: 'ctx-123',
    sentinel: 'blob-456',
  })

  assert.match(instruction, /NETLIFY_SITE_ID="\$\{NETLIFY_SITE_ID:-\$SITE_ID\}" \/opt\/buildhome\/node-deps\/node_modules\/\.bin\/netlify blobs:get nax-run-1 synthesize-prior-results/)
  assert.doesNotMatch(instruction, /--auth/)
  assert.match(instruction, /NAX-CONTEXT-LOADED ctx-123/)
  assert.match(instruction, /NAX-BLOB-SENTINEL <the exact sentinel value from the blob>/)
  assert.doesNotMatch(instruction, /blob-456/)
})

test('runner fetch command defaults to the hosted runner netlify CLI path', () => {
  assert.equal(runnerNetlifyCliCommand(), '/opt/buildhome/node-deps/node_modules/.bin/netlify')
})

test('fetch instruction can render a PATH fallback runner command', () => {
  const instruction = buildFetchInstruction({
    store: 'nax-run-1',
    key: 'synthesize-prior-results',
    marker: 'ctx-123',
    runner: { fallbackToPath: true },
  })

  assert.match(instruction, /\$\(if \[ -x "\/opt\/buildhome\/node-deps\/node_modules\/\.bin\/netlify" \]/)
  assert.match(instruction, /else printf %s netlify/)
  assert.equal(runnerNetlifyCliCommand({ cliPath: 'netlify' }), 'netlify')
})

test('blob payload plants the blob-only sentinel before full prior results', () => {
  const payload = buildBlobPayload({ fullResults: 'full report', sentinel: 'blob-abc' })
  assert.equal(payload, 'NAX-BLOB-SENTINEL blob-abc\n\nfull report')
})

test('inline essentials prefer structured findings and fall back to bounded excerpts', () => {
  const runs = [
    {
      agent: 'codex',
      sourceStep: 'review',
      resultText: 'Intro\n\n```json structured-findings\n{"findings":[{"title":"Keep me"}]}\n```\n\nLong prose',
    },
    {
      agent: 'gemini',
      sourceStep: 'review',
      resultText: `No structured block. ${'fallback '.repeat(1000)}`,
    },
  ]

  const essentials = buildInlineEssentials(runs, {
    totalBytes: 1400,
    perRunBytes: 650,
    renderStructured: (text) => {
      const match = String(text).match(/```json structured-findings\n([\s\S]*?)\n```/)
      return match ? match[1] : '_Structured findings block not found._'
    },
  })

  assert.ok(utf8ByteLength(essentials) <= 1400)
  assert.match(essentials, /Keep me/)
  assert.match(essentials, /Structured findings block not found/)
  assert.match(essentials, /Full prior result prose was offloaded/)
})

test('context fetch classifier avoids fragile marker-only rerun signals', () => {
  assert.deepEqual(
    classifyContextFetch({ reply: 'NAX-CONTEXT-LOADED ctx-1\nNAX-BLOB-SENTINEL blob-1', marker: 'ctx-1', sentinel: 'blob-1' }),
    { status: 'confirmed', confirmed: true, signals: ['marker', 'sentinel'] },
  )
  assert.deepEqual(
    classifyContextFetch({ reply: 'The hidden checksum was found.', marker: 'ctx-1', sentinel: 'blob-1', inlineOnlyNeedles: ['hidden checksum'] }),
    { status: 'probable', confirmed: true, signals: ['blob-only-detail'] },
  )
  assert.deepEqual(
    classifyContextFetch({ reply: 'netlify blobs:get failed with Forbidden', marker: 'ctx-1', sentinel: 'blob-1' }),
    { status: 'suspect', confirmed: false, signals: ['context-starved'] },
  )
  assert.deepEqual(
    classifyContextFetch({ commandOutput: 'netlify blobs:get failed with Forbidden', fetchExitCode: 1, marker: 'ctx-1', sentinel: 'blob-1' }),
    { status: 'failed', confirmed: false, signals: ['fetch-error'] },
  )
  assert.deepEqual(
    classifyContextFetch({ reply: 'I do not have enough context.', marker: 'ctx-1', sentinel: 'blob-1' }),
    { status: 'suspect', confirmed: false, signals: ['context-starved'] },
  )
})

test('context fetch classifier confirms command transcript proof even when final prose omits marker', () => {
  assert.deepEqual(
    classifyContextFetch({
      reply: `I used the fetched context. This answer discusses blobs:get and NETLIFY_AUTH_TOKEN without echoing them. ${'substantive '.repeat(200)}`,
      transcript: 'NAX-CONTEXT-LOADED ctx-9\nNAX-BLOB-SENTINEL blob-9\nfull payload',
      marker: 'ctx-9',
      sentinel: 'blob-9',
    }),
    { status: 'confirmed', confirmed: true, signals: ['marker', 'sentinel'] },
  )
})
