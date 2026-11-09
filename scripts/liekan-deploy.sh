#!/bin/sh
set -eu
with_clickhouse=0
if [ "${1:-}" = '--with-clickhouse' ]; then with_clickhouse=1; shift; fi
with_traefik=0
if [ "${1:-}" = '--traefik' ]; then with_traefik=1; shift; fi

if [ "${1:-}" = '--help' ]; then
  printf '%s\n' '用法：sh scripts/liekan-deploy.sh [--with-clickhouse] [--traefik] [--check]' '需要 Docker 和 Docker Compose，源码构建要求 Docker 至少配置 6 GiB 内存，建议 8 GiB 或以上并预留空闲内存。' '首次生成私有配置，构建并启动GEOInflow；再次运行保留配置与数据。--check 只检查 Docker 和构建内存门槛。' '--traefik 使用现有外部 traefik 网络和 GEOINFLOW_DOMAIN HTTPS 路由。'
  exit 0
fi
check_only=0
if [ "$#" -eq 1 ] && [ "$1" = '--check' ]; then
  check_only=1
elif [ "$#" -ne 0 ]; then
  printf '%s\n' '用法：sh scripts/liekan-deploy.sh [--with-clickhouse] [--traefik] [--check]' >&2
  exit 1
fi
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
base_compose() {
  if [ "$with_traefik" -eq 1 ]; then
    docker compose -f docker-compose.liekan.yml -f docker-compose.liekan.traefik.yml "$@"
  else
    docker compose -f docker-compose.liekan.yml "$@"
  fi
}
clickhouse_compose() {
  if [ "$with_traefik" -eq 1 ]; then
    docker compose -f docker-compose.liekan.yml -f docker-compose.liekan.traefik.yml -f docker-compose.liekan-clickhouse.yml "$@"
  else
    docker compose -f docker-compose.liekan.yml -f docker-compose.liekan-clickhouse.yml "$@"
  fi
}
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' '请先安装并启动 Docker 和 Docker Compose。' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  printf '%s\n' '无法连接 Docker，请确认服务已启动，当前用户有访问权限。' >&2
  exit 1
fi
# MemTotal is reported by the Docker daemon, including a remote daemon or Desktop VM.
# The 3 GiB V8 heap excludes native allocations, build workers and the operating system.
docker_memory=$(docker info --format '{{.MemTotal}}' 2>/dev/null || :)
case "$docker_memory" in
  ''|*[!0-9]*)
    printf '%s\n' '无法确认 Docker 内存，部署已停止。请检查 docker info --format '\''{{.MemTotal}}'\'' 后重试。' >&2
    exit 1 ;;
esac
if [ "${#docker_memory}" -gt 15 ] || [ "$docker_memory" -lt 6442450944 ]; then
  printf '%s\n' 'Docker 源码构建至少需要配置 6 GiB 内存，建议 8 GiB 或以上。请增加服务器或 Docker 虚拟机内存，或在独立构建机生成镜像后部署。现有服务与配置保持原状。' >&2
  exit 1
fi
printf '%s\n' 'Docker 构建内存门槛检查通过（至少 6 GiB）。请为构建预留空闲内存，已有服务也会消耗资源。'
if [ "$check_only" -eq 1 ]; then exit 0; fi
umask 077
mkdir -p .local
deployment_lock=.local/liekan-deploy.lock
# The operating system releases this lock after the shell and its children exit.
exec 9> "$deployment_lock"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    printf '%s\n' '另一个部署正在执行，请等待它结束。' >&2
    exit 1
  fi
elif command -v lockf >/dev/null 2>&1; then
  if ! lockf -s -t 0 9; then
    printf '%s\n' '另一个部署正在执行，请等待它结束。' >&2
    exit 1
  fi
else
  printf '%s\n' '需要系统锁工具 flock（Linux util-linux）或 lockf（macOS）来安全执行部署。' >&2
  exit 1
fi
temporary=''
candidate_override=''
candidate_tag=''
cleanup() {
  cleanup_status=$?
  if [ "$cleanup_status" -ne 0 ] && [ -n "${workers_stopped:-}" ]; then stop_candidate_workers; fi
  if [ -n "$temporary" ]; then rm -f "$temporary"; fi
  if [ -n "$candidate_override" ]; then rm -f "$candidate_override"; fi
  if [ -n "$candidate_tag" ]; then docker image rm "$candidate_tag" >/dev/null 2>&1 || :; fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

if [ ! -e .env ] && [ ! -L .env ]; then
  # Existing volumes need their original configuration, including app and 2FA keys.
  existing_volumes=$(docker volume ls --format '{{.Name}}')
  existing_database=''
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    if printf '%s\n' "$existing_volumes" | grep -Fx "${COMPOSE_PROJECT_NAME}_liekan-data" >/dev/null; then
      existing_database=1
    fi
  elif printf '%s\n' "$existing_volumes" | grep -E '_liekan-data$' >/dev/null; then
    # A lost .env may have contained a custom Compose project name.
    existing_database=1
  fi
  if [ -n "$existing_database" ]; then
    printf '%s\n' '发现已有 GEOInflow 数据库，请恢复原 .env 后再部署，以保留数据库密码、应用密钥和双重验证密钥。' >&2
    exit 1
  fi
  random_secret() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
  database_password=$(random_secret)
  app_secret=$(random_secret)
  two_factor_key=$(random_secret)
  temporary=$(mktemp .local/liekan-env.XXXXXX)
  cat > "$temporary" <<EOF
POSTGRES_USER=liekan
POSTGRES_DB=liekan
POSTGRES_PASSWORD=$database_password
DATABASE_URL=postgresql://liekan:$database_password@127.0.0.1:15435/liekan
APP_SECRET=$app_secret
TWO_FACTOR_ENCRYPTION_KEY=$two_factor_key
DISABLE_TELEMETRY=1
NEXT_TELEMETRY_DISABLED=1
DEFAULT_LOCALE=zh-CN
API_KEY_ENABLED=1
LIEKAN_AI_ENABLED=false
EOF
  # A hard link installs the configuration atomically without overwriting a file.
  ln "$temporary" .env
  rm -f "$temporary"
  temporary=''
  printf '%s\n' '首次安装配置已生成并保存在私有 .env 中。'
fi

if [ "$with_traefik" -eq 1 ]; then
  if ! docker network inspect traefik >/dev/null 2>&1; then
    printf '%s\n' '未找到外部 Docker 网络 traefik，请先在目标机器创建或恢复现有 Traefik 网络。' >&2
    exit 1
  fi
fi
base_compose config --quiet
compose_configuration=$(base_compose config --format yaml)
compose_project=$(printf '%s\n' "$compose_configuration" | awk '/^name: / { sub(/^name: /, ""); print; exit }' | tr -d "\"'")
application_image=$(printf '%s\n' "$compose_configuration" | awk '
  /^services:$/ { in_services=1; next }
  in_services && /^[^[:space:]]/ { in_services=0 }
  in_services && /^  app:$/ { in_app=1; next }
  in_services && /^  [^[:space:]]/ { in_app=0 }
  in_services && in_app && /^    image: / { sub(/^    image: /, ""); print }
' | tr -d "\"'")
database_volume=$(printf '%s\n' "$compose_configuration" | awk '
  /^volumes:$/ { in_volumes=1; next }
  in_volumes && /^[^[:space:]]/ { in_volumes=0 }
  in_volumes && /^  liekan-data:$/ { in_database=1; next }
  in_volumes && /^  [^[:space:]]/ { in_database=0 }
  in_volumes && in_database && /^    name: / { sub(/^    name: /, ""); print }
' | tr -d "\"'")
unset compose_configuration
case "$database_volume" in
  ''|*[!a-zA-Z0-9_.-]*)
    printf '%s\n' '无法确认 Compose 数据库卷名称，部署已停止。' >&2
    exit 1
    ;;
esac
case "$application_image" in
  ''|*[!a-zA-Z0-9_./:@-]*)
    printf '%s\n' '无法确认应用镜像名称，部署已停止。' >&2
    exit 1
    ;;
esac
database_container=$(base_compose ps --all --quiet db)
cache_container=$(base_compose ps --all --quiet analytics-cache)
for container_id in "$database_container" "$cache_container"; do
  case "$container_id" in
    *[!a-zA-Z0-9_.-]*)
      printf '%s\n' '发现多个或无法识别的依赖服务容器，部署已停止。' >&2
      exit 1
      ;;
  esac
done
existing_volumes=$(docker volume ls --format '{{.Name}}')
if [ -z "$database_container" ] && printf '%s\n' "$existing_volumes" | grep -Fx "$database_volume" >/dev/null; then
  printf '%s\n' '发现已有数据库卷，但原数据库容器缺失。请按原 PostgreSQL 大版本恢复容器并检查数据，再执行部署。' >&2
  exit 1
fi

start_existing_dependency() {
  dependency_name=$1
  dependency_id=$2
  dependency_state=$(docker inspect --format '{{.State.Status}}' "$dependency_id")
  case "$dependency_state" in
    running) ;;
    created|exited) docker start "$dependency_id" >/dev/null ;;
    *)
      printf '%s\n' "$dependency_name 容器状态异常，部署已停止，请先检查原容器。" >&2
      return 1
      ;;
  esac
  health_attempt=0
  while [ "$health_attempt" -lt 150 ]; do
    dependency_health=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$dependency_id")
    case "$dependency_health" in
      'running healthy') return 0 ;;
      'running starting') ;;
      *)
        printf '%s\n' "$dependency_name 容器未通过健康检查，部署已停止，请先恢复原服务。" >&2
        return 1
        ;;
    esac
    health_attempt=$((health_attempt + 1))
    sleep 2
  done
  printf '%s\n' "$dependency_name 容器健康检查超时，部署已停止。" >&2
  return 1
}

if [ "$with_clickhouse" = 1 ] || grep -Eq '^LIEKAN_ANALYTICS_CLICKHOUSE_URL=http://geoinflow_analytics:[a-f0-9]+@analytics-clickhouse:8123/geoinflow_analytics$' .env; then
  if grep -Eq '^LIEKAN_ANALYTICS_CLICKHOUSE_URL=.+$' .env && ! grep -Eq '^LIEKAN_ANALYTICS_CLICKHOUSE_URL=http://geoinflow_analytics:[a-f0-9]+@analytics-clickhouse:8123/geoinflow_analytics$' .env; then
    printf '%s\n' '当前已配置外部 ClickHouse，请保留该连接并使用默认部署命令。' >&2
    exit 1
  fi
  if grep -Eq '^LIEKAN_CLICKHOUSE_PASSWORD=.+$' .env && ! grep -Eq '^LIEKAN_ANALYTICS_CLICKHOUSE_URL=.+$' .env; then
    printf '%s\n' '请先恢复完整的 ClickHouse 连接配置，部署会保留已有密码。' >&2
    exit 1
  fi
  case "$compose_project" in
    ''|*[!a-zA-Z0-9_.-]*) printf '%s\n' '无法确认 ClickHouse 所属 Compose 项目，部署已停止。' >&2; exit 1 ;;
  esac
  clickhouse_volume="${compose_project}_liekan-clickhouse-data"
  if ! grep -Eq '^LIEKAN_CLICKHOUSE_PASSWORD=.+$' .env; then
    if printf '%s\n' "$existing_volumes" | grep -Fx "$clickhouse_volume" >/dev/null; then
      printf '%s\n' '发现已有 ClickHouse 数据卷，请先恢复原连接配置和密码。' >&2
      exit 1
    fi
    if grep -Eq '^LIEKAN_ANALYTICS_CLICKHOUSE_URL=.+$' .env; then
      printf '%s\n' '当前已配置外部 ClickHouse，请保留该连接并使用默认部署命令。' >&2
      exit 1
    fi
    if [ -L .env ]; then printf '%s\n' '请在原配置文件中添加 ClickHouse 连接，再执行部署。' >&2; exit 1; fi
    clickhouse_password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    temporary=$(mktemp .local/liekan-clickhouse-env.XXXXXX)
    # Remove empty optional keys before appending one authoritative value.
    sed '/^LIEKAN_CLICKHOUSE_PASSWORD=$/d; /^LIEKAN_ANALYTICS_CLICKHOUSE_URL=$/d' .env > "$temporary"
    printf '\nLIEKAN_CLICKHOUSE_PASSWORD=%s\nLIEKAN_ANALYTICS_CLICKHOUSE_URL=http://geoinflow_analytics:%s@analytics-clickhouse:8123/geoinflow_analytics\n' "$clickhouse_password" "$clickhouse_password" >> "$temporary"
    mv "$temporary" .env
    temporary=''
    unset clickhouse_password
  fi
  clickhouse_compose config --quiet
  clickhouse_container=$(clickhouse_compose ps --all --quiet analytics-clickhouse)
  case "$clickhouse_container" in *[!a-zA-Z0-9_.-]*) printf '%s\n' 'ClickHouse 容器无法识别，部署已停止。' >&2; exit 1 ;; esac
  if [ -n "$clickhouse_container" ]; then
    start_existing_dependency 'ClickHouse' "$clickhouse_container"
  elif printf '%s\n' "$existing_volumes" | grep -Fx "$clickhouse_volume" >/dev/null; then
    printf '%s\n' '发现 ClickHouse 数据卷，但原容器缺失。请先恢复原容器并检查数据。' >&2
    exit 1
  else
    clickhouse_compose up -d --no-deps --wait --wait-timeout 300 analytics-clickhouse
  fi
fi

# Build a private tag so another build cannot replace our candidate between build and inspect.
# Git is optional for source archives. Unknown metadata never substitutes for an image ID.
source_revision=unknown
source_state=unknown
source_difference=unknown
if command -v git >/dev/null 2>&1 && [ "$(git rev-parse --show-toplevel 2>/dev/null || :)" = "$PWD" ]; then
  source_revision=$(git rev-parse HEAD)
  source_state=clean
  source_difference=none
  # The `:!` exclusion pathspecs need git >= 1.9; CentOS 7 ships 1.8 and falls
  # back to plain listings filtered in the shell with the same exclusions.
  liekan_git_pathspecs=1
  if git status --porcelain --untracked-files=no -- ':!.git' >/dev/null 2>&1; then
    source_status=$(git status --porcelain --untracked-files=all -- . ':!.local' ':!.env*' ':!**/.env*' ':!node_modules' ':!**/node_modules' ':!.next' ':!outputs' ':!tmp' ':!coverage' ':!test-results' ':!playwright-report')
  else
    liekan_git_pathspecs=0
    liekan_source_excludes='(\.local/|([^/]+/)*\.env[^/]*$|([^/]+/)*node_modules/|\.next/|(outputs|tmp|coverage|test-results|playwright-report)/)'
    source_status=$(git status --porcelain --untracked-files=all | { grep -vE "^...$liekan_source_excludes" || :; })
  fi
  if [ -n "$source_status" ]; then
    source_state=dirty
    source_difference=$({
      printf '%s\n' "$source_status"
      if [ "$liekan_git_pathspecs" -eq 1 ]; then
        git diff --binary HEAD -- . ':!.local' ':!.env*' ':!**/.env*' ':!node_modules' ':!**/node_modules' ':!.next' ':!outputs' ':!tmp' ':!coverage' ':!test-results' ':!playwright-report'
        git ls-files --others --exclude-standard -z -- . ':!.local' ':!.env*' ':!**/.env*' ':!node_modules' ':!**/node_modules' ':!.next' ':!outputs' ':!tmp' ':!coverage' ':!test-results' ':!playwright-report' | xargs -0 git hash-object --
      else
        git diff --binary HEAD
        git ls-files --others --exclude-standard -z | { grep -zvE "^$liekan_source_excludes" || :; } | xargs -0 -r git hash-object --
      fi
    } | git hash-object --stdin)
  fi
  unset source_status liekan_git_pathspecs liekan_source_excludes
fi
candidate_override=$(mktemp .local/liekan-candidate.XXXXXX)
candidate_tag="liekan:deploy-$(basename "$candidate_override" | tr '[:upper:]' '[:lower:]')"
cat > "$candidate_override" <<EOF
services:
  app:
    image: $candidate_tag
    build:
      labels:
        org.opencontainers.image.revision: "$source_revision"
        io.liekan.source.state: "$source_state"
        io.liekan.source.difference: "$source_difference"
EOF
candidate_compose() {
  if [ "$with_traefik" -eq 1 ]; then
    docker compose -f docker-compose.liekan.yml -f docker-compose.liekan.traefik.yml -f "$candidate_override" "$@"
  else
    docker compose -f docker-compose.liekan.yml -f "$candidate_override" "$@"
  fi
}
candidate_compose build --build-arg "LIEKAN_REVISION=$source_revision" app
candidate_image=$(docker image inspect --format '{{.Id}}' "$candidate_tag")
case "$candidate_image" in
  sha256:*) image_digest=${candidate_image#sha256:} ;;
  *) image_digest='' ;;
esac
case "$image_digest" in
  ''|*[!a-f0-9]*) image_digest='' ;;
esac
if [ "${#image_digest}" -ne 64 ]; then
  printf '%s\n' '无法确认本次构建的不可变镜像 ID，部署已停止。' >&2
  exit 1
fi
revision_format='{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "io.liekan.upstream.revision"}}|{{index .Config.Labels "io.liekan.migration"}}'
candidate_revisions=$(docker image inspect --format "$revision_format" "$candidate_image")
if [ "$source_revision" != unknown ] && [ "${candidate_revisions%%|*}" != "$source_revision" ]; then
  printf '%s\n' 'app 构建来源版本不匹配，部署已停止。' >&2
  exit 1
fi
cat > "$candidate_override" <<EOF
services:
  app:
    image: $candidate_image
    pull_policy: never
  log-worker:
    image: $candidate_image
    pull_policy: never
  analytics-worker:
    image: $candidate_image
    pull_policy: never
EOF

verify_candidate_service() {
  service_name=$1
  require_health=$2
  service_id=$(candidate_compose ps --all --quiet "$service_name")
  case "$service_id" in
    ''|*[!a-zA-Z0-9_.-]*)
      printf '%s\n' "$service_name 容器无法唯一确认，部署已停止。" >&2
      return 1 ;;
  esac
  actual_image=$(docker inspect --format '{{.Image}}' "$service_id")
  actual_revisions=$(docker inspect --format "$revision_format" "$service_id")
  if [ "$actual_image" != "$candidate_image" ] || [ "$actual_revisions" != "$candidate_revisions" ]; then
    printf '%s\n' "$service_name 镜像或版本与本次候选不匹配，部署已停止；后台处理服务保持停止。" >&2
    return 1
  fi
  if [ "$require_health" = healthy ]; then
    service_health=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$service_id")
    if [ "$service_health" != 'running healthy' ]; then
      printf '%s\n' "$service_name 未通过候选健康检查，部署已停止。" >&2
      return 1
    fi
  else
    service_state=$(docker inspect --format '{{.State.Status}}' "$service_id")
    case "$service_state" in
      created|exited) ;;
      *)
        printf '%s\n' "$service_name 未处于待启动状态，部署已停止。" >&2
        return 1 ;;
    esac
  fi
}

workers_stopped=''
stop_candidate_workers() {
  if [ -n "$workers_stopped" ]; then
    candidate_compose stop log-worker analytics-worker >/dev/null 2>&1 || :
  fi
}
# Existing dependencies retain their container, image, configuration and data mounts.
if [ -n "$database_container" ]; then
  start_existing_dependency '数据库' "$database_container"
else
  base_compose up -d --no-build --no-deps --wait --wait-timeout 300 db
fi
if [ -n "$cache_container" ]; then
  start_existing_dependency '缓存' "$cache_container"
else
  base_compose up -d --no-build --no-deps --wait --wait-timeout 300 analytics-cache
fi
base_compose stop log-worker analytics-worker
workers_stopped=1
trap 'stop_candidate_workers; exit 130' INT
trap 'stop_candidate_workers; exit 143' TERM HUP
if ! candidate_compose up -d --no-build --no-deps --wait --wait-timeout 1800 app; then
  printf '%s\n' 'app 启动或迁移健康检查失败，后台处理服务保持停止。' >&2
  exit 1
fi
verify_candidate_service app healthy
# Inspect stopped workers before they can claim work, then start these exact containers.
candidate_compose up -d --no-build --no-deps --no-start log-worker analytics-worker
for service_name in log-worker analytics-worker; do
  if ! verify_candidate_service "$service_name" stopped; then
    stop_candidate_workers
    exit 1
  fi
done
if ! candidate_compose up -d --no-build --no-deps --no-recreate --wait --wait-timeout 300 log-worker analytics-worker; then
  for service_name in log-worker analytics-worker; do verify_candidate_service "$service_name" healthy || :; done
  stop_candidate_workers
  printf '%s\n' 'log-worker 或 analytics-worker 启动健康检查失败，后台处理服务已停止。' >&2
  exit 1
fi
for service_name in app log-worker analytics-worker; do
  if ! verify_candidate_service "$service_name" healthy; then
    stop_candidate_workers
    exit 1
  fi
done
docker tag "$candidate_image" "$application_image"
printf '%s\n' "候选镜像：${candidate_image}；来源：${source_revision}；工作区：${source_state}；差异摘要：${source_difference}。"
printf '%s\n' 'GEOInflow部署完成：http://127.0.0.1:3002' '首次安装登录：admin / liekan。已有账号使用原密码。' '公网访问通过反向代理配置域名与 HTTPS。' '访客统计需要可信 IP 入口：按 docs/local-deployment.md 配置 CLIENT_IP_HEADER 和代理覆盖规则，再核对新事件身份覆盖。'
