# nax Flow Reference

## `review`

Purpose: multi-model code review with adversarial cross-review and final synthesis.

Steps:

| Step | Agents | Submit | Input |
|------|--------|--------|-------|
| `review` | claude, gemini, codex | new-run | none |
| `cross-review` | claude, gemini, codex | follow-up | `review` |
| `synthesize` | codex | new-run | `review`, `cross-review` |

Run examples:

```bash
nax review
nax review --branch '#123' --where local-machine --force
nax review --step cross-review
```

## `ideas`

Purpose: generate project improvement ideas, score them adversarially, react to criticism, and synthesize a ranked plan.

Steps:

| Step | Agents | Submit | Input |
|------|--------|--------|-------|
| `ideate` | claude, gemini, codex | new-run | none |
| `cross-score` | claude, gemini, codex | follow-up | `ideate` |
| `react` | claude, gemini, codex | follow-up | `ideate`, `cross-score` |
| `synthesize` | codex | new-run | `ideate`, `cross-score`, `react` |

Run examples:

```bash
nax ideas
nax ideas --where local-machine --timeout-minutes 45
nax ideas --from-step react
```

## `do-next`

Purpose: ask multiple models for the next best task, then synthesize one ranked recommendation.

Steps:

| Step | Agents | Submit | Input |
|------|--------|--------|-------|
| `propose` | claude, gemini, codex | new-run | none |
| `synthesize` | codex | new-run | `propose` |

Run examples:

```bash
nax do-next
nax do-next --branch '#123' --where local-machine --force
```

## Flow Authoring Notes

- Use `action: issue` for a fresh top-level result.
- Use `action: comment` when continuing a runner thread.
- Use `submit: follow-up` only when there is a prior runner for the same agent.
- Use `input` to embed prior step results into the current prompt.
- Keep follow-up prompt size under control; prior outputs can get large quickly.

