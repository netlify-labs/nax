---
title: Cross Score Ideas
description: Score the other agents' ideas using an adversarial 0-1000 rubric.
instruction: please cross-score the other agents' ideas with a candid 0-1000 evaluation
---

# Cross Score Project Ideas

This is the adversarial scoring pass of a multi-agent idea duel. The **Prior Agent Results** section contains first-round idea proposals from multiple agents.

This is **analysis-only**. Do not edit files, do not stage files, do not commit, and do not open or update PRs.

## Task

Score the other agents' ideas. In a 3-agent run, score both other agents' idea lists in a single response. Do not score your own ideas unless you cannot reliably identify which ideas are yours; if so, state that limitation and score all ideas neutrally.

Read every other agent idea completely before scoring. The point is not to be agreeable; the point is to create an adversarial market for ideas.

Use a single 0-1000 score per idea:

- `900-1000`: Exceptional; do it now.
- `700-899`: Strong; clearly accretive and worth the effort.
- `500-699`: Decent; has merit but also real concerns.
- `300-499`: Weak; costs likely outweigh benefits.
- `100-299`: Poor; fundamental problems.
- `0-99`: Harmful, incoherent, or dead on arrival.

Evaluate each idea on:

1. Smartness: is this a real insight?
2. Practical utility: would real humans or AI agents benefit?
3. Feasibility: can it be built correctly without heroics?
4. Complexity budget: does the value justify the debt?
5. Accretiveness: does it strengthen the existing project rather than distract from it?

Also consider the full improvement rubric:

- robust: handles edge cases and failure modes
- reliable: works consistently instead of intermittently
- performant: improves or preserves important hot paths
- intuitive: users can predict behavior correctly
- user-friendly: setup, errors, and recovery are humane
- ergonomic: reduces repeated friction for humans and agents
- useful: solves a real, frequent problem
- compelling: people would actually want it
- accretive: strengthens the existing project
- pragmatic: realistic to build and maintain

Use weighted judgment: useful and pragmatic matter most; accretive matters next. A shiny idea that is hard to build correctly should not score highly.

## Scoring Discipline

Be candid to the point of catty. Polite scoring destroys the entire methodology — a 600 from a polite scorer carries no information. Strip the tone, keep the substance: if an idea would waste engineering time, say so specifically and unhedged. The disagreements between agents are the point — they are what surface hidden assumptions and blind spots. Honest harshness is the highest-signal contribution you can make to this duel.

- If every idea scores above 600, you are being polite. Spread the scores.
- If every idea scores below 300, you are being tribal. Make sure your objections are concrete and technical, not vague dismissals.
- A great idea should usually be 800+.
- A weak idea should usually be 200-.
- Exact 500s for everything are not useful.
- Healthy distributions are bimodal (clusters near 250 and 800) or normal-with-outliers. Uniform clusters in the 500-700 range mean you did not engage deeply — go back and re-score.
- Large disagreements are valuable signal; call out ideas where you expect another model to score very differently and classify the type of disagreement (see below).
- If two agents independently proposed overlapping ideas, note that as independent convergence rather than double-counting.

### Exclusion-Test Discipline For Low Scores

Any score below 400 should articulate a specific, falsifiable failure condition — e.g. "this approach requires O(n^2) joins across the user table, which will degrade beyond 10K users and conflicts with the existing pagination strategy." Vague difficulty objections ("seems hard to build") are noise. If your low score cannot be backed by a specific failure mode, raise the score.

### Disagreement-Type Tagging

Where you expect to disagree with another model, classify the disagreement as one of:

- `insight_gap` — you see a specific mechanism or codebase fact they probably missed
- `values_divergence` — same tradeoffs, different weighting (e.g. user value vs. complexity cost)
- `framing_mismatch` — the idea is ambiguous and you suspect another model interpreted it differently
- `systematic_bias` — pattern likely reflects a model-family tendency, not this specific idea
- `information_asymmetry` — your codebase grounding is deeper or shallower than another model's likely depth

### Your Reasoning Is Ammunition

The reactions phase that follows requires defenders and attackers to engage with your specific arguments. A score of 350 backed by 2000 tokens of technical reasoning has dramatically more impact than a score of 350 backed by "this seems impractical." Front-load the specifics — name the mechanism, cite the file or function, describe the failure condition.

Use ultrathink: decompose each opposing idea into its claims, evaluate each claim against this codebase's actual files and architecture, consider second-order effects, identify specific implementation risks, only then commit to a score.

## Output

Start with `## Scoring Notes` and briefly explain how you identified your own ideas versus other agents' ideas.

Then write `## Score Calibration` with:

- any overlap between agents' ideas
- any signs of score inflation or deflation you intentionally corrected for
- the top scoring criterion that drove your harshest rejections

Then write `## Structured Scores` as a fenced JSON block:

```json
[
  {
    "target_agent": "claude|gemini|codex|unknown",
    "target_idea_id": "CLAUDE-1",
    "score": 850,
    "subscores": {
      "useful": 90,
      "pragmatic": 85,
      "accretive": 80,
      "robust": 75,
      "ergonomic": 90
    },
    "verdict": "consensus_win|strong|decent|weak|kill|contested",
    "strengths": "Best argument for the idea",
    "concerns": "Most important objection",
    "implementation_risk": "Specific risk to watch",
    "confidence": "high|medium|low"
  }
]
```

After the JSON, include:

1. **Top Opponent Ideas:** 2-4 strongest ideas and why.
2. **Ideas To Kill:** ideas that should probably not survive, each with a specific failure condition (not a vague difficulty objection).
3. **Underrated Ideas:** ideas that may look boring but deserve attention.
4. **Predicted Disagreements:** ideas where you expect another model to score >250 points differently than you did. Tag each with `insight_gap`, `values_divergence`, `framing_mismatch`, `systematic_bias`, or `information_asymmetry` and explain the basis for the prediction.
5. **Hidden Costs:** implementation, UX, migration, or operational risks the originator underplayed.
6. **Score Distribution Self-Check:** report your min, max, median, and rough spread; confirm the distribution is not a uniform 500-700 cluster.
