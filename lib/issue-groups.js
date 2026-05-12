const { spawnSync } = require('child_process')

const TITLE_PATTERN = /^(\d{4}-\d{2}-\d{2})\s+(Claude|Gemini|Codex)\s+(.+)$/i

function parseWorkflowTitle(title) {
  const match = String(title || '').match(TITLE_PATTERN)
  if (!match) return null
  return {
    date: match[1],
    model: match[2].toLowerCase(),
    promptTitle: match[3].trim(),
  }
}

function listRepoIssues({ repo, limit = 60, state = 'all' }) {
  const result = spawnSync(
    'gh',
    [
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      state,
      '--limit',
      String(limit),
      '--json',
      'number,title,createdAt,url,state',
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim() || (result.stdout || '').trim()
    throw new Error(`Could not list issues in ${repo}: ${detail}`)
  }
  return JSON.parse(result.stdout || '[]')
}

function buildGroups(issues) {
  const map = new Map()
  for (const issue of issues) {
    const parsed = parseWorkflowTitle(issue.title)
    if (!parsed) continue
    const key = `${parsed.date}::${parsed.promptTitle.toLowerCase()}`
    if (!map.has(key)) {
      map.set(key, {
        date: parsed.date,
        promptTitle: parsed.promptTitle,
        members: [],
      })
    }
    map.get(key).members.push({
      number: issue.number,
      model: parsed.model,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      createdAt: issue.createdAt,
    })
  }

  for (const group of map.values()) {
    group.members.sort((a, b) => a.number - b.number)
    group.models = group.members.map((m) => m.model)
    group.issueNumbers = group.members.map((m) => m.number)
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date)
    return a.promptTitle.localeCompare(b.promptTitle)
  })
}

function listRecentIssueGroups({ repo, limit = 60, state = 'all', loader = listRepoIssues }) {
  return buildGroups(loader({ repo, limit, state }))
}

function formatGroupHint(group) {
  return group.members
    .map((member) => `${member.model[0].toUpperCase() + member.model.slice(1)} #${member.number}`)
    .join(', ')
}

module.exports = {
  buildGroups,
  formatGroupHint,
  listRecentIssueGroups,
  listRepoIssues,
  parseWorkflowTitle,
}
