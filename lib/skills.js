const fs = require('fs')
const path = require('path')

const PACKAGE_ROOT = path.join(__dirname, '..')
const PACKAGE_JSON_PATH = path.join(PACKAGE_ROOT, 'package.json')
const BUNDLED_SKILLS_DIR = path.join(PACKAGE_ROOT, 'templates', 'skills')
const PROVIDER_DIRS = [
  '.claude',
  '.codex',
  '.cursor',
  '.gemini',
  '.agents',
  '.opencode',
  '.kiro',
  '.pi',
  '.qoder',
  '.trae',
  '.github',
]
const DEFAULT_SKILLS = ['nax-workflows']
const SUBSTITUTABLE_EXTENSIONS = new Set(['.md'])

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')).version || 'unknown'
  } catch {
    return 'unknown'
  }
}

function findProjectRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir)
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(startDir)
}

function normalizeProvider(provider) {
  const value = String(provider || '').trim()
  if (!value) return ''
  return value.startsWith('.') ? value : `.${value}`
}

function parseList(value) {
  if (Array.isArray(value)) return value.flatMap(parseList)
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function listBundledSkills({ skillsDir = BUNDLED_SKILLS_DIR } = {}) {
  if (!fs.existsSync(skillsDir)) return []
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(skillsDir, name, 'SKILL.md')))
    .sort((a, b) => a.localeCompare(b))
}

function resolveSkillNames({ skill, allSkills = false, skillsDir = BUNDLED_SKILLS_DIR } = {}) {
  const bundled = listBundledSkills({ skillsDir })
  if (allSkills) return bundled
  const requested = parseList(skill)
  const names = requested.length > 0 ? requested : DEFAULT_SKILLS
  for (const name of names) {
    if (!bundled.includes(name)) {
      throw new Error(`Unknown bundled skill "${name}". Available skills: ${bundled.join(', ') || 'none'}.`)
    }
  }
  return [...new Set(names)]
}

function findExistingProviders(projectRoot) {
  return PROVIDER_DIRS.filter((provider) => fs.existsSync(path.join(projectRoot, provider)))
}

function resolveProviders({ projectRoot, providers, allProviders = false } = {}) {
  if (allProviders) return PROVIDER_DIRS
  const requested = parseList(providers).map(normalizeProvider).filter(Boolean)
  if (requested.length > 0) return [...new Set(requested)]
  const existing = findExistingProviders(projectRoot)
  return existing.length > 0 ? existing : ['.claude']
}

function fileExtension(name) {
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

function applySubstitutions(content, substitutions) {
  let output = content
  for (const [token, value] of Object.entries(substitutions || {})) {
    output = output.split(token).join(value)
  }
  return output
}

function setFrontmatterVersion(content, version) {
  if (!content.startsWith('---\n')) return content
  const end = content.indexOf('\n---', 4)
  if (end === -1) return content
  const frontmatter = content.slice(4, end)
  const rest = content.slice(end)
  const nextFrontmatter = /^version:\s*.+$/m.test(frontmatter)
    ? frontmatter.replace(/^version:\s*.+$/m, `version: "${version}"`)
    : `${frontmatter.trimEnd()}\nversion: "${version}"\n`
  return `---\n${nextFrontmatter.trimEnd()}\n${rest.slice(1)}`
}

function readInstalledVersion(skillRoot) {
  const skillPath = path.join(skillRoot, 'SKILL.md')
  if (!fs.existsSync(skillPath)) return null
  const content = fs.readFileSync(skillPath, 'utf8')
  return content.match(/^version:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') || null
}

function copySkillDir({ src, dest, substitutions = {}, version, dryRun = false }) {
  if (dryRun) return
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copySkillDir({ src: from, dest: to, substitutions, version, dryRun })
      continue
    }
    if (!entry.isFile()) continue
    if (SUBSTITUTABLE_EXTENSIONS.has(fileExtension(entry.name))) {
      let text = applySubstitutions(fs.readFileSync(from, 'utf8'), substitutions)
      if (entry.name === 'SKILL.md') text = setFrontmatterVersion(text, version)
      fs.writeFileSync(to, text)
    } else {
      fs.writeFileSync(to, fs.readFileSync(from))
    }
  }
}

function installSkills({
  projectRoot = findProjectRoot(),
  providers,
  allProviders = false,
  skill,
  allSkills = false,
  dryRun = false,
  force = true,
  skillsDir = BUNDLED_SKILLS_DIR,
  version = packageVersion(),
} = {}) {
  const root = path.resolve(projectRoot)
  const targets = resolveProviders({ projectRoot: root, providers, allProviders })
  const skills = resolveSkillNames({ skill, allSkills, skillsDir })
  const results = []

  for (const provider of targets) {
    for (const skillName of skills) {
      const src = path.join(skillsDir, skillName)
      const dest = path.join(root, provider, 'skills', skillName)
      const existed = fs.existsSync(dest)
      if (!dryRun && existed && force) fs.rmSync(dest, { recursive: true, force: true })
      copySkillDir({
        src,
        dest,
        version,
        dryRun,
        substitutions: {
          '{{package_version}}': version,
          '{{skill_name}}': skillName,
        },
      })
      results.push({
        provider,
        skill: skillName,
        path: dest,
        status: dryRun ? (existed ? 'would-update' : 'would-install') : (existed ? 'updated' : 'installed'),
        version,
      })
    }
  }

  return results
}

function updateSkills(options = {}) {
  return installSkills(options)
}

function checkSkills({
  projectRoot = findProjectRoot(),
  providers,
  allProviders = false,
  skill,
  allSkills = false,
  skillsDir = BUNDLED_SKILLS_DIR,
  version = packageVersion(),
} = {}) {
  const root = path.resolve(projectRoot)
  const targets = resolveProviders({ projectRoot: root, providers, allProviders })
  const skills = resolveSkillNames({ skill, allSkills, skillsDir })
  const results = []
  for (const provider of targets) {
    for (const skillName of skills) {
      const dest = path.join(root, provider, 'skills', skillName)
      const installedVersion = readInstalledVersion(dest)
      results.push({
        provider,
        skill: skillName,
        path: dest,
        installed: Boolean(installedVersion),
        installedVersion,
        packageVersion: version,
        current: installedVersion === version,
      })
    }
  }
  return results
}

module.exports = {
  BUNDLED_SKILLS_DIR,
  DEFAULT_SKILLS,
  PROVIDER_DIRS,
  checkSkills,
  copySkillDir,
  findExistingProviders,
  findProjectRoot,
  installSkills,
  listBundledSkills,
  normalizeProvider,
  packageVersion,
  readInstalledVersion,
  resolveProviders,
  resolveSkillNames,
  setFrontmatterVersion,
  updateSkills,
}
