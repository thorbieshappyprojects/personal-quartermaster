# Shared helpers for the server-side scripts. Sourced, not executed.
# shellcheck shell=bash
set -euo pipefail
umask 077

PQ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PQ_DIR"

# The deployed tag is recorded by update.sh so every compose call (backups,
# one-off jobs, manual restarts) uses the running version and never pulls :latest.
current_tag() { cat "$PQ_DIR/.deployed_tag" 2>/dev/null || echo latest; }

# PQ_COMPOSE_ARGS lets the scripts run against the local trial stack (see docs/operations.md).
read -r -a _compose_args <<< "${PQ_COMPOSE_ARGS:--f compose.yml}"
dc() { APP_TAG="${APP_TAG:-$(current_tag)}" docker compose --project-directory "$PQ_DIR" "${_compose_args[@]}" "$@"; }

# Reads one variable from .env without sourcing it (values may contain shell metacharacters).
env_value() { [ -f "$PQ_DIR/.env" ] && sed -n "s/^$1=//p" "$PQ_DIR/.env" | tail -n 1 || true; }

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
