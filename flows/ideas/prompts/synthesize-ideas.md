---
title: Synthesize Ideas
description: Synthesize multi-agent idea proposals, scores, and reactions into a ranked plan.
instruction: please synthesize the idea duel into a ranked set of project improvement recommendations
---

# Synthesize The Idea Duel

You are the final synthesis pass for a multi-agent idea duel. The **Prior Agent Results** section contains:

1. First-round ideas.
2. Cross-scores.
3. Reactions, concessions, defenses, and blind spot ideas.

This is **analysis-only**. Do not edit files, do not stage files, do not commit, and do not open or update PRs.

## Task

Build a ranked synthesis that uses disagreement as signal. Do not simply average scores. Consider:

- High average score with low disagreement: strong consensus.
- High average score with high disagreement: contested but potentially valuable.
- Low scores from every reviewer: likely kill.
- Post-reveal concessions: high-signal evidence that an idea improved or collapsed under scrutiny.
- Blind spot ideas: ideas that emerged from the debate rather than the first round.

Use these categories:

- `CONSENSUS WIN`: all reviewers are strongly positive, generally 700+.
- `STRONG`: average 700+ and no serious unresolved objection.
- `SPLIT`: one model loves it and another has substantial concerns.
- `CONTESTED`: useful disagreement; needs human decision.
- `CONSENSUS KILL`: broadly scored below 400 or rejected after reveal.

## Output

Start with `## Executive Summary`: the 3-5 ideas most worth acting on.

Then write `## Structured Synthesis` as a fenced JSON block:

```json
{
  "consensus_winners": [
    {
      "rank": 1,
      "idea_id_or_title": "CODEX-1",
      "verdict": "CONSENSUS WIN",
      "why": "Why this survived",
      "first_steps": ["Concrete first step", "Concrete second step"],
      "risk": "Main implementation risk"
    }
  ],
  "contested_ideas": [
    {
      "idea_id_or_title": "GEMINI-2",
      "why_contested": "The disagreement signal",
      "decision_needed": "What a human should decide"
    }
  ],
  "killed_ideas": [
    {
      "idea_id_or_title": "CLAUDE-4",
      "reason": "Why it should not proceed"
    }
  ],
  "blind_spot_ideas": [
    {
      "title": "New idea from the debate",
      "why_it_matters": "Why it belongs in the final set"
    }
  ],
  "recommended_next_steps": [
    "Immediate concrete action"
  ]
}
```

After the JSON, include:

1. **Score Matrix:** compact table with each idea, origin, reviewer scores if available, average, disagreement gap, and verdict.
2. **Top Recommendations:** ranked plan with implementation shape.
3. **Rejected Ideas:** ideas that should not consume attention.
4. **Meta-Analysis:** where the agents disagreed and what that says about the project.

Do not create Beads tasks. You may suggest Beads titles for the top winners if the project uses Beads.
