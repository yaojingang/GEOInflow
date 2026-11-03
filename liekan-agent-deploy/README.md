# GEOInflow 采集器手动部署包

自包含的日志采集器部署文件夹。从构建机整目录拷贝到日志服务器，填好 `.env` 后一条命令完成配对和启动，不需要在目标服务器下载安装脚本。

## 前置要求

- Linux x64 / arm64，可用的 Docker Engine 和 Docker Compose V2
- 网站的 Nginx / Apache Combined 格式访问日志（整目录可读，含轮转文件）
- `liekan-agent-deploy/` 文件夹中已包含 `agent.mjs` 和 `container.mjs`（由构建机执行 `pnpm liekan:build-agent` 生成；若缺失，请回到构建机生成后再拷贝）

## 部署步骤

1. 拷贝整个 `liekan-agent-deploy/` 文件夹到日志服务器的非公开目录，例如 `/opt/liekan-agent-deploy`。
2. 进入文件夹，复制并填写配置：

   ```sh
   cd /opt/liekan-agent-deploy
   cp .env.example .env
   vi .env   # 填写统计服务地址、网站标识、日志目录/文件名、日志组 GID、配对码
   ```

3. 创建状态目录并授权（容器以 UID 65532 运行）：

   ```sh
   mkdir -p state && chown 65532:65532 state
   ```

4. 在网站后台"数据接入 → 服务器安装"生成一次性配对码（10 分钟内有效、只能使用一次），填入 `.env` 的 `LIEKAN_PAIRING_CODE`。
5. 启动（首次会自动构建镜像、校验日志并在容器内完成配对）：

   ```sh
   docker compose up -d --build
   ```

6. 查看状态：`docker compose ps`、日志：`docker compose logs collector`。容器显示 healthy 且后台"重新检查"通过即接入成功。

## 备选：在日志服务器上从源码构建

以上默认流程需要从构建机拷贝预生成的 `agent.mjs`、`container.mjs`（它们是构建产物，不进 git）。如果日志服务器能直接访问代码仓库和 npm 源，也可以跳过拷贝步骤，在服务器上直接从源码构建镜像：

1. 在日志服务器上克隆仓库（或上传源码包），进入本部署文件夹：

   ```sh
   git clone -b <分支> https://github.com/<你的账号>/GEOInflow.git /opt/GEOInflow
   cd /opt/GEOInflow/liekan-agent-deploy
   ```

2. 按上文步骤 2–4 准备 `.env`、`state/` 和配对码。
3. 使用服务器构建编排启动（打包在镜像构建阶段完成，需能拉取基础镜像和两个 npm 包）：

   ```sh
   docker compose -f docker-compose.server.yml up -d --build
   ```

npm 访问受限时可指定镜像源：

```sh
docker compose -f docker-compose.server.yml build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
docker compose -f docker-compose.server.yml up -d
```

基础镜像拉取受限时，同样可以用构建参数指向镜像源（无需改动本文件）：

```sh
docker compose -f docker-compose.server.yml build --build-arg BASE_IMAGE=docker.m.daocloud.io/library/node:22.23.4-alpine
```

两种方式产出的镜像和运行配置完全一致；整目录拷贝仍是默认推荐方式（日志服务器无需访问代码仓库与 npm 源）。

## 如何确定日志路径和 GID

- 宝塔面板：网站 → 设置 → 日志，可查看日志路径（通常 `/www/wwwlogs/域名.log`）；日志组通常为 `www`，执行 `id -g www` 得到 GID。
- 自装 Nginx：查看站点配置的 `access_log` 指令，例如 `access_log /var/log/nginx/example.com.access.log combined;` 对应目录 `/var/log/nginx`、文件 `example.com.access.log`。
- 日志文件需要对上述组可读（`r`），日志目录需要可进入（`r-x`）。
- `LIEKAN_LOG_DIRECTORY` 必须是目录而不是单个文件：日志轮转后采集器要继续读取同目录的轮转文件。

## 配对码与凭据说明

- 配对码 10 分钟内有效、只能消耗一次。容器首次启动且状态目录为空时自动用它换取长期接收凭据；配对成功后该码即失效，可从 `.env` 删除。
- 长期接收凭据只保存在 `state/<来源ID>/config.json`（权限 0600），不会进入 `.env`、容器编排或镜像。
- 日常重启、升级镜像都不需要重新配对。已有配置会继续使用原凭据；后台断开后按下方步骤显式重连。接入新网站时使用独立的部署目录和状态目录。
- 配对失败（码过期、已使用或网站不符）时容器会退出并在日志中说明原因：重新生成配对码、更新 `.env` 后执行 `docker compose up -d` 重建容器。

## 后台断开后的重连

在后台为原网站生成新配对码，更新 `.env` 中的 `LIEKAN_PAIRING_CODE`，保留接收地址、网站标识、日志路径和整个 `state/` 目录，然后执行：

```sh
docker compose stop collector &&
docker compose run --rm -T --no-deps --entrypoint sh collector -c \
  'printf "%s" "$LIEKAN_PAIRING_CODE" | node /app/container.mjs pair' &&
  docker compose up -d --force-recreate
```

源码构建方式在以上每条 `docker compose` 命令后加 `-f docker-compose.server.yml`。配对命令先核对原凭据，授权仍有效时复用原连接；凭据已撤销时交换新码，旧来源配置和缓存继续保留。只有配对命令成功才会启动采集器；失败时按提示修正后重试，并保留状态目录。重连成功后可删除 `.env` 中已消耗的配对码，再检查后台接收状态。

## 安全与保密

- `state/` 含长期凭据和加密缓冲，请保持目录权限受限（仅属主可读），不要放入代码仓库、网页可访问目录或网盘共享。
- `.env` 中的配对码在配对成功后即为废码；如仍不放心可删除该行。
- 传输本文件夹时建议核对文件 SHA-256（构建机执行 `pnpm liekan:build-agent` 结束时会打印）。

## 升级、备份与卸载

- 升级：从构建机重新拷贝新生成的 `agent.mjs`、`container.mjs` 覆盖本目录同名文件，执行 `docker compose up -d --build`。`state/` 保留采集进度。
- 备份：停止容器后打包 `state/` 目录即可（含凭据，请加密保存）。
- 卸载：`docker compose down` 后删除本文件夹。同时建议在网站后台"断开连接"撤销接收授权。

更多背景说明见产品文档 `docs/automatic-logs.md` 的"手动部署（自带部署包）"一节。
