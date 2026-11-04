# 同机在线备份、独立恢复与 ClickHouse 测试

`scripts/liekan-warehouse-test.py` 将现有 PG 版本复制到同机的独立测试环境，自动执行备份、恢复、增量迁移、PG → CH 回填核验和测试切换。生产服务继续运行，生产代理与采集地址保持原状。

源端只执行容器检查、只读 SQL 和 `pg_dump`。所有初始化、冻结、迁移、切换与停止操作都限定在带本次运行标记的测试资源中。脚本不会删除旧 PG 数据，也不会把生产流量导入测试。

## 前提与边界

- 在生产目录以外的独立 CH 候选源码目录运行；必须包含本脚本及配套 Compose、迁移和部署文件。运行期间固定版本，不在这个目录拉取更新。
- Linux Docker Engine **26.1.4 或更新版本**，Python **3.8 或更新版本**，Docker Compose v2 支持 `!override`、`config --hash`、`up --wait`。脚本不升级或重启 Docker。较早的 26.0.0/26.0.1 存在关闭 IPv6 仍可能可达的缺陷，不纳入支持范围。
- Docker 版本满足要求不代表宿主内核也已通过验证。旧内核机器先运行程序版本检查，再用下文 `check-storage` 验证完整服务健康；这两项通过仍不能代替实际容量验收。
- 源服务是仓库 Compose 中正在运行的 `app`、`db`，PG 为 12–16。脚本核对应用连接确实指向选定容器，不支持外部托管 PG、未知连接覆盖参数或已经安装完整仓库的源系统。后者不能只复制 PG，需另做一致备份方案。
- 源应用必须保留原 APP_SECRET 和 2FA 密钥。脚本只复制身份/加密所需的密钥白名单，为测试 PG、CH 生成独立密码。不会复制生产 PG/CH/队列连接或整个 `.env`。
- 同机仍共用 CPU、内存和磁盘 I/O。在线备份不要求停业务，但会扫描生产数据；请在低峰运行，并预留恢复 PG、只读源克隆、CH、两份归档、队列、临时文件和镜像的空间。`plan` 输出的是源码目录所在文件系统的空闲量，不能代替 Docker 数据卷/WAL 所在盘的检查。
- 测试网络始终使用 `internal` 并关闭 IPv6。Docker 26/27 设置 `com.docker.network.bridge.inhibit_ipv4=true`；28 及以上使用 `isolated` 网关模式。两种方式均不为测试桥接接口分配宿主机地址，且不设置外部默认网关；应用和数据库不发布端口。选定模式会冻结并在续跑时核对，不会降级到普通 `internal` 网络。外部 AI、CDN、代理控制、地理库下载等能力在此环境不可用。地理库缺失不阻断事件采集。
- 脚本默认构建独立测试镜像；测试镜像标签不会覆盖线上标签。可用 `--app-image` 复用已在本机构建、与候选源码兼容的 GEOInflow 镜像，仍会复制为本次独立标签。需要测试服务器采集器安装时，先按 [自动日志文档](automatic-logs.md) 准备签名资产。

## 一次执行完整流程

下面假设独立源码位于 `/opt/geoinflow-ch-test`，生产容器为 `liekan-app-1` 和 `liekan-db-1`。先在服务器查看实际名称：

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}'
cd /opt/geoinflow-ch-test
python3 scripts/liekan-warehouse-test.py --help
```

只读预检：

```bash
python3 scripts/liekan-warehouse-test.py plan \
  --source-app liekan-app-1 \
  --source-db liekan-db-1 \
  --project geoinflow-test-ch
```

执行完整流程：

```bash
python3 scripts/liekan-warehouse-test.py run \
  --source-app liekan-app-1 \
  --source-db liekan-db-1 \
  --project geoinflow-test-ch
```

项目名必须以 `geoinflow-test-` 开头。发现同名但没有本次运行标记的容器、网络、数据卷或非空目标库，会拒绝使用。脚本不会自动接管或清空这些资源。

Docker 地址池耗尽时，选择一个与现有 Docker 网络和主机路由均不冲突的私有网段，在首次 `plan`、`run` 中增加，例如：

```bash
python3 scripts/liekan-warehouse-test.py plan \
  --source-app liekan-app-1 --source-db liekan-db-1 \
  --project geoinflow-test-ch --subnet 10.253.80.0/28
```

脚本检查 Docker 网段重叠；主机/VPN/机房路由仍需自行核对。不要直接照抄示例网段。首次执行后网段、源容器 ID、配置和镜像身份会保存，续跑沿用原记录。

## 自动执行的阶段

| 阶段 | 执行内容 |
| --- | --- |
| 准备 | 校验源容器配对、数据库版本、测试资源归属；冻结配置，生成私有测试密码 |
| 在线备份 | 在源 PG 容器执行只读 `pg_dump`，保存 custom-format 归档、SHA-256 与完成回执 |
| 独立恢复 | 启动全新测试 PG；在一个事务里恢复数据和完成回执；校验原迁移账本 |
| 测试部署 | 独立 CH、队列、缓存与 worker；增量升级测试库，建立过渡安装身份 |
| 源快照 | 只冻结测试采集边界，导出测试 PG，建立不可变源克隆 |
| 迁移核验 | 登记固定迁移 ID，分批回填 26 类事实，独立核验并建立基线 |
| 测试切换 | 排空测试边界，切换 CH，执行 `exit-complete` 结束测试库的过渡结果同步 |

最终预期为 `authority=clickhouse`、`transition=exited`、复制流 `state=closed`。此后新增测试分析事实进入 CH，PG 保留账号、权限、配置和运行控制。旧测试 PG 明细和迁移克隆仍保留，不自动回收。

恢复的是 **pg_dump 快照时刻** 的生产数据。生产后续新增数据不会自动进入测试；这不是持续复制。希望再取一份新数据时，用新的测试项目名启动另一轮。

也可以分阶段执行，检查后再继续：

```bash
# 只备份，不创建测试容器
python3 scripts/liekan-warehouse-test.py run \
  --source-app liekan-app-1 --source-db liekan-db-1 \
  --project geoinflow-test-ch --until backup

# 恢复和部署完成，暂不执行历史迁移/切换
python3 scripts/liekan-warehouse-test.py run \
  --project geoinflow-test-ch --until deploy

# 使用同一份备份和已完成检查点，继续到 CH 切换并结束过渡同步
python3 scripts/liekan-warehouse-test.py run --project geoinflow-test-ch
```

`--until deploy` 只是暂停点。若本轮已完成 CH 切换，该选项不会把它切回 PG。完整执行默认结束测试环境的在线回退窗口；若需专门演练回退，停在 `--until deploy`，另按 [迁移手册](warehouse.md) 在该独立测试配置中执行。

## 备份完成后更新镜像与检查服务

源代码包升级了 CH 安全版本、或需要通过其他镜像仓库获取相同内容时，可在 **只完成 backup、尚未构建应用或创建测试容器/网络/数据卷** 的阶段更新镜像配置。先安装配套更新文件并下载指定摘要的镜像，再执行：

```bash
python3 scripts/liekan-warehouse-test.py refresh-images \
  --project geoinflow-test-ch \
  --clickhouse-image 'clickhouse/clickhouse-server:26.8.36.3@sha256:d426d2f612e1e189c90f9a3f8dcd85a03c6851273833817a296bb327e63aa7a7' \
  --queue-image 'apache/kafka:4.3.1@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837'
```

**这个命令只更新相同引擎的镜像，不把旧 Redpanda 项目转换为 Kafka。** 若旧项目已生成 Redpanda 配置或探测卷，保留旧项目及备份，选择新的 `geoinflow-test-*` 项目名重新 `plan` / `run`。不要修改旧状态摘要、重用队列卷或删除备份。

两个镜像参数仅供 `refresh-images` 使用；可以替换仓库地址，必须保留受认可的 `@sha256:`。命令会检查镜像已下载，重新核验备份 SHA256、大小、完成回执与来源身份，并比较新旧 Compose 模型。只有 CH 和队列的镜像字段可以改变；端口、密码、卷、网络、命令或其他部署文件变化会被拒绝。

更新先保存新的版本化配置文件，再原子提交状态指针；原配置和备份保留。中断后可以重跑同一命令，已经完成的同一更新不会重复写入。这个入口不适用于已经部署的测试环境；不要手工修改状态摘要来续跑。

恢复数据库之前，执行服务健康检查：

```bash
python3 scripts/liekan-warehouse-test.py check-storage --project geoinflow-test-ch
```

它仅在测试网络中启动 CH 和队列，等待最多 300 秒的 Compose 健康检查，不构建应用、不启动 PG、不导入备份。成功或失败后都会尝试停止通过归属校验的这两个测试容器，并保留测试卷与备份。若发现配置或资源归属被修改，停止操作也会被拒绝，需按错误检查现场。成功后再运行 `run --until deploy` 继续恢复和部署。

检查会创建测试资源，因此应先完成 `refresh-images`。检查成功不等于旧内核已获厂商支持，也不证明大数据量写入与查询性能。

## 访问测试页面

先在服务器单独一个终端运行本地转发，保持该终端打开：

```bash
cd /opt/geoinflow-ch-test
python3 scripts/liekan-warehouse-test.py serve --project geoinflow-test-ch
```

然后在自己的电脑运行 SSH 隧道：

```bash
ssh -N -L 127.0.0.1:3003:127.0.0.1:3003 root@服务器地址
```

浏览器打开 `http://127.0.0.1:3003`，使用备份里的原账号和密码。脚本不会重置管理员密码。`serve` 仅监听服务器的 `127.0.0.1`，通过固定测试 App 容器 ID 转发字节，不接入生产网络或配置 Nginx。

若服务器 3003 端口已占用，`serve --port 3004` 可换端口，SSH 的远端目标同步改为 `127.0.0.1:3004`。转发最多允许 16 个活跃连接，空闲连接超时 120 秒。Ctrl-C 只结束转发；测试服务继续运行。服务重建后重新启动 `serve`，以绑定新的容器 ID。

## 查询、停止与续跑

```bash
python3 scripts/liekan-warehouse-test.py status --project geoinflow-test-ch
python3 scripts/liekan-warehouse-test.py stop --project geoinflow-test-ch

# 重启已部署的测试服务，继续保留此前迁移进度
python3 scripts/liekan-warehouse-test.py run --project geoinflow-test-ch --until deploy
```

`stop` 只停止校验归属后的测试容器，保留所有卷和备份。脚本没有删除数据、删除卷、清空线上表或切换生产入口的命令。

同一项目的运行管理命令使用独立文件锁，不会并发修改检查点。`serve` 使用另一把锁，不阻塞 `status` 或 `stop`。普通中断后重跑原命令，已完成备份和恢复不重复执行；不完整备份重用一个自有临时文件，避免反复中断堆积副本。

以下情况会保留现场并停止，需要核查后再继续：

- 归档或克隆创建后响应丢失，且找不到有效完成回执：不能盲目创建第二份克隆。先核对保留的归档与描述文件；脚本不会自动改写检查点。
- 首次准备失败，仅留下无状态的配置目录：修复 Compose/配置问题后换一个新测试项目名；不自动删除未完成目录。
- 源码、冻结配置、只读依赖文件、镜像或资源归属改变：保持原版本完成本轮，或使用独立项目重新演练；不要绕过校验修改校验值。
- 目标库非空且没有匹配的恢复回执：拒绝覆盖。恢复回执与数据在同一事务提交，避免中断后把半份数据当成成功。

私有材料都位于 `.local/<测试项目名>/`，包括备份、加密密钥、配置、运行状态和迁移回执。目录权限默认为 700，文件为 600。Docker 数据卷也含真实数据；不要提交、公开或将目录放到 Web 根目录。脚本的错误输出只保留阶段和安全错误码，不打印密钥、完整 SQL 错误或访客数据。

## 核验范围

单元回归可执行：

```bash
python3 tests/liekan/warehouse-test.test.py
```

实际服务器还应核对原服务容器未重建、测试账本完整、CH 事实数量和原备份相符、原账号可登录，并按实际容量观察 CPU、内存、磁盘与查询耗时。小数据链路通过不等于大库性能验收。

基础机制参考：[PostgreSQL 在线 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)、[Docker 桥接选项](https://docs.docker.com/engine/network/drivers/bridge/#options)、[Docker isolated 网关](https://docs.docker.com/engine/network/port-publishing/#gateway-modes)。
