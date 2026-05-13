---
title: React To Scores
description: React to adversarial scores, concede valid criticism, defend strong ideas, and identify blind spots.
instruction: please react to the cross-scores, revise your judgment, and identify blind spot ideas
---

# React To Cross-Scores

This is the reveal phase of a multi-agent idea duel. The **Prior Agent Results** section contains first-round ideas and cross-scores.

This is **analysis-only**. Do not edit files, do not stage files, do not commit, and do not open or update PRs.

## Task

Review how the other agents scored your ideas and how they scored each other. Your job is to make the disagreement useful.

This step combines the original reveal, rebuttal, steelman, and blind-spot phases into one Agent Runner follow-up.

For your own ideas:

1. Identify criticism you accept.
2. Identify criticism you reject and explain why.
3. Identify any idea where both other agents raised the same concern; treat that as high-signal.
4. Revise your ranking if the cross-scores exposed a real blind spot.
5. Defend only the ideas that still deserve defense after seeing the critiques.
6. Pick your 1-2 most underrated ideas and make the strongest concrete rebuttal for them.

For other agents' ideas:

1. Pick the strongest idea another agent proposed and steelman it: make the best possible case, stronger than the originator did.
2. Pick the weakest idea another agent proposed and explain the hidden cost or failure mode the originator missed.
3. Be intellectually honest: if steelmanning changes your mind, say so.

For the whole set:

1. Identify ideas that are stronger after adversarial scrutiny.
2. Identify ideas that looked good initially but should be killed.
3. Add 3-5 **blind spot ideas** that no first-round agent captured but the debate revealed. These should not be simple variants of existing ideas.

Use ultrathink.

## Output

Write `## Structured Reactions` as a fenced JSON block:

```json
{
  "accepted_criticism": [
    {
      "idea_id": "CODEX-1",
      "point": "Criticism you accept",
      "impact": "How it changes the idea or ranking"
    }
  ],
  "defenses": [
    {
      "idea_id": "CODEX-2",
      "defense": "Why the idea still deserves to survive",
      "what_critics_missed": "Specific context, second-order effect, or implementation detail",
      "revised_confidence": "high|medium|low"
    }
  ],
  "steelman": [
    {
      "idea_id": "GEMINI-1",
      "strongest_case": "The strongest possible argument for another agent's idea",
      "best_implementation_path": "How to build it for maximum value",
      "residual_concern": "Honest concern that remains"
    }
  ],
  "attacks": [
    {
      "idea_id": "CLAUDE-4",
      "hidden_cost": "Why this looks better on paper than in practice",
      "failure_mode": "What could go wrong"
    }
  ],
  "revised_top_ideas": [
    {
      "idea_id": "GEMINI-1",
      "reason": "Why this belongs near the top now"
    }
  ],
  "blind_spot_ideas": [
    {
      "title": "Idea no one proposed directly",
      "why_it_emerged": "What the debate revealed",
      "implementation_shape": "Concrete starting point"
    }
  ]
}
```

After the JSON, add a concise prose section:

1. **Concessions:** strongest points made against your original ideas.
2. **Rebuttals:** original ideas that still deserve serious consideration and why.
3. **Steelman:** another agent's best idea, argued as strongly as possible.
4. **Changed Mind:** what you now believe that you did not believe after the first pass.
5. **Blind Spots:** genuinely new ideas that emerged from the adversarial exchange.
