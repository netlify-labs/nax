# Changelog

## 0.3.0

- Skills can come from a zip: `{ "from": "https://example.com/skills.zip" }`. The zip can hold skill folders, or be a single skill with `SKILL.md` at its root (named after the file). `.skill` files work too. `path` and `names` pick skills as with other sources, and `auth: { "env": "VARIABLE" }` sends a bearer token. Extraction uses `unzip`, which agent runners have.
- Logs, the install record and installed skills show a URL source as its host and file name only (`https://example.com/…/skills.zip`), so a URL with a secret path doesn't leak.

## 0.2.0

- `add` changes only `package.json`. It no longer writes a section into `AGENTS.md`, so setting up a repo is a one-file commit.
- `install` writes a `netlify-agent-kit` skill into the same skill folders as the others, describing what's installed: tools, the HyperFrames project and version, cloned repositories, secret names, and how to check or retry. It's regenerated on every install, so it matches the config, and it's hidden from git like the other installed skills. A `netlify-agent-kit` skill the repo or user already has is never replaced.
- `description` now goes at the top of that skill.

If you used 0.1.0, you can delete the `<!-- netlify-agent-kit:start -->` section from `AGENTS.md`.

## 0.1.0

First release, replacing `netlify-agent-init`.

- `npx netlify-agent-kit add hyperframes` configures a repo once. It finds the HyperFrames project and the version it pins (or looks up the latest once), writes the config and the `postinstall` hook, and adds a section to `AGENTS.md`.
- `netlify-agent-kit install` runs from `postinstall` and installs only in Netlify Agent Runners (`CONTEXT=dev-server`, or `NETLIFY_AGENT_RUNNER_ID` in the agent's shell). `--dry-run` shows what it would install, and `--force` installs anywhere.
- `netlify-agent-kit status` shows what the last install did.
- Presets are top-level config keys: `"netlifyAgent": { "hyperframes": { "version": "0.8.217", "dir": "video" } }`.
- Tools: `ffmpeg` (static FFmpeg and FFprobe, linked into `~/.local/bin`).
- Skills from npm, GitHub (including private repos through a named environment variable) and local folders, installed into the repo's agent folders without overwriting existing skills.
- `repositories` (read-only shallow clones), `secrets` (presence checks), `run` commands, and experimental `mcpServers`.
- Everything added inside the repo is listed in `.git/info/exclude`, so it never shows up in `git status`.
