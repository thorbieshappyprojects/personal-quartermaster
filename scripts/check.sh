#!/usr/bin/env bash
# Local gate before each commit: stops at the first failure.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm typecheck
pnpm lint
pnpm test
pnpm build
