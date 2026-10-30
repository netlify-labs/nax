const START = '<!-- netlify-agent-kit:start -->'
const END = '<!-- netlify-agent-kit:end -->'

/**
 * The AGENTS.md section `add` writes. Names secrets and repositories, never values.
 * @param {import('./config').AgentConfig} config
 */
function renderAgentsSection(config) {
  const lines = [START, '## Netlify Agent Runners', '']
  if (config.description) lines.push(config.description, '')
  lines.push(
    'In Netlify Agent Runners, `npm install` runs `netlify-agent-kit install`, which installs the tools and skills listed below. It keeps everything it adds out of git (through `.git/info/exclude`), so never commit those files.',
    '',
    '- Check what it installed with `npx netlify-agent-kit status`. If it reports problems or didn\'t run, run `npx netlify-agent-kit install` yourself.',
  )
  lines.push(...config.agentsMd)
  if (config.tools.length > 0) {
    lines.push(`- Installed tools (in \`~/.local/bin\`): ${config.tools.map((tool) => `\`${tool.name}\``).join(', ')}.`)
  }
  if (config.secrets.length > 0) {
    lines.push(`- These environment variables are available. Use them, but never print their values: ${config.secrets.map((name) => `\`${name}\``).join(', ')}.`)
  }
  for (const repo of config.repositories) {
    const [owner, name] = repo.repo.split('/')
    lines.push(`- \`${repo.repo}\` is cloned read-only at \`${repo.path || `~/repos/${owner}/${name}`}\` for reference. Don't commit to it.`)
  }
  lines.push(END)
  return lines.join('\n')
}

/**
 * Replaces the managed section, or appends it.
 * @param {string} content
 * @param {string} section
 */
function upsertSection(content, section) {
  const start = content.indexOf(START)
  const end = content.indexOf(END)
  if (start !== -1 && end > start) {
    return content.slice(0, start) + section + content.slice(end + END.length)
  }
  const prefix = content.trim() ? `${content.replace(/\s*$/, '')}\n\n` : '# Agent guide\n\n'
  return `${prefix}${section}\n`
}

module.exports = {
  END,
  START,
  renderAgentsSection,
  upsertSection,
}
