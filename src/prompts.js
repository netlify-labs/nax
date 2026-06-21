const fs = require('fs')
const path = require('path')
const { renderPromptMarker } = require('./comment-markers')
const { DEFAULT_MODELS } = require('./constants')
const { runGh } = require('./gh-cli')

const PROMPTS_DIR = path.join(__dirname, 'flows', 'review', 'prompts')
const PROMPT_ORDER = ['review', 'cross-review', 'summarize-consensus']

/**
 * Prompt file loaded from markdown frontmatter and body.
 * @typedef {{
 *   name: string,
 *   path?: string,
 *   title: string,
 *   description?: string,
 *   instruction: string,
 *   body: string,
 * }} PromptDefinition
 *
 * Prompt fields needed to build an issue title.
 * @typedef {{
 *   name: string,
 *   title: string,
 * }} PromptTitleDefinition
 *
 * Issue title build options.
 * @typedef {{
 *   date?: string,
 *   model?: string,
 *   prompt: PromptTitleDefinition,
 *   title?: string,
 *   sourceModels?: string[],
 * }} BuildIssueTitleInput
 *
 * Issue body build options.
 * @typedef {{
 *   runner?: string,
 *   model?: string,
 *   prompt: PromptDefinition,
 *   context?: string,
 *   roundResults?: string,
 *   date?: string,
 *   resolves?: Array<string | number>,
 * }} BuildIssueBodyInput
 */

function stripPromptOrderPrefix(name) {
  return String(name).replace(/^\d+_/, '')
}

function resolvePromptPath(name, promptsDir) {
  const exactPath = path.join(promptsDir, `${name}.md`)
  if (fs.existsSync(exactPath)) return exactPath
  if (!fs.existsSync(promptsDir)) return exactPath

  const prefixed = fs
    .readdirSync(promptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .find((entry) => stripPromptOrderPrefix(entry.name.replace(/\.md$/, '')) === name)

  return prefixed ? path.join(promptsDir, prefixed.name) : exactPath
}

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
      const name = stripPromptOrderPrefix(entry.name.replace(/\.md$/, ''))
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
  const filePath = resolvePromptPath(name, promptsDir)
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
  const name = fallbackName || stripPromptOrderPrefix(path.basename(filePath).replace(/\.md$/, ''))
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
    .map((name) => stripPromptOrderPrefix(name.replace(/\.md$/, '')))
    .sort()
}

/** @param {BuildIssueTitleInput} param0 */
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

/** @param {BuildIssueBodyInput} param0 */
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

  const result = runGh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    errorPrefix: 'Could not resolve GitHub repo with gh. Pass --repo owner/name.',
  })

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
