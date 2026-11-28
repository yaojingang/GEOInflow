# ClickHouse 隔离协议原型

此目录验证混合批次的删除等待隔离、临时迁移结果链路的安全退出，以及它们直接依赖的去重、发布和故障恢复机制。第一轮数据由测试端生成；第二轮另使用服务器归档的隔离克隆与脱敏分析投影。它尚未接入产品采集接口，也不提供生产迁移命令。

## 隔离边界

- 固定 Compose 项目 `liekan_ch_proto_20261027`，三个独立持久卷，不使用 tmpfs，不挂载既有数据库。
- PG、CH 数据库名为 `liekan_ch_proto`。仅本机开放 PG `25439`、CH `28129`、Redpanda `29099`。
- 不读取根目录 `.env`，不使用生产连接串。测试 PG 在隔离网络中使用 trust。
- 启动测试前核对容器的 Compose 标签、卷名称、端口绑定和实际数据库名；每轮使用新的 `proto_*` 运行标识与主题，不清空已有运行的数据。
- 源码与依赖只读挂载给故障执行容器；可写挂载仅为已忽略的 `.local/ch-prototype/`。
- 镜像锁定到 digest 和 `linux/arm64`。此配置针对当前 macOS Docker 环境，其他平台需重新选择并记录镜像。

## 运行

以下命令从仓库根目录执行，仅作用于原型项目。端口被占用或容器标签不匹配时先排查，不改为连接已有服务。

```sh
mkdir -p .local/ch-prototype
npm ci --prefix experiments/ch-prototype
docker compose -p liekan_ch_proto_20261027 -f experiments/ch-prototype/compose.yaml up -d --wait pg ch redpanda
npm --prefix experiments/ch-prototype run typecheck
npm --prefix experiments/ch-prototype test
npm --prefix experiments/ch-prototype run test:clients
```

两个测试命令须顺序执行：它们会断开本原型 Redpanda 网络，不能与另一组测试同时运行。主实验还会终止本项目的 CH 进程及临时 actor 容器。

测试结束后可停止服务，保留持久卷供复核：

```sh
docker compose -p liekan_ch_proto_20261027 -f experiments/ch-prototype/compose.yaml stop
```

不需要运行主应用构建、产品迁移、演示数据导入或部署脚本。本目录使用独立的 `package.json` 和 `npm-shrinkwrap.json`，不会更改主项目锁文件。

根目录 `tsconfig.json`、`pnpm-workspace.yaml` 和 `.dockerignore` 仅增加对本目录的排除，避免原型成为主应用编译、依赖安装或生产镜像的一部分。

## 协议与预期

1. 输入事实进入 Redpanda。PG 只登记临时输入引用和处理状态，payload 留在队列；未判定的引用仍可恢复，不能据“已读取”位置清理输入。
2. 判定单元按站点和会话拆分。删除待定的单元暂停；其他站点的单元继续。同 UUID 依赖不能跨过暂缓项。重复请求引用的原会话也参与删除屏障。
3. CH 落地后核验内容，PG 短事务复核分区代次、站点 epoch、修订与删除状态后确认。失去所有权的写入不会参与凭据查找或查询发布。
4. 事件、属性、金额分表派生，发布清单选择唯一候选。清单核验后，以站点指针的条件更新发布；查询用集合成员过滤避免重复清单行放大计数。
5. 迁移期间，确认事务同时登记可补发结果。发送成功后才记进度，应用端按操作 ID 去重。会话被删除后，补发仍只读取已持久结果。
6. 退出时先关闭捕获并记录终止边界，旧代次发送者被拒绝；排空并确认应用完成后封闭结果链路，停用发送与清理主题、临时结果。已封闭但尚未完成清理的状态可重入恢复。

测试预期由输入事件账本和显式操作构造，不从被测事实表生成。报告包括原始事件 ID 集合、金额与属性断言的结果、故障点、镜像与设置。日志和 JSON 报告位于 `.local/ch-prototype/`，不会提交。

## 本原型的具体限制

- 输入读取采用有界重放（每主题少于 20,000 个位点），发布清单用完整小型快照；生产需要持续消费、范围检查点和清单压缩，不能照搬吞吐结论。
- 逐输入临时引用和尝试状态尚未实现生产级生命周期回收；落地表的凭据保护仅演示“拒绝过早回收”，尚未实现精简凭据迁出。
- 故障测试为进程 SIGKILL、网络断开和重连。Docker 虚拟机断电、磁盘损坏、多节点容灾均未验证。
- 主题按运行唯一命名，关闭自动建主题。第一轮 KafkaJS 主协议未集成 broker topic ID；第二轮将 Confluent 元数据探针接入主协议，验证同名主题重建后拒绝重放与删除激活。
- 影子表只保留验证所需字段。第二轮从备份实际视图投影当时的资格与规则信息；在线质量更新、完整会话状态、GEO 证据计数、历史修复及权限契约仍未接入。
- 第二轮验证了冻结备份克隆、选定分析字段的全量投影与断点续传。全部产品事实/凭据迁移、在线输入/结果/控制操作统一切换边界仍需完整迁移程序实现；不能据这些测试宣告全部 PG↔CH 切换已完成。
- 方案中的实验编号仅作需求对应。主测试通过不等于 24 项完整验收全部通过；历史迁移、容量和真实业务契约必须另行验证。

`clients.ts` 对 KafkaJS 与 Confluent 仅进行确认、重连、失败传播和禁止自动建主题的薄适配探针。正常传输探针通过不能证明网络超时后的端到端 exactly-once；业务去重仍由主协议负责。

## 第二轮：服务器备份与真实进程验证

第二轮使用 `PROTO_ROUND=2`、独立 Compose 项目 `liekan_ch_proto_round2_20261027`，端口为备份克隆 PG `25449`、实验控制 PG `25459`、CH `28139`、队列 `29109`。第一轮项目和产品数据库均不参与。当前配置针对本机备份路径；换机器前必须显式检查 `compose-round2.yaml` 的只读备份挂载路径。

第一轮的免密配置仅限本机隔离合成数据实验，禁止用于生产、共享环境或真实数据。第二轮的原始备份恢复库采用生成密码，目录权限为 0700，密码文件为 0600；恢复完成后设为只读，并使用无写权限的 `r2_reader` 提取分析字段。CH 分析投影和协议样本仅保留经过加盐散列的标识与路径，不投影账号、凭据、原始 IP 或完整 UA。原始归档只读挂载且不修改。测试卷与专用目录可持久保留用于恢复验证。

第二轮 PG 的 `max_wal_size` 设为 256 MB，以减少本机实验盘上的 WAL 留存；未关闭同步提交或 fsync。第二轮完整原始克隆位于 Colima 客体机 `/var/tmp/liekan_ch_proto_round2_20261027/source-pg-complete`；恢复使用一个 CPU、单任务顺序执行。原先中断的工作区内数据目录已经删除，不能按旧记录恢复使用。实验控制与 PG 对照表、CH、Redpanda 使用 Colima 客体机 `/var/tmp/liekan_ch_proto_round2_20261027/` 下的专用目录，位于与 Docker 数据盘分开的文件系统。该目录不得复用于生产。克隆和查询对照均使用客体机原生文件系统；它们仍共享本机 CPU 与虚拟机资源，本机耗时不代表生产性能。Redpanda 的存储要求不适用于 macOS 共享目录。所有输出均位于忽略的私有目录，不可提交。

安装依赖仍使用本目录的 `npm ci`：独立 shrinkwrap 明确锁定实验依赖，避免将其注册到主项目 pnpm 工作区。第二轮故障执行器是本机独立 Node 进程，加载本目录依赖并记录解析路径。主题身份使用 Confluent 原生元数据 API，因此依赖须在执行平台安装。第一轮容器 actor 已移除根 `node_modules` 的回退挂载。

第二轮验证按以下顺序执行，避免 PG 重启和故障注入相互干扰：

```sh
# 创建全新的隔离克隆；已有同名克隆时会拒绝覆盖。
python3 experiments/ch-prototype/round2-restore.py --backup-directory /path/to/verified-backup
PROTO_SOURCE_BACKUP=/path/to/verified-backup docker compose --env-file /dev/null -f experiments/ch-prototype/compose-round2.yaml up -d --wait control ch redpanda
PROTO_ROUND=2 node --import ./experiments/ch-prototype/node_modules/tsx/dist/loader.mjs experiments/ch-prototype/round2-prepare.ts
python3 experiments/ch-prototype/round2-sample.py
npm --prefix experiments/ch-prototype run test:round2
npm --prefix experiments/ch-prototype run test:round2-backfill
npm --prefix experiments/ch-prototype run test:round2-query
```

- `round2-prepare.ts` 必须核验同一克隆的完整恢复成功记录，之后冻结克隆，并设置只读角色。不会启动应用、任务执行器或外部通知。
- `round2-sample.py` 从归档只读提取 32 条浏览器事件并脱敏。修改样本的 UUID、来源或时序用于构造故障，不代表实际流量统计。
- `round2-integration.ts` 验证多进程所有权转移、跨分区同 UUID 并发、来源与范围冲突、CH SQL 可见性、真实 HTTP 回复与崩溃、无 UUID 语义、日志异步确认及同名主题重建。
- `round2-backfill-test.ts` 将备份分析字段分批投影至 CH，逐批校验摘要。提取器使用只读可重复读事务与有序游标，每批 50,000 行；重连时以已发布的源主键为下界重新打开游标，避免每页展开并扫描历史修复视图。源 SQL 的实验超时为 300 秒，故障点等待为 600 秒；这是单 CPU 克隆全量扫描的验证边界，不是线上请求时延目标。在 CH 写入后、检查点提交前杀死回填进程，重启本轮 PG，再从检查点续传。失败候选留在 CH 中，查询只选择已发布候选。CH 使用候选批次的 Bloom 跳数索引辅助校验，摘要比对仍逐批执行；PG 对照表每次写入 5,000 行子批，全部子批与该页检查点在同一事务提交，避免一次展开 50,000 行 JSON 的内存峰值。
- `round2-query.ts` 对照备份原有有效视图、PG 实验投影和 CH 查询。删除、epoch、发布候选与资格过滤均在数据库内执行，并记录五次本机查询样本。

这些程序验证冻结备份的分析投影与故障协议。完整产品 schema、在线增量捕获启用与切换封口、全部查询消费者、GEO 和历史修复仍属于正式升级交付。PG 实验对照表只是验证设施，不能据此推导为最终长期双写架构。当前发布清单与删除集合有界，生产规模下的压缩、索引和生命周期仍需实现及容量验收。

这套固定命名的环境用于本轮隔离验证。完整回填结束后，没有待续传页面，故障回填命令不能当作重复运行的冒烟检查；脚本不会自动清空已完成的克隆或对照表。后续独立实验应使用新的隔离环境，并重新记录源归档、目录、端口和成功证据。

## 正式实施前定向补测

`npm --prefix experiments/ch-prototype run test:proof` 只使用第二轮 control、CH 和队列服务，不启动或访问备份源库。每次生成新运行标识；合成页使用独立的 `r3_*`、`proof_facts` 表，不改原有投影或检查点。需要 Node 22。按顺序运行，每个子进程限时两分钟，全组十分钟。

严格路由实验锁定主题 ID、分区数与路由版本；同 UUID 按站点与凭据键路由，无 UUID 按站点与会话路由。同键判定在分区控制锁下登记为单个在途工作，错误路由留下隔离引用。仅严格模式取消站点普通确认版本的相等比较，所有权、epoch、策略/删除修订和提交版本顺序保留。旧实验模式继续验证跨分区错误输入的保守防线。

补测覆盖同站点不同分区并发、同所有者内同键重试/冲突、无 UUID、接管/重置、错误路由、默认 HTTP 路由、子批中断、提交前中断、提交成功但回复丢失和同主题扩分区。提交回复丢失通过本机 TCP 代理截获服务端 `CommandComplete(COMMIT)` 后断开实现；不是提交前杀进程的替代用例。重试须识别原检查点与候选，逐项核对 12,000 个 ID。

`PROTO_PROOF_FILTER` 可限制复跑范围，未运行项在报告中标为 `not-run`。报告保留失败和修正后运行，不视为正式产品、全量迁移或容量验收。
