# TODO

## Feature Enhancements

- Add an optional review-artifact persistence mode for Netlify Agent Runner workflows. Scope:
  - keep it opt-in rather than default for all runs
  - target review/cross-review flows where the written analysis matters even if later git or PR steps fail
  - likely modes: `comment-first`, `artifact`, or `both`
  - source data can come from canonical `.nax/agent-sessions/<session-id>/` artifacts and `.nax/workflows/<workflow-run-id>/artifacts/summary.md`
  - goal: preserve completed reviewer output before any later commit/push/PR mutation step can fail
