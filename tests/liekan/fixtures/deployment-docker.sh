#!/bin/sh
# Keep a raw trace for metadata/pinning assertions and a stable trace for upgrade ordering.
printf '%s\n' "$*" >> "$DEPLOY_TEST_CALLS.raw"
override=''
if [ "$1" = compose ] && [ "$2" = -f ] && [ "$4" = -f ]; then
  override=$5
  shift 5
  set -- compose -f docker-compose.liekan.yml "$@"
fi
if [ "$1" = compose ] && [ "${4:-}" = build ]; then
  revision=${6#LIEKAN_REVISION=}
  printf '%s' "$revision" > "$DEPLOY_TEST_CALLS.revision"
  cp "$override" "$DEPLOY_TEST_CALLS.build-override"
  set -- compose -f docker-compose.liekan.yml build app
fi
printf '%s\n' "$*" >> "$DEPLOY_TEST_CALLS"
compose_project=${DEPLOY_TEST_PROJECT_FROM_ENV:-${COMPOSE_PROJECT_NAME:-liekan}}
database_volume=${DEPLOY_TEST_DATABASE_VOLUME_NAME:-${compose_project}_liekan-data}
db_container=${DEPLOY_TEST_DB_CONTAINER:-}
cache_container=${DEPLOY_TEST_CACHE_CONTAINER:-}
candidate=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
case "$*" in
  'info --format {{.MemTotal}}') printf '%s\n' "${DEPLOY_TEST_MEMORY_BYTES-8589934592}" ;;
  'compose version'|info|'compose -f docker-compose.liekan.yml config --quiet') exit 0 ;;
  'volume ls --format {{.Name}}')
    if [ "${DEPLOY_TEST_VOLUME_EXISTS:-1}" = 0 ]; then printf '%s\n' "${DEPLOY_TEST_VOLUME_NAME:-${compose_project}_liekan-data}"; fi ;;
  'compose -f docker-compose.liekan.yml config --format yaml')
    printf 'name: "%s"\nservices:\n  app:\n    image: liekan:1.2.0\nvolumes:\n  liekan-data:\n    name: "%s"\n  liekan-geography:\n    name: %s_liekan-geography\n' "$compose_project" "$database_volume" "$compose_project" ;;
  'compose -f docker-compose.liekan.yml ps --all --quiet db') printf '%s\n' "$db_container" ;;
  'compose -f docker-compose.liekan.yml ps --all --quiet analytics-cache') printf '%s\n' "$cache_container" ;;
  'compose -f docker-compose.liekan.yml ps --all --quiet analytics-clickhouse') printf '%s\n' "${DEPLOY_TEST_CLICKHOUSE_CONTAINER:-}" ;;
  'compose -f docker-compose.liekan.yml up -d --no-deps --wait --wait-timeout 300 analytics-clickhouse') exit 0 ;;
  'compose -f docker-compose.liekan.yml ps --all --quiet '*) printf '%s\n' "$7-container" ;;
  'image inspect --format '*)
    if [ "$4" = '{{.Id}}' ]; then printf '%s\n' "${DEPLOY_TEST_CANDIDATE_IMAGE:-$candidate}"
    else printf '%s|upstream|63\n' "${DEPLOY_TEST_REVISION_LABEL:-$(cat "$DEPLOY_TEST_CALLS.revision")}"; fi ;;
  'inspect --format '*)
    actual_image=$candidate
    revision=${DEPLOY_TEST_REVISION_LABEL:-$(cat "$DEPLOY_TEST_CALLS.revision" 2>/dev/null)}
    if [ "$4" = "$db_container" ] && [ -n "$db_container" ]; then state=${DEPLOY_TEST_DB_STATE:-running}; health=${DEPLOY_TEST_DB_HEALTH:-healthy}
    elif [ "$4" = "$cache_container" ] && [ -n "$cache_container" ]; then state=${DEPLOY_TEST_CACHE_STATE:-running}; health=${DEPLOY_TEST_CACHE_HEALTH:-healthy}
    else
      state=running; health=healthy
      case "$4" in
        app-container) actual_image=${DEPLOY_TEST_APP_IMAGE:-$candidate}; health=${DEPLOY_TEST_APP_HEALTH:-healthy}; revision=${DEPLOY_TEST_APP_REVISION:-$revision} ;;
        log-worker-container) actual_image=${DEPLOY_TEST_LOG_WORKER_IMAGE:-$candidate}; health=${DEPLOY_TEST_LOG_WORKER_HEALTH:-healthy}; revision=${DEPLOY_TEST_LOG_WORKER_REVISION:-$revision} ;;
        analytics-worker-container) actual_image=${DEPLOY_TEST_ANALYTICS_WORKER_IMAGE:-$candidate}; health=${DEPLOY_TEST_ANALYTICS_WORKER_HEALTH:-healthy}; revision=${DEPLOY_TEST_ANALYTICS_WORKER_REVISION:-$revision} ;;
        *) exit 91 ;;
      esac
      if [ ! -e "$DEPLOY_TEST_CALLS.workers-started" ] && [ "$4" != app-container ]; then state=created; fi
      if [ -e "$DEPLOY_TEST_CALLS.workers-started" ] && [ "$4" != app-container ]; then actual_image=${DEPLOY_TEST_RUNNING_WORKER_IMAGE:-$actual_image}; fi
    fi
    if [ -e "$DEPLOY_TEST_CALLS.started.$4" ]; then state=running; fi
    case "$3" in
      '{{.Image}}') printf '%s\n' "$actual_image" ;;
      '{{.State.Status}}') printf '%s\n' "$state" ;;
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}') printf '%s %s\n' "$state" "$health" ;;
      *) printf '%s|upstream|63\n' "$revision" ;;
    esac ;;
  start\ *)
    if [ "$2" != "$db_container" ] && [ "$2" != "$cache_container" ]; then exit 92; fi
    if [ "${DEPLOY_TEST_START_STATUS:-0}" != 0 ]; then exit "$DEPLOY_TEST_START_STATUS"; fi
    touch "$DEPLOY_TEST_CALLS.started.$2" ;;
  'compose -f docker-compose.liekan.yml build app')
    if [ "${DEPLOY_TEST_KILL_DEPLOY:-0}" = 1 ]; then kill -KILL "$PPID"; fi
    if [ "${DEPLOY_TEST_BLOCK_BUILD:-0}" = 1 ]; then touch "$DEPLOY_TEST_CALLS.building"; sleep 2; fi
    exit "${DEPLOY_TEST_BUILD_STATUS:-0}" ;;
  'compose -f docker-compose.liekan.yml stop log-worker analytics-worker')
    if [ "${DEPLOY_TEST_WORKER_STOP_STATUS:-0}" != 0 ]; then exit "$DEPLOY_TEST_WORKER_STOP_STATUS"; fi
    rm -f "$DEPLOY_TEST_CALLS.workers-started" ;;
  'compose -f docker-compose.liekan.yml up -d --no-build --no-deps --no-start log-worker analytics-worker') cp "$override" "$DEPLOY_TEST_CALLS.create-override" ;;
  'compose -f docker-compose.liekan.yml up -d --no-build --no-deps '*)
    case "$*" in
      *' app') cp "$override" "$DEPLOY_TEST_CALLS.app-override"; exit "${DEPLOY_TEST_APP_UP_STATUS:-0}" ;;
      *' analytics-cache') exit "${DEPLOY_TEST_CACHE_UP_STATUS:-0}" ;;
      *' log-worker analytics-worker') cp "$override" "$DEPLOY_TEST_CALLS.worker-override"; touch "$DEPLOY_TEST_CALLS.workers-started" ;;
      *' db') ;;
      *) exit 93 ;;
    esac ;;
  'image rm '*|tag\ *) ;;
  *) printf 'Unexpected Docker command in deployment test\n' >&2; exit 90 ;;
esac
exit 0
