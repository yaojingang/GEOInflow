#!/usr/bin/env bash
# Run on the machine hosting a fresh Compose project. Scope every operation by Docker labels.
set -euo pipefail
project=${1:?usage: liekan-run-compose-v2-formal-100x.sh PROJECT NEW_EVIDENCE_DIRECTORY [preflight|formal]}
out=${2:?provide a new evidence directory}
case "${3:-formal}" in
  preflight) preflight=1 ;;
  formal) preflight=0 ;;
  *) echo "Expected preflight or formal" >&2; exit 1 ;;
esac
[[ "$project" =~ ^v2accept[a-z0-9_-]+$ ]] || { echo "Expected an isolated v2accept Compose project" >&2; exit 1; }
if docker info >/dev/null 2>&1; then docker_cmd=(docker); else docker_cmd=(sudo -n docker); fi
service_id() {
  local name=$1 id
  id=$("${docker_cmd[@]}" ps --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$name" --format '{{.ID}}')
  [[ $id =~ ^[0-9a-f]{12,64}$ ]] || { echo "Expected one running $project/$name" >&2; return 1; }
  printf '%s' "$id"
}
app=$(service_id app)
db=$(service_id db)
ch=$(service_id warehouse-ch)
here=$(cd "$(dirname "$0")" && pwd)
mkdir -m 700 "$out"
bench_dir="/tmp/formal-100x-$(date -u +%Y%m%dT%H%M%SZ)-$$"
# Keep the benchmark separate from the application and the image's own scripts.
# Only the isolated app should configure CLIENT_IP_HEADER=x-liekan-benchmark-ip.
driver="/app/.accept-driver-$$-$(date +%s)"
files=(liekan-warehouse-v2-formal-100x.mts liekan-warehouse-v2-visibility.ts liekan-warehouse-v2-formal-fixture.mts liekan-benchmark-fixtures.ts)
"${docker_cmd[@]}" exec "$app" sh -ec 'test "$CLIENT_IP_HEADER" = x-liekan-benchmark-ip; cd /app; test -x node_modules/.bin/tsx'
"${docker_cmd[@]}" exec --user 0 "$app" mkdir "$driver"
for file in "${files[@]}"; do
  "${docker_cmd[@]}" cp "$here/$file" "$app:$driver/$file"
done
(cd "$here" && sha256sum "${files[@]}") >"$out/expected-driver.sha256"
"${docker_cmd[@]}" exec -w "$driver" "$app" sha256sum "${files[@]}" >"$out/actual-driver.sha256"
diff -u "$out/expected-driver.sha256" "$out/actual-driver.sha256"
"${docker_cmd[@]}" inspect --format '{{.Name}} {{.Image}} cpu={{.HostConfig.NanoCpus}} memory={{.HostConfig.Memory}}' "$app" "$db" "$ch" > "$out/containers.txt"
# Collect resource samples outside the driver process. Bench evidence records the timed windows.
(
  while true; do
    date -u '+%Y-%m-%dT%H:%M:%SZ'
    "${docker_cmd[@]}" stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' "$db" "$ch" "$app" || break
    "${docker_cmd[@]}" exec "$db" sh -ec 'psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT clock_timestamp(),count(*) FILTER (WHERE wait_event_type=\$\$Lock\$\$),count(*) FILTER (WHERE state=\$\$active\$\$) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()"' || break
    "${docker_cmd[@]}" exec -i "$db" sh -ec 'psql -XAt -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL' || break
SELECT json_build_object('at',clock_timestamp(),'pid',l.pid,'holders',pg_blocking_pids(l.pid),
  'lock',l.locktype,'class',l.classid,'key',l.objid)
FROM pg_locks l WHERE NOT l.granted AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database());
SQL
    sleep 2
  done
) >"$out/containers.log" &
sampler=$!
trap 'kill "$sampler" 2>/dev/null || true; wait "$sampler" 2>/dev/null || true' EXIT
set +e
"${docker_cmd[@]}" exec -w /app -e "BENCH_COMPOSE_PROJECT=$project" -e "BENCH_OUTPUT_DIR=$bench_dir" \
  -e "BENCH_PREFLIGHT=$preflight" -e BENCH_BASE_URL=http://127.0.0.1:3000 "$app" ./node_modules/.bin/tsx "$driver/liekan-warehouse-v2-formal-100x.mts" \
  2>&1 | tee "$out/driver.log"
rc=${PIPESTATUS[0]}
set -e
"${docker_cmd[@]}" cp "$app:$bench_dir/." "$out/"
exit "$rc"
