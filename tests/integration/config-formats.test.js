const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const NAX_BIN = path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-config-format-'))
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '')
}

function flowObject(id, title) {
  return {
    id,
    title,
    defaults: {
      agents: ['codex'],
    },
    steps: [{
      id: 'one',
      title: 'One',
      prompt: 'prompts/one.md',
      agents: ['codex'],
    }],
  }
}

function flowSource(format, id, title) {
  const flow = flowObject(id, title)
  if (format === 'yml') {
    return [
      `id: ${id}`,
      `title: ${title}`,
      'defaults:',
      '  agents: [codex]',
      'steps:',
      '  - id: one',
      '    title: One',
      '    prompt: prompts/one.md',
      '    agents: [codex]',
      '',
    ].join('\n')
  }
  if (format === 'json') return `${JSON.stringify(flow, null, 2)}\n`
  if (format === 'toml') {
    return [
      `id = "${id}"`,
      `title = "${title}"`,
      '',
      '[defaults]',
      'agents = ["codex"]',
      '',
      '[[steps]]',
      'id = "one"',
      'title = "One"',
      'prompt = "prompts/one.md"',
      'agents = ["codex"]',
      '',
    ].join('\n')
  }
  if (format === 'js') return `module.exports = ${JSON.stringify(flow, null, 2)}\n`
  if (format === 'ts') return `export default ${JSON.stringify(flow, null, 2)}\n`
  throw new Error(`Unsupported test format: ${format}`)
}

function configSource(format, flowsDir) {
  const config = { flowsDirs: [flowsDir] }
  if (format === 'yml') {
    return [
      'flowsDirs:',
      `  - ${flowsDir}`,
      '',
    ].join('\n')
  }
  if (format === 'json') return `${JSON.stringify(config, null, 2)}\n`
  if (format === 'toml') return `flowsDirs = ["${flowsDir}"]\n`
  if (format === 'js') return `module.exports = ${JSON.stringify(config, null, 2)}\n`
  if (format === 'ts') return `export default ${JSON.stringify(config, null, 2)}\n`
  throw new Error(`Unsupported test format: ${format}`)
}

function writeFlow(root, flowsDir, id, fileName, source) {
  const flowDir = path.join(root, flowsDir, id)
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, fileName), source)
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), [
    '---',
    'title: One Prompt',
    '---',
    '',
    `Prompt body for ${id}.`,
    '',
  ].join('\n'))
}

function runDryFlow(root, flowId) {
  return spawnSync(process.execPath, [
    NAX_BIN,
    'run',
    flowId,
    '--dry',
    '--force',
    '--branch',
    'format-integration',
    '--transport',
    'netlify-api',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
    },
  })
}

const SYNTAX_CASES = [
  { label: 'YAML', extension: 'yml' },
  { label: 'JSON', extension: 'json' },
  { label: 'TOML', extension: 'toml' },
]

const EXECUTABLE_SYNTAX_CASES = [
  { label: 'JavaScript', extension: 'js' },
  { label: 'TypeScript', extension: 'ts' },
]

test('CLI dry run loads project flow files across supported syntaxes', async (t) => {
  for (const { label, extension } of SYNTAX_CASES) {
    await t.test(label, () => {
      const root = tmpRoot()
      const flowId = `flow-${extension}`
      const title = `${label} Flow`
      writeFlow(root, path.join('.github', 'nax-flows'), flowId, `flow.${extension}`, flowSource(extension, flowId, title))

      const result = runDryFlow(root, flowId)
      const stdout = stripAnsi(result.stdout)

      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.match(stdout, /Multi step agent workflow:/)
      assert.match(stdout, new RegExp(`"${title}"`))
      assert.match(stdout, /Dry run only/)
      assert.equal(fs.existsSync(path.join(root, '.nax')), false)
    })
  }
})

test('CLI dry run blocks executable project flow files', async (t) => {
  for (const { label, extension } of EXECUTABLE_SYNTAX_CASES) {
    await t.test(label, () => {
      const root = tmpRoot()
      const flowId = `flow-${extension}`
      const title = `${label} Flow`
      writeFlow(root, path.join('.github', 'nax-flows'), flowId, `flow.${extension}`, flowSource(extension, flowId, title))

      const result = runDryFlow(root, flowId)
      const output = stripAnsi(`${result.stdout}\n${result.stderr}`)

      assert.notEqual(result.status, 0)
      assert.match(output, /Blocked executable config file in safe mode/)
      assert.equal(fs.existsSync(path.join(root, '.nax')), false)
    })
  }
})

test('CLI dry run loads nax config files across supported syntaxes', async (t) => {
  for (const { label, extension } of SYNTAX_CASES) {
    await t.test(label, () => {
      const root = tmpRoot()
      const flowsDir = 'custom-flows'
      const flowId = `config-${extension}`
      const title = `${label} Config Flow`

      fs.writeFileSync(path.join(root, `nax.config.${extension}`), configSource(extension, flowsDir))
      writeFlow(root, flowsDir, flowId, 'flow.yml', flowSource('yml', flowId, title))

      const result = runDryFlow(root, flowId)
      const stdout = stripAnsi(result.stdout)

      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.match(stdout, /Multi step agent workflow:/)
      assert.match(stdout, new RegExp(`"${title}"`))
      assert.match(stdout, /Dry run only/)
      assert.equal(fs.existsSync(path.join(root, '.nax')), false)
    })
  }
})

test('CLI dry run blocks executable nax config files', async (t) => {
  for (const { label, extension } of EXECUTABLE_SYNTAX_CASES) {
    await t.test(label, () => {
      const root = tmpRoot()
      const flowsDir = 'custom-flows'
      const flowId = `config-${extension}`
      const title = `${label} Config Flow`

      fs.writeFileSync(path.join(root, `nax.config.${extension}`), configSource(extension, flowsDir))
      writeFlow(root, flowsDir, flowId, 'flow.yml', flowSource('yml', flowId, title))

      const result = runDryFlow(root, flowId)
      const output = stripAnsi(`${result.stdout}\n${result.stderr}`)

      assert.notEqual(result.status, 0)
      assert.match(output, /Blocked executable config file in safe mode/)
      assert.equal(fs.existsSync(path.join(root, '.nax')), false)
    })
  }
})
