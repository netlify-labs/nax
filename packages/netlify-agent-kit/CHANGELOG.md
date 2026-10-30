# Changelog

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
