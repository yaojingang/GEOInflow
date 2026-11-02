# GEOInflow 文档

GEOInflow 将浏览器访客、AI 爬虫日志、搜索引荐和内容目录关联到同一网站，支持自托管部署。产品显示版本 v1.2 对应工程版本 1.2.0。

快速开始和部署指南同时提供英文版：[Quick start](getting-started.en.md) · [Deployment](deployment.en.md)。

## 从这里开始

| 你的目标 | 阅读顺序 |
| --- | --- |
| 安装并接入第一个网站 | [部署指南](deployment.md) → [快速开始](getting-started.md) |
| 了解 AI 爬虫与 GEO 分析 | [AI 爬虫分析](ai-crawler-analytics.md) → [统计口径](data-definitions.md) |
| 了解代码与系统原理 | [系统架构](system-overview.md) → [贡献指南](../CONTRIBUTING.md) |
| 检查统计延迟或排队 | [统计加速](analytics-acceleration.md) → [缓存](analytics-cache.md) |
| 升级或维护已有实例 | [部署指南](deployment.md) → [本地部署与恢复细节](local-deployment.md) |

## 接入与使用

| 文档 | 内容 |
| --- | --- |
| [快速开始](getting-started.md) | 首次登录、账户时区、浏览脚本、日志、目录与首轮分析 |
| [数据接入](installation.md) | 网站接入引导、检查状态和 AI 蜘蛛展示开关 |
| [自动日志](automatic-logs.md) | 服务器采集器、Cloudflare、凭据、缓冲与来源区间 |
| [默认示例](default-demo.md) | 示例初始化、处理方式与数据范围 |
| [日期与时区](date-ranges.md) | 今天、账户时区、跨日与分享固定范围 |
| [页面覆盖](ui-coverage.md) | 页面和功能边界 |
| [导航](navigation.md) | 网站、空间、账户、后台与公开分享的上下文 |
| [中英文](i18n.md) | 界面语言、持久偏好和导出语言 |

## AI 爬虫、内容与证据

| 文档 | 内容 |
| --- | --- |
| [AI 爬虫分析](ai-crawler-analytics.md) | 场景、指标解释、运营步骤与结论边界 |
| [爬虫目录](crawler-directory.md) | 内置目录、用途和本版能力 |
| [识别与目录管理](crawler-recognition.md) | UA、官方范围、DNS / 边缘证据、版本及规则发布 |
| [流量证据](traffic-evidence.md) | 请求响应、采集对账、身份覆盖与来源质量 |
| [抓取风险与控制](crawler-control.md) | 风险处理、公开访问检查、robots / Nginx 和 Cloudflare |
| [GEO 权重](geo-weight.md) | Beta 政策、公式、证据、日快照与导出 |
| [AI 配置器](ai.md) | 可选模型连接、事实输入、费用和数据发送范围 |

## 统计原理与治理

| 文档 | 内容 |
| --- | --- |
| [系统架构](system-overview.md) | 数据路径、服务、权限边界及源码结构 |
| [统计口径](data-definitions.md) | PV / UV、会话、关键词、搜索引荐和导出范围 |
| [流量质量](traffic-quality.md) | 浏览总体、可信输入、排除策略和审计 |
| [历史修复](history-repair.md) | 扫描、预览、确认、发布代次与回退 |
| [统计加速](analytics-acceleration.md) | 精确汇总、持久任务、覆盖、预热与计算准入 |
| [可选 ClickHouse 分析](clickhouse-analytics.md) | 历史日志副本、后台开关、同步对账、回退与独立服务预算 |
| [缓存](analytics-cache.md) | 缓存身份、容量、失效及公开分享 |
| [性能](performance.md) | 查询与性能验证方法 |
| [地域](geography.md) | 地理来源、缺失状态与授权文件 |

## 部署与开发

| 文档 | 内容 |
| --- | --- |
| [部署指南](deployment.md) | 新安装、HTTPS、服务检查、备份与升级 |
| [本地部署与恢复细节](local-deployment.md) | 既有容器保护、地理库、可信入口和恢复步骤 |
| [贡献指南](../CONTRIBUTING.md) | 本地开发、验证范围和提交约定 |
| [上游关系](upstream.md) | Umami 基线与兼容边界 |
| [上游升级](upstream-upgrade.md) | 上游同步工具、隔离候选与发布检查 |
| [升级说明](upgrade.md) | 既有安装的升级规则 |
| [API 迁移](report-api-migration.md) | 报告 API 的兼容调整 |
| [API 客户端](../packages/api-client/README.md) | 工作区 SDK 的用法 |
| [MCP](../packages/mcp/README.md) | 兼容 MCP 包的使用 |

许可见 [LICENSE](../LICENSE)，第三方组件与数据许可见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
