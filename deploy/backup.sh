#!/usr/bin/env bash
# Nightly backup: database (pg_dump custom format) and media volume.
# Keeps 7 daily and 4 weekly copies in /var/backups/personal-quartermaster.
# Optional off-server copy, encrypted with age, via rclone.
# Cron (as deploy): 15 3 * * * /opt/personal-quartermaster/backup.sh >> /var/backups/personal-quartermaster/backup.log 2>&1
source "$(dirname "$0")/lib.sh"

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/personal-quartermaster}"
KEEP_DAILY=7
KEEP_WEEKLY=4

stamp="$(date +%Y%m%d-%H%M%S)"
target="$BACKUP_ROOT/daily/$stamp"
mkdir -p "$target" "$BACKUP_ROOT/weekly"
trap 'rm -rf "$target.partial"' ERR
mkdir -p "$target.partial"

log "backup $stamp: database"
dc exec -T db pg_dump -U pq -d pq --format=custom --compress=6 > "$target.partial/db.dump"

log "backup $stamp: media"
dc run --rm --no-deps -T --entrypoint tar jobs -C /data -cf - media | gzip -6 > "$target.partial/media.tar.gz"

printf '%s\n' "$(current_tag)" > "$target.partial/app_tag"
(cd "$target.partial" && sha256sum db.dump media.tar.gz > SHA256SUMS)
rmdir "$target" && mv "$target.partial" "$target"
trap - ERR

# Sunday: keep a weekly copy (hard links, no extra space).
if [ "$(date +%u)" = 7 ]; then cp -al "$target" "$BACKUP_ROOT/weekly/$stamp"; fi

prune() { ls -1d "$1"/*/ 2>/dev/null | sort -r | tail -n "+$(($2 + 1))" | xargs -r rm -rf; }
prune "$BACKUP_ROOT/daily" "$KEEP_DAILY"
prune "$BACKUP_ROOT/weekly" "$KEEP_WEEKLY"

recipient="$(env_value BACKUP_AGE_RECIPIENT)"
remote="$(env_value BACKUP_REMOTE)"
if [ -n "$remote" ]; then
  if [ -z "$recipient" ]; then log "BACKUP_REMOTE set without BACKUP_AGE_RECIPIENT: refusing an unencrypted off-server copy"; exit 1; fi
  command -v age >/dev/null && command -v rclone >/dev/null || { log "off-server copy needs age and rclone"; exit 1; }
  log "backup $stamp: encrypted off-server copy"
  tar -C "$BACKUP_ROOT/daily" -cf - "$stamp" | age -r "$recipient" | rclone rcat "$remote/pq-$stamp.tar.age"
fi

log "backup $stamp done: $(du -sh "$target" | cut -f1)"
