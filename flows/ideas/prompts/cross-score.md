---
title: Cross Score Ideas
description: Score the other agents' ideas using an adversarial 0-1000 rubric.
instruction: please cross-score the other agents' ideas with a candid 0-1000 evaluation
---

# Cross Score Project Ideas

This is the adversarial scoring pass of a multi-agent idea duel. The **Prior Agent Results** section contains first-round idea proposals from multiple agents.

This is **analysis-only**. Do not edit files, do not stage files, do not commit, and do not open or update PRs.

## Task

Score the other agents' ideas. Do not score your own ideas unless you cannot reliably identify which ideas are yours; if so, state that limitation and score all ideas neutrally.

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

Be candid. Polite score inflation makes the synthesis worse.

## Output

Start with `## Scoring Notes` and briefly explain how you identified your own ideas versus other agents' ideas.

Then write `## Structured Scores` as a fenced JSON block:

```json
[
  {
    "target_agent": "claude|gemini|codex|unknown",
    "target_idea_id": "CLAUDE-1",
    "score": 850,
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
3. **Most Interesting Disagreement:** any idea you expect another model to score very differently.
