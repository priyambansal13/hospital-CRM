#!/usr/bin/env bash
# One-command local setup for MediCare. Expects ../backend and ../frontend next to this repo.
set -euo pipefail
cd "$(dirname "$0")"
for t in node pnpm docker; do command -v "$t" >/dev/null || { echo "missing $t"; exit 1; }; done
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "Node >= 22 required"; exit 1; }
node scripts/mc.mjs setup
