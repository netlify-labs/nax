// @ts-nocheck
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const { deleteBlob, setBlob } = require('../../src/integrations/netlify/blobs')
const { buildNetlifyEnv, submitLocalAgentRun, waitForLocalAgentRuns } = require('../../src/integrations/netlify/local-runner')

const enabled = process.env.NAX_NETLIFY_BLOB_ROUNDTRIP_E2E === '1'

test('opt-in probe proves local blob write is readable from a hosted agent run', { skip: enabled ? false : 'set NAX_NETLIFY_BLOB_ROUNDTRIP_E2E=1 to run real Netlify probe' }, async () => {
  const projectRoot = path.resolve(__dirname, '..', '..')
  const netlify = buildNetlifyEnv({ projectRoot, siteId: process.env.NETLIFY_SITE_ID })
  const marker = `roundtrip-${Date.now()}`
  const store = `nax-probe-${marker}`
  const key = 'context'
  const payload = `NAX-BLOB-ROUNDTRIP ${marker}`

  setBlob({
    store,
    key,
    value: payload,
    siteId: netlify.siteId,
    token: netlify.env.NETLIFY_AUTH_TOKEN,
    cwd: projectRoot,
    env: netlify.env,
  })

  try {
    const submitted = await submitLocalAgentRun({
      run: {
        agent: process.env.NAX_BLOB_ROUNDTRIP_AGENT || 'codex',
        promptText: [
          'Fetch this Netlify Blob and echo its content exactly:',
          '',
          `NETLIFY_SITE_ID="\${NETLIFY_SITE_ID:-$SITE_ID}" /opt/buildhome/node-deps/node_modules/.bin/netlify blobs:get ${store} ${key}`,
          '',
          `Expected marker: ${payload}`,
        ].join('\n'),
      },
      projectRoot,
      branch: process.env.NAX_BLOB_ROUNDTRIP_BRANCH || 'main',
      siteId: netlify.siteId,
      env: netlify.env,
    })

    const completed = await waitForLocalAgentRuns({
      projectRoot,
      runs: [submitted],
      siteId: netlify.siteId,
      env: netlify.env,
      timeoutMinutes: Number.parseInt(process.env.NAX_BLOB_ROUNDTRIP_TIMEOUT_MINUTES || '10', 10),
      initialDelayMs: 5000,
      pollIntervalMs: 5000,
    })

    assert.match(completed[0].resultText || '', new RegExp(payload))
  } finally {
    deleteBlob({
      store,
      key,
      siteId: netlify.siteId,
      token: netlify.env.NETLIFY_AUTH_TOKEN,
      cwd: projectRoot,
      env: netlify.env,
      allowFailure: true,
    })
  }
})
