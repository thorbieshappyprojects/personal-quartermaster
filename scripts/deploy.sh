#!/usr/bin/env bash
# Deploys the image of the current commit to the server.
#   scripts/deploy.sh [--dry-run]
# Checks locally, copies deploy/ files into /opt/personal-quartermaster and runs
# update.sh there. Touches nothing outside that directory.
source "$(dirname "$0")/_remote.sh"

dry=false
[ "${1:-}" = --dry-run ] && dry=true
IMAGE=ghcr.io/thorbieshappyprojects/personal-quartermaster
FILES=(compose.yml lib.sh update.sh backup.sh restore.sh env.production.example)

cd "$ROOT" || exit 1
problems=0
check() { if ! eval "$1"; then echo "check failed: $2"; problems=1; fi; }
check '[ -z "$(git status --porcelain)" ]' "working tree not clean"
check '[ "$(git rev-parse --abbrev-ref HEAD)" = main ]' "deploy from main only"
git fetch -q origin main 2>/dev/null || true
check '[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main 2>/dev/null)" ]' "HEAD is not origin/main; push first"
sha="$(git rev-parse HEAD)"
tag="${sha:0:12}"
check 'docker buildx imagetools inspect "$IMAGE:$tag" >/dev/null 2>&1' "image $IMAGE:$tag not found; wait for the image workflow"
if [ "$problems" = 1 ] && ! $dry; then exit 1; fi
echo "deploying $IMAGE:$tag to $REMOTE:$DEPLOY_PATH"

plan=(
  "test -d $DEPLOY_PATH && test -f $DEPLOY_PATH/.env && test \"\$(stat -c %a $DEPLOY_PATH/.env)\" = 600"
  "scp ${FILES[*]/#/deploy/} $REMOTE:$DEPLOY_PATH/"
  "chmod 750 $DEPLOY_PATH/*.sh"
  "cd $DEPLOY_PATH && ./update.sh $tag"
)
if $dry; then
  printf 'would run:\n'; printf '  %s\n' "${plan[@]}"; exit 0
fi

ssh_open
remote "${plan[0]}" || { echo "server not prepared: $DEPLOY_PATH/.env missing or not mode 600 (see docs/operations.md)"; exit 1; }
scp "${SSH_OPTS[@]}" -q "${FILES[@]/#/deploy/}" "$REMOTE:$DEPLOY_PATH/"
remote "${plan[2]}"
remote "${plan[3]}"
