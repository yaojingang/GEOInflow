# 参与 GEOInflow

感谢你帮助改进 GEOInflow。项目基于 Umami 开发，保留其 MIT 版权、采集协议和必要的兼容接口。产品显示名称为 GEOInflow，工程、命令和工作区中的 `Liekan` / `liekan` 标识继续保留。

## 问题反馈

在本仓库提交问题前，搜索现有 Issue。错误报告尽量包含：

- 产品和镜像版本、数据库版本、部署方式。
- 具体页面、操作步骤、预期与实际结果。
- 日期、时区、筛选、输入来源及数据状态。
- 已脱敏的错误码或必要日志，说明首次计算与缓存命中的区别。

问题中的截图和日志需要移除密钥、接收凭据、真实访客 IP 和其他敏感资料。疑似安全问题先使用仓库公布的私密报告入口；尚未公布入口时，可先提交不含漏洞细节的联系请求。公开 Issue 保留不涉及敏感细节的描述。

## 分支与 Pull Request

以公开仓库的默认分支为基线，使用 `feature/*` 提交功能与修复。上游合并在保留完整开发历史的维护仓库中使用 `upstream-sync/*`，步骤见[上游维护](docs/upstream-upgrade.md)。将 PR 提交到本仓库当前默认分支，发布候选在 `main` 核验。

一个 PR 保持一个清楚的目标。描述具体问题、修改后的行为、验证范围和已知限制，关联对应 Issue。涉及范围变化时同步更新说明。

## 本地开发

使用 `.nvmrc` 固定的 Node.js 22.23.4 与 pnpm 12.3.4，准备独立 PostgreSQL 15 / 16 开发数据库。`.env` 根据 `env.example` 配置并保留为私有文件，原有部署的配置与数据库继续保持独立。

```sh
pnpm install --frozen-lockfile
pnpm build:db
pnpm db:migrate
pnpm liekan:migrate
pnpm liekan:queue-bootstrap
pnpm build:openapi
pnpm build:packages
pnpm build:tracker
pnpm build:recorder
pnpm liekan:build-worker
pnpm dev --port 3302
```

这里用 `3302` 演示开发端口，避免与默认 Docker 应用的 `3002` 冲突。先确认所选数据库和端口属于自己的开发环境。

需要日志和统计任务时，在另外两个终端使用同一私有环境运行：

```sh
node --env-file=.env dist/liekan-worker.mjs
```

```sh
node --env-file=.env dist/liekan-analytics-worker.mjs
```

可以显式运行 `pnpm liekan:seed-demo` 初始化已处理的默认示例。合成数据与性能夹具使用独立测试网站及数据库，不写入业务网站。

## 代码与数据边界

| 位置 | 约定 |
| --- | --- |
| `src/components/liekan` | 产品页面使用 Liekan 契约，保留已批准的布局、图表和交互 |
| `src/lib/liekan/contracts` | 定义产品请求、响应与稳定数据语义 |
| `src/lib/liekan/upstream` | 集中上游查询、认证和权限适配 |
| `config/liekan/core-overrides.json` | 登记必要的上游核心覆写及回归覆盖 |
| `db/liekan/migrations` | 使用追加迁移，已应用文件按原校验值保留 |
| `packages` | 保留采集协议、API 客户端及 MCP 的兼容名称 |

来源质量、身份与核验证据、原始采集存在性及被纳入统计的总体分别维护。历史缺失保持未知；新算法、策略或证据版本调整需要相应缓存失效和回归验证。

爬虫规则、目录与访问控制保持各自的预览、发布和权限边界。外部内容和公开采集载荷不能授予可信身份或执行权限。

## 如何选择验证

先列出行为与直接依赖，再选择能证明该行为的检查。文档修改检查事实、链接、代码示例和格式；一般修复运行针对性回归，类型、API 或构建按影响增加。

首次克隆公开仓库时，先按[基线准备](docs/upstream-upgrade.md#公开仓库的基线准备)获取源码检查所需的固定上游提交。

常用检查：

```sh
pnpm exec tsc --noEmit
pnpm exec vitest run src/lib/liekan/contracts/calendar.test.ts
node scripts/liekan-static-check.mjs
pnpm openapi:check --explicit
pnpm check:api:client
```

示例使用日期单元测试；实际检查按本次修改选择对应测试文件。修改契约、路由或生成规则时，重新生成 OpenAPI / SDK 并核对产物。

修改 Docker 打包边界时运行 `node --test tests/liekan/docker-context.test.mjs`。该检查需要 Docker Buildx，通过独立的最小构建核对私有文件排除和许可文件保留，不更新已有应用。

敏感信息检查使用 Gitleaks CLI 8.30.1，GitHub 工作流按固定摘要校验后安装。先运行 `node --test tests/liekan/secrets-scan.test.mjs`，再分别运行 `gitleaks dir . --redact=100 --max-archive-depth=1` 和 `gitleaks git . --log-opts="HEAD --full-history --diff-merges=first-parent" --redact=100`。目录检查应在仅含待发布源码的独立目录执行，保留 `.gitleaks.toml`；历史检查在候选仓库执行，包含合并提交相对第一父提交的差异，分支提交也纳入遍历。本地安装位置不在 PATH 时，通过 `GITLEAKS_BINARY` 指定测试使用的可执行文件。例外同时限定精确路径和已核对的元数据；文件摘要按具体值登记，更新摘要前重新复核，新增凭据仍需触发检查。

数据库集成测试使用各自的独立数据库和端口保护，参照 [统计加速](docs/analytics-acceleration.md)、[流量质量](docs/traffic-quality.md)、[自动日志](docs/automatic-logs.md)与[历史修复](docs/history-repair.md)的测试入口。不要向已联机数据库执行测试重置。

共享 UI 检查代表页面、中英文、桌面与移动端。响应式验证使用独立浏览器上下文，保持其他已打开的浏览器窗口尺寸。

正式发布和上游同步执行完整验证，包括冻结依赖、类型、必要单元/API、生成一致性、原始视觉参考、生产构建、Docker 迁移及隔离恢复。按 `AGENTS.md` 的范围规则复用仍有效的证据，发现新的风险时扩展检查。

## 文档、许可与提交内容

功能、日期语义、部署或数据口径变化时更新对应专题，并通过 [文档目录](docs/README.md)提供入口。用户可见文案同时维护简体中文与英文。

提交源码、测试、冻结依赖、设计参考、公开文档和已审核示例资源。私有 `.env`、数据库备份、真实访客数据、受限地理库、运行密钥、构建产物及本地验收输出保持在发布内容之外。

贡献按 [MIT](LICENSE) 分发。保留 Umami、Liekan 贡献者和依赖的版权及许可声明；新增依赖或数据同时补充 [第三方声明](THIRD_PARTY_NOTICES.md)。
