#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec node "$ROOT/src/cli/nax.js" preview-spinner \
  --label "Audit Security" \
  --agents claude,gemini,codex \
  --count 3 \
  --tick-ms 12000 \
  --flavor-min-ms 2500 \
  --flavor-max-ms 4500
