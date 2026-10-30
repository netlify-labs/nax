# netlify-agent-kit

Gives the agent in a [Netlify Agent Runner](https://docs.netlify.com/build/build-with-ai/agent-runners/overview/) the tools and skills it needs, like FFmpeg and the HyperFrames skills for rendering video. You configure your repo once, and every agent run starts with everything installed. Deploys, CI and local installs are left alone, and nothing it installs shows up in the agent's pull request.

## Quick start

```bash
npx netlify-agent-kit add hyperframes
npm install
```

Commit `package.json` and `AGENTS.md`. That's it: the next agent run has FFmpeg, the HyperFrames skills and HyperFrames' Chrome before the agent starts.

## Commands

| Command | Who runs it | What it does |
| --- | --- | --- |
| `npx netlify-agent-kit add hyperframes` | You, once | Configures the repo: adds the preset to `package.json`, the `postinstall` hook, and a section in `AGENTS.md` so the agent knows what's installed. |
| `netlify-agent-kit install` | Your `postinstall`, on every `npm install` | Installs everything, in agent runners only. Anywhere else it prints one line and exits. |
| `npx netlify-agent-kit status` | You or the agent | Shows what the last install did. |

`add` options: `--version <v>` and `--dir <path>` override what it detects.
`install` options: `--dry-run` shows what it would install, `--force` installs anywhere (your laptop included), `--strict` exits non-zero when a step fails.
`status` options: `--json`.

## What `add` writes

For a repo with a HyperFrames project in `video/`:

```json
{
  "scripts": { "postinstall": "netlify-agent-kit install || exit 0" },
  "devDependencies": { "netlify-agent-kit": "^0.1.0" },
  "netlifyAgent": { "hyperframes": { "version": "0.8.217", "dir": "video" } }
}
```

- **The folder:** the shallowest folder with a `hyperframes.json`.
- **The version:** the one the project already pins (the `hyperframes@x.y.z` that `npx hyperframes init` writes into its scripts, or an exact `hyperframes` dependency). If nothing is pinned, the latest version, looked up once and written down, so every agent run uses the same one.
- **An existing `postinstall`:** kept. Ours runs after it: `<yours> && (netlify-agent-kit install || exit 0)`.
- **`|| exit 0`:** installs that skip dev dependencies (`npm install --omit=dev`) don't have the command, and shouldn't fail because of it.

Running `add` again is safe: it updates the same config and the same `AGENTS.md` section.

## Presets

| Preset | Options | Installs |
| --- | --- | --- |
| `hyperframes` | `version`, `dir` (both detected by `add`) | FFmpeg and FFprobe; the `hyperframes`, `hyperframes-cli` and `media-use` skills from the npm package at that version; HyperFrames' headless Chrome |

The `hyperframes-registry` skill isn't in the npm package. To add it, list it as a GitHub skill source (below). That downloads the whole repository, about 140 MB, on every agent run.

## More than a preset

Everything a preset does, you can also list yourself, under the same `netlifyAgent` key (or in a `netlify-agent.json` file, which wins if both exist). Add `"$schema": "./node_modules/netlify-agent-kit/schema.json"` for editor autocomplete.

```jsonc
{
  "netlifyAgent": {
    "hyperframes": { "version": "0.8.217", "dir": "video" },

    // Shown at the top of the AGENTS.md section.
    "description": "Marketing site and its HyperFrames hero video.",

    // Environment variable names the agent needs. Checked, never printed.
    "secrets": ["SENTRY_AUTH_TOKEN"],

    // Related repos, cloned read-only to ~/repos/<owner>/<name>.
    "repositories": [{ "repo": "netlify/design-tokens", "ref": "v3.2.0" }],

    // Tools installed without root and linked into ~/.local/bin.
    "tools": ["ffmpeg"],

    // Agent skills, installed into .claude/skills and .agents/skills.
    "skills": [
      { "from": "github:my-org/private-skills#v1.4.0", "path": "skills", "auth": { "env": "SKILLS_TOKEN" } },
      { "from": "./tools/skills/house-style" }
    ],

    // Extra commands, in order, after everything above.
    "run": ["npx playwright install chromium"],

    // Exit non-zero when a step fails. Default: record the error and exit 0.
    "strict": false
  }
}
```

### Tools

| Tool | Provides | How |
| --- | --- | --- |
| `ffmpeg` | `ffmpeg`, `ffprobe` | Static builds from `ffmpeg-static` and `@ffprobe-installer/ffprobe`, installed into `~/.cache/netlify-agent-kit` |

- **Where they go:** linked into `~/.local/bin`, which is on `PATH` in agent runners. If it isn't on `PATH`, they go to `~/.cache/netlify-agent-kit/bin`, with a warning.
- **Already installed:** a tool that's already on `PATH` is left alone.
- **Project folders:** to also link a tool where a program looks, use `{ "name": "ffmpeg", "link": ["video/.hyperframes/bin"] }`.

### Skills

| Source | Example |
| --- | --- |
| npm | `npm:<package>@<exact version>`, with `path` to the folder that holds the skills |
| GitHub | `github:<owner>/<repo>#<tag or sha>`, with `path` |
| Local | `./relative/path`, either one skill folder or a folder of skills |

- **Which skills:** `names` picks skills from the source; leave it out to install every folder with a `SKILL.md`.
- **Where:** `.claude/skills/` and `.agents/skills/`, plus `.codex/skills/`, `.cursor/skills/` and similar when those folders already exist.
- **Never overwritten:** a skill is never installed over one that already exists, committed in the repo or preinstalled in `~/.claude/skills`.
- **Marked as ours:** installed copies get `installed-by: netlify-agent-kit` in their frontmatter.

### Private sources

Name the environment variable that holds the credential, and set its value as a Netlify environment variable on the site:

```json
{ "from": "github:my-org/private-skills#9f3c2e1", "path": "skills", "auth": { "env": "SKILLS_GITHUB_TOKEN" } }
{ "from": "npm:@my-org/skills@2.1.0", "registry": "https://npm.pkg.github.com", "auth": { "env": "SKILLS_NPM_TOKEN" } }
```

- **GitHub:** the token is sent only in an `Authorization` header, never in a URL, command line or file. Without `auth`, GitHub sources and `repositories` use the first of `NETLIFY_AGENT_KIT_GITHUB_TOKEN`, `GITHUB_TOKEN` and `GH_TOKEN` that's set.
- **npm:** install writes a temporary `.npmrc` containing `${VARIABLE_NAME}`. npm fills in the value itself, so the token is never written to disk.
- **Which token:** a fine-grained, read-only token scoped to the one repository.

### Experimental: MCP servers

```json
"mcpServers": {
  "sentry": { "url": "https://mcp.sentry.dev/mcp", "headers": { "Authorization": { "env": "SENTRY_AUTH_TOKEN", "prefix": "Bearer " } } }
},
"experimental": { "mcpServers": true }
```

Servers are added to Claude Code's user-level `~/.claude.json` (never the repo), and existing servers with the same name are left alone. The file is written with mode `0600`, because it holds the resolved header values. Experimental until it's been confirmed in agent runners.

## Where `install` runs

| Environment | `install` |
| --- | --- |
| Agent runner environment setup (`NETLIFY=true`, `CONTEXT=dev-server`) | Installs |
| The agent's own shell (`NETLIFY_AGENT_RUNNER_ID` set) | Installs |
| Netlify deploys (`CONTEXT=production`, `deploy-preview`, `branch-deploy`) | Skips |
| Local installs, CI, `netlify dev` | Skips |
| `--force` | Installs |

Agent runner setup runs `npm install` with `BUILD_ID` and `DEPLOY_ID` set but without `NETLIFY_AGENT_RUNNER_ID`, so `CONTEXT=dev-server` is the signal. Netlify's hosted preview servers also use `CONTEXT=dev-server`, so it installs there too.

## What it changes

- **Inside the repo:** installed skills and any project tool links. Each path goes in a managed block in `.git/info/exclude`, git's per-clone ignore file, so it never shows up in `git status`.
- **Outside the repo:** tools in `~/.cache/netlify-agent-kit/`, links in `~/.local/bin`, repositories in `~/repos/`, and the record of the last install in `~/.cache/netlify-agent-kit/last-install.json`.

Logs and the record contain environment variable names only, never values.

## Troubleshooting

- **The agent says a tool is missing.** Have it run `npx netlify-agent-kit status`. If install didn't run or a step failed, the record says why. `npx netlify-agent-kit install` from the agent's shell retries.
- **See what an agent run would install** from your machine: `npx netlify-agent-kit install --dry-run`.
- **Install it for real locally:** `npx netlify-agent-kit install --force`.

## API

```js
const { detect, install, status, planAdd, applyAdd } = require('netlify-agent-kit')

detect(process.env)                                // { active, label, reason, markers }
await install({ cwd, env })                        // { record, exitCode, skipped }
status()                                           // { detect, lastRecord }
applyAdd(planAdd({ cwd, preset: 'hyperframes' }))  // what `add` does
```

## Limitations

- Repos need a `package.json`: agent runners only run `npm install` when one exists.
- GitHub is the only git host for `repositories` and git-based skill sources.
- Don't use this in packages you publish to npm: a published package's `postinstall` runs in every install of it. `add` warns when `package.json` isn't `"private": true`.
