---
title: Synthesize Security Findings
description: Merge independent audits into one prioritized security report.
instruction: synthesize the security audit results into one ranked vulnerability report
---

# Synthesize Security Findings

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

Read all prior audit results. Your job is not to average them; it is to produce the strongest defensible security report.

## Synthesis Method

1. Extract every structured and prose finding from each agent.
2. Merge duplicates by root cause, not by symptom.
3. Re-check each merged finding against the source file/line if possible.
4. Promote findings independently confirmed by multiple agents.
5. Demote or reject findings that are generic, missing `file:line`, contradicted by code, or only describe hardening without a credible attack.
6. Preserve disagreement. A single high-confidence exploit beats three vague checklist items.
7. Look for attack chains by composing low/medium findings across auth, tenant, billing, logging, and recovery paths.
8. Calibrate severity by actual impact:
   - Critical: direct data breach, tenant break, auth bypass, billing bypass, subscription hijack, RCE, or unsafe fail-open in a security gate.
   - High: practical privilege escalation, webhook forgery, serious SSRF/XSS/CSRF, TOCTOU, mass assignment, or broad but constrained exposure.
   - Medium: real but limited security weakness, stale entitlement risk, missing defense-in-depth on sensitive paths, or bounded abuse/DoS.
   - Low: hardening or narrow information exposure.

## Output

Produce:

1. `## Consensus Summary`
   - total confirmed/likely/needs-runtime-validation findings by severity
   - top risk
   - ship recommendation: `ship`, `ship after high fixes`, or `do not ship`

2. `## Methodology Coverage`
   - threat model coverage
   - domains covered and skipped
   - highest-risk blind spots

3. `## Structured Consensus` as fenced JSON:

```json
[
  {
    "id": "SEC-CONSENSUS-1",
    "severity": "critical",
    "status": "confirmed",
    "domain": "billing",
    "title": "Short title",
    "file": "path/to/file.ts",
    "line": 123,
    "agents": ["claude", "codex"],
    "kernel_axiom": "Axiom 9 - server-side authority",
    "attack_vector": "How an attacker exploits it",
    "impact": "Revenue loss / data exposure / privilege escalation / DoS",
    "evidence": "Concrete code-grounded evidence",
    "recommended_fix": "Specific fix",
    "verification": "How to prove the fix",
    "regression_test": "Specific test to add",
    "confidence": "high"
  }
]
```

4. `## Ranked Findings`
   - include every consensus finding ordered by severity, exploitability, and confidence

5. `## Attack Chains`
   - list any composed exploit chains or state that none were defensible

6. `## Disputed Or Rejected Findings`
   - include why each was rejected or what evidence is missing

7. `## Remediation Roadmap`
   - immediate, this week, this sprint, backlog

8. `## Regression Prevention`
   - tests, static checks, lint rules, monitoring, or audit logs needed for critical/high findings

Every accepted finding must include severity, status, domain, `file:line`, attack vector, impact, evidence, recommended fix, verification, regression test, confidence, and source agents.
