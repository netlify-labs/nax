const fs = require('node:fs')
const path = require('node:path')

const { cacheDir, localBinDir, tildify } = require('../paths')
const { isOnPath, isWritableDir, runFile, which } = require('../process')
const { ffmpeg } = require('./ffmpeg')

/**
 * @typedef {(installDir: string, packages: string[]) => void} NpmInstall
 *
 * @typedef {{
 *   name: string,
 *   version: string,
 *   provides: string[],
 *   install: (context: { installDir: string, npmInstall: NpmInstall, env: NodeJS.ProcessEnv }) => Promise<Record<string, string>>,
 * }} ToolRecipe
 *
 * @typedef {{
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   npmInstall?: NpmInstall,
 *   recipes?: Record<string, ToolRecipe>,
 * }} ToolOptions
 */

/** @type {Record<string, ToolRecipe>} */
const RECIPES = { ffmpeg }

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {NpmInstall}
 */
function defaultNpmInstall(env) {
  return (installDir, packages) => {
    fs.mkdirSync(installDir, { recursive: true })
    const result = runFile('npm', [
      'install',
      '--prefix', installDir,
      '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--loglevel=error',
      ...packages,
    ], { env })
    if (result.status !== 0) {
      throw new Error(`npm install ${packages.join(' ')} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`)
    }
  }
}

/**
 * Picks where binaries go: ~/.local/bin when it's on PATH and writable (true in
 * agent runners), otherwise a cache folder that isn't on PATH.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ dir: string, onPath: boolean }}
 */
function chooseBinDir(env) {
  const local = localBinDir(env)
  if (isOnPath(local, env) && isWritableDir(local)) return { dir: local, onPath: true }
  const fallback = path.join(cacheDir(env), 'bin')
  fs.mkdirSync(fallback, { recursive: true })
  return { dir: fallback, onPath: false }
}

/**
 * @param {string} target
 * @param {string} linkPath
 */
function forceSymlink(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  try {
    fs.rmSync(linkPath, { force: true })
  } catch {
    // nothing to remove
  }
  fs.symlinkSync(target, linkPath)
}

/**
 * Installs one tool. Returns the step for the record and any paths created inside the repo.
 * @param {import('../config').ToolSpec} spec
 * @param {ToolOptions} [options]
 * @returns {Promise<{ step: import('../record').InstallStep, repoPaths: string[] }>}
 */
async function installTool(spec, { env = process.env, cwd = process.cwd(), npmInstall, recipes = RECIPES } = {}) {
  const started = Date.now()
  const recipe = recipes[spec.name]
  if (!recipe) {
    return {
      step: { kind: 'tool', name: spec.name, status: 'error', error: `unknown tool "${spec.name}". Available tools: ${Object.keys(recipes).join(', ')}` },
      repoPaths: [],
    }
  }

  const found = Object.fromEntries(recipe.provides.map((bin) => [bin, which(bin, env)]))
  /** @type {Record<string, string>} */
  let binaries
  let status
  if (Object.values(found).every(Boolean)) {
    binaries = /** @type {Record<string, string>} */ (found)
    status = 'already-on-path'
  } else {
    const installDir = path.join(cacheDir(env), 'tools', `${recipe.name}@${recipe.version}`)
    binaries = await recipe.install({ installDir, npmInstall: npmInstall || defaultNpmInstall(env), env })
    status = 'installed'
  }

  const links = []
  const warnings = []
  if (status === 'installed') {
    const bin = chooseBinDir(env)
    if (!bin.onPath) warnings.push(`${tildify(path.join(localBinDir(env)), env)} is not on PATH; linked into ${tildify(bin.dir, env)} instead`)
    for (const [name, target] of Object.entries(binaries)) {
      const linkPath = path.join(bin.dir, name)
      forceSymlink(target, linkPath)
      links.push(tildify(linkPath, env))
    }
  }

  const repoPaths = []
  for (const dir of spec.link) {
    const linkDir = path.resolve(cwd, dir)
    for (const [name, target] of Object.entries(binaries)) {
      const linkPath = path.join(linkDir, name)
      forceSymlink(target, linkPath)
      links.push(path.relative(cwd, linkPath))
    }
    repoPaths.push(linkDir)
  }

  return {
    step: { kind: 'tool', name: recipe.name, version: recipe.version, status, links, warnings, ms: Date.now() - started },
    repoPaths,
  }
}

module.exports = {
  RECIPES,
  chooseBinDir,
  installTool,
}
