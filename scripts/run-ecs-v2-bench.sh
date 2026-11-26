#!/usr/bin/env bash
set -euo pipefail

# Runs Phase 1 Warehouse v2 unit tests + 100x isolated benchmark on the configured test ECS.
# Strictly isolated: creates temporary PG & CH databases (liekan_v2_bench), drops them on exit,
# and restores geoinflow-ecs-memory-{pg,ch}-1 to their prior stopped state.

REMOTE_HOST="${V2_ECS_HOST:?Set V2_ECS_HOST to the isolated test SSH destination}"
WORKTREE="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="v2bench_$(date +%Y%m%dT%H%M%S)"
REMOTE_DIR="$RUN_ID"

echo "[local] Packaging v2 source files..."
TMP_TAR="$(mktemp /tmp/warehouse-v2-XXXXXX)"
trap 'rm -f "$TMP_TAR"' EXIT

tar -czf "$TMP_TAR" -C "$WORKTREE" \
  src/lib/liekan/warehouse-v2 \
  scripts/liekan-warehouse-v2-bench.mts \
  package.json \
  tsconfig.json

echo "[local] Uploading to ${REMOTE_HOST}:${REMOTE_DIR}..."
ssh -o BatchMode=yes "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"
scp -q -o BatchMode=yes "$TMP_TAR" "${REMOTE_HOST}:${REMOTE_DIR}/src.tar.gz"

echo "[local] Executing isolated unit tests + 100x benchmark on test ECS..."
ssh -o BatchMode=yes "$REMOTE_HOST" bash -s -- "$REMOTE_DIR" "$RUN_ID" <<'REMOTE_SCRIPT'
set -euo pipefail
REMOTE_DIR="$HOME/$1"
DB_NAME="$2"
cd "$REMOTE_DIR"
tar -xzf src.tar.gz

# Set V2_ECS_DONOR_APP in the remote environment to use another installed checkout.
DONOR="${V2_ECS_DONOR_APP:-$HOME/geoinflow}/node_modules"
test -x "$DONOR/.bin/vitest" || { echo "Install project dependencies in the remote donor checkout" >&2; exit 1; }
echo "[ecs] Using node_modules donor: $DONOR"
ln -s "$DONOR" node_modules

echo "[ecs] Node version: $(node -v)"
echo "[ecs] Recording container quotas & initial state..."
sudo -n docker inspect --format '{{.Name}} status={{.State.Status}} cpus={{.HostConfig.NanoCpus}} mem={{.HostConfig.Memory}}' \
  geoinflow-ecs-memory-pg-1 geoinflow-ecs-memory-ch-1

PG_USER=""
CH_USER=""
CH_PASS=""
STATS_PID=""

cleanup() {
  echo "[ecs] Cleaning up temporary databases and restoring containers..."
  if [ -n "$STATS_PID" ]; then
    kill "$STATS_PID" 2>/dev/null || true
    wait "$STATS_PID" 2>/dev/null || true
  fi
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

# 1. Run v2 unit tests on Node 22
echo "[ecs] Running vitest unit tests..."
./node_modules/.bin/vitest run src/lib/liekan/warehouse-v2/warehouse-v2.test.ts

# 2. Start isolated PG and CH containers
echo "[ecs] Starting geoinflow-ecs-memory-pg-1 and geoinflow-ecs-memory-ch-1..."
sudo -n docker start geoinflow-ecs-memory-pg-1 geoinflow-ecs-memory-ch-1 >/dev/null
for i in $(seq 1 40); do
  if sudo -n docker exec geoinflow-ecs-memory-pg-1 pg_isready >/dev/null 2>&1 && \
     sudo -n docker exec geoinflow-ecs-memory-ch-1 clickhouse-client -q 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Discover container IPs and credentials without printing secrets
PG_IP="$(sudo -n docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' geoinflow-ecs-memory-pg-1)"
CH_IP="$(sudo -n docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' geoinflow-ecs-memory-ch-1)"
PG_USER="$(sudo -n docker exec geoinflow-ecs-memory-pg-1 sh -c 'printf %s "${POSTGRES_USER:-postgres}"')"
PG_PASS="$(sudo -n docker exec geoinflow-ecs-memory-pg-1 sh -c 'printf %s "${POSTGRES_PASSWORD:-}"')"
CH_USER="$(sudo -n docker exec geoinflow-ecs-memory-ch-1 sh -c 'printf %s "${CLICKHOUSE_USER:-default}"')"
CH_PASS="$(sudo -n docker exec geoinflow-ecs-memory-ch-1 sh -c 'printf %s "${CLICKHOUSE_PASSWORD:-}"')"

echo "[ecs] Creating isolated databases: $DB_NAME"
sudo -n docker exec geoinflow-ecs-memory-pg-1 psql -U "$PG_USER" -d postgres -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null
sudo -n docker exec geoinflow-ecs-memory-ch-1 clickhouse-client --user "$CH_USER" --password "$CH_PASS" -q "CREATE DATABASE \`$DB_NAME\`" >/dev/null

# Sample CH & PG container CPU/mem in background during benchmark
(
  while true; do
    sudo -n docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' \
      geoinflow-ecs-memory-pg-1 geoinflow-ecs-memory-ch-1 >> "$REMOTE_DIR/stats.log" 2>/dev/null || true
    sleep 5
  done
) &
STATS_PID=$!

echo "[ecs] Running 100x isolated benchmark (5.7M logs + 181.3k PV/96k UV + 66s pure + 66s mixed)..."
V2_PG_URL="postgresql://${PG_USER}:${PG_PASS}@${PG_IP}:5432/${DB_NAME}" \
V2_CH_URL="http://${CH_IP}:8123" \
V2_CH_USER="$CH_USER" \
V2_CH_PASSWORD="$CH_PASS" \
V2_CH_DB="$DB_NAME" \
V2_PORT=13922 \
  ./node_modules/.bin/tsx scripts/liekan-warehouse-v2-bench.mts

kill "$STATS_PID" 2>/dev/null || true
wait "$STATS_PID" 2>/dev/null || true

echo "[ecs] ClickHouse active parts & disk size for $DB_NAME:"
sudo -n docker exec geoinflow-ecs-memory-ch-1 clickhouse-client --user "$CH_USER" --password "$CH_PASS" -q \
  "SELECT table, count() AS parts, sum(rows) AS rows, formatReadableSize(sum(bytes_on_disk)) AS disk FROM system.parts WHERE database = '$DB_NAME' AND active GROUP BY table ORDER BY table FORMAT PrettyCompact"

echo "[ecs] Resource stats summary:"
tail -n 16 "$REMOTE_DIR/stats.log" || true
REMOTE_SCRIPT
