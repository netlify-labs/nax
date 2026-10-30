const fs = require('node:fs')
const path = require('node:path')

const { runFile } = require('../process')

/** The skills the hyperframes npm package ships in dist/skills. hyperframes-registry is only on GitHub. */
const HYPERFRAMES_SKILLS = ['hyperframes', 'hyperframes-cli', 'media-use']

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out'])
const MAX_DEPTH = 3

/**
 * HyperFrames: static FFmpeg, the skills the npm package ships at the pinned
 * version, and the headless Chrome HyperFrames renders with.
 * @param {{ version?: string, dir?: string }} options
 * @returns {import('../config').PresetResult}
 */
function expand(options = {}) {
  const version = options.version
  if (!version) throw new Error('"hyperframes" needs a "version", for example "0.8.217". Run `npx netlify-agent-kit add hyperframes` to fill it in.')
  const dir = options.dir || '.'
  return {
    tools: [{ name: 'ffmpeg', link: [] }],
    skills: [{ from: `npm:hyperframes@${version}`, path: 'dist/skills', names: HYPERFRAMES_SKILLS }],
    run: [{ cwd: dir, command: `npx -y hyperframes@${version} browser ensure` }],
    guide: [
      `- To edit or render the HyperFrames video, read the \`hyperframes\` skill first and follow its work loop. The project is in \`${dir}\`; run \`npx hyperframes\` commands from there. It uses hyperframes@${version}.`,
      '- FFmpeg, FFprobe and HyperFrames\' Chrome are ready. Check with `npx hyperframes doctor --json`.',
    ],
  }
}

/**
 * Finds folders that contain hyperframes.json, shallowest first.
 * @param {string} cwd
 * @returns {string[]} paths relative to cwd, "." for cwd itself
 */
function findProjects(cwd) {
  /** @type {string[]} */
  const found = []
  /** @type {Array<{ dir: string, depth: number }>} */
  const queue = [{ dir: cwd, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = /** @type {{ dir: string, depth: number }} */ (queue.shift())
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'hyperframes.json')) {
      found.push(path.relative(cwd, dir) || '.')
    }
    if (depth >= MAX_DEPTH) continue
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      }
    }
  }
  return found
}

/**
 * Reads the HyperFrames version a package.json pins: an exact dependency, or the
 * `hyperframes@x.y.z` that `npx hyperframes init` writes into its scripts.
 * @param {string} file
 * @returns {string | null}
 */
function pinnedVersion(file) {
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  for (const field of ['dependencies', 'devDependencies']) {
    const range = pkg?.[field]?.hyperframes
    const exact = typeof range === 'string' ? /^[\^~=]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range.trim()) : null
    if (exact) return exact[1]
  }
  for (const script of Object.values(pkg?.scripts || {})) {
    const match = typeof script === 'string' ? /hyperframes@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(script) : null
    if (match) return match[1]
  }
  return null
}

/**
 * Fills in the options `add` writes: the folder with hyperframes.json and the
 * version the project already pins, or the latest published version.
 * @param {{ cwd: string, options: Record<string, string>, runFile?: import('../process').RunFile }} input
 * @returns {{ options: Record<string, string>, notes: string[] }}
 */
function detectOptions({ cwd, options, runFile: run = runFile }) {
  const notes = []
  let dir = options.dir
  if (!dir) {
    const projects = findProjects(cwd)
    if (projects.length === 0) {
      throw new Error('no HyperFrames project found (a folder with hyperframes.json). Create one with `npx hyperframes init <dir>`, or pass --dir.')
    }
    dir = projects[0]
    notes.push(`found the HyperFrames project in ${dir}`)
    if (projects.length > 1) notes.push(`also found ${projects.slice(1).join(', ')}; pass --dir to pick another`)
  }

  let version = options.version
  if (!version) {
    version = pinnedVersion(path.join(cwd, dir, 'package.json')) || pinnedVersion(path.join(cwd, 'package.json')) || undefined
    if (version) {
      notes.push(`using hyperframes@${version}, the version the project pins`)
    } else {
      const result = run('npm', ['view', 'hyperframes', 'version'], { cwd })
      const latest = result.status === 0 ? result.stdout.trim() : ''
      if (!/^\d+\.\d+\.\d+/.test(latest)) {
        throw new Error('couldn\'t find a pinned HyperFrames version or look up the latest one. Pass --version.')
      }
      version = latest
      notes.push(`the project doesn't pin a version, so using the latest, hyperframes@${version}`)
    }
  }
  return { options: { version, dir }, notes }
}

module.exports = {
  HYPERFRAMES_SKILLS,
  detectOptions,
  expand,
  findProjects,
  pinnedVersion,
}
