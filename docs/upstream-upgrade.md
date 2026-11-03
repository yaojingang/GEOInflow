# 持续吸收 Umami 更新

GEOInflow 公开仓库以完整源码快照作为初始提交，保留 MIT 许可证、上游版权与来源说明。持续合并上游的开发仓库保留 Umami Git 历史，以下升级流程在该开发仓库执行。upstream 指向官方仓库；main 保存已验收的 Liekan 版本；feature/* 用于产品迭代；upstream-sync/* 用于上游升级候选。Liekan 自有前端通过稳定契约连接 src/lib/liekan/upstream，认证、权限和原统计算法集中适配。必要核心修改逐文件记录在 config/liekan/core-overrides.json。

## 公开仓库的基线准备

公开仓库的提交历史独立维护。首次从公开仓库克隆并运行源码检查时，先获取 `config/liekan/upstream.json` 中固定的上游提交，供核心差异检查使用：

```sh
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const { repository, commit } = JSON.parse(readFileSync('config/liekan/upstream.json', 'utf8'));
execFileSync('git', ['fetch', '--no-tags', '--depth=1', repository, commit], { stdio: 'inherit' });
NODE
```

该命令将上游基线写入本地对象库，公开分支的提交历史保持独立。GitHub 源码检查已包含这一步。开发维护中的上游合并需要保留共同祖先的完整开发历史。

## GitHub 与 Gitee 独立发布

完整开发历史保存在私有仓库 `git@gitee.com:liekan/liekan-statistics-history.git`，开发目录的 `origin` 指向这里，供功能开发和上游升级使用。GitHub `yaojingang/GEOInflow` 与 Gitee `liekan/liekan-statistics` 使用相同的独立项目历史和发布提交编号。开发目录中指向两个项目仓库的 remote 仅用于读取，推送地址设置为 `disabled://geoinflow-use-public-checkout`。Gitee 项目仓库沿用当前可见性，公开权限另行审批。

首次准备公共目录时，单独克隆 GitHub 仓库。公共目录保留 GitHub `origin` 和 Gitee `gitee` 两个 remote，保持在干净的 `main` 分支：

```bash
git remote add gitee https://gitee.com/liekan/liekan-statistics.git
```

使用 `.nvmrc` 指定的 Node 版本。首次使用或更新推送守卫后，在开发目录安装共享钩子，并为独立公共目录安装公共钩子：

```sh
pnpm liekan:install-push-guard
pnpm liekan:install-push-guard --repo /path/to/GEOInflow-public
```

钩子保存在各仓库共享 Git 目录，链接工作目录自动继承。检查器、策略和运行路径以固定内容快照安装，旧分支无需拥有新脚本。安装器保留已有用户钩子和自定义 hooksPath，发现冲突时停止；重复安装相同版本保持不变。开发钩子拒绝向 GitHub 和干净 Gitee 项目仓库发布，公共钩子检查全部待推分支和注解标签的祖先，覆盖直接 URL、其他 remote 名称、URL 重写和 SSH Host 别名。完整开发历史仅向私有历史仓库推送。Gitee main 的待推提交还须与实时读取的受保护 GitHub main 一致；无法读取时停止。新克隆需要执行上述安装；主动跳过或禁用本地钩子会失去客户端检查，GitHub main 的服务端保护继续生效。

安装前检查全部链接工作目录的 hooksPath，并确认已有受管钩子可执行。SSH 解析遵循 Git 的 `core.sshCommand` 和 `GIT_SSH_COMMAND` 配置，保留用户名、端口和配置文件；无法安全解释的 shell 命令或第三方 SSH 包装器会阻止推送，需先审查其路由配置。

提交并验证开发修改后准备公共候选：

```sh
pnpm liekan:publish-public --target /path/to/GEOInflow-public --branch feature/your-change --source-ref HEAD --push
pnpm liekan:check-public-history --repo /path/to/GEOInflow-public refs/heads/feature/your-change
git -C /path/to/GEOInflow-public ls-remote origin refs/heads/feature/your-change
git -C /path/to/GEOInflow-public ls-remote gitee refs/heads/feature/your-change
```

发布工具在临时目录导出指定提交中的完整文件，核对源码树摘要，将候选提交接到公共分支上。工具默认准备本地 `feature/*` 提交；加上 `--push` 时，核对两个 remote 后将同一个提交分别普通快进推送到 GitHub 和 Gitee。任何一端失败均返回非零状态和两端结果，保留候选供重试，不自动覆盖独立改动。公共目录的工作文件和 `main` 保持原样。重复导出相同源码不会生成额外提交。候选提交记录开发提交和源码树摘要，便于跨仓库追溯。

GitHub 新增的独立贡献需要先同步回开发仓库。工具通过三方合并检查确认源码已包含公共改动；发生冲突或缺失时会停止，保留公共文件和分支。已准备的候选可在排查推送错误后直接重试普通推送。发布前运行 `git -C /path/to/GEOInflow-public fetch --no-tags origin` 和 `git -C /path/to/GEOInflow-public merge --ff-only origin/main`，保持本地 main 与远端一致。已合入 main 的旧候选可继续快进；未合并且落后 main 的候选需要先协调或使用新分支。保留尚未推送的本地候选。若工具返回 `changed: false`，源码已同步，可跳过推送。

`config/liekan/public-history.json` 固定两个项目仓库地址、私有开发历史仓库地址、允许的根提交和首次独立发布基线。历史检查遍历全部父节点，拒绝额外历史根、可达的浅克隆边界和 grafts，忽略本地 replace 规则。它允许社区贡献者从项目分支继续提交。

GitHub `main` 启用分支保护：通过 PR 合并，必过检查为 `GEOInflow public history`，管理员同样受限，禁止强制推送和删除。PR 检查由 `pull_request_target` 的受信工作流执行，使用目标分支的检查器、策略和测试，只获取候选提交图；独立报告步骤将必过状态写到候选 head SHA，读取候选的步骤只有只读权限。公开仓库的常规 PR 无需导入开发祖先。历史污染回归测试使用独立临时仓库，覆盖干净提交、第二父节点带入上游、浅克隆、replace 遮蔽、完整导出、重复执行以及公共改动保护：

```sh
node --test tests/liekan/public-history.test.mjs tests/liekan/pre-push.test.mjs
```

Gitee main 启用保护分支，仅管理员同步已在 GitHub 通过 PR 和必过检查的 main。Gitee 的服务端保护和 GitHub 的检查机制分别核验；本地守卫额外校验 Gitee main 与 GitHub main 的提交编号完全一致。GitHub main 合并获授权并完成后，执行：

```bash
git -C /path/to/GEOInflow-public fetch --no-tags origin
git -C /path/to/GEOInflow-public merge --ff-only origin/main
pnpm liekan:check-public-history --repo /path/to/GEOInflow-public main
git -C /path/to/GEOInflow-public push gitee main
```

Gitee 的社区贡献先通过 GitHub 的受保护合并流程接纳，再同步同一提交；发现 Gitee main 有独立提交时停止并先保存、审查该贡献。私有历史仓库保留原有全部分支和 PR，不参与项目贡献者统计。各平台按自己的账号邮箱绑定与缓存规则显示贡献者，最终人数和头像需要分别实测。

上游比较所需的浅层基线可以获取到本地对象库；它保持在公开分支祖先之外。处理上游升级时，在开发仓库完成合并和验收，再通过上述流程发布源码。保留 MIT 许可、原始版权、来源说明和完整示例数据包。

## 开发仓库的升级流程

1. 在现有运行版本导出数据库备份，保留镜像 ID、标签、APP_SECRET 和 TWO_FACTOR_ENCRYPTION_KEY。环境配置和备份放私有位置。
2. 使用 Node.js 22.23.4、pnpm 12.3.4，运行 `pnpm liekan:upstream:report --tag vX.Y.Z`。工具核对官方 remote、获取目标发布并输出变更、核心重叠和关键路径报告，不修改 main。
3. 运行 `pnpm liekan:upstream:prepare --tag vX.Y.Z`。工具从已提交 main 创建隔离 worktree，执行保留历史的合并。候选目录和分支记录在报告中，当前工作区保留。冲突留在候选内处理；进程中断或启动失败保留候选报告并返回失败。
4. 在候选检查上游发布说明，处理认证、数据库、框架、包接口与已登记改动的交集；同步兼容适配层和契约，不改原型基准。将候选的 upstream.json tag/SHA/version 与 core-overrides.json baseline 更新为已核对的官方目标，使边界检查比较目标上游与 Liekan 的实际差异；同时保留上一接受版本的报告。新增 Liekan 迁移追加文件，既有迁移校验和保持不变。
5. 在干净的已提交候选运行 `pnpm liekan:verify`。工具先检查冻结依赖、SDK/OpenAPI、类型、测试、原型与迁移指纹、导入边界和生产构建，再构建 revision 对应的候选镜像，在临时 Docker 中验证空库初始化、只读统计 SQL 回归、完整 API、延迟资源加载与真实保存交互、数据库副本恢复、迁移二次运行、11 页和 22 图的视觉对照，以及 68 个补充场景的桌面与移动布局验收。完整结果写入 `outputs/acceptance.json`，源码检查写入 `outputs/verification.json`。
6. 完整验收需要运行独立 Liekan 数据库、私有 `.env`、地理数据库，以及 `.local/ui-test.env` 中的登录凭据。工具只对现有 Liekan 库导出备份，在临时 3302 端口执行回归，正常退出及取消时清理自己创建的容器和卷。恢复后的业务总量必须与同一备份升级前一致；官方迁移核对执行状态、文件名和 SQL 校验和，Liekan 迁移核对独立账本。升级前允许候选新增官方迁移处于待执行状态，升级后必须全部成功。原有体验服务保持当前镜像。
7. 记录目标 tag/SHA、UI 指纹、依赖锁、迁移校验和与镜像 revision。候选验证通过并合入 main 后，upstream.json 对应的版本成为最后接受版本；创建新的 Liekan 发布标签。

升级报告和候选创建均可独立运行。失败时停留在候选中检查，默认工具不切换容器、不替换数据库、不推送远端。部署新迁移后，应用镜像回退需要检查 schema 兼容性；涉及不可逆的数据改变时应使用完整备份恢复到独立卷验证后切换。

认证、会话、SDK 命名、tracker 的 /api/send、脚本全局名及上游数据库字段保持兼容。公开版本随分发包保留 LICENSE 中的版权与许可声明，以及第三方依赖各自的许可。正式开源前还需要配置 Liekan 仓库 origin、外部 CI、发布地址与审查可分发数据；当前阶段只在本机构建。

源码检查可单独运行 `pnpm liekan:verify --source-only`，开发中的未提交修改使用 `--working-tree`。这两种模式只提供源码检查结果，完整定版依据为 `outputs/acceptance.json` 的 `passed`、`finalized`、候选 HEAD 和镜像 ID。远端 CI 当前只配置源码检查，首次正式发布前应补充同版本的完整验收任务。视觉凭据文件使用 `LIEKAN_TEST_USERNAME` 与 `LIEKAN_TEST_PASSWORD`，对应副本中有网站访问权限且无需交互式 2FA 的专用测试账号。

## 补充 UI 升级约束

补充 UI 的文件指纹由 feature-ui.json 和 upstream.json 联合记录。吸纳上游更新时保持该指纹，优先在 src/lib/liekan/upstream 修复接口差异；核心路由、查询或认证的必要改动逐条登记 core-overrides.json。升级回归包含来源分类、重复筛选、关联访问、统计 Decimal、已有队列日期范围、分享撤销、完整导出和回放异步流程。

0.2.0 的分享授权依赖主库实时核验。应用回退时需要保留该授权层；直接启用缺少此校验的旧镜像会恢复旧的分享行为。回退候选须复用当前安全适配层，完成分享停用、密码变化和范围收缩的回归后再替换容器。数据库备份保存在私有位置，默认通过独立恢复卷验证。

## 导航适配

更新后的路由或资源 API 在上游适配层和 Liekan 契约中对齐。共享导航读取 `navigation.ts` 的页面归属，保持全局资源和网站分析的上下文边界。新增页面先明确所属模块、上级页面、空间和日期范围，再加入独立的 `navigation-ui.json` 验收基准；原型文件继续保留。上游新增或调整权限时，同时验证直接访问、只读身份、团队资源、网站切换和网站分享，参见 [导航与页面层级](navigation.md)。
