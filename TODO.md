# TODO

## Feature Enhancements

- Add an optional review-artifact persistence mode for Netlify Agent Runner workflows. Scope:
  - keep it opt-in rather than default for all runs
  - target review/cross-review flows where the written analysis matters even if later git or PR steps fail
  - likely modes: `comment-first`, `artifact`, or `both`
  - source data can come from the existing agent session payload (`agent-sessions-<agent-id>.json` / latest session result)
  - goal: preserve completed reviewer output before any later commit/push/PR mutation step can fail
