import test from 'node:test'
import assert from 'node:assert/strict'

import { extractMarkdownToc } from '../../web/src/run-details-toc'

test('run details toc excludes generated contents and repository state headings', () => {
  const toc = extractMarkdownToc([
    '# Review',
    '',
    '## Contents',
    '',
    '- [Review](#review)',
    '',
    '## [Claude Results](https://app.netlify.com/projects/netlify-agent-executor/agent-runs/run-id?session=session-id)',
    '',
    '### 1. Repository State',
    '',
    '### 2. Structured Findings',
    '',
    '## `Gemini Results`',
    '',
    '### 1. Repository State',
    '',
    '### Explore',
  ].join('\n'))

  assert.deepEqual(toc.map((entry) => entry.text), [
    'Claude Results',
    'Structured Findings',
    'Gemini Results',
    'Explore',
  ])
})
