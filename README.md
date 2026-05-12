# netlify-agent-executor

`nax` runs multi step Netlify agent workflows using the worlds leading AI models.

It is workflow-first: `nax` shows the workflows in `flows/*/flow.yml`, asks where to run them, then runs each step in order. Steps wait for completed Netlify Agent Runner results before the next step starts.

## Install

```bash
cd /Users/david/dotfiles/clis/netlify-agent-executor
npm install
```

## Run

Interactive:

```bash
nax
```

Set up a repository for GitHub Actions transport:

```bash
nax init
```

`nax init` runs the normal Netlify CLI site initialization flow first when no site is linked. Then it asks whether to enable GitHub Actions. If enabled, it writes `.github/workflows/netlify-agents.yml` when it is missing and sets the `NETLIFY_SITE_ID` and `NETLIFY_AUTH_TOKEN` GitHub Actions secrets. It uses the current Netlify CLI login token; if that token is missing, run `netlify login` first or set `NETLIFY_AUTH_TOKEN`.

Run a named workflow:

```bash
nax review-cycle
nax run review-cycle
```

Preview without creating GitHub issues or comments:

```bash
nax review-cycle --dry --force
```

Choose where the workflow runs:

```bash
nax review-cycle --where github-actions
nax review-cycle --where local-machine
```

`github-actions` currently requires a workflow in the target repository that uses `netlify-labs/agent-runner-action`. `local-machine` is detected when Netlify CLI has a linked local site; execution support is still being wired up.

## Setup Hints

For GitHub Actions:

1. Run `nax init` from the repository root.
2. Commit `.github/workflows/netlify-agents.yml`.
3. Run `nax`.

For local execution:

1. Install and log in to Netlify CLI: `netlify login`.
2. Link the repo to a Netlify site: `netlify link`.
3. Run `nax` from the repository root and choose `Locally on this machine`.

## Workflows

Workflows live in `flows/<workflow-id>/flow.yml`.

Prompts for a workflow live beside it, usually in `flows/<workflow-id>/prompts/*.md`.

List workflows:

```bash
nax list
```

Current workflow:

```text
review-cycle
```

This runs review, cross-review, and consensus synthesis as one ordered flow.
