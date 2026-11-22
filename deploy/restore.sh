#!/usr/bin/env bash
# Restores a backup into a NEW database (and optionally a new media volume) and
# prints row counts. Never overwrites the running database or volume.
#   ./restore.sh /var/backups/personal-quartermaster/daily/<stamp> [--media]
# Switching the app over to the restored copy is a separate, manual decision.
source "$(dirname "$0")/lib.sh"

src="${1:?usage: restore.sh <backup dir> [--media]}"
with_media="${2:-}"
[ -f "$src/db.dump" ] || { echo "no db.dump in $src"; exit 1; }
(cd "$src" && sha256sum -c --quiet SHA256SUMS) || { echo "checksum mismatch in $src"; exit 1; }

stamp="$(date +%Y%m%d%H%M%S)"
newdb="pq_restore_$stamp"
psql() { dc exec -T db psql -U pq -d "${PGDB:-pq}" -v ON_ERROR_STOP=1 -qAt "$@"; }

if [ "$(psql -c "SELECT 1 FROM pg_database WHERE datname = '$newdb'")" = 1 ]; then echo "$newdb exists"; exit 1; fi
log "restoring $src into new database $newdb"
psql -c "CREATE DATABASE $newdb"
dc exec -T db pg_restore -U pq -d "$newdb" --no-owner --exit-on-error < "$src/db.dump"

echo "row counts in $newdb:"
PGDB="$newdb" psql -F $'\t' -c "
  SELECT relname, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint
    FROM pg_stat_user_tables ORDER BY relname" | sed 's/^/  /' 

if [ "$with_media" = --media ]; then
  vol="pq_media_restore_$stamp"
  log "restoring media into new volume $vol"
  # Mounting the empty volume at /data/media makes Docker copy the image's ownership (node) onto it.
  dc run --rm --no-deps -T -v "$vol:/data/media" --entrypoint tar jobs -C /data -xzf - < "$src/media.tar.gz"
  echo "media files: $(dc run --rm --no-deps -T -v "$vol:/data/media" --entrypoint find jobs /data/media -type f | wc -l)"
fi

echo "done. Drop the copy when finished: docker compose exec db dropdb -U pq $newdb"
