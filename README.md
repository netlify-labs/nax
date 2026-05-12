# netlify-agent-executor

`nax` (Netlify Agent eXecutor) creates Netlify agent-runner GitHub issues from reusable prompt templates.

This is intentionally isolated from the app workspace. Install dependencies inside this folder:

```bash
cd netlify-agent-executor
npm install
```

Run the interactive chooser:

```bash
npm start
```

Create the default review swarm issues after previewing them:

```bash
npm run dry-run
nax issue review --yes
```

Useful flags:

```bash
nax issue review \
  --models claude,gemini,codex \
  --context "Focus on the latest message center work" \
  --sha "$(git rev-parse HEAD)" \
  --label agent-review \
  --dry-run
```

By default, every `issue` and `comment` workflow now auto-injects:

- a **review-only contract**
- the **pinned git SHA** (default: current `HEAD`)
- a **repository snapshot**
- an **open PR merge-state ledger**

This keeps all reviewer rounds anchored to the same commit and gives synthesis explicit PR-state context. Disable it only if you intentionally want a free-form prompt:

```bash
nax issue review --no-auto-context --dry-run
```

Post follow-up prompts back onto existing model-specific issues:

```bash
nax comment cross-review \
  --repo netlify-labs/gmail-emailer \
  --issues 29,30,31 \
  --sha "$(git rev-parse HEAD)" \
  --context-file ./round-1-context.md \
  --yes
```

If the issue thread already has a Netlify runner comment saying a PR was opened, `nax comment ...` will automatically redirect the follow-up `@netlify` prompt to that linked PR instead of posting another dead-end issue comment.

Create a single consensus-summary issue after the cross-review round:

```bash
nax issue summarize-consensus \
  --repo netlify-labs/gmail-emailer \
  --models claude \
  --sha "$(git rev-parse HEAD)" \
  --from-issues 29,30,31 \
  --yes
```

Useful context-related flags:

```bash
--sha <rev>          # pin reviewers to an explicit git revision
--repo-root <path>   # choose which local repo to inspect for SHA/status
--pr-limit <count>   # cap the number of open PRs in the merge-state ledger
--no-auto-context    # disable the review contract / SHA snapshot / PR ledger
```

Prompt templates live in `prompts/*.md`. Each template supports simple frontmatter:

```markdown
---
title: Review
description: Short picker hint
instruction: please review and access current setup
---

Prompt body...
```

The generated issue title format is:

```text
YYYY-MM-DD Model PromptTitle
```

The generated issue body starts with:

```text
@netlify model instruction
```

For comments on existing issues, `nax comment ... --issues 29,30,31` infers the model from each issue title (for example `2026-04-24 Claude Review`) and builds the same `@netlify model instruction` header automatically for each comment.

The prompts themselves now ask for:

- a repository-state section that verifies the pinned SHA
- a structured findings / structured consensus JSON block
- prose sections for human-readable reasoning
- explicit separation between defects and polish
- a short list of rejected items
