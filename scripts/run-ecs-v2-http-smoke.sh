#!/usr/bin/env bash
set -euo pipefail

# Runs Phase 3 Full-Stack Live Next.js Standalone HTTP Smoke Verification on Test ECS:
# 1. Starts isolated PG 16 + CH 26.8 containers
# 2. Creates fresh isolated databases and runs full Prisma + Liekan PG migrations
# 3. Initializes Warehouse v2 schema + seeds official bundled demo ("猎看官网（示例数据）")
# 4. Verifies demo idempotency (second automatic seed returns status=existing)
# 5. Boots compiled `.next/standalone/server.js` on 127.0.0.1:13002 with LIEKAN_WAREHOUSE_V2=1
# 6. Runs full authenticated HTTP smoke suite (login, /api/send, observations, reconciliation,
#    all 10 page-report resources, summary, stats, realtime, retention, reset, delete)
# 7. Verifies AGENTS.md non-recreation invariant (automatic seed after demo deletion returns status=deleted)
# 8. Drops temporary databases and stops containers cleanly

APP_DIR="$1"
export PATH="${APP_DIR}/node_modules/.bin:${PATH}"
DOCKER="${DOCKER:-sudo docker}"
PG_CONTAINER="${PG_CONTAINER:-geoinflow-ecs-memory-pg-1}"
CH_CONTAINER="${CH_CONTAINER:-geoinflow-ecs-memory-ch-1}"
RUN_ID="$(date +%s)"
PG_DB="v2_smoke_${RUN_ID}"
CH_DB="v2_smoke_${RUN_ID}"
SMOKE_PORT=13002
SERVER_PID=""

cleanup() {
  set +e
  if [ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  ${DOCKER} exec "${PG_CONTAINER}" psql -U postgres -c "DROP DATABASE IF EXISTS ${PG_DB} WITH (FORCE);" >/dev/null 2>&1 || true
  ${DOCKER} exec "${CH_CONTAINER}" clickhouse-client --query "DROP DATABASE IF EXISTS ${CH_DB}" >/dev/null 2>&1 || true
  ${DOCKER} stop "${PG_CONTAINER}" "${CH_CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> [1/7] Starting isolated PG & ClickHouse containers"
${DOCKER} start "${PG_CONTAINER}" "${CH_CONTAINER}" >/dev/null
for i in $(seq 1 30); do
  if ${DOCKER} exec "${PG_CONTAINER}" pg_isready -U postgres >/dev/null 2>&1 && \
     ${DOCKER} exec "${CH_CONTAINER}" clickhouse-client --query "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

PG_IP="$(${DOCKER} inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${PG_CONTAINER}")"
CH_IP="$(${DOCKER} inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${CH_CONTAINER}")"
export DATABASE_URL="postgresql://postgres:postgres@${PG_IP}:5432/${PG_DB}"
export LIEKAN_ANALYTICS_BACKEND="clickhouse"
export LIEKAN_WAREHOUSE_V2="1"
export LIEKAN_CLICKHOUSE_URL="http://default:@${CH_IP}:8123"
export LIEKAN_CLICKHOUSE_DATABASE="${CH_DB}"
export LIEKAN_CH_READ_CONCURRENCY="4"
export APP_SECRET="v2-http-smoke-secret-${RUN_ID}"
export CLIENT_IP_HEADER="x-forwarded-for"
export PORT="${SMOKE_PORT}"
export HOSTNAME="127.0.0.1"

echo "==> [2/7] Creating isolated databases (${PG_DB} / ${CH_DB}) & running full PG migrations"
${DOCKER} exec "${PG_CONTAINER}" psql -U postgres -c "CREATE DATABASE ${PG_DB};" >/dev/null
${DOCKER} exec "${CH_CONTAINER}" clickhouse-client --query "CREATE DATABASE ${CH_DB}" >/dev/null

cd "${APP_DIR}"
node scripts/check-db.js
node scripts/liekan-migrate.mjs

echo "==> [3/7] Running Warehouse v2 init + official bundled demo seed"
./node_modules/.bin/tsx scripts/liekan-warehouse-v2.mts init
SEED1="$(./node_modules/.bin/tsx scripts/liekan-warehouse-v2.mts seed-demo --automatic)"
echo "Seed #1: ${SEED1}"
echo "${SEED1}" | grep -q '"status":"created"'

echo "==> [4/7] Verifying demo idempotency (second run must not duplicate)"
SEED2="$(./node_modules/.bin/tsx scripts/liekan-warehouse-v2.mts seed-demo --automatic)"
echo "Seed #2: ${SEED2}"
echo "${SEED2}" | grep -q '"status":"existing"'

echo "==> [5/7] Booting real compiled Next.js production server on 127.0.0.1:${SMOKE_PORT}"
NODE_ENV=production ./node_modules/.bin/next start -H 127.0.0.1 -p "${SMOKE_PORT}" > /tmp/v2-smoke-server.log 2>&1 &
SERVER_PID=$!

for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${SMOKE_PORT}/api/heartbeat" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "Server exited prematurely:"
    cat /tmp/v2-smoke-server.log
    exit 1
  fi
  sleep 0.5
done

echo "==> [6/7] Executing full-stack authenticated HTTP smoke verification"
if ! SMOKE_BASE_URL="http://127.0.0.1:${SMOKE_PORT}" ./node_modules/.bin/tsx scripts/liekan-warehouse-v2-http-smoke.mts; then
  echo "--- Server log tail ---"
  tail -n 60 /tmp/v2-smoke-server.log || true
  exit 1
fi

echo "==> [7/7] Verifying deleted demo is NEVER recreated on automatic seed"
SEED3="$(./node_modules/.bin/tsx scripts/liekan-warehouse-v2.mts seed-demo --automatic)"
echo "Seed #3 (after delete): ${SEED3}"
echo "${SEED3}" | grep -q '"status":"deleted"'

echo "==> ALL PHASE 3 LIVE HTTP SMOKE GATES PASSED!"
