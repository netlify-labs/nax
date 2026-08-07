# Multi-instance agent configuration fixtures

Golden fixtures for the Arena program (bead `nax-2rx6`). Each `*.flow.yml` is a minimal
one-step workflow whose `agents` lineup exercises a use case; `goldens.json` records the
**expected resolved instance list**, transport, and warnings per spec v4
(`docs/plans/multi-instance-agent-configuration.md`).

Resolution rules encoded here (spec v4):

- Instance id = `agent:model:effort` using resolved catalog ids; `auto` for an omitted
  dimension; effort as the catalog id (`max`), NOT the wire value (`xhigh`).
- **Bare provider = Auto on the wire** (no model/effort). Councils keep today's behavior.
- `latest`/`default` model → the provider's configured `defaultModel`
  (claude→claude-fable-5, gemini→gemini-3.1-pro-preview, codex→gpt-5.6-sol,
  opencode→moonshotai/kimi-k3), with `resolvedFrom: "latest"`.
- Fan-out: `models: [...]` × `efforts: [...]` = cartesian; deduped by tuple id.
- **Effort clamps to the nearest supported** effort by rank (low<medium<high<max), rounding
  up, with a warning; a fan-out that collapses to one instance after clamping dedupes.
- **Exact-tuple duplicates are an error** (no label bypass).
- Transport: any pinned model/effort or >1 instance per provider → `netlify-api`;
  a pure-open lineup may use `github` (`transport: auto`).

These goldens drive Phase 1 resolver/pipeline tests (`nax-2rx6.2.8`).
