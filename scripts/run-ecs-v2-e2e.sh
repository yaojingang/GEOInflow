#!/usr/bin/env bash
set -euo pipefail

# Runs Phase 2 end-to-end verification + full Next.js production build on the configured test ECS.
# Strictly isolated: creates temporary PG & CH databases, drops them and restores containers on exit.

REMOTE_HOST="${V2_ECS_HOST:?Set V2_ECS_HOST to the isolated test SSH destination}"
WORKTREE="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="v2e2e_$(date +%Y%m%dT%H%M%S)"
REMOTE_DIR="$RUN_ID"

echo "[local] Packaging clean v2 worktree..."
TMP_TAR="$(mktemp /tmp/warehouse-v2-e2e-XXXXXX)"
trap 'rm -f "$TMP_TAR"' EXIT

git -C "$WORKTREE" archive --format=tar.gz -o "$TMP_TAR" HEAD

echo "[local] Uploading to ${REMOTE_HOST}:${REMOTE_DIR}..."
ssh -o BatchMode=yes "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"
scp -q -o BatchMode=yes "$TMP_TAR" "${REMOTE_HOST}:${REMOTE_DIR}/worktree.tar.gz"

echo "[local] Running vitest + tsc + real PG/CH Phase 2 E2E + Next.js build on test ECS..."
ssh -o BatchMode=yes -o ServerAliveInterval=15 "$REMOTE_HOST" bash -s -- "$REMOTE_DIR" "$RUN_ID" <<'REMOTE_SCRIPT'
set -euo pipefail
REMOTE_DIR="$HOME/$1"
DB_NAME="$2"
cd "$REMOTE_DIR"

DONOR_APP="${V2_ECS_DONOR_APP:-$HOME/geoinflow}"
test -d "$DONOR_APP/node_modules" && test -d "$DONOR_APP/src/generated" || {
  echo "Install dependencies and generate the Prisma client in the remote donor checkout" >&2
  exit 1
}
echo "[ecs] Extracting clean v2 worktree (reusing node_modules + prisma client from $DONOR_APP)..."
mkdir app
tar --warning=no-unknown-keyword -xzf worktree.tar.gz -C app/
ln -s "$DONOR_APP/node_modules" app/node_modules
ln -s "$DONOR_APP/src/generated" app/src/generated
if [ -d "$DONOR_APP/packages/api-client/node_modules" ]; then
  ln -s "$DONOR_APP/packages/api-client/node_modules" app/packages/api-client/node_modules
fi
if [ -d "$DONOR_APP/packages/mcp/node_modules" ]; then
  ln -s "$DONOR_APP/packages/mcp/node_modules" app/packages/mcp/node_modules
fi
if [ -d "$DONOR_APP/public/geo" ]; then
  mkdir -p app/public
  cp -a "$DONOR_APP/public/geo" app/public/geo 2>/dev/null || true
fi

cd app
echo "[ecs] Node version: $(node -v)"

PG_USER=""
CH_USER=""
CH_PASS=""

cleanup() {
  echo "[ecs] Cleaning up temporary databases and restoring containers..."
  if [ -n "$PG_USER" ]; then
    sudo -n docker exec geoinflow-ecs-memory-pg-1 psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE);" >/dev/null 2>&1 || true
  fi
  if [ -n "$CH_USER" ]; then
    sudo -n docker exec geoinflow-ecs-memory-ch-1 clickhouse-client --user "$CH_USER" --password "$CH_PASS" -q "DROP DATABASE IF EXISTS \`$DB_NAME\` SYNC" >/dev/null 2>&1 || true
  fi
  sudo -n docker stop geoinflow-ecs-memory-pg-1 geoinflow-ecs-memory-ch-1 >/dev/null 2>&1 || true
  rm -rf "$REMOTE_DIR"
  echo "[ecs] Cleanup complete."
}
trap cleanup EXIT

# 1. Unit tests
echo "[ecs] 1/4 Running vitest unit tests..."
./node_modules/.bin/vitest run src/lib/liekan/warehouse-v2/warehouse-v2.test.ts

# 2. TypeScript check on clean v2 branch
echo "[ecs] 2/4 Running tsc --noEmit..."
NODE_OPTIONS=--max-old-space-size=5120 ./node_modules/.bin/tsc --noEmit

# 3. Start isolated PG & CH and run Phase 2 real DB E2E
echo "[ecs] 3/4 Running real PG + ClickHouse 26.8 Phase 2 E2E..."
sudo -n docker start geoinflow-ecs-memory-pg-1 geoinflow-ecs-memory-ch-1 >/dev/null
for i in $(seq 1 40); do
  if sudo -n docker exec geoinflow-ecs-memory-pg-1 pg_isready >/dev/null 2>&1 && \
     sudo -n docker exec geoinflow-ecs-memory-ch-1 clickhouse-client -q 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

PG_IP="$(sudo -n docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' geoinflow-ecs-memory-pg-1)"
CH_IP="$(sudo -n docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' geoinflow-ecs-memory-ch-1)"
PG_USER="$(sudo -n docker exec geoinflow-ecs-memory-pg-1 sh -c 'printf %s "${POSTGRES_USER:-postgres}"')"
PG_PASS="$(sudo -n docker exec geoinflow-ecs-memory-pg-1 sh -c 'printf %s "${POSTGRES_PASSWORD:-}"')"
CH_USER="$(sudo -n docker exec geoinflow-ecs-memory-ch-1 sh -c 'printf %s "${CLICKHOUSE_USER:-default}"')"
CH_PASS="$(sudo -n docker exec geoinflow-ecs-memory-ch-1 sh -c 'printf %s "${CLICKHOUSE_PASSWORD:-}"')"

sudo -n docker exec geoinflow-ecs-memory-pg-1 psql -U "$PG_USER" -d postgres -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null
sudo -n docker exec geoinflow-ecs-memory-ch-1 clickhouse-client --user "$CH_USER" --password "$CH_PASS" -q "CREATE DATABASE \`$DB_NAME\`" >/dev/null

DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@${PG_IP}:5432/${DB_NAME}" \
LIEKAN_CLICKHOUSE_URL="http://${CH_IP}:8123" \
LIEKAN_CLICKHOUSE_USERNAME="$CH_USER" \
LIEKAN_CLICKHOUSE_PASSWORD="$CH_PASS" \
LIEKAN_CLICKHOUSE_DATABASE="$DB_NAME" \
LIEKAN_ANALYTICS_BACKEND=clickhouse \
LIEKAN_WAREHOUSE_V2=1 \
  ./node_modules/.bin/tsx scripts/liekan-warehouse-v2-e2e.mts

# 4. Production Next.js build verification
echo "[ecs] 4/4 Running Next.js production build..."
DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" \
APP_SECRET="build-placeholder" \
NODE_OPTIONS=--max-old-space-size=5120 \
NEXT_TELEMETRY_DISABLED=1 \
  ./node_modules/.bin/next build --webpack
test -s .next/standalone/server.js && echo "[ecs] Next.js production standalone build succeeded!"
REMOTE_SCRIPT
