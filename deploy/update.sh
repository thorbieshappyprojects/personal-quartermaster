#!/usr/bin/env bash
# Server-side update: backup, pull, restart, wait for health, print the running
# commit. If the new version does not become healthy, start the previous tag again.
#   ./update.sh <image tag (commit sha)>
# Note: migrations must stay compatible with the previous release (expand first,
# contract in a later release), because a rollback runs the old code on the new schema.
source "$(dirname "$0")/lib.sh"

new="${1:?usage: update.sh <image tag>}"
prev="$(cat .deployed_tag 2>/dev/null || true)"
[ -f .env ] || { echo ".env missing in $PQ_DIR"; exit 1; }
[ "$(stat -c %a .env)" = 600 ] || { echo ".env must have mode 600"; exit 1; }

wait_healthy() {
  local id status
  for _ in $(seq 1 40); do
    id="$(dc ps -q app)"
    status="$( [ -n "$id" ] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)"
    [ "$status" = healthy ] && return 0
    sleep 3
  done
  log "app status: $status"; return 1
}

if [ -n "$(dc ps -q db 2>/dev/null)" ]; then
  log "backup before update"
  ./backup.sh
else
  log "first start: no backup"
fi

log "pulling $new"
APP_TAG="$new" dc pull app
APP_TAG="$new" dc up -d --remove-orphans

if wait_healthy; then
  echo "$new" > .deployed_tag
  log "healthy; running commit: $(dc exec -T app printenv GIT_COMMIT)"
  exit 0
fi

log "new version not healthy; last log lines:"
dc logs --tail 30 app || true
if [ -n "$prev" ]; then
  log "rolling back to $prev"
  APP_TAG="$prev" dc up -d
  wait_healthy && log "rolled back; running commit: $(dc exec -T app printenv GIT_COMMIT)"
else
  log "no previous tag to roll back to"
fi
exit 1
