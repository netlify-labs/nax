const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '../..')
const guardedPaths = [
    'src/core/constants.js',
    'src/core/agents/selection.js',
    'src/integrations/github/comment-markers.js',
    'src/integrations/github/issue-groups.js',
    'src/integrations/github/issue-plan.js',
    'src/workflows/followups/plan.js',
    'src/workflows/engine/runner.js',
    'src/workflows/catalog/prompts.js',
    'src/workflows/round-results.js',
    'src/cli/commands/nax.js',
    'src/cli/commands/issue.js',
    'src/cli/main.js',
    'src/contracts/dashboard.ts',
    'src/dashboard/api/serializers.js',
    'src/dashboard/services/mutations.js',
    'src/dashboard/server.js',
    'src/dashboard/web/src/App.tsx',
    'src/dashboard/web/src/components/RunFollowupModal.tsx',
    'tests/unit/agent-selection.test.js',
    'tests/unit/followup-plan.test.js',
    'tests/unit/workflow-runner.test.js',
    'README.md',
    'site/content/concepts/council-pattern.mdx',
    'site/content/for-agents.mdx',
    'site/content/guides/run-workflows.mdx',
    'site/content/reference/commands.mdx',
    'src/templates/skills/nax-workflows/SKILL.md',
]

test('hard-cut surfaces contain no provider-as-model vocabulary', () => {
  const forbidden = [
    /\bDEFAULT_MODELS\b/,
    /\bDEFAULT_MODEL_CSV\b/,
    /\bDEFAULT_FOLLOWUP_MODELS\b/,
    /\bnormalizeModels\b/,
    /\bdefaultModelsForTarget\b/,
    /\bselectedModels\b/,
    /\bfallbackModels\b/,
    /\binferModelFrom(?:Title|IssueTitle)\b/,
    /\bsourceModels\b/,
    /\bmodels\??:\s*string\[\]/,
    /--models[ \t]+(?:<list>|(?:claude|codex|gemini|opencode)(?=,|[ \t]*$))/m,
    /--step-models\s+<step=models>/,
    /Choose Netlify agent models/i,
    /\bmissing_models\b/,
    /\binvalid_models?\b/,
    /\bUnknown model "(?:claude|gemini|codex|opencode)/,
    /\bModels:\s*(?:all configured agents|\$\{agents\})/,
  ]
  const failures = []
  for (const relativePath of guardedPaths) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')
    for (const pattern of forbidden) {
      if (pattern.test(source)) failures.push(`${relativePath}: ${pattern}`)
    }
  }
  assert.deepEqual(
    failures,
    [],
    `Provider values must be named agents; models are real model IDs:\n${failures.join('\n')}`,
  )
})

test('pinned GitHub Action has no true model or effort channel', () => {
  const workflow = fs.readFileSync(
    path.join(projectRoot, 'src/templates/netlify-agents.yml'),
    'utf8',
  )
  assert.match(
    workflow,
    /netlify-labs\/agent-runner-action@4e06b4897d1d69c619af6a25e00ee65e8cb9c91f/,
  )
  assert.match(workflow, /default-agent/)
  assert.doesNotMatch(workflow, /^\s+(?:default-)?model:/m)
  assert.doesNotMatch(workflow, /^\s+effort:/m)
})
