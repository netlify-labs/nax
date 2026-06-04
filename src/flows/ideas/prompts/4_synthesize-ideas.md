---
title: Synthesize Ideas
description: Synthesize multi-agent idea proposals, scores, and reactions into a ranked plan.
instruction: please synthesize the idea duel into a ranked set of project improvement recommendations
---

# Synthesize The Idea Duel

You are the final synthesis pass for a multi-agent idea duel. The **Prior Agent Results** section contains:

1. First-round ideas.
2. Cross-scores.
3. Reactions, concessions, rebuttals, steelman arguments, attacks, and blind spot ideas.

This is **analysis-only**. Do not edit files, do not stage files, do not commit, and do not open or update PRs.

## Task

Build a ranked synthesis that uses disagreement as signal. Do not simply average scores. Consider:

- High average score with low disagreement: strong consensus.
- High average score with high disagreement: contested but potentially valuable.
- Low scores from every reviewer: likely kill.
- Post-reveal concessions: high-signal evidence that an idea improved or collapsed under scrutiny.
- Rebuttals: if a defense is concrete and technically specific, preserve the idea as contested instead of killing it too quickly.
- Steelman arguments: if an opponent can argue for an idea better than its originator, boost confidence.
- Attacks: if multiple agents identify the same hidden cost, discount the idea.
- Blind spot ideas: ideas that emerged from the debate rather than the first round.

Use these categories:

- `CONSENSUS WIN`: all reviewers are strongly positive, generally 700+.
- `STRONG`: average 700+ and no serious unresolved objection.
- `SPLIT`: one model loves it and another has substantial concerns.
- `CONTESTED`: useful disagreement; needs human decision.
- `CONSENSUS KILL`: broadly scored below 400 or rejected after reveal.

## Synthesis Process

1. Build a score matrix for every idea: origin, self-rank if available, reviewer scores, average, score gap, verdict, and post-reveal adjustment.
2. Interpret score gaps:
   - `<100`: strong agreement
   - `100-250`: mild disagreement
   - `250-400`: significant disagreement
   - `>400`: fundamental disagreement
3. Treat disagreement as information, not friction. Consensus is low-entropy/high-confidence; large gaps are high-entropy/high-information. Do not average disagreements away — preserve them as contested for human judgment.
4. Check for score inflation and deflation. Do not blindly trust a model that gave every idea similar scores.
5. **Detect shared blind spots.** When every agent scored an idea highly *and then* every agent downgraded it in the reactions phase, that pattern is the signature of a bias every model shares. Flag those ideas as `shared_blind_spot_risk: yes` and treat them with extra scrutiny.
6. Identify independent convergence where multiple agents proposed essentially the same improvement. Independent convergence by decorrelated evaluators is one of the strongest positive signals available.
7. Integrate blind spot ideas, but mark them as not cross-scored unless reactions contain clear support.
8. Account for known model tendencies without overfitting:
   - Claude may under-rate bold ideas out of caution.
   - Codex may over-rate implementation-heavy ideas.
   - Gemini may over-emphasize breadth.
9. Prefer ideas that are useful, pragmatic, and accretive over ideas that are only clever.
10. **Verify code claims before recommending action.** For every consensus winner that names specific files, functions, or behaviors in this repository, flag it for verification. Models sometimes confidently agree on an idea whose factual grounding has not been checked. Add `requires_verification` for those entries.
11. **Devil's Advocate pass on every consensus winner.** Even ideas every reviewer scored highly can share hidden flaws. For each consensus winner, articulate the single strongest objection — the real killer argument — and the most likely failure mode after implementation. If no serious objection survives, say so and explain why you are confident rather than rubber-stamping.
12. Do not create task tracker items. If the project appears to use a task tracker, you may suggest optional task titles, but the recommendations must stand without that tooling.

### Orchestrator Discipline

You are the synthesizer, not another scorer. Report the agents' scores and arguments faithfully. Do not editorialize inside the score matrix or the consensus/contested/killed sections — those should reflect what the agents actually argued. Reserve your own assessment for the Meta-Analysis and Devil's Advocate sections, where it belongs.

Use ultrathink.

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
      "average_score": 850,
      "score_gap": 90,
      "why": "Why this survived",
      "first_steps": ["Concrete first step", "Concrete second step"],
      "risk": "Main implementation risk",
      "requires_verification": "Code claims that should be confirmed before action, or null",
      "shared_blind_spot_risk": "yes|no",
      "devils_advocate": "Strongest possible objection and most likely failure mode after implementation"
    }
  ],
  "contested_ideas": [
    {
      "idea_id_or_title": "GEMINI-2",
      "why_contested": "The disagreement signal",
      "strongest_case_for": "Best argument in favor",
      "strongest_case_against": "Best argument against",
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
  ],
  "optional_task_titles": [
    "Task title only if the project uses a task tracker"
  ]
}
```

After the JSON, include:

1. **Methodology:** agents, phases, and how many ideas were considered.
2. **Score Matrix:** compact table with each idea, origin, reviewer scores if available, average, disagreement gap, and verdict.
3. **Consensus Winners:** ranked winners with average scores and first steps.
4. **Contested Ideas:** strongest argument on each side; leave these for human judgment.
5. **Killed Ideas:** ideas that should not consume attention.
6. **Blind Spot Ideas:** genuinely new ideas that emerged from the adversarial process.
7. **Meta-Analysis:** where the agents disagreed, what model biases showed up, and what that says about the project.
8. **Recommended Next Steps:** top 3-5 actions with implementation notes.
9. **Devil's Advocate:** strongest objection to each consensus winner and the most likely failure mode after implementation.
10. **Verification Checklist:** consensus winners whose factual grounding (file paths, function names, performance claims) should be confirmed against the current repository state before acting.

Do not create task tracker items. Optional task titles are fine only when the project already appears to use a task tracker.
