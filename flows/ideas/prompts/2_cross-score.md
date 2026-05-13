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

Be candid. Polite score inflation makes the synthesis worse.

- If every idea scores above 600, you are probably being too polite. Spread the scores.
- If every idea scores below 300, you may be being tribal. Make sure your objections are concrete.
- A great idea should usually be 800+.
- A weak idea should usually be 200-.
- Exact 500s for everything are not useful.
- Large disagreements are valuable signal; call out ideas where you expect another model to disagree with you.
- If two agents independently proposed overlapping ideas, note that as independent convergence rather than double-counting.

Use ultrathink.

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
2. **Ideas To Kill:** ideas that should probably not survive.
3. **Underrated Ideas:** ideas that may look boring but deserve attention.
4. **Most Interesting Disagreement:** any idea you expect another model to score very differently.
5. **Hidden Costs:** implementation, UX, migration, or operational risks the originator underplayed.
