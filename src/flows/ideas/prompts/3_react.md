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

1. Identify criticism you accept. These concessions are the highest-signal output of this entire process — a model acknowledging its own blind spot is rare and valuable. When applicable, frame your reaction as one of these patterns:
   - **Graceful Concession:** "they made a fair point, I revise downward"
   - **Strategic Retreat:** "the core idea has merit; the implementation path I proposed does not"
   - **Genuine Surprise:** "I had not considered the interaction with X — that changes my analysis"
2. Identify criticism you reject. Use **Counter-Escalation** when the criticism actually strengthens your case ("the complexity they identified is the complexity this feature manages for the user"). Avoid **Defensive Deflection** ("they misunderstood me") unless the misreading is genuine — if you cannot defend on substance, the score stands.
3. Identify any idea where multiple other agents raised the same concern. Treat that as overdetermined evidence and update accordingly.
4. Revise your ranking if the cross-scores exposed a real blind spot.
5. Pick the **two ideas of yours that another agent scored lowest but that you still believe in** — these are the hills you are going to die on. Write a forceful, technically specific rebuttal for each. Cite specific files, functions, or code paths in this repository. Vague conviction is worthless; concrete mechanism is everything.

For other agents' ideas:

1. **Steelman another agent's strongest idea.** This is counterintuitive but load-bearing. You are not being asked whether you agree — you are being asked to demonstrate that you understand the idea deeply enough to advocate for it better than its creator did. Your steelman must include all five components:
   - **Why this idea is actually brilliant:** the non-obvious insight it captures
   - **The strongest implementation path:** how to build it for maximum impact, more specific than the originator proposed
   - **The second-order benefits:** positive knock-on effects the originator did not articulate
   - **Pre-emptive defense:** the two most likely objections, and why each is wrong or manageable
   - **Honest residual concerns:** any weaknesses that remain after steelmanning that you genuinely could not argue away
2. **Attack another agent's weakest idea.** Identify the hidden cost, failure mode, or second-order risk the originator missed. Be specific — name the mechanism, not the feeling.
3. **Be intellectually honest.** If steelmanning changes your mind about an idea, say so explicitly. That is the most valuable signal this phase produces.

For the whole set:

1. Identify ideas that are stronger after adversarial scrutiny.
2. Identify ideas that looked good initially but should be killed.
3. Add 3-5 **blind spot ideas** that no first-round agent captured but the debate revealed. The adversarial pressure has expanded your understanding beyond the original framing. Work through three explicit angles to find them:
   - **Gap analysis:** look at every agent's idea list side by side. What category of improvement is completely absent from every list? What user need or technical concern did everyone overlook?
   - **Synthesis insight:** is there an idea that only becomes visible when something from one agent's list combines with something from another's? An idea that no list contains but the intersection points toward?
   - **Contrarian take:** what did every agent implicitly assume was fine or out of scope that actually deserves to be questioned?
   These must be genuinely new framings, not variants of previously proposed ideas. For each, explain why no agent thought of it originally and why it matters now.

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
      "code_evidence": "Specific file:line references that ground the defense",
      "what_critics_missed": "Specific context, second-order effect, or implementation detail",
      "revised_confidence": "high|medium|low"
    }
  ],
  "steelman": [
    {
      "idea_id": "GEMINI-1",
      "why_brilliant": "The non-obvious insight the idea captures",
      "best_implementation_path": "How to build it for maximum value, more specific than the originator proposed",
      "second_order_benefits": "Positive knock-on effects the originator did not articulate",
      "preemptive_defense": "Two most likely objections and why each is wrong or manageable",
      "residual_concern": "Honest weakness that remains after steelmanning"
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
