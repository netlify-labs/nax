# Review Flow

Three-agent code review with adversarial cross-check: Claude, Gemini, and Codex review the project independently, critique each other's findings, and produce one ranked consensus plan.

Catches things any single reviewer would miss and filters out findings the other models disagree with.

## When to use it

- Pre-release hardening of a project or branch.
- Auditing an unfamiliar codebase before changing it.
- Filtering noisy single-model review output through peer disagreement.
- Producing a ranked, defensible punch list rather than a wall of suggestions.

Not for: targeted single-PR review (use `/review` or `/ultrareview`), or quick lint-style checks.

## Flow

```mermaid
flowchart TD
    Start([Start]) --> Review

    subgraph Review[1. Review]
        V1[Claude reviews repo]
        V2[Gemini reviews repo]
        V3[Codex reviews repo]
    end

    Review --> CrossReview

    subgraph CrossReview[2. Cross Review]
        X1[Claude critiques others' findings]
        X2[Gemini critiques others' findings]
        X3[Codex critiques others' findings]
    end

    CrossReview --> Synthesize[3. Summarize Consensus<br/>Codex only]
    Synthesize --> End([Ranked consensus plan])
```

## Steps

| # | Step | Agents | Purpose |
|---|------|--------|---------|
| 1 | `review` | claude, gemini, codex | Each agent independently explores the repo and reports findings and improvements. |
| 2 | `cross-review` | claude, gemini, codex | Each agent cross-checks the other agents' findings, agreeing, disputing, or escalating. |
| 3 | `synthesize` | codex | Single agent merges first-round and cross-review output into one ranked consensus plan. |

## Run

```bash
nax review
```
