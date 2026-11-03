# GEOInflow collector manual deployment kit

A self-contained deployment folder for the log collector. Copy the whole folder from the build machine to the log server, fill in `.env`, and a single command pairs and starts the collector — no installer download is required on the target server.

## Requirements

- Linux x64 / arm64 with Docker Engine and Docker Compose V2
- The website's Nginx / Apache Combined access log (whole directory readable, including rotated files)
- `agent.mjs` and `container.mjs` present in this folder (generated on the build machine by `pnpm liekan:build-agent`; if missing, generate them on the build machine first and copy again)

## Deployment steps

1. Copy the entire `liekan-agent-deploy/` folder to a non-public directory on the log server, for example `/opt/liekan-agent-deploy`.
2. Enter the folder and prepare the configuration:

   ```sh
   cd /opt/liekan-agent-deploy
   cp .env.example .env
   vi .env   # statistics URL, website ID, log directory/file, log group GID, pairing code
   ```

3. Create and own the state directory (the container runs as UID 65532):

   ```sh
   mkdir -p state && chown 65532:65532 state
   ```

4. Generate a one-time pairing code in the statistics console under "Data ingestion → Server install" (valid for 10 minutes, single use) and put it into `LIEKAN_PAIRING_CODE` in `.env`.
5. Start (the first run builds the image, validates the log file and pairs inside the container):

   ```sh
   docker compose up -d --build
   ```

6. Check status with `docker compose ps` and logs with `docker compose logs collector`. A healthy container plus a passing "re-check" in the console means the source is connected.

## Alternative: build from source on the log server

The default flow above requires copying pre-built `agent.mjs` / `container.mjs` from the build machine (they are generated artifacts kept out of git). If the log server can reach the code repository and the npm registry, you can skip the copy step and build the image from source on the server:

1. Clone the repository (or upload a source archive) on the log server and enter this folder:

   ```sh
   git clone -b <branch> https://github.com/<your-account>/GEOInflow.git /opt/GEOInflow
   cd /opt/GEOInflow/liekan-agent-deploy
   ```

2. Prepare `.env`, `state/` and the pairing code as in steps 2–4 above.
3. Start with the server-build compose file (bundling happens inside the image build; pulling the base image and two npm packages is required):

   ```sh
   docker compose -f docker-compose.server.yml up -d --build
   ```

If npm is slow or blocked, point the build at a mirror:

```sh
docker compose -f docker-compose.server.yml build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
docker compose -f docker-compose.server.yml up -d
```

If pulling the base image is restricted, point `BASE_IMAGE` at a mirror as well (no file edit needed):

```sh
docker compose -f docker-compose.server.yml build --build-arg BASE_IMAGE=docker.m.daocloud.io/library/node:22.23.4-alpine
```

Both paths produce the identical image and runtime configuration; copying the whole folder remains the default recommendation (the log server then needs no access to the repository or npm).

## Finding the log path and GID

- BT (BaoTa) panel: website → Settings → Log shows the path (usually `/www/wwwlogs/<domain>.log`); the log group is usually `www` — run `id -g www` for the GID.
- Manual Nginx: check the `access_log` directive in the site configuration, e.g. `access_log /var/log/nginx/example.com.access.log combined;` means directory `/var/log/nginx` and file `example.com.access.log`.
- The log file must be group-readable (`r`) and the directory traversable (`r-x`).
- `LIEKAN_LOG_DIRECTORY` must be a directory, never a single file: after rotation the collector keeps reading rotated files in the same directory.

## Pairing code and credentials

- The pairing code is valid for 10 minutes and can be consumed once. On first start with an empty state directory the container exchanges it for the long-term receive credential automatically; the code is dead afterwards and can be removed from `.env`.
- The long-term receive credential only lives in `state/<source id>/config.json` (mode 0600). It never enters `.env`, the compose file or the image.
- Restarts and image upgrades reuse the saved credential. After disconnecting in the console, follow the explicit reconnection steps below. Use a separate deployment folder and state directory for a new website.
- If pairing fails (expired, already used, or wrong website) the container exits with the reason in its logs: generate a new code, update `.env` and recreate the container with `docker compose up -d`.

## Reconnect after disconnecting in the console

Generate a new code for the original website and update `LIEKAN_PAIRING_CODE` in `.env`. Keep the receive URL, website ID, log path and entire `state/` directory, then run:

```sh
docker compose stop collector &&
docker compose run --rm -T --no-deps --entrypoint sh collector -c \
  'printf "%s" "$LIEKAN_PAIRING_CODE" | node /app/container.mjs pair' &&
  docker compose up -d --force-recreate
```

For source builds, add `-f docker-compose.server.yml` immediately after `docker compose` in each command above. The pairing command checks the saved credential first and reuses an active connection. A revoked credential allows the new code to be exchanged while preserving the old source configuration and buffer. The collector starts only after the pairing command succeeds. If it fails, correct the reported problem and retry while retaining the state directory. After reconnection, remove the consumed code from `.env` if desired and check reception in the console.

## Security notes

- `state/` holds the long-term credential and the encrypted buffer. Keep the directory permission-restricted (owner-only) and out of repositories, web-exposed directories and shared cloud drives.
- The pairing code in `.env` is inert after a successful pairing; remove the line if you prefer.
- When transferring this folder, verify file SHA-256 checksums (printed at the end of `pnpm liekan:build-agent` on the build machine).

## Upgrade, backup and removal

- Upgrade: copy freshly generated `agent.mjs` and `container.mjs` over the ones in this folder and run `docker compose up -d --build`. `state/` preserves the collection progress.
- Backup: stop the container and archive the `state/` directory (it contains the credential — store it encrypted).
- Remove: run `docker compose down` and delete this folder. Also disconnect the source in the statistics console to revoke the receive authorization.

See "Manual deployment (pre-built kit)" in `docs/automatic-logs.md` for background details.
