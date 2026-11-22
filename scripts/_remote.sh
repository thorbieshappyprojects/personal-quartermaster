# Shared SSH helpers for deploy.sh and deploy_verify.sh. Sourced, not executed.
# One multiplexed SSH connection per run, BatchMode only, never retried:
# fail2ban on the server bans an address after five failed logins.
# shellcheck shell=bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${DEPLOY_ENV:-$ROOT/deploy.env}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy deploy.env.example)"; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${DEPLOY_HOST:?DEPLOY_HOST missing in deploy.env}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/personal-quartermaster}"
case "$DEPLOY_PATH" in
  /opt/personal-quartermaster) ;;
  *) echo "refusing DEPLOY_PATH=$DEPLOY_PATH (this project lives only in /opt/personal-quartermaster)"; exit 1 ;;
esac

SSH_CTL="$(mktemp -u "${TMPDIR:-/tmp}/pq-ssh.XXXXXX")"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=auto -o "ControlPath=$SSH_CTL" -o ControlPersist=60)
[ -n "${DEPLOY_SSH_KEY:-}" ] && SSH_OPTS+=(-i "$DEPLOY_SSH_KEY" -o IdentitiesOnly=yes)
REMOTE="$DEPLOY_USER@$DEPLOY_HOST"

ssh_open() {
  if ! ssh "${SSH_OPTS[@]}" -fN "$REMOTE"; then
    echo "SSH login failed. Not retrying (fail2ban). Check key and deploy.env, then run again once."
    exit 1
  fi
  trap 'ssh "${SSH_OPTS[@]}" -O exit "$REMOTE" 2>/dev/null || true' EXIT
}
remote() { ssh "${SSH_OPTS[@]}" "$REMOTE" "$@"; }
