# 本地安装、体验与恢复

产品显示名称为 GEOInflow，界面版本 v1.2 对应工程和镜像版本 1.2.0。`liekan` 命令、镜像仓库名、Compose 项目、数据卷与环境变量沿用原标识。升级已有实例时保留运行中的数据库大版本和私有配置，仅更新应用与后台处理服务。

## 一键部署

安装并启动 Docker 与 Docker Compose 后，在项目根目录运行 `sh scripts/liekan-deploy.sh`。服务器无需安装 Node.js 或 pnpm，镜像内使用固定版本完成构建。首次运行生成权限为 0600 的 `.env`，分别创建独立随机数据库密码、应用密钥和 2FA 密钥；配置与密钥不会打印。随后构建镜像、启动服务并等待健康检查。应用默认绑定 `127.0.0.1:3002`，公网通过反向代理配置域名与 HTTPS。

重复执行保留 `.env` 和已有数据库、账号与自定义密码。检测到既有数据库卷却没有 `.env` 时停止，要求恢复原配置，避免替换旧应用与 2FA 密钥。部署失败保留已生成配置供重试。构建依赖 Docker 镜像源与依赖下载源可达；脚本不会安装或调整宿主机的 Docker、反向代理与网络。

升级时按当前 Compose 项目识别已有数据库与缓存容器，保留其容器、镜像、配置和数据卷。已停止的原容器会先启动并通过健康检查；依赖服务异常时停止应用更新。已有数据库卷且原容器缺失时，在构建前停止，需按原 PostgreSQL 大版本恢复容器。首次安装按 Compose 默认版本创建数据库，缺失的缓存单独创建。应用通过健康检查后更新后台处理服务。直接执行全栈 `docker compose up` 会绕过这些升级保护，请使用上述部署脚本。

每次部署先构建独立候选，再锁定该镜像的不可变 ID。app、log-worker 和 analytics-worker 均使用这个 ID，并核对容器实际镜像、版本标签与健康状态；worker 在启动领任务前完成镜像核对。app 的启动、迁移与首次示例导入最多等待 30 分钟，worker 最多等待 300 秒。版本不一致或健康检查失败时，脚本显示对应服务并停止后台处理服务；构建或依赖准备失败时，原应用与 worker 继续保持原状。私有临时 Compose 文件只覆盖本次候选镜像，部署结束后删除，已有 `.env` 和基础配置定制继续保留。

Git 工作目录的构建标签记录实际 HEAD，未提交的产品文件同时带有 `dirty` 标记和差异摘要，摘要覆盖未忽略的新文件，输出中只显示摘要。密钥、依赖目录和本地运行输出不进入来源摘要。源码压缩包无需安装 Git，来源版本记为 `unknown`，一致性仍以镜像 ID 为准。历史镜像的缺失版本标签与 `development` 均按未知来源处理，版本标签本身无法证明镜像一致。

## 地理数据自动准备

首次构建默认自动下载 [DB-IP City Lite](https://db-ip.com/db/download/ip-to-city-lite) MMDB，无需注册账号或提供下载密钥。该免费库每月更新，覆盖和精度有限，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可；产品与分享页面保留 DB-IP 署名链接。文件保存为兼容的 `geo/GeoLite2-City.mmdb`，镜像中包含该文件。没有本月发布包时尝试上个月的版本。

已有有效城市库优先复用，构建不会自动覆盖。下载与解压使用临时目录，完整文件通过 MMDB 类型校验后原子替换。下载失败会停止构建，避免缺库结果进入成功镜像缓存；网络恢复后重跑同一部署命令即可。运行时文件缺失、损坏或显式跳过准备时，应用继续采集浏览事件，无法确定的国家、省份和城市保持缺失；代理提供的地域信息继续正常使用。缺库重试最多每分钟一次，并共享并发打开请求，避免逐个访问产生错误日志。

需要 MaxMind 时，可直接将按其条款取得的 City MMDB 放到 `geo/GeoLite2-City.mmdb`。自动准备也支持在私有环境中配置 `MAXMIND_ACCOUNT_ID` 与 `MAXMIND_LICENSE_KEY` 后执行 `pnpm build:geo`，使用官方认证地址和重定向下载。只配置 License Key 会失败并提示检查配置；自定义授权 HTTPS 地址通过 `GEO_DATABASE_URL` 指定。自定义下载失败返回非零状态，保留原文件，凭据不会输出。Docker 构建不接收或保存 MaxMind 密钥；预先准备的文件随构建上下文进入镜像。MaxMind 数据更新和分发遵循 [官方条款](https://www.maxmind.com/en/geolite/eula)。

库版本随构建镜像固定。需要更新时替换源文件并重建镜像；自动下载的镜像在重新执行地理准备的构建层时取得当月版本。`SKIP_BUILD_GEO=1` 可用于离线验收，跳过准备仍会创建 `geo/`，不会阻断镜像文件复制。

Alpine 包下载显式使用构建代理的小写变量，Node.js 构建步骤启用环境代理支持，保留官方 HTTPS 地址及证书校验。城市库下载每个版本最多等待十五分钟，以容纳较慢网络。运行镜像的系统包安装层位于产品版本参数之前，可在不同候选之间复用；代理仅传入下载步骤，不保存为应用环境变量。

源码构建前运行 `sh scripts/liekan-deploy.sh --check`。部署脚本要求 Docker 总内存至少 6 GiB，建议 8 GiB 或以上、2 个 CPU 或以上，并预留空闲内存；该门槛用于构建保护，运行容量按真实负载实测。小内存机器可使用独立构建机生成的同一提交镜像。详见 [环境要求](deployment.md#环境要求)。

Next.js 构建使用两个静态生成工作进程。Docker 构建同时限制 Rayon 线程数为 2、Node 堆为 3072 MiB，为完整类型检查保留空间；构建机器还需为系统、原生编译和其他运行服务预留内存。这些 Docker 构建环境变量不传入运行容器。线程设置依据 [Rayon 官方说明](https://docs.rs/rayon/latest/rayon/struct.ThreadPoolBuilder.html)。资源检查需结合 Docker 虚拟机总量，逐个容器的使用率不等于虚拟机整体占用。

## 手动开发与本地验收

手动开发与验收要求 Docker Desktop、Node.js 22.23.4、pnpm 12.3.4。应用 http://127.0.0.1:3002，专用 PostgreSQL 在本机 15435，新卷 liekan_liekan-data。原 Umami 的 3001 入口和 umami_umami-db-data 卷保持独立。

手动安装时复制 env.example 到 .env，替换随机密码与密钥，文件权限设为 0600。迁移已有 Umami 数据时沿用原 APP_SECRET 与 TWO_FACTOR_ENCRYPTION_KEY，避免既有会话、身份标识和 2FA 加密数据失配。DATABASE_URL 指向新的副本，所有备份与配置都不纳入 Git。

开发时安装冻结依赖、生成 Prisma 客户端、生成 OpenAPI/SDK 并构建工作区包。先执行上游 `pnpm db:migrate`，再运行 `pnpm liekan:migrate`。`pnpm liekan:seed-demo` 从仓库内的示例数据包创建“猎看官网（示例数据）”，保持已有管理员密码。数据包可离线导入，详情见 [默认示例说明](default-demo.md)。

Docker 首次启动会在迁移后自动导入完整官方示例。手动开发或需要显式重试初始化时，可执行：

```sh
docker compose -f docker-compose.liekan.yml exec app node scripts/liekan-seed-demo.mjs
```

默认示例随源码和镜像分发完整脱敏数据包、目录与 SHA-256 清单。重启和升级保留已有数据、自定义资源、清空与删除状态，重复初始化不会重建已删除的示例。

构建自动准备地理库，也可优先使用已获授权的本地 City MMDB。首次安装先运行独立数据库并完成迁移和演示站接入，再将已审查代码提交。完整验收会生成带候选 SHA 的镜像。完成验收后，统一通过部署脚本构建本次候选并核对三个服务，已有数据库和缓存继续使用原容器。

```sh
pnpm liekan:verify
sh scripts/liekan-deploy.sh
```

启动依次检查并应用 Umami 迁移、应用 Liekan 校验和迁移、初始化官方示例、准备队列、更新 tracker 文件、启动服务器。首次安装的默认用户名为 `admin`，密码为 `liekan`。Liekan 的第 5 项迁移仅更新身份、名称、角色及密码摘要仍与上游初始管理员完全一致的有效账号，保留自定义密码、改名账号和已删除账号。迁移账本保证后续重启保留用户修改后的密码。已有账号继续使用其设置的密码。

完整验收的镜像构建沿用环境中的 HTTP_PROXY、HTTPS_PROXY 和 NO_PROXY；macOS 的回环代理地址转换为 Docker Desktop 的 host.docker.internal。可用 LIEKAN_DOCKER_HTTP_PROXY / LIEKAN_DOCKER_HTTPS_PROXY 单独指定容器可达的构建代理。代理值通过构建进程环境传入，命令参数只带变量名，最终应用不配置这些构建代理；官方组件来源和 HTTPS 校验保持有效。Prisma 的代理支持见 [官方说明](https://www.prisma.io/docs/orm/v7/reference/environment-variables-reference#proxy-environment-variables)。

每次升级先按 [部署指南](deployment.md#备份与升级) 导出数据备份，保存原 `.env` 和定制过的 `docker-compose.liekan.yml`，并记录镜像 SHA、代码标签和迁移版本。启动新版本后检查登录/2FA、网站切换、人类指标、日志导入、目录管理、目标、CSV 与数据总量。应用回退须保留当前分享实时授权层，并验证分享停用、密码变化和范围收缩；已记录的旧镜像需要完成这些适配后再启用。若迁移改变数据或不向后兼容，需要从备份恢复至新的卷再验证。删除数据库卷、清空数据和重置历史均需要明确授权。

公开分享密码请求内容上限为 1 KiB。验证在 60 秒窗口内限制每客户端/分享 5 次、每分享 60 次、每应用 120 次，成功和失败均计入次数，每进程最多同时验证 4 个密码。达到限制返回 429 和 Retry-After；拒绝请求保持原窗口到期时间。未配置 Redis 时使用有容量上限的进程内计数，多实例部署需共用 Redis 与 APP_SECRET，并配置代理正确传递客户端地址。Redis 不可用时返回 503 和重试时间，保留密码验证保护。计数键使用摘要，保持原始客户端地址不被记录。

Compose 使用专用 10.253.30.0/24 网段。其他机器部署时核对该网段与既有网络，冲突时在 Compose 中改为已核验的空闲网段。临时验收从 10.253.31.0/24 到 10.253.254.0/24 中选择与现有 Docker 网络没有重叠的网段，避免默认地址池耗尽；用完清理本次网络。构建结果默认只保存在本机，未发布到镜像仓库。

完整验收默认使用临时 3302 端口；并行运行时通过 `LIEKAN_ACCEPTANCE_PORT` 选择空闲端口，API、视觉验收及覆盖率结果使用同一地址，始终绑定 `127.0.0.1`。源数据库只导出备份，API 回归与延迟加载、跨空间工作台保存、网站切换、分享列表、目标创建交互在本次创建的空库执行。恢复副本核对业务总量、角色、目标、已有 2FA 密文和迁移校验和，再完成原型视觉验收。成功后清理临时容器、数据库卷和网络，备份及脱敏报告保留在被 Git 忽略的私有 `outputs/acceptance-*` 目录。验收失败时体验服务继续运行当前镜像。固定版本标签已有镜像时先核对 image ID，保留旧版本用于恢复。

空库验收使用独立临时密钥启用 AI 模块，以创建页面检查需要的真实对话记录；模型连接保持空状态。恢复副本沿用源环境的 AI 开关和加密密钥。

后台完整登录状态从登录时起保留 90 天，浏览器使用现有持久存储保存登录凭据；重新打开登录页时先核验当前身份，验证成功后进入工作台。普通登录、完成双重验证和 Redis 会话使用相同期限，双重验证的待验证凭据仍为 5 分钟，SSO 保留提供方指定的较短期限。历史登录凭据按原签发时间计算 90 天上限；退出、密码变更和账号删除继续生效，临时网络或服务故障保留浏览器凭据。升级与重启沿用 APP_SECRET。同一浏览器内 localhost 与 127.0.0.1 使用独立的登录存储，清除站点数据或关闭无痕窗口后需要重新登录。


## 网站清空与删除

网站清空和删除在同一数据库事务内按每批最多 5000 行处理依赖数据。事务开始时核验当前操作人的权限，并持有网站、账号和团队权限锁直到提交；网站转移、撤权和浏览器采集与该锁协调。清理使用独立的 10 分钟总预算，每条 SQL 最多执行 30 秒。任一批次或最终提交失败时整笔事务回滚，已保留的数据可在排除故障后重试清理。反向代理的请求期限需覆盖预期清理时间。

数据库回归测试使用专用本机空库 `lifecycle_test`。设置 `DATABASE_URL` 和 `LIEKAN_WEBSITE_LIFECYCLE_TEST=1` 后运行 `pnpm exec vitest run src/lib/liekan/upstream/website-mutation.integration.test.ts --maxWorkers=1`；测试在随机独立 schema 内应用迁移、生成合成数据并清理该 schema。测试覆盖多批数据、超过原 30 秒期限的操作、网站转移与撤权、采集锁、失败回滚、软删除和 robots 回滚引用。

## 已上线功能连续性检查

更新本地应用前，核对候选构建与当前运行版本、最近完整版本的页面入口和 API 路由，候选必须包含已上线功能。检查应覆盖全局导航、页面直达链接及实际接口响应，并保存源码指纹与镜像对应关系。并行工作目录中的已上线功能需要先合入候选源码，再执行验证和构建。恢复 AI 页面时沿用原启用状态与加密密钥，并保留模型连接、对话记录、缓存服务和数据库迁移指纹。


### IP 入口与管理地理卷

Compose 将 CLIENT_IP_HEADER、IGNORE_IP、GEOLITE_DB_PATH 和 SKIP_LOCATION_HEADERS 注入应用。已有入口配置需要代理清理并覆盖同名请求头。更改可信入口会改变部分匿名访问标识，应安排明确切换时间并记录统计口径。

`liekan-geography` 是本产品独立持久卷，应用只读，日志 worker 写入。默认全局库继续使用 DB-IP City Lite，大陆 XDB 补齐为影子模式。`LIEKAN_GEO_CHINA_MODE=active` 仍需要独立真实样本审核和有效 XDB 数据许可清单。

标准部署脚本显式读取基础 `docker-compose.liekan.yml`，自动 override 文件和 `COMPOSE_FILE` 不会被加载。自定义库、许可清单和源文件放到被 Git 忽略的 `.local/private-geo/`，然后在基础配置的 `app` 与 `log-worker` 中维护以下挂载片段，保留已有管理卷：

```yaml
services:
  app:
    volumes:
      - liekan-geography:/app/managed-geo:ro
      - ./.local/private-geo:/app/private-geo:ro
  log-worker:
    volumes:
      - liekan-geography:/app/managed-geo
      - ./.local/private-geo:/app/private-geo:ro
```

同时在私有 .env 中将 GEOLITE_DB_PATH 指向 `/app/private-geo/City.mmdb`，将 LIEKAN_GEO_XDB_MANIFEST 指向相应私有 JSON 清单。清单中 path 使用容器内位置。两个服务必须能读取同一授权文件，原文件不会自动覆盖。备份并保留这些基础配置定制，升级源码时核对挂载和路径，再通过部署脚本更新应用与后台，继续保留原数据库容器及其大版本。MaxMind 下载账号与密钥只进入 worker 环境。管理目录内 `.update-lock` 保证同一时间一个写入者；异常终止后先确认不存在更新进程，再清理锁。地理更新失败保留权限有效的旧版本，事件采集持续可用。

## 浏览器身份的可信入口

原始浏览事件可以在缺少可信 IP 入口时继续采集。正式浏览 PV、UV、访问次数、跳出率及身份依赖分析统一使用有可信输入的浏览子集；缺失部分保留在流量质量审计中。只填写 `CLIENT_IP_HEADER` 不能验证代理边界。部署者需要记录切换时间，先比较新旧身份覆盖；历史缺失输入保持未知。

先核对实际链路中的 CDN、WAF、负载均衡、Nginx 和应用监听地址，以及每一跳的访问控制。单独核对实际采集接口 `/api/send` 的 location、upstream、WAF 规则和可信头覆盖策略；该路径的处理规则可能与页面或 `script.js` 不同。`Server`、`Via`、`CF-Ray` 等响应头只提供拓扑线索；实际授权范围须由部署配置、网络策略和受控请求共同证明。部署脚本保持无参数入口，不会自动写入反向代理规则。当前文档提供配置方法，具体生产入口的授权与连通结果需由部署者验证。

直接反向代理示例：应用仅绑定本机 `127.0.0.1:3002`，配置 `CLIENT_IP_HEADER=x-liekan-client-ip`，Nginx 从实际连接建立唯一地址，并覆盖或清空客户端转发字段。

```nginx
location / {
    proxy_pass http://127.0.0.1:3002;
    proxy_set_header Host $host;
    proxy_set_header X-Liekan-Client-IP $remote_addr;
    proxy_set_header X-Forwarded-For "";
    proxy_set_header X-Real-IP "";
    proxy_set_header True-Client-IP "";
    proxy_set_header CF-Connecting-IP "";
    proxy_set_header Forwarded "";
    proxy_set_header X-Umami-Client-IP "";
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

CDN → 反向代理模式在上述入口增加真实地址恢复。先确认 Nginx 已包含 realip 模块，并核对 `set_real_ip_from` 只授权实际前置代理；真实地址恢复后，应用的专用头仍由 Nginx 用 `$remote_addr` 覆盖。规则含义见 [Nginx realip 官方文档](https://nginx.org/en/docs/http/ngx_http_realip_module.html)。以下以 Cloudflare 为例：`cloudflare-realip.conf` 只包含从 [Cloudflare 官方地址清单](https://www.cloudflare.com/ips/) 维护的 IPv4 和 IPv6 `set_real_ip_from CIDR;`，同时由防火墙限定该入口只接受 CDN 网络，并禁止绕过 CDN 访问源站。不要配置 `0.0.0.0/0` 或 `::/0`。应用端口继续仅允许反向代理连接。

```nginx
include /etc/nginx/trusted-proxies/cloudflare-realip.conf;
real_ip_header CF-Connecting-IP;
real_ip_recursive on;
# location / 使用上面的覆盖配置；$remote_addr 此时为经过可信 CDN 校验的地址。
```

Cloudflare 的头部恢复与 Pseudo IPv4 行为见 [恢复访客地址官方说明](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/)。启用 Pseudo IPv4 的 `Overwrite Headers` 时，`CF-Connecting-IP` 会变成伪 IPv4，原 IPv6 保存在 `CF-Connecting-IPv6`。按上例使用原地址前，需要关闭这项覆盖或单独审核 IPv6 恢复策略；同时核对会删除地址头的 Transform Rules，以及经过 Workers 或其他代理的额外跳转。代理清单、源站允许范围与恢复策略应同步维护。

验收创建独立、受控的网站与访问端，不得把测试流量发送到真实业务站点。每项采集测试均向该测试网站发送真实 `/api/send` 请求，核对接口响应与网站内已接受的新采集事件相互对应，再检查这些事件的可信输入覆盖和身份。页面、`script.js` 或 heartbeat 的正常响应只证明各自路径可达，采集通过需要上述实际接口与已接受事件的证据。记录测试时间、入口配置版本、测试事件 ID、地址族和通过情况；身份比较使用已有匿名标识或覆盖计数，日志与验收材料均不保存原始 IP、完整 UA 或凭据。

| 场景 | 操作与通过条件 |
| --- | --- |
| 同一实际出口 | 在相同 UA、同一匿名盐周期内，从同一出口发送真实请求；轮换伪造的专用头 `X-Liekan-Client-IP` 及示例中清理的所有转发头。可信身份和范围判断应保持一致。 |
| 不同实际出口 | 保持 UA 与盐周期相同，通过两个已确认不同的真实网络出口发请求。身份应能区分，不能只改客户端请求头来模拟出口。 |
| IPv4 与 IPv6 | 分别使用已确认的 IPv4、IPv6 出口完成前两项，检查实际地址族经过全部代理后仍可解析；没有可控 IPv6 出口时将该项记为待验收。 |
| 应用旁路 | 从外部访问应用端口应失败，包括源站的 IPv4 与 IPv6 地址。核对 Docker 绑定、主机防火墙及额外端口映射。 |
| CDN 旁路 | 在独立测试入口中，绕过 CDN 直连源站并带上相同 Host 和伪造地址头；应被入口访问控制拒绝。多源站、备用域名和 IPv6 均需覆盖。 |
| 缺失可信输入 | 在隔离副本撤掉可信入口配置，原始事件继续进入审计，正式浏览统计显示身份不足；测试结束后恢复原配置。 |

发现出口身份合并、伪造头改变身份或源站旁路可达时，先修复相应入口规则，再重复对应场景。身份变化只根据受控请求与新事件判断，页面响应头或历史缺失数据无法补足这项证明。

### 查询耗时诊断

后台统计沿用任务 ID、尝试次数和现有时间字段，每次实际取得计算任务后输出一条有界的 `analysis-attempt` 记录，包含目标类别、首次或重试、计算、发布、有限错误类别与来源结果状态。`firstQueueWaitWallMs` 只用于首次尝试；重试的 `retryEligibleWaitWallMs` 从该次 `next_attempt_at` 到新的 `started_at`，包含可执行后的等待，退避时间单独留在既有调度字段中。`started_at` 会在每次认领时更新，不能据此推算全部历史排队耗时。`finishedAt` 为本次诊断结束时间，已发布结果继续使用数据库中的 `completed_at`。

报表的直接查询组在原有事务内记录 wall-clock 耗时，包含组内连接和执行队列等待。`queryGroups` 仅收录日志输出时已经结束的查询组；`Promise.all` 提前拒绝时，其他组可能仍在执行，失败尝试的查询组证据可能不完整。缺失组的耗时保持未知，不能按零值计算。并行组的耗时存在重叠，组耗时之和既不能作为总耗时，也不能作为数据库执行时间。失败尝试也输出诊断，权限变化、来源过期、容量和计算失败使用固定类别，不输出 SQL、条件值、异常正文或访客信息。准入争用按队列的一次有界投递周期汇总，在取得资格或周期结束时输出 `analysis-admission`，逐次轮询保持安静。进程中断或周期记录到期时，尚未结束的内存汇总可能丢失。

page-report 的 `Server-Timing` 只描述当前 HTTP 请求。命中已发布后台结果时，响应中的请求耗时涵盖本次读取；后台计算耗时保留在 worker 诊断中。同步报表发生实际计算时，响应附带本次查询组的 wall-clock 耗时，缓存对象不保存这些计时。

升级包含增量迁移 `056_qualified_browser_metrics.sql`。部署不会自动信任任何客户端转发头。若访客卡片全部不可用，先验证本节的代理覆盖规则，再配置入口并观察新事件的身份覆盖。已有缺失 IP/UA 的历史记录保持未知，重新部署和刷新无法重建这些输入。

应用服务器仍兼容旧 tracker。爬虫范围用途更新在后台爬虫管理的升级草稿中预览并发布；应用与 worker 使用同一候选版本。回退选择保留来源、类型和自动化硬边界的兼容候选，数据库只保留增量结构。

隔离恢复验收同时核对候选迁移校验和与恢复前的迁移记录。其它已应用的独立迁移须原样保留，候选不得重写其校验和或应用时间；验收报告列出这些迁移。该检查验证记录保留，相关独立功能仍由其所属候选验证。

## 可选历史日志分析服务

使用 `sh scripts/liekan-deploy.sh --with-clickhouse` 安装独立的内部 ClickHouse 服务，额外预算为 2 CPU、4 GiB。随后由系统管理员在“存储与分析”检查连接、准备数据、对账并启用。默认部署和 PostgreSQL 数据卷保持现状，升级保留已配置的 ClickHouse。连接、清理和恢复流程见 [可选 ClickHouse 历史日志分析](clickhouse-analytics.md)。
