# ClickHouse 版本：安装、迁移与运行

同机复制生产 PG 到独立测试环境，可使用 [在线备份、恢复与 CH 测试脚本](warehouse-same-host-test.md)，生产继续运行。

独立测试服务器的逐步操作见 [测试部署与 PG 迁移演练](warehouse-test-server.md)。当前候选版已整合公开 main `cf71de165ae275a4c624d0c36b6a8dfc82758264`，包括 robots 管理、存储清理和可选 CH 分析副本。支持截至 056 的旧 PG 源结构和截至 070 的 main 完整源结构，保留旧密封快照续传；迁移前仍必须校验完整账本和实际结构。

GEOInflow 的 ClickHouse 版本将日志、浏览器事件及关联分析证据放入 ClickHouse。PostgreSQL 继续保存账号、网站、团队、权限、配置、治理规则及运行控制。Apache Kafka（JVM / KRaft）持久保存采集输入，连续消费者按批确认和发布数据。

后台统计读取 CH 并发布报表，页面读取已发布结果；实时、访问记录和日志明细保持按固定边界读取。完整路径、权限、质量口径、历史未知状态和业务证明保留；排行榜不替代全量路径。系统没有单站 1 GiB、全局 8 GiB 或结果 2 MiB 的业务封锁线。真实资源不足、队列不可达、控制库切换等情况会如实返回失败或可重试状态，不返回伪造的统计结果。

## 服务与配置

仓库根目录的 `compose.yml` 组合应用与仓库服务。CH 和队列默认只在 Compose 内网开放，应用绑定 `127.0.0.1:3002`。入口代理与可信 IP 设置继续遵循 `docs/local-deployment.md`。

私有 `.env` 保存数据库密码、应用密钥、双重验证密钥和 ClickHouse 密码。升级或恢复时使用原有 `.env`、Compose 项目名和数据卷。不要将 `.env`、备份或导出数据提交到版本库。

主要配置：

| 配置 | 用途 |
| --- | --- |
| `LIEKAN_INSTALL_MODE=fresh` | 空库新装，分析权威直接为 CH |
| `LIEKAN_CH_QUERY_MEMORY_BYTES=1073741824` | 单查询内存保护，默认 1 GiB，最小 64 MiB；聚合、排序和关联在更低阈值落盘，不限制数据保留总量 |
| `LIEKAN_CH_READ_CONCURRENCY=1` | analytics worker 的 CH 读取并发。设为 `2` 可让不同站点的首次总览同时生成，最多同时计算一份近 30 天总览。常规刷新、自选区间和历史回填保持串行 |
| `LIEKAN_INSTALL_MODE=pg-transition` | 已有 PG 升级，完成明确切换前 PG 仍为权威 |
| `LIEKAN_CLICKHOUSE_DATABASE`、`LIEKAN_CLICKHOUSE_USERNAME`、`LIEKAN_CLICKHOUSE_PASSWORD` | 独立 Liekan CH 仓库 |
| `LIEKAN_QUEUE_PARTITIONS` | 首次创建输入主题时固定的分区数，默认 8；安装后不能直接改变 |
| `LIEKAN_CH_CPUS`、`LIEKAN_CH_MEMORY` | CH 容器资源，默认 4 CPU / 4 GiB |
| `LIEKAN_QUEUE_CPUS`、`LIEKAN_QUEUE_CONTAINER_MEMORY` | Kafka 容器资源，默认 2 CPU / 2 GiB；JVM 堆为 256–768 MiB，旧 `LIEKAN_QUEUE_MEMORY` 不再使用 |
| `LIEKAN_CONSUMER_CPUS`、`LIEKAN_CONSUMER_MEMORY` | 批量消费资源 |
| `LIEKAN_EXPORT_DIRECTORY` | 完整导出和高基数归并的临时目录；容器使用独立的 `/app/warehouse-exports` 数据卷 |
| `LIEKAN_EXPORT_MIN_FREE_BYTES=268435456` | 临时文件写入时保留的实际磁盘余量，默认 256 MiB，不是站点或结果总量配额 |
| `LIEKAN_SEED_DEMO` | 新装默认导入“猎看官网（示例数据）”；设为 `false` 可稍后手动导入 |
| `LIEKAN_WAREHOUSE_ANALYSIS_READS=1` | 使用覆盖已核验的分析数据；设为 `0` 后后台报表从原始权威事实计算，保留分析表和检查点 |
| `LIEKAN_WAREHOUSE_ANALYSIS_SITES` | 可选、逗号分隔的网站 UUID；非空时只对这些网站启用分析层读取，空值表示全部网站。构建和结果发布仍使用相同校验 |

这里的容器默认资源只是起始配置，不代表千万/亿级日志容量验收结果。内置队列为单节点，不能抵御整机或数据卷永久丢失；需要高可用时应单独部署多副本队列和 CH，并按实际负载验收。外部队列支持 `LIEKAN_QUEUE_TLS` 与 SCRAM 凭据；必须同步调整 Compose 内网地址配置。应用凭据除生产、消费权限外，还需要主题元数据和 `DescribeConfigs` 只读权限，安装账号需要创建主题权限。

不要设置上游 `CLICKHOUSE_URL` 来启用此版本，它对应另一套上游存储路径。Liekan 使用 `LIEKAN_CLICKHOUSE_URL`，并以 PG 中持久记录的安装身份和权威为准。

## ClickHouse CPU 调度

随仓库提供的 `docker/warehouse/clickhouse.xml` 使用 ClickHouse 原生 CPU workload 调度，开启 CPU 时间片抢占。总线程槽按可用 CPU 核数计算；发布、交互读取和后台报表／导出／维护的权重分别为 4、2、1，未标记查询属于 `default`。空闲份额可供其他类别使用，后台保留非零份额。配置不识别站点、URL 或爬虫名称，不增加单查询内存、并发或超时。

标准 Compose 挂载此配置。使用外部 ClickHouse 时，由管理员在专用实例上配置相同 workload 名称，或将这些 workload 接入现有资源树；不要用项目资源树覆盖共享实例的管理策略。可检查 `system.workloads`、`system.scheduler` 和查询日志中的 `Settings['workload']`。没有加载资源树时，仅传递 workload 名称不会产生 CPU 隔离；若外部实例启用了 `throw_on_unknown_workload`，须先配置名称再升级应用。已在项目固定的 ClickHouse 26.8 版本验证。

消费者在 Kafka 消息登记到持久工作表后通知所属分区处理，完成一批后将仍有工作的分区排到队尾。各分区保持单一执行者，总并发沿用原配置；不按站点或输入内容选择优先级。通知仅用于减少等待，周期性检查、持久检查点和租约接管仍负责漏通知、重启及失败恢复。后台报表遇到短暂的控制库繁忙或连接不可用时按原队列延期重试；真正的计算错误继续记录为失败。

该机制调度查询执行线程，不保证整个发布链路的延迟，也不调度 MergeTree 合并／mutation。既有查询内存、应用准入、后台构建节流和磁盘保护仍然生效。删除、发布和批次确认协议不变。调整部署配置后，应比较同负载下的前台延迟、发布延迟和后台最老任务年龄，避免只改善一类任务。

日志首页和游标翻页先读取物理候选的时间边界，再按输出方向读取互不重叠的小时窗口；匹配稀疏时扩大后续窗口，凑齐一页及额外一条后停止。每段先完成接受版本、删除、修正、分类及搜索过滤，再排序和截取。覆盖不足仍读权威事实；未接受候选只能扩大探测范围，不能进入返回结果。计数独立计算；直接跳页的 OFFSET 链接及导出保留完整有序查询。

## ClickHouse 诊断日志

执行器逐阶段明细默认关闭。需要定位一条查询时，可在该查询的会话临时设置 `log_processors_profiles=1`，再按 query ID 查 `system.processors_profile_log`。

`system.query_log` 保留执行前和执行中错误、耗时至少 1 秒的查询，以及按 query ID 稳定抽取的约 1% 快速成功查询，保留期均为 7 天。其余快速成功记录有 5 分钟临时保留期，后台 TTL 合并时回收。查询发起阶段默认不记日志。核算空间时，`system.part_log` 的 `NewPart` 字节反映首次写盘量，包含这些临时记录；实际占用可查 `system.parts` 的活跃部件。

堆栈日志、系统指标和查询指标保留 14 天；用于排查数据部件写入、合并的 `system.part_log` 保留 30 天。

已有安装首次采用此配置时，可在现有诊断表上先应用 `docker/warehouse/diagnostic-logs.xml` 中对应的 TTL 和表设置，保持表结构与下次启动配置一致。ClickHouse 遇到结构不一致会把原系统表重命名为带数字后缀的历史表；检查其保留策略并单独核对其中的诊断记录。修改大型系统表 TTL 时可设置 `materialize_ttl_after_modify=0`，已有部件随后在正常合并中逐步应用规则。`metric_log` 的表定义较大，修改此表时可对该次 DDL 使用 `max_query_size=1048576`。

## 后台报表、读取边界与准备状态

现有 analytics worker 定时生成总览、AI、访客、地域、来源、内容、转化和留存结果。今天、7 天、30 天及本月留存无需访问页面即可排期；今天每 10 分钟、7 天每 6 小时、30 天每 12 小时刷新；本月留存保持原有 30 分钟周期。按站点错峰，同一任务在租约有效时不会重入。筛选或自选区间未命中结果时登记后台任务。实时、会话和日志明细使用最近窗口或分页查询。

报表接口用 `200` 返回有效结果及统计截止时间。刷新期间保留同条件的有效结果，`meta.snapshot.state` 为 `updating`。没有可用结果时，接口立即以 `202` 返回 `{"status":"preparing"}`；已经登记的按需任务还会返回任务标识。页面显示“数据准备中，请稍后查看”，结束加载；不自动轮询、重试或在窗口聚焦时重新请求。“重新查看”读取状态和结果，不在请求内执行报表计算。失败且没有有效结果会返回错误，不能用准备状态掩盖失败。若当前区间尚无结果，可返回同站点、同条件、同控制版本下上一份有效结果，并明确标注实际统计区间和截止时间；不能把上一份结果标成当前区间。删除、权限或控制版本失效的结果不可回退。

总览的“今日总请求”统一读取同站点、同统计时区的“今天”预设已发布卡片。7 天、30 天和自选范围不重复计算或保存这项指标；读取时组合今日结果，UV、AI 请求和排行仍使用所选范围。这个计数沿用全站内容请求口径，不受报表搜索或爬虫筛选影响。卡片单独显示实际数据截止日期和时间，`meta.todayRequests` 描述该部分的范围、截止时间、状态及刷新周期。今天尚未生成时可以使用同控制版本下上一天的有效结果并展示真实日期；无结果或失败只影响这张卡片，不填零。读取时校验删除、策略及权限边界。切换总览区间会轻量重读已发布结果，浏览器不按 6/12 小时缓存今日卡片，也不因此启动重算或持续轮询。

普通新增只推进发布位点。一次查询固定同一位点；删除、清空、质量策略、排除项、目标和历史修正激活仍强制校验。缓存命中和返回结果都需要有效权限及控制版本。报表分页携带 `reportVersion`（兼容 `overviewVersion`），读取已经排序的同版本产物；版本失效返回 `409`，页面清空分页并回到第一页。日志各部分和访问分页使用 15 分钟有效的 `readBoundary`，过期或条件、控制版本变化后重新读取第一页。

升级自动应用 PG 增量迁移 `096_warehouse_report_boundaries.sql`，并创建 `warehouse_analysis_browser_v1`、`warehouse_analysis_log_v1`、`warehouse_analysis_visit_hour_v1`、`warehouse_analysis_coverage_v1` 和 `warehouse_report_rank_v1`。无需重新迁移 PG 事实到 CH。原始事实、账号、站点和数据卷保留。新分析层按小时核验覆盖，近 64 天可复用，较早或不完整的覆盖回到权威关系，由后台完成报表；64 天不是原始数据删除期限。

迟到事件、访问变化及证据修正会重建受影响小时。UV 使用精确去重状态，访问片段先合并再计算跳出和时长。候选构建核验后才发布；中断可重试，旧代次不能覆盖新控制版本。排行榜逐段保存完整顺序，单次构建有 128 MiB 临时产物保护，超限明确标记任务失败，不返回截断排名；它不限制原始采集或站点存储。未引用的旧派生产物在后台回收，读取引用及当前报表产物受到保护。

按站点启用可先配置 `LIEKAN_WAREHOUSE_ANALYSIS_SITES`，核对同边界的原始与分析结果，再扩展名单。发现分析层问题时设置 `LIEKAN_WAREHOUSE_ANALYSIS_READS=0`，使用原 Compose 项目重新创建应用和 worker；旧分析表、核验清单和采集数据均保留。该开关回退计算读取路径，不回退已升级的应用协议，也不会立即重算仍有效的已发布报表。

请求级 `Server-Timing`、`X-Liekan-Read-Id` 和 `warehouse-report-read` 日志可区分授权、准入等待、CH 执行、序列化及缓存命中。诊断只保留有限数量的 query ID，不输出 SQL 参数、访客内容或 IP。部署验收需分别测已发布结果读取、首次构建、持续刷新和对摄入的影响；小样本通过不代表亿级容量已验证。

## Kafka 持久化与原 Redpanda 安装

内置队列固定使用 Apache Kafka 4.3.1 JVM 镜像及 SHA-256，采用单节点 KRaft，无 ZooKeeper。`liekan-warehouse-queue` 卷挂载到 `/var/lib/kafka/data`；集群 ID 首次生成后与日志一起保留。两个临时配置目录使用 tmpfs，重启时重新生成，备份不保存它们。

输入主题和迁移结果主题均设置 `retention.ms=-1`、`retention.bytes=-1`、`cleanup.policy=delete`、`flush.messages=1` 和禁止不完整副本当选。生产者使用幂等生产及 `acks=all`；每批追加同步刷盘，应用成功响应仍需完整业务确认与发布。安装及连接时校验有效主题配置，不安全的刷盘、过期或压缩策略会拒绝启动。多副本主题至少要求两个同步副本确认；单节点仅能确认本机磁盘写入，不能保证磁盘永久损坏后的数据恢复。配置依据见 [Kafka 主题配置](https://kafka.apache.org/43/configuration/topic-configs/)。

内置同机部署将队列卷只读挂入应用，用 `LIEKAN_QUEUE_STORAGE_PATH` 读取文件系统实际可用空间。新输入每批写入前保留 5 GiB 余量；低于余量或挂载不可读时返回可重试失败，不删除未确认消息。已接收包的迁移结果流仍可完成，让消费者和安全回收继续推进。监控输出 `queue.storage` 的余量及输入状态。部署外部 Kafka 时需同时移除 `LIEKAN_QUEUE_STORAGE_PATH` 和该本地卷映射，由队列部署侧提供磁盘监控与背压；本地余量不能代表远程磁盘。

队列回收继续由已验证的消费、发布和恢复边界控制，禁止人工按时间删除未确认的消息。逐批刷盘增加磁盘 I/O，需要按实际批量与吞吐压测；大规模部署需另行规划副本、分区和独立资源。

**已有 Redpanda 仓库不能直接换镜像升级。** Kafka 无法继承其磁盘格式、主题 UUID 或未完成消息；部署预检及 Kafka 启动脚本都会拒绝采用旧卷。保留原栈及一致备份，另行制定队列迁移流程。尚未启用仓库的 PG 安装可在独立项目按下述流程迁移，无需先运行 Redpanda。此前只做了备份或 Redpanda 探测的同机测试，应保留旧项目，新建测试项目；不要删除旧卷或手改冻结状态来续跑。

## 新安装与应用升级

主机需要 Docker 和 Docker Compose V2（2.20.3 或更新）。若使用服务器自动日志采集，先按[自动日志接入说明](automatic-logs.md)准备签名资产。

首次安装时，在仓库根目录将 `env.example` 复制为 `.env`。为 `POSTGRES_PASSWORD`、`APP_SECRET`、`TWO_FACTOR_ENCRYPTION_KEY` 和 `LIEKAN_CLICKHOUSE_PASSWORD` 各生成一个独立的随机值，每次可运行 `openssl rand -hex 32`。将文件权限设为 `0600`。如果还要在宿主机运行开发工具，将 `DATABASE_URL` 中的密码同步为 `POSTGRES_PASSWORD` 的值。

```bash
docker compose up -d
```

Compose 构建应用镜像，等待存储服务健康，由 `warehouse-init` 执行迁移、初始化队列并导入官方示例。应用在初始化成功后启动，worker 等待应用健康。执行 `docker compose ps` 查看状态，执行 `docker compose logs warehouse-init` 查看初始化结果。默认访问 `http://127.0.0.1:3002`，首次登录账号和密码为 `admin / liekan`。

升级源码版时保留原 `.env`，在同一个目录运行：

```bash
git pull --ff-only && docker compose up -d
```

默认由 Compose 重新构建应用镜像并复用构建缓存。镜像变化时，Compose 替换应用和 worker，并让新版进程等待新版初始化成功。升级期间应用可能短暂停止服务。原来通过 PG 迁移安装的实例继续使用 `LIEKAN_INSTALL_MODE=pg-transition`。

使用本机已有的预构建镜像时，在 `.env` 将 `LIEKAN_APP_IMAGE` 设为该镜像的版本标签，并设置 `LIEKAN_APP_PULL_POLICY=never`，然后运行 `docker compose up -d`。

已有 PG 数据需要迁移到 CH 时，使用仓库的补充部署脚本：

```bash
python3 scripts/liekan-warehouse-deploy.py --mode pg-transition
```

此时启用持久队列和 PG 权威结果捕获，旧事实表加写入保护，防止旧程序绕过捕获。历史数据仍需按下一节迁移。脚本不会直接切到 CH，也不会删除 PG 原始数据。应用更新继续使用这次安装的原模式；完成迁移的安装会保留 CH 权威，不重建主题或重新开始捕获。

部署失败后保留已有数据和配置。修复错误后重试同一命令；不要启动旧版本写入进程去绕过新保护。

需要自动生成私有配置或在升级前核对现有存储容器时，也可以用 `python3 scripts/liekan-warehouse-deploy.py` 并沿用原安装模式。此脚本需要 Python 3。

部署脚本会核对既有 CH、队列和缓存容器的 Compose 配置，在发现不一致时退出，并保留原 PG 容器及其引擎版本。直接使用 Compose 时，已有存储服务会按所声明的镜像和配置进行协调。常规应用升级请保留现有存储镜像和配置。存储引擎升级按以下步骤处理。

需要更新这些存储依赖时，先完成一致备份，核对目标镜像的升级兼容性、原卷名和私有凭据，再停止全部入口与 worker。用与部署相同的 `--env-file`、项目名和 Compose override，只重建报错的非 PG 服务，例如：

```bash
docker compose -f docker-compose.liekan.yml -f docker-compose.warehouse.yml \
  stop -t 120 app log-worker analytics-worker warehouse-worker warehouse-transition warehouse-maintenance
docker compose -f docker-compose.liekan.yml -f docker-compose.warehouse.yml \
  up -d --no-build --no-deps --wait warehouse-ch
```

同一 Kafka 引擎的配置变化时将最后的服务名换为 `warehouse-queue`，缓存为 `analytics-cache`。此步骤不能用于 Redpanda 换 Kafka。不要把 `db` 加入重建命令，也不要删除数据卷。依赖健康后，重跑原安装模式的部署脚本，完成迁移检查并启动应用与 worker。磁盘扩容、数据引擎版本升级仍需按对应存储的运维流程处理。

## 历史 PG 迁移与切换

以下命令都通过同一组合配置运行。可先定义本地 shell 函数，简化调用：

```bash
dc() { docker compose -f docker-compose.liekan.yml -f docker-compose.warehouse.yml "$@"; }
wh() { dc exec -T app node scripts/liekan-warehouse-command.mjs "$@"; }
```

凭据由容器环境提供，命令输出不包含数据库密码。迁移前先备份，并确认所有采集都已进入新版入口。迁移与回退窗口内会暂缓历史修复、排除规则变更和部分维护操作；管理界面收到的暂缓状态不代表操作已经完成。

1. `wh preflight` 检查源表和字段映射。出现未知表或结构变更时停止，先补全映射。
2. 生成并保存一个 UUID 作为快照操作 ID：`wh barrier --kind snapshot --operation UUID`。命令记录队列边界 H。边界后的输入仍可留在队列，但不会混入这次快照。
3. `wh freeze --operation UUID`。若返回 `input-not-drained` 等状态，等待消费者处理后重试同一 ID。成功后入口暂时不可用；旧录屏收藏及修复上传的业务控制也会按批完成转换。
4. `wh snapshot-export --directory /app/warehouse-backups`。记录返回的目录、归档路径、SHA-256。该归档与控制边界属于同一个 PG 快照。
5. `wh snapshot-restore --archive 归档路径 --sha256 校验值 --directory /app/warehouse-backups --boundary 归档目录/archive.json`。程序新建源克隆、校验结构并加写保护；不会覆盖任何原数据库。记录返回的 `descriptor.database`。
6. 将克隆名传给登记/回填命令：

```bash
dc exec -T -e LIEKAN_MIGRATION_CLONE=liekan_snapshot_实际名称 app \
  node scripts/liekan-warehouse-command.mjs register
```

7. 记录返回的 `migrationId`，执行 `wh resume-snapshot --operation UUID` 恢复 PG 采集。此后新增的权威结果持久捕获，回填仍只读取不可变克隆。
8. 使用同一克隆名运行 `backfill --migration 迁移ID`。凭据先行，然后逐数据族分批复制和核验。中断后重试同一迁移 ID；页检查点防止跳过尾部或重复计数。独立复核使用 `verify --migration 迁移ID`。进度查询：`wh status --migration 迁移ID`。
9. `wh baseline --migration 迁移ID` 建立已核验的历史基线 O。复制进程只从 O 后的权威结果开始应用；快照中已有的累加计数不会再加一次。用 `wh transition-status` 检查进度，`wh sync` 可手动推进一批。
10. 生成新的切换操作 UUID，执行 `wh barrier --kind cutover --operation UUID`、`wh freeze --operation UUID`，等待发送、CH 应用和 PG 应用位点全部到达该边界，再执行 `wh switch --operation UUID`。条件未满足时程序拒绝切换；不能手动修改 authority 字段跳过检查。

每个边界操作都使用稳定 UUID。冻结前可以 `cancel-barrier --operation UUID`；冻结后用对应恢复或切换命令。遇到响应丢失，查询状态并重试原 ID，避免新建第二次操作。

`register`、`backfill`、`verify` 必须明确使用恢复出的克隆。其他控制命令仍针对现有业务库。恢复出的只读克隆用于完整审计，保留到升级验收完成；清理原始数据需要另外安排。

## 回退与结束过渡同步

CH 切换后的回退窗口内，PG 只应用 CH 已确认的权威结果，不重新做业务判定。需要回退时，使用新的操作 UUID 执行 `barrier --kind rollback` → `freeze` → 等待复制位点齐备 → `switch`。切换条件不成立时继续恢复同步，不能直接改配置读旧 PG。

确认不再需要在线回退后：

```bash
wh exit-begin
wh transition-status
wh sync
wh exit-complete
```

`exit-begin` 固定终止位点；`exit-complete` 仅在此前结果已排空且发布完成后成功。终止位点之后的新数据只进入 CH，PG 原始分析明细及结果日志不再随新访问增长。退出后不能使用旧副本直接回退；应依赖一致备份或向前恢复。

维护 worker 自动按安全位点回收已完成的工作控制记录与队列前缀。`wh reclaim` 可执行一批。失败重试不会重建已回收的旧工作；CH 的去重凭据及仍有引用的证明保持有效。

`wh retirement-preview` 只读列出旧 PG 明细和退役汇总的物理大小、估计行数、分区数量及入向外键，并检查迁移核验、写保护和过渡退出状态。需要保留业务元数据的表单独列出。预览不会执行清理，也不授权删除；确认备份和依赖关系后，再另行批准具体行或分区的清理。表结构继续保留以兼容业务模型。`wh help` 可查看全部命令。

## 监控、留存与磁盘

`wh monitor` 输出安装权威、队列积压、过渡复制位点、PG 大小和锁等待、CH 活跃 parts/物理字节及磁盘余量。物理行数包含版本和候选，不能当作 PV。PG 数据库大小不等于磁盘剩余空间；部署层还要监控数据卷、WAL、队列卷、备份卷和 inode。

应对持续增长：监控增长速度与预计耗尽时间，提前扩容，按已批准留存规则归档/清理。优先减少历史预热、离线任务和查询并发，保持采集与普通报表资源。真实磁盘不足仍可能导致写入失败，不能靠关闭磁盘保护换取虚假成功。

CH 证据、报表和关键词的完整 CSV 使用流式处理，需要保留完整数据的排序与连接会使用上述临时目录。页面的明细分页和全量卡片分别计算，翻页不会改变卡片的统计范围。临时磁盘不足或查询超时会返回明确错误，不返回截断后冒充完整的数据。应监控该卷的空闲空间与并发导出负载；完整来源证据字段、来源图和爬虫筛选目录仍保留原协议，不能只凭每页 20 行估算响应字节数。

已发布的会话删除、网站重置和网站删除会由维护进程分批物理回收；在途报表、GEO 证明和历史修复引用会阻止相关回收。会话删除保留必要的去重判定日志，旧 epoch 可在引用释放后回收。回收按表记录进度，失败可重试，迟到的旧写入仍受删除标记约束。`monitor` 显示待回收删除数量与最早时间。

本版本默认没有破坏性的 90 天 TTL。90 天是架构评估条件；历史明细、去重凭据、质量/GEO 证明、修复依据与引用关系需要一并确定后才启用数据清理。不能直接删除 CH 某张凭据/证明表，或只清空队列卷。普通 DELETE 也不保证立即向操作系统归还 PG 空间。

## 一致备份与独立恢复

使用停机备份，确保 PG 控制位点、CH 发布事实与队列未完成输入相互对应：

```bash
python3 scripts/liekan-warehouse-backup.py backup --directory /安全存储/本次备份 --restart
```

目标目录必须不存在。程序先停入口和 worker，再停存储服务，确认没有其他容器继续占用这些卷，再归档和计算 SHA-256。迁移归档卷、导出卷及只读配置文件一起保存，恢复时使用备份中的配置，不依赖原机器的文件路径。可写 bind mount、目录 bind mount 和未映射的 Compose secrets/configs 会中止备份，需要先明确它们的备份方式。默认还保存对应版本镜像。备份含敏感数据及私有配置，只能放在受控存储，建议离机加密备份。`--restart` 在结束后启动原容器；未指定则保持停止。任何未生成完整 `manifest.json` 的目录都不能视为完成备份。

恢复必须使用不同的新项目名：

```bash
python3 scripts/liekan-warehouse-backup.py restore \
  --directory /安全存储/本次备份 --project liekan-restore-check
```

程序校验归档，使用原版本镜像，只创建新的独立卷，保留队列主题身份、位点和未完成工作。它不会修改当前 `.env`，不会覆盖旧卷，也不会自动启动任何服务。生成的 `restore-项目名.compose.json` 含私有配置，默认移除所有宿主端口，并将所有恢复网络设为 Docker `internal` 桥接网络，阻止恢复副本访问外部服务。同时移除初始化服务及其启动依赖；核对目标环境后再补充 loopback 端口映射。外部网络、host/container 共享网络及 macvlan 等网络类型不支持直接恢复。

使用生成配置，以 `up -d --no-deps` 分别启动存储依赖、应用和 worker；不要重新运行 init。先检查 `monitor`、队列恢复、已知时间段报表和本地采集重试。恢复副本仍含原 Cloudflare 等凭据，出网隔离必须保留；仅隐藏宿主端口不能阻止 worker 修改真实 Zone 或 Logpush 任务。隔离验证时，外部健康检查、规则部署或数据下载报告不可达属于预期状态。

部分 Docker 环境不会为 `internal` 网络启用宿主端口映射，即使 Compose 中已经配置了端口。此时可通过 `docker compose exec` 在恢复容器内验证；需要浏览器访问时，从容器宿主机建立仅监听 `127.0.0.1` 的 SSH 本地转发，目标为恢复容器的内部 IP 和端口。Docker 运行在 Colima 等虚拟机中时，SSH 目标是该虚拟机。验证后关闭转发；不要为临时访问取消恢复网络的出网隔离。

真正需要由恢复副本接管服务时，先停用原安装的入口与所有 worker，再停止恢复副本的全部容器。确认要恢复外部集成的写权限后，生成接管配置：

```bash
python3 scripts/liekan-warehouse-backup.py activate \
  --directory /安全存储/本次备份 --project liekan-restore-check --confirm-takeover
```

命令只生成 `active-项目名.compose.json`，不会启动服务。它保留恢复卷与镜像，使用新的可出网网络；用该配置加 `up -d --no-deps --force-recreate`，依次启动存储依赖、应用与 worker，再核对外部连接、待处理任务和入口域名。原安装与恢复副本不能同时运行外部写任务。仅用于本地测试时，不执行 `activate`。冷备份应在兼容的 CPU 架构上恢复，不能混用不同时刻的 PG、CH 和队列归档。

备份工具支持 `--skip-images`，仅适合已另行保存全部对应镜像的环境。恢复缺失镜像时不会用新版本替代旧数据卷所需的引擎。

### 查询资源分配

查询内存预算独立于存储容量。默认 CH 容器为 4 GiB，报表与导出各有一个并发入口；调整查询预算或并发时，要同时为另一条读取通道、采集写入、合并和服务器缓存预留资源。小规格测试机上的超时或内存失败不能用于宣称已经达到日千万至亿条容量目标；生产容量验收应使用固定硬件和明确的并发、积压恢复及延迟目标。

读取层按原始逻辑主键选择已发布版本，保留空值、历史读边界和删除屏障。报表只聚合所需列；历史修复 JSON 中的字段先提取再参与版本聚合，完整证据仍按原格式保留。大关联提前落盘。上述资源保护不会根据站点累计数据量或旧派生账本关闭采集、总览或历史统计。

## 从可选分析副本或较早 CH 候选版升级

完整仓库接管采集后，旧可选分析副本停止读取、历史构建和普通维护；已登记的删除与周期扫尾由 analytics worker 继续处理。保留原 `LIEKAN_ANALYTICS_CLICKHOUSE_URL` 及对应服务，直到相关删除已处理、旧写入者已停止且按运维计划退役该副本。多个旧目标需要逐个恢复对应连接；不能通过清空 `pending_targets` / `sweep_targets` 跳过删除。管理页会提示仍未完成的清理及缺失的连接配置。独立测试时只能配置隔离副本，不能沿用生产连接。

PostgreSQL 的存储清理仍可回收无引用旧统计副本和已完成任务。CH 页面不使用原单站/全局空间额度；该清理也不删除 CH 分析明细。CH 留存与磁盘余量按仓库运维策略处理。

默认示例使用带目录证据的格式 2。已完成、已修改或已删除的旧示例保持原状；未完成的旧格式导入需先在对应旧版本上完成，再升级。自动启动在迁移切换期间跳过示例初始化，并遵守 `LIEKAN_SEED_DEMO=false`；管理员仍可在迁移结束后手动导入。
