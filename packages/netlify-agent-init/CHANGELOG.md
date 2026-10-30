# Changelog

## 0.1.0

First release.

- `netlify-agent-init` runs setup from `postinstall` inside Netlify Agent Runners, and does nothing in deploys, CI and local installs. It detects agent runner setup by `CONTEXT=dev-server` (or `NETLIFY_AGENT_RUNNER_ID` in the agent's shell).
- Tools: `ffmpeg` (static FFmpeg and FFprobe, linked into `~/.local/bin`).
- Skills from npm, GitHub (including private repos through a named environment variable) and local folders, installed into the repo's agent folders without overwriting existing skills.
- `repositories` (read-only shallow clones), `secrets` (presence checks), `run` commands, and experimental `mcpServers`.
- Everything added inside the repo is listed in `.git/info/exclude`, so it never shows up in `git status`.
- `hyperframes` preset.
- Commands: `run`, `status`, `init`, `doctor`.
