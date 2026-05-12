const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { renderPromptMarker } = require('./comment-markers')

const DEFAULT_MODELS = ['claude', 'gemini', 'codex']
const PROMPTS_DIR = path.join(__dirname, '..', 'flows', 'review-cycle', 'prompts')
const PROMPT_ORDER = ['review', 'cross-review', 'summarize-consensus']

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return { frontmatter: {}, body: content.trimStart() }

  const frontmatter = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (kv) frontmatter[kv[1]] = kv[2].trim()
  }

  return {
    frontmatter,
    body: content.slice(match[0].length).trimStart(),
  }
}

function listPrompts(promptsDir = PROMPTS_DIR) {
  return fs
    .readdirSync(promptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const name = entry.name.replace(/\.md$/, '')
      const prompt = loadPrompt(name, promptsDir)
      return {
        name,
        title: prompt.title,
        description: prompt.description,
        path: prompt.path,
      }
    })
    .sort((a, b) => {
      const ai = PROMPT_ORDER.indexOf(a.name)
      const bi = PROMPT_ORDER.indexOf(b.name)
      if (ai !== -1 && bi !== -1) return ai - bi
      if (ai !== -1) return -1
      if (bi !== -1) return 1
      return a.name.localeCompare(b.name)
    })
}

function loadPrompt(name, promptsDir = PROMPTS_DIR) {
  const filePath = path.join(promptsDir, `${name}.md`)
  if (!fs.existsSync(filePath)) {
    const available = listPromptNames(promptsDir).join(', ') || 'none'
    throw new Error(`Unknown prompt "${name}". Available prompts: ${available}`)
  }

  const raw = fs.readFileSync(filePath, 'utf8')
  const { frontmatter, body } = parseFrontmatter(raw)
  return {
    name,
    path: filePath,
    title: frontmatter.title || titleCase(name),
    description: frontmatter.description || '',
    instruction: frontmatter.instruction || `please run the ${name} workflow`,
    body: body.trim(),
  }
}

function loadPromptFile(filePath, fallbackName) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Prompt file does not exist: ${filePath}`)
  }

  const raw = fs.readFileSync(filePath, 'utf8')
  const { frontmatter, body } = parseFrontmatter(raw)
  const name = fallbackName || path.basename(filePath).replace(/\.md$/, '')
  return {
    name,
    path: filePath,
    title: frontmatter.title || titleCase(name),
    description: frontmatter.description || '',
    instruction: frontmatter.instruction || `please run the ${name} workflow`,
    body: body.trim(),
  }
}

function listPromptNames(promptsDir = PROMPTS_DIR) {
  if (!fs.existsSync(promptsDir)) return []
  return fs
    .readdirSync(promptsDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''))
    .sort()
}

function buildIssueTitle({ date, model, prompt, title, sourceModels = [] }) {
  if (title && title.trim()) {
    return `${date} ${titleCase(model)} ${title.trim()}`
  }
  if (prompt.name === 'summarize-consensus' && Array.isArray(sourceModels) && sourceModels.length > 0) {
    const sources = sourceModels.map(titleCase).join('/')
    return `${date} Summarize ${sources} Consensus using ${titleCase(model)}`
  }
  return `${date} ${titleCase(model)} ${prompt.title}`
}

function buildIssueBody({ runner, model, prompt, context, roundResults, date, resolves = [] }) {
  const summaryLabel = `${titleCase(prompt.name)} instructions`
  const parts = [
    `${runner} ${model} ${prompt.instruction}`.trim(),
    '',
    '<details>',
    `<summary>${summaryLabel}</summary>`,
    '',
    prompt.body,
    '',
    '</details>',
  ]

  if (roundResults && roundResults.trim()) {
    parts.push('', '---', '', roundResults.trim())
  }

  if (context && context.trim()) {
    parts.push('', '---', '', '## Additional Context', '', context.trim())
  }

  if (Array.isArray(resolves) && resolves.length > 0) {
    parts.push('', '---', '', ...resolves.map((number) => `Resolves #${number}`))
  }

  if (date) {
    parts.push('', renderPromptMarker({ promptName: prompt.name, model, date }))
  }

  return parts.join('\n')
}

function getLocalDate(now = new Date()) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function titleCase(value) {
  return String(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function resolveRepo(explicitRepo) {
  if (explicitRepo) return explicitRepo

  const result = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`Could not resolve GitHub repo with gh. Pass --repo owner/name. ${detail}`.trim())
  }

  return result.stdout.trim()
}

module.exports = {
  DEFAULT_MODELS,
  PROMPTS_DIR,
  buildIssueBody,
  buildIssueTitle,
  getLocalDate,
  listPromptNames,
  listPrompts,
  loadPrompt,
  loadPromptFile,
  resolveRepo,
  titleCase,
}
