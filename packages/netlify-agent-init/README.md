# netlify-agent-init

Sets up what an agent needs inside a [Netlify Agent Runner](https://docs.netlify.com/build/build-with-ai/agent-runners/overview/): tools like FFmpeg, agent skills, related repositories, and a check that the right secrets exist. It runs from your repo's `postinstall`, does its work only in agent runners, and does nothing in deploys, CI, or local installs.

Nothing it adds shows up in `git status`, so none of it ends up in the agent's pull request.

## Why

Agent runners are Netlify build containers: Ubuntu, Node, no root and no `apt`. If your agent needs FFmpeg to render a video, or a skill that teaches it your workflow, your repo has to install those itself during environment setup, without root, and without the files landing in the agent's commits. This package does that, from one config block.

## Quick start

```bash
npx netlify-agent-init init --preset hyperframes --version 0.8.217 --dir video
npm install
```

`init` shows its changes, asks before writing, and then:

- adds `netlify-agent-init` to `devDependencies`;
- adds `"postinstall": "netlify-agent-init || exit 0"`, chained onto any existing `postinstall`;
- adds a `netlifyAgent` config block;
- adds a managed "Agent runner setup" section to `AGENTS.md`, so the agent knows what's installed.

Commit `package.json` and `AGENTS.md`. The next agent run sets everything up before the agent starts.

## Configuration

Put the config in `package.json` under `netlifyAgent`, or in a `netlify-agent.json` file next to it (the file wins if both exist). `schema.json` in this package gives editors autocomplete:

```json
{
  "$schema": "./node_modules/netlify-agent-init/schema.json",
  "schemaVersion": 1
}
```

A full example:

```jsonc
{
  "netlifyAgent": {
    "schemaVersion": 1,
    "description": "Marketing site and its HyperFrames hero video.",

    // Bundles of tools, skills and commands.
    "presets": { "hyperframes": { "version": "0.8.217", "dir": "video" } },

    // Environment variable names the agent needs. Checked, never printed.
    "secrets": ["SENTRY_AUTH_TOKEN"],

    // Related repos, cloned read-only to ~/repos/<owner>/<name>.
    "repositories": [{ "repo": "netlify/design-tokens", "ref": "v3.2.0" }],

    // Tools installed without root and linked into ~/.local/bin.
    "tools": ["ffmpeg"],

    // Agent skills, installed into .claude/skills and .agents/skills.
    "skills": [
      { "from": "npm:hyperframes@0.8.217", "path": "dist/skills", "names": ["hyperframes", "media-use"] },
      { "from": "github:my-org/private-skills#v1.4.0", "path": "skills", "auth": { "env": "SKILLS_TOKEN" } },
      { "from": "./tools/skills/house-style" }
    ],

    // Extra commands, in order, after everything above.
    "run": [{ "cwd": "video", "command": "npx -y hyperframes@0.8.217 browser ensure" }],

    // Exit non-zero when a step fails. Default: record the error and exit 0.
    "strict": false
  }
}
```

### Presets

| Preset | Options | Sets up |
| --- | --- | --- |
| `hyperframes` | `version` (required), `dir` | FFmpeg and FFprobe; the `hyperframes`, `hyperframes-cli` and `media-use` skills from the npm package at that version; HyperFrames' headless Chrome |

The `hyperframes-registry` skill isn't in the npm package. To add it, list it as a GitHub source, for example `{ "from": "github:heygen-com/hyperframes#v0.8.217", "path": "skills", "names": ["hyperframes-registry"] }`. That downloads the whole repository (about 140 MB) on every agent run.

### Tools

| Tool | Provides | How |
| --- | --- | --- |
| `ffmpeg` | `ffmpeg`, `ffprobe` | Static builds from `ffmpeg-static` and `@ffprobe-installer/ffprobe`, installed into `~/.cache/netlify-agent-init` |

- **Where they go:** binaries are linked into `~/.local/bin`, which is on `PATH` in agent runners. If it isn't on `PATH`, they go to `~/.cache/netlify-agent-init/bin`, and setup records a warning.
- **Already installed:** a tool that's already on `PATH` is left alone.
- **Project folders:** to also link a tool somewhere a program looks, use `{ "name": "ffmpeg", "link": ["video/.hyperframes/bin"] }`. Those links are hidden from git like everything else.

### Skills

| Source | Example |
| --- | --- |
| npm | `npm:<package>@<exact version>`, with `path` to the folder that holds the skills |
| GitHub | `github:<owner>/<repo>#<tag or sha>`, with `path` |
| Local | `./relative/path`, either one skill folder or a folder of skills |

- **Which skills:** `names` picks skills from the source; leave it out to install every folder with a `SKILL.md`.
- **Where:** skills are copied into `.claude/skills/` and `.agents/skills/`, plus `.codex/skills/`, `.cursor/skills/` and similar when those agent folders already exist in the repo.
- **Never overwritten:** a skill is never installed over one that already exists, whether it's committed in the repo or preinstalled in `~/.claude/skills`.
- **Marked as ours:** installed copies get `installed-by: netlify-agent-init` in their frontmatter.

### Private sources

Name the environment variable that holds the credential, and set its value as a Netlify environment variable on the site:

```json
{ "from": "github:my-org/private-skills#9f3c2e1", "path": "skills", "auth": { "env": "SKILLS_GITHUB_TOKEN" } }
{ "from": "npm:@my-org/skills@2.1.0", "registry": "https://npm.pkg.github.com", "auth": { "env": "SKILLS_NPM_TOKEN" } }
```

- **GitHub:** the token is sent only in an `Authorization` header, never in a URL, command line, or file. Without `auth`, GitHub sources and `repositories` use the first of `NETLIFY_AGENT_INIT_GITHUB_TOKEN`, `GITHUB_TOKEN` and `GH_TOKEN` that's set.
- **npm:** setup writes a temporary `.npmrc` containing `${VARIABLE_NAME}`. npm fills in the value itself, so the token is never written to disk.
- **Which token:** use a fine-grained, read-only token scoped to the one repository.

### Experimental: MCP servers

```json
"mcpServers": {
  "sentry": { "url": "https://mcp.sentry.dev/mcp", "headers": { "Authorization": { "env": "SENTRY_AUTH_TOKEN", "prefix": "Bearer " } } }
},
"experimental": { "mcpServers": true }
```

Servers are added to Claude Code's user-level `~/.claude.json` (never the repo), and existing servers with the same name are left alone. The file is written with mode `0600`, because it holds the resolved header values. This is experimental until it's been confirmed in agent runners.

## How it decides where to run

| Environment | What setup does |
| --- | --- |
| Agent runner environment setup (`NETLIFY=true`, `CONTEXT=dev-server`) | Runs |
| The agent's own shell (`NETLIFY_AGENT_RUNNER_ID` set) | Runs |
| Netlify deploys (`CONTEXT=production`, `deploy-preview`, `branch-deploy`) | Skips |
| Local installs, CI, `netlify dev` | Skips |
| `NETLIFY_AGENT_INIT=1` or `--local` | Runs anyway |
| `NETLIFY_AGENT_INIT=0` | Never runs |

Agent runner setup runs `npm install` with `BUILD_ID` and `DEPLOY_ID` set but without `NETLIFY_AGENT_RUNNER_ID`, so `CONTEXT=dev-server` is the signal. Netlify's hosted preview servers also use `CONTEXT=dev-server`, so setup runs there too.

## What it changes

- **Inside the repo:** installed skills and any project tool links. Each path is listed in a managed block in `.git/info/exclude`, the per-clone ignore file. That file isn't committed and isn't `.gitignore`, so the paths never show up in `git status`.
- **Outside the repo:**
  - tool installs in `~/.cache/netlify-agent-init/`;
  - links in `~/.local/bin`;
  - repositories in `~/repos/`;
  - the setup record in `~/.cache/netlify-agent-init/last-setup.json`.

Logs and the record contain environment variable names only, never values.

## Commands

```text
netlify-agent-init                  Run setup (what postinstall calls)
netlify-agent-init run -- <cmd>     Run a command, but only in agent runners
netlify-agent-init status [--json]  The current environment and the last setup record
netlify-agent-init init             Add setup to a repo (--preset, --version, --dir, --yes)
netlify-agent-init doctor           Validate config and show what setup would do
```

Options: `--local`, `--dry-run`, `--strict`, `--json`.

## Troubleshooting

- **The agent says a tool is missing.** Have it run `npx netlify-agent-init status`. If setup didn't run or a step failed, the record says why. Running `npx netlify-agent-init` once from the agent's shell retries.
- **Preview what an agent run would do** from your machine with `npx netlify-agent-init doctor`.
- **Try it for real locally** with `NETLIFY_AGENT_INIT=1 npm install`.

## API

```js
const { detect, setup, run, status } = require('netlify-agent-init')

detect(process.env)            // { active, label, reason, markers }
await setup({ cwd, env })      // { record, exitCode, skipped }
run('npm test', { cwd, env })  // { skipped, exitCode, detect }
status()                       // { detect, lastRecord }
```

## Limitations

- Repos need a `package.json`: agent runners only run `npm install` when one exists.
- GitHub is the only git host for `repositories` and git-based skill sources.
- Don't use this in packages you publish to npm: a published package's `postinstall` runs in every install of it. `init` warns when `package.json` isn't `"private": true`.
