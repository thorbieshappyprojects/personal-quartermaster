#!/usr/bin/env bash
# Verifies a deployment:
#   1. without login the hostname answers 302 to the Access login
#   2. with a service token and an API token /healthz answers 200 {"ok":true}
#   3. no published ports for this Compose project
#   4. .env on the server has mode 600
# Credentials are read from the environment (PQ_CF_CLIENT_ID, PQ_CF_CLIENT_SECRET,
# PQ_API_TOKEN) or prompted for without echo. They never appear on a command line.
source "$(dirname "$0")/_remote.sh"
: "${APP_URL:?APP_URL missing in deploy.env}"

fail=0
ok() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fail=1; }

echo "1. access gate"
read -r code location < <(curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$APP_URL/")
if [ "$code" = 302 ] && [[ "$location" == https://*.cloudflareaccess.com/* ]]; then ok "302 to Access login"; else bad "expected 302 to *.cloudflareaccess.com, got $code"; fi

echo "2. service token + API token"
[ -n "${PQ_CF_CLIENT_ID:-}" ] || { read -r -s -p "  CF-Access-Client-Id: " PQ_CF_CLIENT_ID; echo; }
[ -n "${PQ_CF_CLIENT_SECRET:-}" ] || { read -r -s -p "  CF-Access-Client-Secret: " PQ_CF_CLIENT_SECRET; echo; }
[ -n "${PQ_API_TOKEN:-}" ] || { read -r -s -p "  API token: " PQ_API_TOKEN; echo; }
hdr="$(mktemp)"; trap 'rm -f "$hdr"' RETURN EXIT
chmod 600 "$hdr"
printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\nAuthorization: Bearer %s\n' \
  "$PQ_CF_CLIENT_ID" "$PQ_CF_CLIENT_SECRET" "$PQ_API_TOKEN" > "$hdr"
body="$(curl -s -H @"$hdr" -w '\n%{http_code}' "$APP_URL/healthz")"
rm -f "$hdr"
if [ "$(tail -n1 <<< "$body")" = 200 ] && [ "$(head -n1 <<< "$body")" = '{"ok":true}' ]; then ok "/healthz 200"; else bad "/healthz answered $(tail -n1 <<< "$body")"; fi

ssh_open
echo "3. published ports"
published="$(remote "cd $DEPLOY_PATH && docker compose ps --format '{{.Name}} {{.Publishers}}'" | grep -E 'PublishedPort:[1-9]' || true)"
[ -z "$published" ] && ok "no published ports" || bad "published ports: $published"

echo "4. .env mode"
mode="$(remote "stat -c %a $DEPLOY_PATH/.env")"
[ "$mode" = 600 ] && ok ".env is 600" || bad ".env mode is $mode"

[ "$fail" = 0 ] && echo "deploy_verify: passed" || { echo "deploy_verify: FAILED"; exit 1; }
