# Operations

How the owner sets up, deploys, backs up and restores the stack. Real hostnames, addresses and secrets never go into this repository.

## Layout on the server

```
/opt/personal-quartermaster/
  .env                     secrets, mode 600, written by the owner only
  compose.yml lib.sh update.sh backup.sh restore.sh env.production.example   (copied by scripts/deploy.sh)
  .deployed_tag            image tag currently running (written by update.sh)
/var/backups/personal-quartermaster/{daily,weekly}/
```

Compose project name: `personal-quartermaster`. Everything else on the server (including the unrelated `/opt/quartermaster` stack) is out of bounds.

## One-time setup

1. **Server directories** (as a user allowed to create them; then hand over to `deploy`):
   ```sh
   sudo install -d -o deploy -g deploy -m 750 /opt/personal-quartermaster
   sudo install -d -o deploy -g deploy -m 700 /var/backups/personal-quartermaster
   ```
2. **Cloudflare** (dashboard, see SPEC §7.3): create the tunnel `personal-quartermaster` and copy only its token; add the route `<subdomain>.<your-domain>` → `http://app:3000`; create the self-hosted Access application (24 h session, one-time PIN, allow the household e-mails); create one service token per device and a *Service Auth* policy for them; note the team domain and the application audience tag.
3. **Secrets**: on the server, as `deploy`:
   ```sh
   cd /opt/personal-quartermaster
   umask 077
   cp env.production.example .env   # after the first deploy copied it, or paste the template
   ${EDITOR:-nano} .env              # fill in values here, never in a chat or shell history
   chmod 600 .env
   ```
4. **Image access**: the image is published to GHCR. Either make the package public (it contains no secrets or data) or `docker login ghcr.io` on the server with a read-only token.
5. **Local deploy config**: `cp deploy.env.example deploy.env` and fill in host and URL. `deploy.env` is gitignored.
6. **First deploy**: `scripts/deploy.sh --dry-run`, then `scripts/deploy.sh`.
7. **Household and first owner** (on the server):
   ```sh
   docker compose run --rm jobs pq init --household "<name>" --email <owner e-mail> --name "<display name>"
   ```
   Until this runs, every request answers 403, including `/healthz` from outside.
8. **API token for a device** (printed once; put it into the device's Shortcuts together with its service token):
   ```sh
   docker compose run --rm jobs pq token create --email <member e-mail> --label "<device>"
   ```
9. **Verify**: `scripts/deploy_verify.sh` (asks for a service token and an API token without echo).
10. **Backups**: add the cron entry from the header of `backup.sh` to the `deploy` user's crontab, run `./backup.sh` once by hand and **test a restore** (below).

## Deploy

`scripts/deploy.sh` checks that the tree is clean, on `main`, pushed, and that the image for the commit exists; then it copies `deploy/` files and runs `update.sh <tag>` on the server: backup → pull → restart → wait for health → print the running commit, or roll back to the previous tag. It uses a single SSH connection with `BatchMode` and never retries (fail2ban).

Migrations run when the app starts. Because a rollback runs the previous code on the new schema, migrations must stay compatible with the previous release.

## Exchange rates

Purchases in other currencies are converted to EUR with the ECB reference rate of the
order day. The app downloads the ECB history (all days since 1999, about 600 kB) after an
import that contains a foreign currency, or on "Fetch ECB rates" on the spending page.
By hand: `docker compose run --rm jobs pq fx update`. `FX_SOURCE=off` in `.env` disables
the download (the app then needs no outbound access for this). Rates are not household
data and are not in the export.

## Backup and restore

- `backup.sh`: `pg_dump --format=custom` plus a tarball of the media volume, 7 daily and 4 weekly copies, SHA-256 sums. With `BACKUP_REMOTE` and `BACKUP_AGE_RECIPIENT` set (and `age` and `rclone` installed), an encrypted copy goes off the server; an unencrypted remote copy is refused.
- `restore.sh <backup dir> [--media]`: restores into a **new** database `pq_restore_<stamp>` (and a new volume with `--media`), prints row counts and leaves the running database alone. Switching over is a separate, manual step.

## Local trial of the production stack

```sh
docker compose -f deploy/compose.yml -f deploy/compose.local.yml --env-file deploy/local.env up -d --build
docker compose -f deploy/compose.yml -f deploy/compose.local.yml --env-file deploy/local.env run --rm jobs pq init --household Test --email owner@example.test --name Owner
docker stats --no-stream
# server scripts against the local stack:
PQ_COMPOSE_ARGS="-f compose.yml -f compose.local.yml --env-file local.env" BACKUP_ROOT=/tmp/pq-backups deploy/backup.sh
```

The local stack has no tunnel, so HTTP requests answer 401; the container health check runs in-process.
