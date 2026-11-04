# ClickHouse 候选版：独立测试服务器部署与 PG 迁移演练

若测试环境与生产在同一台主机，优先使用 [同机测试脚本](warehouse-same-host-test.md)，自动在线备份并恢复到独立资源。

本文用于手动部署 `feature/geoinflow-unified` 候选版，在独立服务器上恢复一份 PostgreSQL 备份，演练历史迁移、切换、回退与结束过渡同步。全程保留原备份与 PG 数据，不连接生产数据库。运行原理和命令说明见 [warehouse.md](warehouse.md)。

## 适用范围与版本边界

本候选版已整合公开 main `cf71de165ae275a4c624d0c36b6a8dfc82758264`（开发源码树对应 `ac23a873e`）。增量迁移共 112 个文件，保留双方原文件名与校验值。支持截至 056 的旧 PG 完整源结构和截至 070 的 main 完整源结构；旧密封快照继续沿用原指纹，不需要重新编号或改写账本。

旧版下载备份约 172 万条原始日志的 26 类事实回填、独立核验、PG → CH → PG → CH 和退出过渡同步已通过隔离验收。本次整合另外验证了真实备份账本的 main→CH、CH→新 main 两种顺序、旧/新源结构续传以及新版完整示例。账本未知、校验值变化或只完成部分迁移时必须停止，不能删账本或改校验值。

迁移结束后的职责为：PG 保存账号、网站、权限、配置及运行控制；CH 保存分析事实；Kafka 保存待处理输入。切换后的回退窗口存在临时结果同步，执行 `exit-complete` 后结束，不保留永久 PG 分析事实双写。

## 1. 准备独立服务器和材料

使用一台独立 Linux Docker 主机，安装 Git、Python 3、Docker Engine 和 Docker Compose v2。Compose 必须支持 `config --hash`、`up --wait` 和覆盖文件的 `!override` 标签。构建采集器还需要 Node.js 22.23.4 与 pnpm 12.3.4；只测报表、手工导入和浏览器采集可以先跳过采集器资产构建。

硬件按实际备份大小和并发配置。默认 CH 容器为 4 CPU / 4 GiB，队列容器为 2 GiB，此外还要容纳 PG、应用、消费者和镜像构建。测试起点可考虑 8 vCPU / 16 GiB RAM / SSD；这不是每日千万～亿条容量保证。磁盘需同时容纳恢复出的 PG、迁移只读克隆、CH 副本、队列、迁移归档、导出临时文件及镜像，不能只按压缩 dump 大小准备。

需要的私有材料：

- 一份已完成的 PostgreSQL custom-format dump 及其 SHA-256。本文使用文件名 `source.dump`。
- 与这份备份对应的私有 `.env`，用于保留 APP_SECRET、2FA 及已加密业务配置所需密钥。没有原密钥时，不要重建后宣称加密数据和身份已兼容。
- 若测试自动日志安装：受控 Ed25519 签名密钥，或构建机生成的完整 `public/liekan-agent/` 资产。

只传输到测试服务器的受控目录，不放入公共下载目录或 Git。生产站点、代理和采集器继续指向原服务。测试服务器不要与生产共用 PG/CH/队列卷。 若源系统曾启用可选 CH 分析副本，本文不会复制其生产连接；需要演练旧副本清理时，另恢复一份隔离副本并使用对应测试连接，禁止让测试 worker 访问生产副本。

在测试服务器执行；以下假设当前用户可以运行 Docker：

```bash
git clone --branch feature/geoinflow-unified --single-branch \
  https://gitee.com/liekan/liekan-statistics.git geoinflow-ch-test
cd geoinflow-ch-test
git rev-parse HEAD
docker version
docker compose version
python3 --version
df -h
df -i
free -h
```

把 HEAD 与交付的公开分支提交号核对。测试期间固定该提交，不自动拉取 main。下载的备份放在 `.local/ch-server-test/source.dump`，原私有配置放在 `.local/ch-server-test/source-private.env`：

```bash
umask 077
mkdir -p .local/ch-server-test
chmod 700 .local/ch-server-test
```

通过 SCP/SFTP 传完后：

```bash
chmod 600 .local/ch-server-test/source.dump .local/ch-server-test/source-private.env
sha256sum .local/ch-server-test/source.dump
```

与备份来源提供的 SHA-256 核对一致后继续。不要覆盖已有测试目录或恢复到已有数据库。

## 2. 生成测试配置并隔离出网

下面只从私有配置保留加密/身份密钥，为独立测试 PG 和 CH 生成新密码。源配置采用仓库部署脚本生成的单行 dotenv 格式；复杂自定义格式应人工按同样白名单处理。目标文件已存在会拒绝覆盖。

```bash
python3 - <<'PY'
from pathlib import Path
import os, secrets
root = Path('.local/ch-server-test')
source = root / 'source-private.env'
target = root / 'test.env'
keep = {
    'APP_SECRET', 'TWO_FACTOR_ENCRYPTION_KEY',
    'LIEKAN_LOG_CREDENTIALS_KEY', 'LIEKAN_LOG_PREVIOUS_KEYS',
    'LIEKAN_AI_ENCRYPTION_KEY',
}
values = {}
for line in source.read_text().splitlines():
    if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    if key.strip() in keep:
        values[key.strip()] = value
for key in ('APP_SECRET', 'TWO_FACTOR_ENCRYPTION_KEY'):
    if not values.get(key, '').strip().strip('"\''):
        raise SystemExit('Source configuration is missing required encryption keys')
password = secrets.token_hex(32)
values.update({
    'POSTGRES_USER': 'liekan', 'POSTGRES_DB': 'liekan',
    'POSTGRES_PASSWORD': password,
    'DATABASE_URL': f'postgresql://liekan:{password}@127.0.0.1:15435/liekan',
    'LIEKAN_CLICKHOUSE_PASSWORD': secrets.token_hex(32),
    'LIEKAN_INSTALL_MODE': 'pg-transition', 'LIEKAN_SEED_DEMO': 'false',
    'LIEKAN_AI_ENABLED': 'false', 'LIEKAN_PUBLIC_URL': '',
    'DISABLE_TELEMETRY': '1', 'NEXT_TELEMETRY_DISABLED': '1',
})
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write(''.join(f'{key}={value}\n' for key, value in values.items()))
print('Private test configuration created; values were not printed.')
PY
```

恢复的数据库可能仍含 Cloudflare 等凭据和待处理任务。所有运行服务使用 Docker internal 网络，禁止副本访问外部供应商。关闭 AI 或不填写 OAuth 变量不能代替网络隔离。构建和镜像下载由主机完成，不需要让运行容器出网。

```bash
cat > .local/ch-server-test/isolation.yml <<'YAML'
services:
  db:
    ports: !override []
  app:
    ports: !override []
networks:
  default:
    internal: true
YAML
```

基础 Compose 使用 `10.253.30.0/24`；先检查主机路由和其他 Docker 网络是否冲突。需要改网段时，在启动前给上述覆盖文件的 `networks.default.ipam.config` 添加 `!override` 列表，选择实际未使用的网段。运行后不要随意改存储服务配置。

```bash
ip route
docker network ls
docker network inspect $(docker network ls -q) \
  --format '{{.Name}} {{json .IPAM.Config}}'
```

在项目根目录的 Bash 会话定义以下函数。后续每次登录服务器都重新定义，保证始终使用相同项目、私有配置和隔离文件：

```bash
set -euo pipefail
export CH_TEST_PROJECT=geoinflow-ch-test
export CH_TEST_ENV="$PWD/.local/ch-server-test/test.env"
export CH_TEST_OVERRIDE="$PWD/.local/ch-server-test/isolation.yml"
export LIEKAN_REVISION="$(git rev-parse HEAD)"
dc() {
  docker compose --project-name "$CH_TEST_PROJECT" --env-file "$CH_TEST_ENV" \
    -f docker-compose.liekan.yml -f docker-compose.warehouse.yml \
    -f "$CH_TEST_OVERRIDE" "$@"
}
wh() { dc exec -T app node scripts/liekan-warehouse-command.mjs "$@"; }
whclone() {
  dc exec -T -e "LIEKAN_MIGRATION_CLONE=$CH_MIGRATION_CLONE" app \
    node scripts/liekan-warehouse-command.mjs "$@"
}
dc config --quiet
```

仅在独立测试机执行，避免全局同名 `liekan:1.2.0` 镜像标签与其他安装混用。不要打印 `dc config` 完整输出，里面含私有密码。

## 3. 恢复旧 PG 备份，检查兼容性

先只启动 PG，应用和 worker 尚不启动：

```bash
dc up -d --no-deps --wait db
dc exec -T db sh -c \
  'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = '\''public'\''"'
```

上面的表数必须为 `0`。非零时停下，查清是否选错项目/卷，不执行清库。确认空库后恢复一次：

```bash
dc exec -T db sh -c \
  'pg_restore --exit-on-error --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < .local/ch-server-test/source.dump
dc exec -T db sh -c \
  'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "ANALYZE"'
```

恢复失败不要在半成品库重复导入；保留错误记录，另建全新的测试项目重新恢复。本文内置客户端/服务端为 PG 16；来源高于 PG 16 或含外部扩展时先单独验证恢复兼容性。

核对 Liekan 已应用迁移：

```bash
dc exec -T db sh -c \
  'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT name || '\'' '\'' || checksum FROM liekan_migration ORDER BY name"' \
  > .local/ch-server-test/source-migrations.txt
python3 - <<'PY'
import json
from pathlib import Path
expected = json.loads(Path('config/liekan/migrations.json').read_text())
errors = []
for row in Path('.local/ch-server-test/source-migrations.txt').read_text().splitlines():
    name, checksum = row.split()
    if expected.get(name) != checksum:
        errors.append(name)
if errors:
    raise SystemExit('STOP: unknown or changed source migrations: ' + ', '.join(errors))
print('Applied source migrations match this candidate.')
PY
```

main 的 `057_storage_retention.sql`、`067_robots_management.sql`、`068_optional_analytics_engine.sql` 等迁移已纳入白名单。数字前缀重叠的文件保持各自完整文件名；不要重编号。只有白名单外或校验值不同的迁移才在此停止。账本通过后，仍必须继续执行第 5 节的完整结构预检。

## 4. 构建并部署 PG 过渡模式

如需测试服务器自动日志采集，先在受控构建环境准备签名资产。可使用已安装的 Node.js 22.23.4 和 pnpm 12.3.4：

```bash
pnpm install --frozen-lockfile
LIEKAN_AGENT_SIGNING_KEY_FILE=/受控目录/已有签名私钥.pem pnpm liekan:build-agent
```

签名私钥在源码目录外；完整资产位于 `public/liekan-agent/`，随后构建镜像才会包含它们。不要提交私钥或生成资产。仅用 `--development-key` 生成的资产限隔离开发测试，不能发给真实生产采集端。若本轮跳过此项，自动安装采集器不可用不算迁移失败。

部署时必须传入相同的项目、配置和覆盖文件：

```bash
python3 scripts/liekan-warehouse-deploy.py --mode pg-transition \
  --project "$CH_TEST_PROJECT" --env-file "$CH_TEST_ENV" \
  --compose-override "$CH_TEST_OVERRIDE"
dc ps -a
wh help
wh monitor
wh transition-status
```

首次镜像构建需要网络和时间。程序增量迁移后启用队列及过渡捕获，权威仍应是 `postgres`，还未完成历史迁移。PG 用户为此测试库的 owner，可创建迁移克隆。若报告依赖容器配置不一致，按 [存储依赖更新规则](warehouse.md#新安装与应用升级) 核对，不删除数据卷。

确认所有运行容器只连接 internal 网络：

```bash
docker network inspect "${CH_TEST_PROJECT}_default" --format '{{.Internal}}'
dc exec -T app node -e \
  'const net=require("node:net");const s=net.connect({host:"1.1.1.1",port:443});s.setTimeout(3000);s.on("connect",()=>{console.error("STOP: unexpected external connectivity");s.destroy();process.exitCode=1});s.on("timeout",()=>{console.log("External probe blocked");s.destroy()});s.on("error",()=>console.log("External probe blocked"));'
```

网络属性必须为 `true`，外网探测应失败。单一探针只作抽查，还应确认所有服务没有额外挂载可出网网络。外部健康检查、地理数据下载和供应商任务不可达属于此测试环境的预期情况。

浏览器访问使用 SSH 转发。先在服务器取得应用容器 IP：

```bash
docker inspect "$(dc ps -q app)" \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
```

在你自己的电脑执行，把下列 IP 换成上一条输出：

```bash
ssh -N -L 127.0.0.1:3002:应用容器IP:3000 服务器用户@测试服务器
```

浏览器打开 `http://127.0.0.1:3002`。使用备份里已有账号，密码不重置。隧道直连没有可信访客 IP 入口，新增浏览器事件可能显示身份不足；UV 等入口质量验收需另接测试用可信代理，按 [入口配置](local-deployment.md) 覆盖转发头，不能让公网请求自行声明可信 IP。

## 5. 事实结构预检与冻结快照

以下输出保存在私有测试目录，便于断线后继续。管道使用前面开启的 `pipefail`，失败立即停止。

```bash
wh preflight | tee .local/ch-server-test/preflight.json
python3 - <<'PY'
import json
from pathlib import Path
v = json.loads(Path('.local/ch-server-test/preflight.json').read_text())
assert v.get('compatible') is True and not v.get('errors'), 'STOP: source schema incompatible'
print('Source fact schema passed.')
PY
```

生成并持久保存快照 UUID，一次操作始终使用这个 UUID：

```bash
python3 - <<'PY'
from pathlib import Path
from uuid import uuid4
p = Path('.local/ch-server-test/snapshot-id')
if not p.exists():
    p.write_text(str(uuid4()) + '\n')
PY
CH_SNAPSHOT_ID=$(cat .local/ch-server-test/snapshot-id)
wh barrier --kind snapshot --operation "$CH_SNAPSHOT_ID"
wh freeze --operation "$CH_SNAPSHOT_ID"
```

若返回 `input-not-drained` 或其他未排空状态，先检查 worker 和 `wh monitor`，等待后重试同一 `freeze`。未成功进入 `frozen` 不执行导出。冻结会暂时停止入口确认，测试时无需把生产流量切过来。

## 6. 导出冻结源并建立不可变克隆

```bash
wh snapshot-export --directory /app/warehouse-backups \
  | tee .local/ch-server-test/snapshot-export.json
CH_ARCHIVE=$(python3 -c 'import json; print(json.load(open(".local/ch-server-test/snapshot-export.json"))["archive"])')
CH_ARCHIVE_SHA=$(python3 -c 'import json; print(json.load(open(".local/ch-server-test/snapshot-export.json"))["sha256"])')
CH_ARCHIVE_DIR=$(python3 -c 'import json; print(json.load(open(".local/ch-server-test/snapshot-export.json"))["directory"])')
wh snapshot-restore --archive "$CH_ARCHIVE" --sha256 "$CH_ARCHIVE_SHA" \
  --directory /app/warehouse-backups --boundary "$CH_ARCHIVE_DIR/archive.json" \
  | tee .local/ch-server-test/snapshot-restore.json
export CH_MIGRATION_CLONE=$(python3 -c 'import json; print(json.load(open(".local/ch-server-test/snapshot-restore.json"))["descriptor"]["database"])')
whclone register | tee .local/ch-server-test/register.json
CH_MIGRATION_ID=$(python3 -c 'import json; print(json.load(open(".local/ch-server-test/register.json"))["migrationId"])')
wh resume-snapshot --operation "$CH_SNAPSHOT_ID"
```

注意：容器内 `/app/warehouse-backups` 是独立数据卷。这里的 `snapshot-restore` 是迁移所需的只读源克隆，不是再覆盖第 3 节的测试业务库。`register` 成功后再恢复 PG 采集，随后在不可变克隆上回填。

断线后重新定义第 2 节函数，并从上述 JSON 恢复三个变量。不要重新生成快照操作 ID、重新注册另一份迁移或手工改 authority。

## 7. 回填、独立核验与建立增量基线

```bash
whclone backfill --migration "$CH_MIGRATION_ID" \
  | tee .local/ch-server-test/backfill.jsonl
whclone verify --migration "$CH_MIGRATION_ID" \
  | tee .local/ch-server-test/verify.jsonl
wh status --migration "$CH_MIGRATION_ID" \
  | tee .local/ch-server-test/migration-status.json
wh baseline --migration "$CH_MIGRATION_ID"
wh sync
wh transition-status
```

大库需要时间，建议在 tmux/screen 会话执行。回填和核验失败可使用同一克隆、同一 migration ID 重试；不要并发启动多个回填。核验需要所有数据族通过并生成核验摘要，不能只看 CH 总行数或几张页面。

`warehouse-transition` 持续推进同步，单次 `wh sync` 只推进一批，不代表积压已全部排空。此时仍是 PG 权威；可先对照固定历史日期的 PV、日志请求数、AI 请求、质量分类、页面排行和导出，记录 PG 基线。

## 8. 切换到 CH

```bash
python3 - <<'PY'
from pathlib import Path
from uuid import uuid4
p = Path('.local/ch-server-test/cutover-id')
if not p.exists():
    p.write_text(str(uuid4()) + '\n')
PY
CH_CUTOVER_ID=$(cat .local/ch-server-test/cutover-id)
wh barrier --kind cutover --operation "$CH_CUTOVER_ID"
wh freeze --operation "$CH_CUTOVER_ID"
wh sync
wh transition-status
wh switch --operation "$CH_CUTOVER_ID"
wh transition-status
wh monitor
```

等待输入及结果位点追平后重试同一 `freeze` / `switch`，不要用新 UUID 绕过失败。切换成功的权威为 `clickhouse`。复核同一批历史报表，并只向明确命名的测试网站导入日志或发送浏览器事件；检查重复上传不增加计数、分页无漏数、完整导出成功。

切换后先保留在线回退窗口，不立即执行第 10 节。这个窗口内 PG 会应用 CH 已确认结果，属于暂时的迁移保护。

## 9. 在测试环境演练回退

仅在过渡同步尚未退出时执行。先创建新的稳定 UUID，保存到 `.local/ch-server-test/rollback-id`，然后：

```bash
python3 - <<'PY'
from pathlib import Path
from uuid import uuid4
p = Path('.local/ch-server-test/rollback-id')
if not p.exists():
    p.write_text(str(uuid4()) + '\n')
PY
CH_ROLLBACK_ID=$(cat .local/ch-server-test/rollback-id)
wh barrier --kind rollback --operation "$CH_ROLLBACK_ID"
wh freeze --operation "$CH_ROLLBACK_ID"
wh sync
wh transition-status
wh switch --operation "$CH_ROLLBACK_ID"
wh transition-status
```

权威应回到 `postgres`，切换期间的新测试数据仍应存在。若位点不齐，排查同步后重试原操作。不能修改连接配置或启动旧应用代替此回退。

演练后重新切 CH：按第 8 节执行，但为这次新切换生成另一个 UUID、保存在 `cutover-after-rollback-id`，不能复用已完成的第一次 cutover ID。确认 CH 权威后继续。

## 10. 结束过渡同步，达到 CH 单事实主存

这是关闭在线 PG 回退窗口的明确步骤。确认本次测试不再需要回退后执行：

```bash
wh exit-begin
wh sync
wh transition-status
wh exit-complete
wh transition-status
wh monitor
```

`exit-complete` 返回 `{ "closed": true }` 才算完成。若尚未排空，继续等后台同步并重试；不要修改终止位点。结束后新增分析事实仅进入 CH，PG 仍有必要的业务/控制写入；不能以 PG 整库大小不变作为验收条件。

继续向测试网站产生新日志与事件，核对 CH 报表增加，旧 PG 分析事实表不再增长。用 `wh retirement-preview` 查看退役候选；本文不执行删除。结束过渡后旧 PG 副本会落后，不能再直接切回，恢复依赖一致备份或向前修复。

## 11. 留存验收结果和一致备份

至少记录下列证据：

| 项目 | 通过标准 |
| --- | --- |
| 迁移 | 全数据族核验摘要成功；固定历史范围前后语义一致 |
| 实时写入 | 正常输入可见；重试不增计；失败和积压可观察 |
| 页面与导出 | 高基数首/中/末页、空值/未知状态、全量导出正确 |
| 权限 | 原账号、团队、私有网站与公开分享权限保留 |
| 过渡 | PG → CH → PG → CH 演练成功；退出后 PG 事实无新增 |
| 压力 | 同时记录输入速率、发布延迟、查询 P95/P99、积压恢复时间和错误数 |
| 资源 | CPU、内存、CH parts/合并、磁盘余量、队列增长、PG 锁等待 |

本地共享主机的 1 万条混合 HTTP 验收为全部发布、查询零错误，查询 P95 约 3.09 秒、P99 约 21.73 秒。这个数字不能代替测试服务器的验收，更不能证明每日 1000 万～1 亿条、90 天的容量。先测代表性日常负载，再逐步增加并发，观察写入是否持续跟得上。

生成一致停机备份，目标目录必须不存在；路径换成实际受控存储：

```bash
python3 scripts/liekan-warehouse-backup.py backup \
  --project "$CH_TEST_PROJECT" --env-file "$CH_TEST_ENV" \
  --compose-override "$CH_TEST_OVERRIDE" \
  --directory /安全备份目录/ch-test-验收时间 --restart
```

备份包含 PG、CH、队列及配置，必须出现完整 `manifest.json`。独立恢复、校验和启动步骤见 [一致备份与独立恢复](warehouse.md#一致备份与独立恢复)，测试副本保持 internal 网络，不执行 `activate --confirm-takeover`。

测试结束可停服务保留数据：

```bash
dc stop -t 120
```

关闭本机 SSH 隧道。不要运行 `down -v`、`volume prune` 或删 PG/CH 表。系统没有站点累计空间的业务配额，仍需监控真实磁盘；本版没有自动删除 90 天以前原始明细的 TTL。

## 常见停止点

| 现象 | 处理 |
| --- | --- |
| 恢复报错、目标已有表 | 停止，保留记录，换全新测试项目；不清已有库 |
| 迁移账本/事实结构不匹配 | 停止，先完成源版本适配；不删未知表、账本或改摘要 |
| `input-not-drained` / 切换位点未齐 | 查 worker、monitor 和同步；等待后重试同一操作 ID |
| CH/队列配置漂移 | 核对镜像、卷名、凭据和资源设置，按手册显式更新依赖 |
| Cloudflare、外部下载不可达 | 隔离副本的预期行为；不要为了消除提示打开出网 |
| UV 为未知但事件有采集 | 核查测试入口可信 IP；历史未知身份不会被迁移补造 |
| 查询慢或队列增长 | 记录实际硬件和并发，查 CPU/IO、parts、合并、锁和消费者，不直接宣称丢数据 |
