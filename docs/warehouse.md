# ClickHouse 仓库版（Warehouse v2）：架构、安装与运行

GEOInflow 默认仓库版采用原生 ClickHouse 架构（Warehouse v2）：

- **PostgreSQL** 保存账号、网站、团队、权限、采集策略、目录、爬虫规则、日志来源及站点 `epoch` 控制状态。
- **ClickHouse 26.8** 保存宽表分析事实与原生小时级预聚合：
  - 宽表事实（`ReplacingMergeTree(_ver)`）：`ch_v2_logs`、`ch_v2_browser_events`，以及低频明细表 `ch_v2_event_data`、`ch_v2_revenue`、`ch_v2_heatmap`、`ch_v2_session_replay`、`ch_v2_session_data`、`ch_v2_session_link`。
  - 原生物化视图聚合（`Materialized View` → `AggregatingMergeTree`）：`ch_v2_log_hour_agg`、`ch_v2_log_path_hour_agg`、`ch_v2_observation_hour_agg`、`ch_v2_browser_path_hour_agg`，写入时由 ClickHouse 自动增量维护精确计数与 `uniqExactState` 基数。
- **采集与查询**：应用进程内置微批聚合写入器直接批量写入 ClickHouse（开启 `insert_deduplication_token` 幂等去重，默认不依赖 Kafka 或独立消费/快照 Worker）；统计页面、诊断观测、对账与摘要均通过无锁 PG 控制读取加 ClickHouse 同步直读返回，直接输出 HTTP `200`。
- **生命周期隔离**：站点重置（`reset`）或删除（`delete`）在 PostgreSQL 单事务内递增 `liekan_log_state.epoch` 并清理本地缓存，随后的读取立刻按新 `epoch` 隔离，ClickHouse 后台异步清理旧 `epoch` 分区/行；单会话删除同步清理对应会话并重建受影响小时的聚合桶。

## 服务与配置

仓库根目录的 `compose.yml` 组合应用与 ClickHouse 服务。ClickHouse 默认只在 Compose 内网开放，应用绑定 `127.0.0.1:3002`。入口代理与可信 IP 设置遵循 `docs/local-deployment.md`。

私有 `.env` 保存数据库密码、应用密钥、双重验证密钥和 ClickHouse 密码。升级或恢复时沿用原有 `.env`、Compose 项目名和数据卷，不要提交 `.env`、备份或导出数据。

主要配置：

| 配置 | 用途 |
| --- | --- |
| `LIEKAN_ANALYTICS_BACKEND=clickhouse` | 启用 ClickHouse 仓库后端 |
| `LIEKAN_WAREHOUSE_V2=1` | 启用原生 ClickHouse v2 引擎（默认 `1`） |
| `LIEKAN_CLICKHOUSE_URL` | ClickHouse HTTP 地址（默认 `http://warehouse-ch:8123`） |
| `LIEKAN_CLICKHOUSE_DATABASE`、`LIEKAN_CLICKHOUSE_USERNAME`、`LIEKAN_CLICKHOUSE_PASSWORD` | 独立 Liekan ClickHouse 库与凭据 |
| `LIEKAN_CH_CPUS`、`LIEKAN_CH_MEMORY` | ClickHouse 容器资源，默认 4 CPU / 4 GiB |
| `LIEKAN_CH_QUERY_MEMORY_BYTES=1073741824` | 单查询内存保护，默认 1 GiB，最小 64 MiB |
| `LIEKAN_CH_READ_CONCURRENCY=4` | 应用进程内 ClickHouse 读取并发，默认 `4` |
| `LIEKAN_EXPORT_DIRECTORY` | 完整导出与大结果归并的临时目录，容器挂载 `/app/warehouse-exports` 卷 |
| `LIEKAN_SEED_DEMO=true` | 首次安装自动导入官方示例“猎看官网（示例数据）”（`www.liekan.com`）；设为 `false` 可跳过 |

不要设置上游 `CLICKHOUSE_URL` 来启用本仓库架构，它保留给上游 Umami 的独立 ClickHouse 路径。

## 新安装与应用升级

主机需安装 Docker 与 Docker Compose V2（2.20.3 或更新）。首次安装时将 `env.example` 复制为 `.env`，分别为 `POSTGRES_PASSWORD`、`APP_SECRET`、`TWO_FACTOR_ENCRYPTION_KEY`、`LIEKAN_CLICKHOUSE_PASSWORD` 生成独立随机值（例如 `openssl rand -hex 32`），并将权限设为 `0600`：

```bash
docker compose up -d
```

Compose 会依次完成：
1. 启动 `db`（PostgreSQL）、`analytics-cache`（Redis）和 `warehouse-ch`（ClickHouse 26.8）。
2. 运行一次性初始化服务 `warehouse-init`（`scripts/liekan-warehouse-init.sh`）：执行上游 Prisma 与 Liekan PG 增量迁移，创建 `ch_v2_*` 表与原生 MV，并在首次安装且 `LIEKAN_SEED_DEMO=true` 时自动导入官方示例数据。
3. 启动 `app`、`log-worker` 与 `analytics-worker`。默认访问 `http://127.0.0.1:3002`，初始管理员账号为 `admin / liekan`。

官方示例遵守 `docs/default-demo.md` 的幂等与非重建规则：已存在或被修改的站点不会被覆盖；用户清空或删除官方示例后，系统保留修订标记，后续重启或升级不会自动重建。

源码升级时保留原 `.env`，在原目录运行：

```bash
git pull --ff-only && docker compose up -d
```

也可以使用可选部署入口脚本，在保留既有私有配置和数据库卷的前提下完成构建与升级：

```bash
python3 scripts/liekan-warehouse-deploy.py --mode fresh
```

## 已有 PostgreSQL 数据直接导入 ClickHouse v2

如需将现有 PostgreSQL 站点历史数据一次性导入 ClickHouse v2（支持全库或按站点过滤，采用 keyset 分页流式写入，自动触发 4 张原生 MV 聚合）：

```bash
# 仅初始化 ClickHouse v2 表与原生 MV
pnpm liekan:warehouse init

# 全库导入 PG 历史事实到 ClickHouse v2
pnpm liekan:warehouse import-pg

# 或仅导入指定网站
pnpm liekan:warehouse import-pg --website-id <WEBSITE_UUID>
```

常用维护命令（`pnpm liekan:warehouse <subcommand>` 或容器内 `node dist/liekan-warehouse-v2.mjs <subcommand>`）：

- `init`：幂等创建所有 `ch_v2_*` 表与原生 `Materialized View`。
- `seed-demo [--automatic]`：校验并导入官方示例数据。
- `import-pg [--website-id UUID] [--batch-size 5000]`：从 PG 流式导入历史日志与浏览器事件到 ClickHouse v2。
- `purge-site --website-id UUID --before-epoch N`：异步清理 ClickHouse 中小于指定 `epoch` 的历史数据。
- `rebuild-hour --website-id UUID --epoch N --hour ISO_UTC`：重建指定 UTC 小时的日志聚合桶。

## ClickHouse CPU 调度与诊断日志

随仓库提供的 `docker/warehouse/clickhouse.xml` 开启 ClickHouse 原生 CPU workload 调度，交互查询与后台导出按权重隔离；`docker/warehouse/diagnostic-logs.xml` 配置了系统查询日志与部件日志的自动 TTL 回收，避免诊断系统表无限增长。

单查询内存通过 `LIEKAN_CH_QUERY_MEMORY_BYTES` 控制，导出流式写入独立 `/app/warehouse-exports` 数据卷。生产容量规划应结合实际硬件、保留周期与并发负载进行基准压测，并按常规运维流程对 PostgreSQL 卷与 ClickHouse 卷（`liekan-warehouse-ch`）执行停机一致备份与独立恢复演练。
