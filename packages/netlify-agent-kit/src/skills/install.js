const fs = require('node:fs')
const path = require('node:path')

const { homeDir } = require('../paths')

/** Repo folders that always get skills, because every agent harness reads one of them. */
const DEFAULT_TARGETS = ['.claude/skills', '.agents/skills']

/** Other agent folders. Skills go there too when the folder already exists in the repo. */
const OPTIONAL_PROVIDER_DIRS = ['.codex', '.cursor', '.gemini', '.opencode', '.kiro', '.pi', '.qoder', '.trae']

/** @param {string} cwd */
function resolveTargets(cwd) {
  const extra = OPTIONAL_PROVIDER_DIRS
    .filter((dir) => fs.existsSync(path.join(cwd, dir)))
    .map((dir) => `${dir}/skills`)
  return [...DEFAULT_TARGETS, ...extra]
}

/**
 * Lists skill folders in a source. A folder with its own SKILL.md is one skill.
 * @param {string} dir
 * @returns {Map<string, string>} name → folder
 */
function listSkills(dir) {
  /** @type {Map<string, string>} */
  const skills = new Map()
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
    skills.set(path.basename(dir), dir)
    return skills
  }
  if (!fs.existsSync(dir)) return skills
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md'))) {
      skills.set(entry.name, path.join(dir, entry.name))
    }
  }
  return skills
}

/**
 * Adds installed-by and source to SKILL.md frontmatter.
 * @param {string} content
 * @param {string} source
 */
function stampFrontmatter(content, source) {
  const fields = `installed-by: netlify-agent-kit\nsource: ${JSON.stringify(source)}`
  if (!content.startsWith('---\n')) return `---\n${fields}\n---\n${content}`
  const end = content.indexOf('\n---', 4)
  if (end === -1) return content
  const frontmatter = content
    .slice(4, end)
    .split('\n')
    .filter((line) => !/^(installed-by|source):/.test(line))
    .join('\n')
  return `---\n${frontmatter.trimEnd()}\n${fields}${content.slice(end)}`
}

/**
 * True when a skill folder was installed by this package (its SKILL.md is stamped).
 * @param {string} skillDir
 */
function isOurInstall(skillDir) {
  try {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')
    const end = content.startsWith('---\n') ? content.indexOf('\n---', 4) : -1
    return end !== -1 && /^installed-by: netlify-agent-kit$/m.test(content.slice(0, end))
  } catch {
    return false
  }
}

/**
 * @param {string} src
 * @param {string} dest
 * @param {string} source
 */
function copySkillDir(src, dest, source) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copySkillDir(from, to, source)
    else if (entry.isFile() && entry.name === 'SKILL.md' && path.resolve(dest) !== path.resolve(src)) {
      fs.writeFileSync(to, stampFrontmatter(fs.readFileSync(from, 'utf8'), source))
    } else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

/**
 * Installs skills from a resolved source into the repo's agent folders. Never
 * replaces a skill that already exists in a target or in ~/.claude/skills.
 * @param {{
 *   sourceDir: string,
 *   from: string,
 *   names?: string[],
 *   cwd: string,
 *   env?: NodeJS.ProcessEnv,
 *   dryRun?: boolean,
 * }} options
 * @returns {{ installed: string[], skipped: { name: string, reason: string }[], targets: string[], createdPaths: string[], missing: string[] }}
 */
function installSkills({ sourceDir, from, names, cwd, env = process.env, dryRun = false }) {
  const available = listSkills(sourceDir)
  const wanted = names && names.length > 0 ? names : [...available.keys()]
  const missing = wanted.filter((name) => !available.has(name))
  const targets = resolveTargets(cwd)
  const userSkills = path.join(homeDir(env), '.claude', 'skills')

  const installed = []
  const skipped = []
  const createdPaths = []
  for (const name of wanted) {
    const src = available.get(name)
    if (!src) continue
    const targetPaths = targets.map((target) => path.join(cwd, target, name))
    const ours = targetPaths.filter((candidate) => isOurInstall(candidate))
    const existing = [...targetPaths, path.join(userSkills, name)]
      .find((candidate) => fs.existsSync(candidate) && !ours.includes(candidate))
    if (existing) {
      const where = existing.startsWith(userSkills) ? '~/.claude/skills' : path.relative(cwd, path.dirname(existing))
      skipped.push({ name, reason: `already in ${where}` })
      createdPaths.push(...ours)
      continue
    }
    if (ours.length === targetPaths.length) {
      skipped.push({ name, reason: 'already installed by an earlier install' })
      createdPaths.push(...ours)
      continue
    }
    for (const target of targets) {
      const dest = path.join(cwd, target, name)
      if (!dryRun) copySkillDir(src, dest, from)
      createdPaths.push(dest)
    }
    installed.push(name)
  }
  return { installed, skipped, targets, createdPaths, missing }
}

module.exports = {
  DEFAULT_TARGETS,
  OPTIONAL_PROVIDER_DIRS,
  copySkillDir,
  installSkills,
  isOurInstall,
  listSkills,
  resolveTargets,
  stampFrontmatter,
}
