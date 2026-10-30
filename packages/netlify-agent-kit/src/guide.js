const fs = require('node:fs')
const path = require('node:path')

const { homeDir } = require('./paths')
const { isOurInstall, resolveTargets } = require('./skills/install')

const GUIDE_NAME = 'netlify-agent-kit'

/**
 * The SKILL.md install writes so the agent knows what's set up. Names secrets
 * and repositories, never values.
 * @param {import('./config').AgentConfig} config
 * @param {string[]} [skills] skills install set up, by folder name
 * @returns {string}
 */
function renderGuide(config, skills = []) {
  const lines = [
    '---',
    `name: ${GUIDE_NAME}`,
    'description: What this Netlify Agent Runner has installed and how to use it. Read before installing a tool, rendering video, or looking for a related repository or secret.',
    'installed-by: netlify-agent-kit',
    '---',
    '',
    '# This agent runner',
    '',
  ]
  if (config.description) lines.push(config.description, '')
  lines.push(
    '`npm install` ran `netlify-agent-kit install`, which set up everything below before you started. Everything it added inside the repo, this skill included, is hidden from git through `.git/info/exclude`, so never commit it.',
    '',
  )
  lines.push(...config.guide)
  if (skills.length > 0) {
    lines.push(`- Skills set up for this repo: ${skills.map((name) => `\`${name}\``).join(', ')}. They're in \`.claude/skills\` and \`.agents/skills\`.`)
  }
  if (config.tools.length > 0) {
    lines.push(`- Installed tools, on \`PATH\` in \`~/.local/bin\`: ${config.tools.map((tool) => `\`${tool.name}\``).join(', ')}. There is no root, so never try \`apt-get\`.`)
  }
  for (const repo of config.repositories) {
    const [owner, name] = repo.repo.split('/')
    lines.push(`- \`${repo.repo}\` is cloned read-only at \`${repo.path || `~/repos/${owner}/${name}`}\` for reference. Don't commit to it.`)
  }
  if (config.secrets.length > 0) {
    lines.push(`- These environment variables are set. Use them, but never print their values: ${config.secrets.map((name) => `\`${name}\``).join(', ')}.`)
  }
  lines.push(
    '- If a tool or skill listed here is missing, run `npx netlify-agent-kit status` to see what the install did, and `npx netlify-agent-kit install` to retry.',
    '',
  )
  return lines.join('\n')
}

/**
 * Writes the guide skill into every skill folder the other skills go to. Replaces
 * an earlier copy of its own, and never one the repo or the user already has.
 * @param {{ config: import('./config').AgentConfig, skills?: string[], cwd: string, env?: NodeJS.ProcessEnv, dryRun?: boolean }} options
 * @returns {{ step: import('./record').InstallStep, createdPaths: string[] }}
 */
function writeGuide({ config, skills = [], cwd, env = process.env, dryRun = false }) {
  const userCopy = path.join(homeDir(env), '.claude', 'skills', GUIDE_NAME)
  const targets = resolveTargets(cwd).map((target) => path.join(cwd, target, GUIDE_NAME))
  const taken = [userCopy, ...targets].find((dir) => fs.existsSync(dir) && !isOurInstall(dir))
  if (taken) {
    const where = taken === userCopy ? '~/.claude/skills' : path.relative(cwd, path.dirname(taken))
    return { step: { kind: 'guide', name: GUIDE_NAME, status: 'skipped', reason: `a ${GUIDE_NAME} skill already exists in ${where}` }, createdPaths: [] }
  }
  if (dryRun) return { step: { kind: 'guide', name: GUIDE_NAME, status: 'would-write' }, createdPaths: [] }
  const content = renderGuide(config, skills)
  for (const dir of targets) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content)
  }
  return { step: { kind: 'guide', name: GUIDE_NAME, status: 'ok' }, createdPaths: targets }
}

module.exports = {
  GUIDE_NAME,
  renderGuide,
  writeGuide,
}
