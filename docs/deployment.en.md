# Deployment and operations

**English** | [简体中文](deployment.md)

Use the repository's `scripts/liekan-deploy.sh` to deploy GEOInflow. It builds the current source, creates private configuration on first installation, runs migrations, checks health, and updates the application and workers.

This guide uses Docker Compose on a single host. See the [local deployment details](local-deployment.md) for existing-instance major-version protection, geographic data, and recovery. That guide and other advanced references linked below are currently in Simplified Chinese.

## Requirements

- Docker Engine or Docker Desktop installed and running, with Docker Compose V2.
- `flock` on Linux or `lockf` on macOS to prevent overlapping deployments.
- Network access to container images, Node dependencies, and geographic database download sources.
- Sufficient memory and disk space for Docker, builds, PostgreSQL, and the application.

The image pins Node.js 22.23.4 and pnpm 12.3.4. Docker builds configure a Node heap of 3072 MiB; native component builds, the Docker VM, and other services also need memory. Runtime capacity depends on actual log volume, retention, concurrency, and background builds. Measure capacity using your own data.

New installations use PostgreSQL 16 and Redis 7.4. Existing PostgreSQL 15 instances retain version 15. Changing the database major version requires a separate migration and recovery plan.

## First installation

Obtain the source code, enter the project root, and run:

```sh
sh scripts/liekan-deploy.sh
```

On first run, the script creates a restricted `.env`, generates independent database credentials, an application secret, and a two-factor encryption key, then builds the image and starts the services. The host does not need a separate Node.js or pnpm installation.

Default endpoints:

| Purpose | Address or behavior |
| --- | --- |
| Application | `http://127.0.0.1:3002` |
| PostgreSQL host endpoint | `127.0.0.1:15435` |
| Redis | Internal Compose access, with no public port mapping by default |
| Default network | `10.253.30.0/24`; check for overlap with existing networks before deployment |

A fresh installation starts with `admin / liekan`. Change the password after signing in and confirm the country and analytics timezone. Upgrades preserve customized credentials, renamed accounts, and deleted accounts.

Password login uses fixed one-minute limits: 10 attempts per account, 30 per trusted client source, and 120 across the shared instance, with a concurrent verification limit. Rejected attempts return `429` and `Retry-After`; an unavailable configured Redis returns `503`. Counters use `REDIS_URL`, then `LIEKAN_ANALYTICS_REDIS_URL`, or process-local memory when neither is configured. Process restarts and Redis eviction can reset counters, so public ingress should also enforce independent limits. Only explicitly configured trusted ingress headers establish client identities; missing or invalid addresses share one unknown-source quota. Multiple application instances should share Redis, and the ingress proxy must overwrite the trusted address header.

The browser tracker and collector redact known sensitive URL query and fragment parameters while retaining ordinary UTM attribution parameters. This applies to new events; existing records, page titles, and custom properties require separate review. Recording defaults to strict masking when no level is configured, while explicitly saved moderate masking remains supported. Strict masking covers text and inputs; exclude sensitive elements or omit the recorder from sensitive pages.

Repeated deployments preserve the existing `.env`, database credentials, and data volumes. If an existing database volume is found without its original configuration, the script stops and asks for that configuration to be restored. Upgrades retain the original database container and image major version to avoid an unintended storage-version change.

Commands in this guide explicitly use `docker-compose.liekan.yml`. Other Docker files at the repository root retain upstream compatibility uses. Standard deployments use the product deployment script.

## Check service health

```sh
docker compose -f docker-compose.liekan.yml ps
curl --fail http://127.0.0.1:3002/api/heartbeat
```

A healthy deployment includes `app`, `log-worker`, `analytics-worker`, `db`, and `analytics-cache`. The application, database, and workers have their own health checks.

Inspect recent logs for the relevant service when investigating a problem:

```sh
docker compose -f docker-compose.liekan.yml logs --tail=100 app
docker compose -f docker-compose.liekan.yml logs --tail=100 log-worker
docker compose -f docker-compose.liekan.yml logs --tail=100 analytics-worker
```

Log receipt and processing, statistics queries, and historical builds run through different workers. If receipt succeeds before analytics updates, check processing status, queues, and the data cutoff.

## Official example initialization

```sh
docker compose -f docker-compose.liekan.yml exec app node scripts/liekan-seed-demo.mjs
```

Docker startup imports “猎看官网（示例数据）” after migrations on a fresh installation. Use the command above for manual development or an explicit retry. Source and Docker images carry the complete sanitized dataset, catalog, and checksum manifest. The first import shifts timestamps; repeated imports preserve existing data, customized resources, and cleared or deleted state. Connect real inputs for production websites using the [quick start](getting-started.en.md).

## Domain, HTTPS, and trusted ingress

Point the domain to your reverse proxy, configure a valid TLS certificate, and proxy to `127.0.0.1:3002` on the same host. Keep the application and database ports off the public network.

If the proxy receives visitor connections directly, set the following in the private `.env`:

```dotenv
CLIENT_IP_HEADER=x-liekan-client-ip
```

The following location block can be used inside an Nginx `server` that already has HTTPS configured. The proxy overwrites the client address header and clears other forwarding fields that could be misused:

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

`client_max_body_size` provides proxy-level room for import requests. The application continues to enforce its own batch, format, and size limits. See the [official Nginx directive documentation](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size).

With a CDN in front, first restore a trusted address using the provider's actual network and firewall policies, restrict direct access to the origin, and then apply the same overwrite rules. Setting a header name alone does not establish proxy trust. See [trusted browser identity ingress](local-deployment.md#浏览器身份的可信入口) for configuration and verification.

Browser PV collection can continue without trusted IP ingress. UV, visits, and other identity-dependent analysis report missing evidence where applicable. When changing trusted ingress, record the switch time and compare identity coverage. Historical records without evidence retain their original state.

## Core configuration and optional capabilities

| Configuration | Purpose | Management |
| --- | --- | --- |
| `POSTGRES_USER` / `POSTGRES_DB` / `POSTGRES_PASSWORD` | Compose database connection | Generated on first installation and retained during upgrades |
| `DATABASE_URL` | Connection for source development, scripts, or custom runtimes | Use an independent database for the relevant environment |
| `APP_SECRET` | Application sessions and existing identifier-related secrets | Keep consistent across instances and retain during upgrades |
| `TWO_FACTOR_ENCRYPTION_KEY` | Encryption of two-factor data | Retain securely with the corresponding database |
| `CLIENT_IP_HEADER` | Visitor address supplied by a trusted reverse proxy | Pair with actual ingress isolation and overwrite rules |
| `LIEKAN_ANALYTICS_REDIS_URL` | Cross-process analytics cache | Standard Compose provides the internal address |
| `LIEKAN_PUBLIC_URL` | Public HTTPS root for automatic log ingestion and OAuth | Match the externally accessible application address |
| `LIEKAN_LOG_CREDENTIALS_KEY` | Encryption of automatic-source and supported control credentials | Generate a separate 32-byte Base64 key |
| `CLOUDFLARE_OAUTH_CLIENT_ID` / `CLOUDFLARE_OAUTH_CLIENT_SECRET` | Cloudflare log authorization | Follow the actual provider application configuration |
| `LIEKAN_AI_ENABLED` / `LIEKAN_AI_ENCRYPTION_KEY` | Optional AI analysis and model credential encryption | Disabled by default; enabling it requires a separate encryption key |

Store secrets in private configuration and follow each feature's rotation instructions. Maintainers build automatic-log installation assets using controlled signing keys. Test signing keys are reserved for isolated development and cannot be used for production distribution. See [automatic logs](automatic-logs.md) and the [AI configuration guide](ai.md).

## Geographic data

The default build prepares DB-IP City Lite under CC BY 4.0. Product and share pages retain DB-IP attribution. Existing valid, authorized City MMDB files take precedence and are preserved by automatic builds.

If the first download fails, the build stops. Restore network access and retry the same command. At runtime, a missing or damaged geographic database does not prevent event collection; unknown geography retains a missing state. Supplied MaxMind or other databases remain subject to their own data licenses.

The application mounts the managed geography volume read-only, and the log worker performs authorized updates. For a supplied geographic database, maintain read-only mounts for both services in the base `docker-compose.liekan.yml`. See [IP ingress and the managed geography volume](local-deployment.md#ip-入口与管理地理卷). The standard deployment script reads that base configuration only. The mainland China XDB supplement defaults to shadow mode; production activation requires a separate review and a valid data license. See [geography](geography.md) and [third-party notices](../THIRD_PARTY_NOTICES.md) for the complete configuration.

## Current data and background calculations

Standard Today dashboards read results over short 30-second intervals. Realtime visitors use their own 30-minute window. Heavier analysis such as heatmaps and retention keeps longer background windows. Automatic reads pause while the page is hidden or offline.

New conditions can register a background task. Published results remain available during updates. Prewarming for common Today, 7-day, and 30-day ranges uses the same conditions as the corresponding pages. Standard dashboards and heavier calculations have separate admission controls, and idle failed tasks pause automatic retries.

Use Analytics Acceleration to inspect coverage, incremental work, historical builds, and error states. Observe initial calculations, queue waiting, and cache hits separately. See [analytics acceleration](analytics-acceleration.md) for the detailed boundaries.

## Backups and upgrades

Before upgrading, retain the original `.env`, a database backup, application image identifiers, and migration records. Also back up a customized `docker-compose.liekan.yml` and preserve it when updating the source. Keep the encryption keys in `.env` with the corresponding database.

For an instance you operate, the following command exports the database into a private directory that is already ignored by Git:

```sh
(
    umask 077
    mkdir -p outputs/backups || exit 1
    backup_time=$(date -u +%Y%m%dT%H%M%SZ) || exit 1
    backup_file="outputs/backups/liekan-${backup_time}.dump"
    if [ -e "$backup_file" ] || [ -L "$backup_file" ]; then
        printf '%s\n' 'The backup target already exists. Keep it and retry later.' >&2
        exit 1
    fi
    backup_tmp=$(mktemp outputs/backups/.liekan-backup.XXXXXX) || exit 1
    trap 'rm -f "$backup_tmp"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    if ! docker compose -f docker-compose.liekan.yml exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_tmp"; then
        printf '%s\n' 'Database export failed. No final backup was created.' >&2
        exit 1
    fi
    if ! test -s "$backup_tmp" || ! docker compose -f docker-compose.liekan.yml exec -T db pg_restore --list < "$backup_tmp" > /dev/null; then
        printf '%s\n' 'Backup archive validation failed. No final backup was created.' >&2
        exit 1
    fi
    if ! ln "$backup_tmp" "$backup_file"; then
        printf '%s\n' 'The backup target exists or cannot be created. Check it before retrying.' >&2
        exit 1
    fi
    printf '%s\n' "Backup saved: $backup_file"
)
```

The final `.dump` is created only after export succeeds and the archive listing check passes. Existing targets with the same name are preserved. Keep another copy of the backup in a controlled location and rehearse a full restore in isolation. The listing check confirms that the archive can be read; a complete restore needs separate verification.

After obtaining the reviewed source intended for the upgrade, run the deployment command again:

```sh
sh scripts/liekan-deploy.sh
```

The script preserves existing configuration and the database, checks dependencies, stops the old workers, updates the application, applies incremental migrations, and updates both workers once the application is healthy. After upgrading, check sign-in, 2FA, website switching, browser metrics, log ingestion, referrals, and goals, then compare actual data totals.

## Recovery and rollback

Prepare an independent empty database or new volume first. Import the backup using a compatible PostgreSQL version, verify data totals, accounts, migration checksums, and encryption keys, then switch the application configuration. Retain the original database and volume for verification and avoid overwriting an instance that is still receiving writes.

If Cloudflare control is enabled, pause old control operations and reconcile remote state read-only after restoring the database and before workers resume control tasks. See [crawler control recovery](crawler-control.md#中断接管与恢复).

For an application rollback, use a candidate verified to be compatible with the current tables, authorization layer, catalogs, and task protocols. Retain applied migrations and newly collected data. An older image starting successfully establishes that its process can run; data and permission compatibility still require verification.

## Troubleshooting entry points

| Symptom | Main checks |
| --- | --- |
| Image build fails | Image sources, dependency sources, geographic downloads, Docker memory, and the original error |
| Application is unhealthy | Database connection, migration checks, and application logs |
| Logs are received but not processed | `log-worker` heartbeat, batch status, source permissions, and backlog |
| Statistics remain queued | `analytics-worker`, task error codes, coverage state, and capacity |
| A new deployment has no AI requests | Real log ingestion, processing completion, identity rules, and filters |
| Today's range is wrong after a timezone change | Saved account timezone, explicit dates in old URLs, and fixed share or task ranges |
| Geography is missing | Source fields and the validity of the authorized MMDB file |

Follow the relevant topic guides for multiple instances, proxy migration, key rotation, and historical recovery. Source deployment and local image builds do not establish a published public image channel.
