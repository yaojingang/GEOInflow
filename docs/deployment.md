# 部署与运维

[English](deployment.en.md) | **简体中文**

推荐用仓库中的 `scripts/liekan-deploy.sh` 部署 GEOInflow。它负责构建当前源码、生成首次私有配置、执行迁移、检查健康并更新应用及后台处理服务。

本文以单机 Docker Compose 为例。既有实例的大版本保护、地理数据与恢复细节见 [本地部署说明](local-deployment.md)。

## 环境要求

- 已安装并启动的 Docker Engine 或 Docker Desktop，以及 Docker Compose V2。
- Linux 的 `flock`，或 macOS 的 `lockf`，用于防止两个部署同时执行。
- 可访问容器镜像、Node 依赖和地理数据库下载源的网络。
- 可供 Docker、构建过程、PostgreSQL 和应用使用的内存与磁盘空间。

镜像固定 Node.js 22.23.4、pnpm 12.3.4。Docker 构建的 Node 堆配置为 3072 MiB，还需要为构建原生组件、Docker 虚拟机及其他服务预留内存。运行规模取决于真实日志量、数据保留范围、并发与后台构建，按自己的数据实测容量。

新安装使用 PostgreSQL 16 和 Redis 7.4。已有 PostgreSQL 15 实例继续保留 15。切换数据库主版本需要单独制定迁移与恢复方案。

## 首次安装

取得源码后进入项目根目录，运行：

```sh
sh scripts/liekan-deploy.sh
```

首次运行会创建权限受限的 `.env`，生成独立数据库密码、应用密钥和二次验证加密密钥，然后构建镜像并启动服务。服务器无需额外安装 Node.js 或 pnpm。

默认入口：

| 用途 | 地址 / 行为 |
| --- | --- |
| 应用 | `http://127.0.0.1:3002` |
| PostgreSQL 宿主机入口 | `127.0.0.1:15435` |
| Redis | Compose 内部访问，不默认映射到公网 |
| 默认网络 | `10.253.30.0/24`，部署前核对与既有网络的重叠 |

首次安装的初始账号为 `admin / liekan`。登录后修改密码，确认国家与分析时区。升级保留自定义凭据、已重命名和已删除的账号。

密码登录按固定一分钟窗口限制：每个账号 10 次、每个可信客户端来源 30 次、实例共享总量 120 次，并限制并发校验。超过限制返回 `429` 与 `Retry-After`；配置的共享 Redis 不可用时返回 `503`。优先使用 `REDIS_URL`，否则使用 `LIEKAN_ANALYTICS_REDIS_URL`，两者都未配置时使用进程内计数。计数会在进程重启或 Redis 数据淘汰后重建，因此公网入口还应配置独立限速。客户端来源只读取显式配置的可信入口头；未配置或无有效地址的请求共用未知来源额度。多实例应使用同一个共享 Redis，并由入口代理覆盖可信地址头。

浏览器 tracker 与接收接口会遮蔽 URL 查询和片段中的已知敏感参数，并保留普通 UTM 归因参数。此规则只处理新采集的数据，已有历史记录和业务主动提交的标题、自定义属性需要独立核查。录制未配置遮蔽级别时默认采用严格遮蔽；已明确保存的标准遮蔽配置继续生效。严格遮蔽覆盖文字和输入，敏感页面仍应通过排除元素或不安装录制脚本限制采集。

部署脚本重复执行时保留已有 `.env`、数据库凭据与数据卷。发现已有数据库卷却缺少原配置时会停止，要求先恢复配置。升级采用原数据库容器与镜像大版本，避免无意切换存储版本。

本文命令均显式使用 `docker-compose.liekan.yml`。根目录其他 Docker 文件保留上游兼容用途，常规部署使用本产品脚本。

## 确认服务健康

```sh
docker compose -f docker-compose.liekan.yml ps
curl --fail http://127.0.0.1:3002/api/heartbeat
```

正常状态应包含 `app`、`log-worker`、`analytics-worker`、`db` 和 `analytics-cache`。应用、数据库及后台进程各有健康检查。

需要排查时分别查看对应服务的最近日志：

```sh
docker compose -f docker-compose.liekan.yml logs --tail=100 app
docker compose -f docker-compose.liekan.yml logs --tail=100 log-worker
docker compose -f docker-compose.liekan.yml logs --tail=100 analytics-worker
```

日志接收与处理、统计查询与历史构建由不同后台承担。接收成功而统计尚未更新时，继续核对处理状态、队列和数据截止时间。

## 官方示例初始化

```sh
docker compose -f docker-compose.liekan.yml exec app node scripts/liekan-seed-demo.mjs
```

Docker 首次启动在迁移后自动导入“猎看官网（示例数据）”，上面的命令可用于手动开发和显式重试。源码与镜像包含完整脱敏数据包、目录和校验清单。首次导入平移时间；重复导入保持已有数据、自定义资源和清空、删除状态。正式网站按 [快速开始](getting-started.md) 接入真实输入。

## 域名、HTTPS 与可信入口

将域名指向自己的反向代理，配置有效 TLS 证书，再代理到本机 `127.0.0.1:3002`。应用端口和数据库端口保持非公网暴露。

如果代理直接接收访问者连接，可以在私有 `.env` 中设置：

```dotenv
CLIENT_IP_HEADER=x-liekan-client-ip
```

已配置 HTTPS 的 Nginx `server` 内可参考以下入口。代理覆盖客户端地址头，并清空其他可被误用的转发地址字段：

```nginx
location / {
    client_max_body_size 12m;
    proxy_pass http://127.0.0.1:3002;
    proxy_set_header Host $host;
    proxy_set_header X-Liekan-Client-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For "";
    proxy_set_header X-Real-IP "";
    proxy_set_header True-Client-IP "";
    proxy_set_header CF-Connecting-IP "";
    proxy_set_header Forwarded "";
    proxy_set_header X-Umami-Client-IP "";
}
```

`client_max_body_size` 为导入请求预留代理层空间，应用继续执行各自的批次、格式和大小限制；该指令见 [Nginx 官方说明](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)。

CDN 前置时，先按提供方的实际网络和防火墙策略恢复可信地址，限制源站直连，再使用同一覆盖规则。仅设置一个请求头名称无法建立代理信任。详细配置与核验方法见 [浏览器身份的可信入口](local-deployment.md#浏览器身份的可信入口)。

浏览 PV 可以在缺少可信 IP 入口时继续采集；UV、访问和其他身份依赖分析会说明缺失依据。改变可信入口时，记录切换时间并比较身份覆盖，历史缺证保留原状态。

## 核心配置与可选能力

| 配置 | 用途 | 管理方式 |
| --- | --- | --- |
| `POSTGRES_USER` / `POSTGRES_DB` / `POSTGRES_PASSWORD` | Compose 数据库连接 | 首次生成，升级保留 |
| `DATABASE_URL` | 源码开发、脚本或自定义运行环境连接 | 指向对应环境的独立数据库 |
| `APP_SECRET` | 应用会话与既有标识相关密钥 | 多实例一致，升级沿用 |
| `TWO_FACTOR_ENCRYPTION_KEY` | 二次验证数据加密 | 与数据库一并安全保留 |
| `CLIENT_IP_HEADER` | 可信反向代理提供的访问者地址 | 配合实际入口隔离和覆盖规则 |
| `LIEKAN_ANALYTICS_REDIS_URL` | 跨进程统计缓存 | 标准 Compose 已提供内部地址 |
| `LIEKAN_PUBLIC_URL` | 自动日志接收与 OAuth 使用的公网 HTTPS 根地址 | 与后台对外访问地址一致 |
| `LIEKAN_LOG_CREDENTIALS_KEY` | 自动来源和受支持控制凭据加密 | 单独生成的 32 字节 Base64 密钥 |
| `CLOUDFLARE_OAUTH_CLIENT_ID` / `CLOUDFLARE_OAUTH_CLIENT_SECRET` | Cloudflare 日志授权 | 依实际供应商应用配置 |
| `LIEKAN_AI_ENABLED` / `LIEKAN_AI_ENCRYPTION_KEY` | 可选 AI 分析及模型凭据加密 | 默认关闭，启用要求独立加密密钥 |

密钥保存在私有配置中，按各功能文档轮换。自动日志的安装资产由维护者用受控签名密钥构建；测试签名密钥只用于隔离开发，不能用于正式分发。具体步骤见 [自动日志](automatic-logs.md) 和 [AI 配置器](ai.md)。

## 地理数据

默认构建准备 DB-IP City Lite，数据采用 CC BY 4.0，产品和分享页面保留 DB-IP 署名。已有有效授权 City MMDB 优先使用，自动构建不会覆盖它。

首次下载失败时构建停止，恢复网络后重试相同命令。运行时地理库缺失或损坏不阻止事件采集，未知地域保持缺失。自备 MaxMind 或其他库需遵循对应数据许可。

管理地理卷由应用只读挂载、日志 worker 负责授权更新。自备地理库需在基础 `docker-compose.liekan.yml` 中维护两个服务的只读挂载，步骤见 [IP 入口与管理地理卷](local-deployment.md#ip-入口与管理地理卷)。标准部署脚本只读取该基础配置。大陆 XDB 补充默认影子模式，正式启用需独立审核及有效数据许可。完整设置见 [地域说明](geography.md) 与 [第三方声明](../THIRD_PARTY_NOTICES.md)。

## 当前数据与后台计算

今日普通看板按 30 秒短窗口读取，实时访客使用自己的 30 分钟范围。热力图、留存等重分析保留较长后台窗口。页面隐藏或离线时暂停自动读取。

首次新条件可能登记后台任务；已发布结果可以在更新期间继续展示。常用今天、7 天、30 天预热与实际页面使用相同条件。普通看板与重计算有独立准入，闲置失败任务暂停自动重试。

在“统计加速”查看覆盖、增量、历史构建和错误状态。首次计算、任务等待和缓存命中分别观察；具体边界见 [统计加速](analytics-acceleration.md)。

## 备份与升级

升级前保存原 `.env`、数据库备份、应用镜像标识和迁移账本；定制过的 `docker-compose.liekan.yml` 也需备份并在升级源码时保留。`.env` 中的加密密钥需要与对应数据库一起保管。

在自己的实例中，可用以下方式导出数据库，输出进入已被 Git 忽略的私有目录：

```sh
(
    umask 077
    mkdir -p outputs/backups || exit 1
    backup_time=$(date -u +%Y%m%dT%H%M%SZ) || exit 1
    backup_file="outputs/backups/liekan-${backup_time}.dump"
    if [ -e "$backup_file" ] || [ -L "$backup_file" ]; then
        printf '%s\n' '备份目标已存在，请保留原文件并稍后重试。' >&2
        exit 1
    fi
    backup_tmp=$(mktemp outputs/backups/.liekan-backup.XXXXXX) || exit 1
    trap 'rm -f "$backup_tmp"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    if ! docker compose -f docker-compose.liekan.yml exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_tmp"; then
        printf '%s\n' '数据库导出失败，未生成正式备份。' >&2
        exit 1
    fi
    if ! test -s "$backup_tmp" || ! docker compose -f docker-compose.liekan.yml exec -T db pg_restore --list < "$backup_tmp" > /dev/null; then
        printf '%s\n' '备份归档检查失败，未生成正式备份。' >&2
        exit 1
    fi
    if ! ln "$backup_tmp" "$backup_file"; then
        printf '%s\n' '备份目标已存在或无法创建，请检查后重试。' >&2
        exit 1
    fi
    printf '%s\n' "备份已保存：$backup_file"
)
```

只有导出成功且归档目录检查通过后才创建正式 `.dump`，已有同名目标保留。备份文件需在受控位置另外保存，并在隔离环境演练完整恢复；归档目录检查只确认归档可读取，完整恢复仍需单独验证。

取得准备升级的已审查源码后，重复执行：

```sh
sh scripts/liekan-deploy.sh
```

脚本保留原配置与数据库，先检查依赖并停止旧后台，再更新应用、应用增量迁移，应用健康后更新两个后台。升级后核对登录、2FA、网站切换、浏览指标、日志接入、来源与目标，再核对实际数据总量。

## 恢复与回退

恢复先准备独立空库或新数据卷，使用与备份兼容的 PostgreSQL 版本导入，核对数据总量、账号、迁移校验值与加密密钥，再切换应用配置。保持原库和原卷供核验，避免覆盖仍在写入的实例。

启用了 Cloudflare 控制时，数据库恢复后、服务重新处理控制任务之前，需要按 [抓取控制恢复说明](crawler-control.md#中断接管与恢复) 暂停旧控制并只读核对远端状态。

应用回退使用已验证兼容当前表、授权层、目录和任务协议的候选。已执行迁移保留，新增数据继续保存；旧镜像能启动只说明进程可运行，数据及权限兼容性仍需验证。

## 排查入口

| 现象 | 主要检查 |
| --- | --- |
| 镜像构建失败 | 镜像源、依赖源、地理下载、Docker 内存与原始错误 |
| 应用不健康 | 数据库连接、迁移校验与应用日志 |
| 日志已接收但未处理 | `log-worker` 心跳、批次状态、来源权限和积压 |
| 统计长期排队 | `analytics-worker`、任务错误码、覆盖状态和容量 |
| 新部署没有 AI 请求 | 接入真实日志、处理完成、身份规则与筛选 |
| 切换时区后今天范围不符 | 账户保存值、明确旧 URL、分享或任务固定范围 |
| 地域缺失 | 来源字段与授权 MMDB 的有效性 |

多实例部署、代理迁移、密钥轮换和历史恢复按对应专题文档进行。源码部署和本地镜像构建均不代表存在已发布的公共镜像渠道。
