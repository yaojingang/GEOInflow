#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
. ./config/liekan/build-resources.sh
build_memory_bytes=$((liekan_build_memory_mib * 1024 * 1024))
build_required_mib=$((liekan_build_memory_mib + liekan_build_reserve_mib))
build_required_kib=$((build_required_mib * 1024))
build_total_floor_bytes=$((build_required_kib * 1024))
with_clickhouse=0
if [ "${1:-}" = '--with-clickhouse' ]; then with_clickhouse=1; shift; fi

if [ "${1:-}" = '--help' ]; then
  printf '%s\n' '用法：sh scripts/liekan-deploy.sh [--with-clickhouse] [--check]' '需要 Docker、Buildx 和支持 --builder 的 Docker Compose。Docker 总内存至少 6 GiB、可用内存至少 6 GiB。' '构建最多使用 1 核、5 GiB 内存，单核机器最多使用半核；构建缓存保留。' '首次生成私有配置，构建并启动 GEOInflow；再次运行保留配置与数据。--check 使用临时只读容器检查构建资源，不创建项目配置或启动服务。' '可选 ClickHouse 使用独立内部服务和数据卷，后台完成同步对账后启用。'
  exit 0
fi
check_only=0
if [ "$#" -eq 1 ] && [ "$1" = '--check' ]; then
  check_only=1
elif [ "$#" -ne 0 ]; then
  printf '%s\n' '用法：sh scripts/liekan-deploy.sh [--with-clickhouse] [--check]' >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' '请先安装并启动 Docker 和 Docker Compose。' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  printf '%s\n' '无法连接 Docker，请确认服务已启动，当前用户有访问权限。' >&2
  exit 1
fi
# MemTotal is reported by the Docker daemon, including a remote daemon or Desktop VM.
# The isolated builder and the host reserve share one budget with Docker compilation.
docker_memory=$(docker info --format '{{.MemTotal}}' 2>/dev/null || :)
case "$docker_memory" in
  ''|*[!0-9]*)
    printf '%s\n' '无法确认 Docker 内存，部署已停止。请检查 docker info --format '\''{{.MemTotal}}'\'' 后重试。' >&2
    exit 1 ;;
esac
if [ "${#docker_memory}" -gt 15 ] || [ "$docker_memory" -lt "$build_total_floor_bytes" ]; then
  printf '%s\n' 'Docker 源码构建至少需要配置 6 GiB 内存，建议 8 GiB 或以上。请增加服务器或 Docker 虚拟机内存，或在独立构建机生成镜像后部署。现有服务与配置保持原状。' >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1 || ! docker compose build --help | grep -q -- '--builder'; then
  printf '%s\n' '资源隔离构建需要 Docker Buildx 和支持 --builder 的 Docker Compose，请更新 Docker 构建插件。' >&2
  exit 1
fi
resource_support=$(docker info --format '{{.MemoryLimit}} {{.SwapLimit}} {{.CPUCfsQuota}} {{.CPUCfsPeriod}}')
if [ "$resource_support" != 'true true true true' ]; then
  printf '%s\n' 'Docker 未提供完整的内存、Swap 和 CPU 配额支持，部署已停止。请启用宿主机 cgroup 资源限制或使用独立构建机。' >&2
  exit 1
fi
docker_cpus=$(docker info --format '{{.NCPU}}')
case "$docker_cpus" in
  ''|*[!0-9]*|0) printf '%s\n' '无法确认 Docker CPU 数量，部署已停止。' >&2; exit 1 ;;
esac
build_cpu_quota=100000
if [ "$docker_cpus" = 1 ]; then build_cpu_quota=50000; fi
check_available_memory() {
  # /proc belongs to the daemon host, including a remote daemon or Desktop VM.
  # This probe has no mounts, network, credentials or project configuration.
  available_kib=$(docker run --rm --memory 32m --memory-swap 32m --cpus 0.1 --network none \
    --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 \
    --entrypoint sh node:22.23.4-alpine -c 'awk '\''$1 == "MemAvailable:" { print $2 }'\'' /proc/meminfo') || {
    printf '%s\n' '无法探测 Docker 所在机器的可用内存，部署已停止。请检查 Node 基础镜像下载与 Docker 容器运行能力。' >&2
    return 1
  }
  case "$available_kib" in
    ''|*[!0-9]*) printf '%s\n' '无法确认 Docker 所在机器的可用内存，部署已停止。' >&2; return 1 ;;
  esac
  if [ "${#available_kib}" -gt 15 ] || [ "$available_kib" -lt "$build_required_kib" ]; then
    printf 'Docker 所在机器的可用内存至少需要 %s MiB（构建上限 %s MiB，另留 %s MiB）。请释放资源或使用独立构建机；现有服务保持原状。\n' "$build_required_mib" "$liekan_build_memory_mib" "$liekan_build_reserve_mib" >&2
    return 1
  fi
  printf 'Docker 构建资源检查通过：总内存至少 6 GiB，可用内存 %s MiB（至少 %s MiB）。\n' "$((available_kib / 1024))" "$build_required_mib"
}
check_available_memory
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
build_builder=''
builder_started=''
build_process=''
build_lease=''
cleanup() {
  cleanup_status=$?
  if [ "$cleanup_status" -ne 0 ] && [ -n "${workers_stopped:-}" ]; then stop_candidate_workers; fi
  if [ -n "$build_process" ]; then kill "$build_process" >/dev/null 2>&1 || :; fi
  if [ -n "$builder_started" ]; then
    if docker buildx stop "$build_builder" >/dev/null 2>&1; then builder_started=''
    else printf '%s\n' '专用构建器未能停止，构建租约已保留；请确认构建器停止后再重试部署。' >&2; fi
  fi
  if [ -n "$build_process" ]; then wait "$build_process" >/dev/null 2>&1 || :; fi
  if [ -n "$build_lease" ] && [ -z "$builder_started" ]; then docker rm "$build_lease" >/dev/null 2>&1 || :; fi
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

docker compose -f docker-compose.liekan.yml config --quiet
compose_configuration=$(docker compose -f docker-compose.liekan.yml config --format yaml)
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
database_container=$(docker compose -f docker-compose.liekan.yml ps --all --quiet db)
cache_container=$(docker compose -f docker-compose.liekan.yml ps --all --quiet analytics-cache)
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
  docker compose -f docker-compose.liekan.yml -f docker-compose.liekan-clickhouse.yml config --quiet
  clickhouse_container=$(docker compose -f docker-compose.liekan.yml -f docker-compose.liekan-clickhouse.yml ps --all --quiet analytics-clickhouse)
  case "$clickhouse_container" in *[!a-zA-Z0-9_.-]*) printf '%s\n' 'ClickHouse 容器无法识别，部署已停止。' >&2; exit 1 ;; esac
  if [ -n "$clickhouse_container" ]; then
    start_existing_dependency 'ClickHouse' "$clickhouse_container"
  elif printf '%s\n' "$existing_volumes" | grep -Fx "$clickhouse_volume" >/dev/null; then
    printf '%s\n' '发现 ClickHouse 数据卷，但原容器缺失。请先恢复原容器并检查数据。' >&2
    exit 1
  else
    docker compose -f docker-compose.liekan.yml -f docker-compose.liekan-clickhouse.yml up -d --no-deps --wait --wait-timeout 300 analytics-clickhouse
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
candidate_compose() { docker compose -f docker-compose.liekan.yml -f "$candidate_override" "$@"; }
# Scope the reusable builder to this installation and daemon; keep the user's selection intact.
docker_daemon_id=$(docker info --format '{{.ID}}')
if [ -z "$docker_daemon_id" ]; then printf '%s\n' '无法确认 Docker 实例，部署已停止。' >&2; exit 1; fi
builder_key=$(printf '%s\n' "$PWD" "$docker_daemon_id" | cksum | awk '{ print $1 }')
build_builder="geoinflow-build-v1-$builder_key"
# A daemon-wide container name atomically excludes builds from other checkouts and clients.
lease_candidate=$(docker create --name geoinflow-build-lease --label "io.liekan.build-owner=$builder_key" \
  --network none --read-only --entrypoint true node:22.23.4-alpine 2>/dev/null) || {
  printf '%s\n' '无法取得 Docker 构建租约。请等待其他 GEOInflow 构建结束；若上次部署被强制终止，请先确认专用构建器已停止，再检查 geoinflow-build-lease 容器。' >&2
  exit 1
}
case "$lease_candidate" in
  ''|*[!a-f0-9]*) printf '%s\n' '无法确认 Docker 构建租约，部署已停止。' >&2; exit 1 ;;
esac
if [ "${#lease_candidate}" -ne 64 ]; then printf '%s\n' '无法确认 Docker 构建租约，部署已停止。' >&2; exit 1; fi
build_lease=$lease_candidate
check_available_memory
if ! docker buildx inspect "$build_builder" >/dev/null 2>&1; then
  buildkit_config=config/liekan/buildkit.toml
  if [ -f .local/liekan-buildkit.toml ]; then buildkit_config=.local/liekan-buildkit.toml; fi
  docker buildx create --name "$build_builder" --driver docker-container \
    --driver-opt "memory=${liekan_build_memory_mib}m" --driver-opt "memory-swap=${liekan_build_memory_mib}m" \
    --driver-opt cpu-period=100000 --driver-opt "cpu-quota=$build_cpu_quota" \
    --driver-opt restart-policy=no \
    --buildkitd-config "$buildkit_config" >/dev/null
fi
builder_description=$(docker buildx inspect "$build_builder")
builder_driver=$(printf '%s\n' "$builder_description" | awk '/^Driver:/ { print $2 }')
builder_names=$(printf '%s\n' "$builder_description" | awk '/^Name:/ { count++ } END { print count }')
if [ "$builder_driver" != docker-container ] || [ "$builder_names" != 2 ]; then
  printf '%s\n' '专用构建器配置不匹配，部署已停止，请检查该构建器。' >&2
  exit 1
fi
builder_started=1
docker buildx inspect --bootstrap "$build_builder" >/dev/null
builder_limits=$(docker inspect --format '{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.CpuPeriod}}|{{.HostConfig.CpuQuota}}' "buildx_buildkit_${build_builder}0")
if [ "$builder_limits" != "$build_memory_bytes|$build_memory_bytes|100000|$build_cpu_quota" ]; then
  printf '%s\n' '专用构建器的实际 CPU 或内存限制不匹配，部署已停止。' >&2
  exit 1
fi
printf '开始资源隔离构建：最多 1 核（单核机器半核）、%s MiB 内存，禁止构建器使用 Swap。首次构建耗时较长，原服务继续运行。\n' "$liekan_build_memory_mib"
DOCKER_BUILDKIT=1 docker compose -f docker-compose.liekan.yml -f "$candidate_override" \
  build --builder "$build_builder" --build-arg "LIEKAN_REVISION=$source_revision" app &
build_process=$!
build_status=0
wait "$build_process" || build_status=$?
build_process=''
if [ "$build_status" -ne 0 ]; then
  printf '%s\n' '镜像构建失败，现有应用与后台服务保持原状。请检查上方日志；资源不足时可在独立构建机生成镜像。' >&2
  exit "$build_status"
fi
docker buildx stop "$build_builder"
builder_started=''
docker rm "$build_lease" >/dev/null
build_lease=''
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
  docker compose -f docker-compose.liekan.yml up -d --no-build --no-deps --wait --wait-timeout 300 db
fi
if [ -n "$cache_container" ]; then
  start_existing_dependency '缓存' "$cache_container"
else
  docker compose -f docker-compose.liekan.yml up -d --no-build --no-deps --wait --wait-timeout 300 analytics-cache
fi
docker compose -f docker-compose.liekan.yml stop log-worker analytics-worker
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
