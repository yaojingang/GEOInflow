import { assertMigrationUpgrade } from './liekan-migration-upgrade-check.mjs';
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { assertProcessSuccess, createCancellation, runProcess } from './liekan-process.mjs';
import { assertUpstreamMigrations } from './liekan-schema-check.mjs';
import {
  acceptancePort as configuredAcceptancePort,
  acceptanceRuntimeDirectory,
} from './liekan-acceptance-target.mjs';

const acceptancePort = configuredAcceptancePort();
const baseUrl = `http://127.0.0.1:${acceptancePort}`;

// All mutations below target resources created by this invocation. The source DB is read only.
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const source = JSON.parse(fs.readFileSync('outputs/verification.json', 'utf8'));
if (!source.passed || !source.finalized || source.mode !== 'release' || source.head !== head)
  throw new Error('A clean source verification for this HEAD is required');
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
  throw new Error('Acceptance requires the verified clean candidate');
const upstream = JSON.parse(fs.readFileSync('config/liekan/upstream.json', 'utf8'));
const incrementalVisualPages = JSON.parse(
  fs.readFileSync('config/liekan/navigation-ui.json', 'utf8'),
).incrementalVisualPages;
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const stamp = `${head.slice(0, 12)}-${Date.now()}`;
const image = `liekan:candidate-${head.slice(0, 12)}`;
const network = `liekan-verify-${stamp}`,
  db = `${network}-db`,
  app = `${network}-app`,
  analyticsWorker = `${network}-analytics-worker`;
const password = randomBytes(32).toString('hex');
const aiPreviewKey = randomBytes(32).toString('hex');
const sourceUser = process.env.POSTGRES_USER || 'liekan';
const sourceDatabase = process.env.POSTGRES_DB || 'liekan';
if (
  !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceUser) ||
  !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceDatabase)
)
  throw new Error('Source database identifiers must be ordinary PostgreSQL identifiers');
for (const key of ['APP_SECRET', 'TWO_FACTOR_ENCRYPTION_KEY'])
  if (!process.env[key]) throw new Error(`Missing private ${key}`);
const directory = `outputs/acceptance-${stamp}`;
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const report = {
  head,
  image,
  url: baseUrl,
  version,
  upstream,
  startedAt: new Date().toISOString(),
  passed: false,
  finalized: false,
  steps: [],
};
const save = () => fs.writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2));
const cancellation = createCancellation();
let cleaning = false;
const run = async (command, args, name, options = {}) => {
  cancellation.checkpoint();
  const log = fs.openSync(`${directory}/${name}.txt`, 'w', 0o600);
  const start = Date.now();
  let result;
  try {
    result = await runProcess(command, args, {
      stdio: ['ignore', log, log],
      ...options,
      signal: cancellation.signal,
    });
  } finally {
    fs.closeSync(log);
  }
  report.steps.push({ name, status: result.status, seconds: (Date.now() - start) / 1000 });
  save();
  cancellation.checkpoint();
  assertProcessSuccess(result, `${name}; see private ${directory}/${name}.txt`);
};
const buildEnvironment = { ...process.env };
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY']) {
  const value = process.env[`LIEKAN_DOCKER_${key}`] || process.env[key];
  if (!value) continue;
  let proxy;
  try {
    proxy = new URL(value);
  } catch {
    throw new Error(`Invalid ${key} URL; proxy credentials are withheld`);
  }
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error(`Unsupported ${key} protocol`);
  if (process.platform === 'darwin' && ['localhost', '127.0.0.1', '[::1]'].includes(proxy.hostname))
    proxy.hostname = 'host.docker.internal';
  buildEnvironment[key] = proxy.toString();
}
const dockerEnv = (env, ...args) => {
  if (!cleaning) cancellation.checkpoint();
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      timeout: 30000,
    }).trim();
  } catch {
    throw new Error(`Docker ${args[0]} failed; credentials are withheld from diagnostics`);
  }
};
const docker = (...args) => dockerEnv({}, ...args);
const psql = (sql, database = 'liekan_empty') =>
  docker(
    'exec',
    db,
    'psql',
    '-U',
    'liekan_verify',
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
    '-Atc',
    sql,
  );
const installationSnapshot = database => {
  if (psql("SELECT to_regclass('liekan_installation') IS NOT NULL", database) !== 't')
    return { present: false };
  const rows = psql(
    "SELECT coalesce(json_agg(json_build_object('websiteId',website_id,'method',method,'lastStep',last_step,'browserCheckDeferred',browser_check_deferred,'logCheckDeferred',log_check_deferred,'completedAt',completed_at,'updatedAt',updated_at) ORDER BY website_id),'[]'::json) FROM liekan_installation",
    database,
  );
  const parsed = JSON.parse(rows);
  if (!Array.isArray(parsed)) throw new Error('Installation snapshot is invalid');
  return {
    present: true,
    count: parsed.length,
    sha256: createHash('sha256').update(rows).digest('hex'),
  };
};
const officialHistory = async (database, allowPending = false) => {
  const result = await assertUpstreamMigrations(
    {
      $queryRawUnsafe: async sql =>
        JSON.parse(
          psql(
            `SELECT coalesce(json_agg(row_to_json(history)), '[]'::json) FROM (${sql}) history`,
            database,
          ),
        ),
    },
    { schema: 'public', allowPending },
  );
  cancellation.checkpoint();
  return result;
};
const countsSQL =
  'SELECT json_build_object(' +
  [
    'user',
    'website',
    'session',
    'website_event',
    'report',
    'liekan_log',
    'liekan_import',
    'liekan_catalog',
    'liekan_setting',
    'liekan_migration',
  ]
    .map(t => `'${t}',(SELECT count(*) FROM "${t}")`)
    .join(',') +
  ')';
const pause = cancellation.pause;
const healthy = async () => {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    cancellation.checkpoint();
    try {
      const response = await fetch(`${baseUrl}/api/heartbeat`, {
        signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)]),
      });
      cancellation.checkpoint();
      if (response.ok) return;
    } catch {
      cancellation.checkpoint();
    }
    await pause(1000);
  }
  throw new Error('Isolated candidate did not become healthy');
};
const startApp = async database => {
  const aiEnvironment =
    database === 'liekan_empty'
      ? { LIEKAN_AI_ENABLED: 'true', LIEKAN_AI_ENCRYPTION_KEY: aiPreviewKey }
      : {
          LIEKAN_AI_ENABLED: process.env.LIEKAN_AI_ENABLED || 'false',
          LIEKAN_AI_ENCRYPTION_KEY: process.env.LIEKAN_AI_ENCRYPTION_KEY || '',
        };
  dockerEnv(
    {
      DATABASE_URL: `postgresql://liekan_verify:${password}@${db}:5432/${database}`,
      ...aiEnvironment,
    },
    'create',
    '--name',
    app,
    '--network',
    network,
    '-p',
    `127.0.0.1:${acceptancePort}:3000`,
    '-e',
    'DATABASE_URL',
    '-e',
    'APP_SECRET',
    '-e',
    'TWO_FACTOR_ENCRYPTION_KEY',
    '-e',
    'LIEKAN_AI_ENABLED',
    '-e',
    'LIEKAN_AI_ENCRYPTION_KEY',
    '-e',
    'DISABLE_BOT_CHECK=1',
    '-e',
    'CLIENT_IP_HEADER=x-liekan-fixture-ip',
    '-e',
    'DISABLE_TELEMETRY=1',
    '-e',
    'DISABLE_UPDATES=1',
    '-e',
    'MCP_ENABLED=1',
    '-e',
    'DEFAULT_LOCALE=zh-CN',
    image,
  );
  appCreated = true;
  docker('start', app);
  await healthy();
  dockerEnv(
    { DATABASE_URL: `postgresql://liekan_verify:${password}@${db}:5432/${database}` },
    'create',
    '--name',
    analyticsWorker,
    '--network',
    network,
    '-e',
    'DATABASE_URL',
    '-e',
    'APP_SECRET',
    '-e',
    'DISABLE_TELEMETRY=1',
    image,
    'node',
    'dist/liekan-analytics-worker.mjs',
  );
  analyticsWorkerCreated = true;
  docker('start', analyticsWorker);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      docker(
        'exec',
        analyticsWorker,
        'node',
        '-e',
        "const fs=require('node:fs');process.exit(Date.now()-fs.statSync('/tmp/liekan-analytics-worker-heartbeat').mtimeMs<120000?0:1)",
      );
      break;
    } catch {
      if (attempt === 29) throw new Error('Isolated analytics worker did not become ready');
      await pause(1000);
    }
  }
  (report.analyticsWorkers ||= []).push({ database, ready: true });
};
let networkCreated = false,
  dbCreated = false,
  appCreated = false,
  analyticsWorkerCreated = false;
save();
try {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(acceptancePort, '127.0.0.1', () => server.close(resolve));
  });
  await run('docker', ['pull', 'node:22.23.4-alpine'], 'node-base');
  await run('docker', ['pull', 'postgres:15-alpine'], 'database-base');
  await run(
    'docker',
    [
      'build',
      '-f',
      'Dockerfile.liekan',
      '--build-arg',
      'HTTP_PROXY',
      '--build-arg',
      'HTTPS_PROXY',
      '--build-arg',
      'NO_PROXY',
      '--build-arg',
      `LIEKAN_REVISION=${head}`,
      '--build-arg',
      `LIEKAN_VERSION=${version}`,
      '--build-arg',
      `LIEKAN_UPSTREAM=${upstream.commit}`,
      '--build-arg',
      `LIEKAN_UI=${upstream.uiManifestSha256}`,
      '--build-arg',
      `LIEKAN_FEATURE_UI=${upstream.featureUiManifestSha256}`,
      '--build-arg',
      `LIEKAN_MIGRATION=${upstream.liekanMigration}`,
      '--build-arg',
      `LIEKAN_AI_UI=${upstream.aiUiManifestSha256}`,
      '-t',
      image,
      '.',
    ],
    'docker-build',
    { env: buildEnvironment },
  );
  await run(
    'docker',
    ['run', '--rm', '--entrypoint', 'node', image, 'generated/ai-maintenance.mjs', '--help'],
    'ai-maintenance-runtime-help',
  );
  const labels = JSON.parse(
    docker('image', 'inspect', image, '--format', '{{json .Config.Labels}}'),
  );
  if (
    labels['org.opencontainers.image.revision'] !== head ||
    labels['org.opencontainers.image.version'] !== version ||
    labels['io.liekan.ui.sha256'] !== upstream.uiManifestSha256 ||
    labels['io.liekan.upstream.revision'] !== upstream.commit ||
    labels['io.liekan.feature-ui.sha256'] !== upstream.featureUiManifestSha256 ||
    labels['io.liekan.migration'] !== String(upstream.liekanMigration) ||
    labels['io.liekan.ai-ui.sha256'] !== upstream.aiUiManifestSha256
  )
    throw new Error('Candidate OCI metadata differs');
  report.imageId = docker('image', 'inspect', image, '--format', '{{.Id}}');
  report.baseImages = ['node:22.23.4-alpine', 'postgres:15-alpine'].map(ref => ({
    ref,
    id: docker('image', 'inspect', ref, '--format', '{{.Id}}'),
  }));
  const sourceId = docker('compose', '-f', 'docker-compose.liekan.yml', 'ps', '-q', 'db');
  if (!sourceId) throw new Error('The separate Liekan source database must be running');
  const sourceLabels = JSON.parse(
    docker('inspect', sourceId, '--format', '{{json .Config.Labels}}'),
  );
  if (
    sourceLabels['com.docker.compose.project'] !== 'liekan' ||
    sourceLabels['com.docker.compose.service'] !== 'db'
  )
    throw new Error('Source DB identity mismatch');
  const backup = `${directory}/database.sql`,
    fd = fs.openSync(backup, 'w', 0o600);
  let dumped;
  try {
    dumped = await runProcess(
      'docker',
      ['exec', sourceId, 'pg_dump', '-U', sourceUser, '--no-owner', '--no-acl', sourceDatabase],
      { stdio: ['ignore', fd, 'ignore'], signal: cancellation.signal },
    );
  } finally {
    fs.closeSync(fd);
  }
  cancellation.checkpoint();
  assertProcessSuccess(dumped, 'Source backup');
  report.backupBytes = fs.statSync(backup).size;
  const networkIds = docker('network', 'ls', '-q').split('\n').filter(Boolean);
  const allocated = JSON.parse(docker('network', 'inspect', ...networkIds))
    .flatMap(value => value.IPAM?.Config || [])
    .filter(value => value.Subnet && ipaddr.parseCIDR(value.Subnet)[0].kind() === 'ipv4')
    .map(value => ipaddr.parseCIDR(value.Subnet));
  const subnet = Array.from({ length: 224 }, (_, index) => `10.253.${index + 31}.0/24`).find(
    value => {
      const [address, prefix] = ipaddr.parseCIDR(value);
      return allocated.every(
        ([existing, existingPrefix]) =>
          !address.match(existing, existingPrefix) && !existing.match(address, prefix),
      );
    },
  );
  if (!subnet) throw new Error('No free isolated verification subnet in the configured range');
  report.subnet = subnet;
  docker('network', 'create', '--subnet', subnet, network);
  networkCreated = true;
  dockerEnv(
    { POSTGRES_PASSWORD: password },
    'create',
    '--name',
    db,
    '--label',
    `io.liekan.api-fixture=${stamp}`,
    '--network',
    network,
    '-e',
    'POSTGRES_USER=liekan_verify',
    '-e',
    'POSTGRES_PASSWORD',
    '-e',
    'POSTGRES_DB=liekan_empty',
    'postgres:15-alpine',
  );
  dbCreated = true;
  docker('start', db);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      psql('SELECT 1');
      break;
    } catch {
      if (attempt === 59) throw new Error('Isolated DB not ready');
      await pause(1000);
    }
  }
  await startApp('liekan_empty');
  report.emptyInstallation = installationSnapshot('liekan_empty');
  if (!report.emptyInstallation.present || report.emptyInstallation.count !== 0)
    throw new Error('Fresh website installation bootstrap differs');
  report.emptyUpstreamMigrations = await officialHistory('liekan_empty');
  report.emptyMigrationCount = Number(psql('SELECT count(*) FROM liekan_migration'));
  if (report.emptyMigrationCount !== upstream.liekanMigration)
    throw new Error('Fresh bootstrap did not apply all migrations');
  await run(
    process.execPath,
    ['scripts/liekan-data-regression.mjs', '--container', db, '--database', 'liekan_empty'],
    'data-regression',
  );
  report.dataRegression = JSON.parse(
    fs.readFileSync(`${directory}/data-regression.txt`, 'utf8').trim(),
  );
  if (
    !report.dataRegression.passed ||
    !report.dataRegression.readOnly ||
    report.dataRegression.fixture !== 'synthetic-relations' ||
    !/^[a-f0-9]{64}$/.test(report.dataRegression.sourceHash) ||
    !Array.isArray(report.dataRegression.checks) ||
    report.dataRegression.checks.length < 8
  )
    throw new Error('Synthetic data regression evidence is incomplete');
  const env = {
    ...process.env,
    PLAYWRIGHT_BASE_URL: baseUrl,
    API_COVERAGE: 'enforce',
    LIEKAN_API_FIXTURE_CONTAINER: db,
    LIEKAN_API_FIXTURE_OWNER: stamp,
    LIEKAN_API_FIXTURE_DATABASE: 'liekan_empty',
    LIEKAN_API_FIXTURE_USER: 'liekan_verify',
  };
  delete env.API_SKIP_SEED;
  await run(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test', '-c', 'playwright.api.config.ts'],
    'api',
    { env },
  );
  report.apiCoverage = JSON.parse(
    fs.readFileSync(
      `${acceptanceRuntimeDirectory(new URL(baseUrl))}/coverage/summary.json`,
      'utf8',
    ),
  );
  await run(process.execPath, ['scripts/liekan-team-user-acceptance.mjs'], 'team-user-acceptance', {
    env: { ...process.env, LIEKAN_URL: baseUrl, LIEKAN_TEAM_TEST_DB_CONTAINER: db },
  });
  report.teamUsers = JSON.parse(
    fs.readFileSync('test-results/liekan-team-users/report.json', 'utf8'),
  );
  if (
    !report.teamUsers.passed ||
    !report.teamUsers.cleanup ||
    report.teamUsers.head !== head ||
    report.teamUsers.checks.length !== 3 ||
    report.teamUsers.checks.some(check => !check.passed) ||
    report.teamUsers.responsive.length !== 3 ||
    report.teamUsers.responsive.some(check => !check.passed) ||
    report.teamUsers.errors.length
  )
    throw new Error('Team user creation, rollback and responsive acceptance incomplete');
  await run(process.execPath, ['scripts/liekan-evidence-visual.mjs'], 'traffic-evidence-visual', {
    env: { ...process.env, LIEKAN_URL: baseUrl },
  });
  report.trafficEvidenceVisual = JSON.parse(
    fs.readFileSync('test-results/liekan-evidence/result.json', 'utf8'),
  );
  if (
    !report.trafficEvidenceVisual.passed ||
    report.trafficEvidenceVisual.head !== head ||
    report.trafficEvidenceVisual.checks.length !== 24 ||
    report.trafficEvidenceVisual.errors.length
  )
    throw new Error('Traffic evidence visual acceptance incomplete');
  await run(process.execPath, ['scripts/liekan-keyword-visual.mjs'], 'keyword-visual', {
    env: { ...process.env, LIEKAN_URL: baseUrl },
  });
  report.keywordVisual = JSON.parse(
    fs.readFileSync('test-results/liekan-keywords/report.json', 'utf8'),
  );
  if (
    !report.keywordVisual.passed ||
    !report.keywordVisual.cleanup ||
    report.keywordVisual.head !== head ||
    report.keywordVisual.checks.length !== 3
  )
    throw new Error('Source keyword visual and interaction acceptance incomplete');
  await run(process.execPath, ['scripts/liekan-search-engine-visual.mjs'], 'search-engine-visual', {
    env: { ...env, LIEKAN_URL: baseUrl },
  });
  report.searchEngineVisual = JSON.parse(
    fs.readFileSync('test-results/liekan-search-engines/report.json', 'utf8'),
  );
  if (
    !report.searchEngineVisual.passed ||
    !report.searchEngineVisual.cleanup ||
    report.searchEngineVisual.head !== head ||
    report.searchEngineVisual.checks.length !== 3
  )
    throw new Error('Search engine visual and interaction acceptance incomplete');
  await run(process.execPath, ['scripts/liekan-feature-flows.mjs'], 'feature-flows', {
    env: { ...process.env, LIEKAN_URL: baseUrl },
  });
  report.featureFlows = JSON.parse(
    fs.readFileSync('test-results/liekan-feature-flows/report.json', 'utf8'),
  );
  if (
    !report.featureFlows.passed ||
    report.featureFlows.head !== head ||
    report.featureFlows.checks.length !== 14 ||
    report.featureFlows.checks.some(check => !check.passed) ||
    report.featureFlows.errors.length
  )
    throw new Error('Supplemental interaction acceptance incomplete');
  await run(process.execPath, ['scripts/liekan-dialog-visual.mjs'], 'dialog-visual', {
    env: { ...process.env, LIEKAN_URL: baseUrl },
  });
  report.dialogVisual = JSON.parse(
    fs.readFileSync('test-results/liekan-dialogs/report.json', 'utf8'),
  );
  if (
    !report.dialogVisual.passed ||
    report.dialogVisual.head !== head ||
    report.dialogVisual.checks.length !== 50 ||
    report.dialogVisual.duplicates?.length !== 7 ||
    report.dialogVisual.responsive.length !== 15 ||
    report.dialogVisual.supplementalResponsive?.length !== 8 ||
    report.dialogVisual.websiteDeletionSuccess?.length !== 6 ||
    report.dialogVisual.websiteDeletionSuccess.some(check => !check.passed) ||
    report.dialogVisual.errors.length ||
    !report.dialogVisual.cleanup?.passed
  )
    throw new Error('Centered dialog acceptance incomplete');
  await run(process.execPath, ['scripts/liekan-feature-visual.mjs'], 'feature-visual', {
    env: { ...process.env, LIEKAN_URL: baseUrl },
  });
  report.featureVisual = JSON.parse(
    fs.readFileSync('test-results/liekan-features/report.json', 'utf8'),
  );
  if (
    !report.featureVisual.passed ||
    report.featureVisual.head !== head ||
    report.featureVisual.checks.length !== 66 * 4 ||
    JSON.stringify(report.featureVisual.incrementalChecks?.map(({ id, width }) => [id, width])) !==
      JSON.stringify(
        [1440, 1280, 375, 320].flatMap(width => incrementalVisualPages.map(id => [id, width])),
      ) ||
    report.featureVisual.incrementalChecks.some(check => !check.passed) ||
    !report.featureVisual.mobile?.passed ||
    report.featureVisual.mobile.head !== head ||
    report.featureVisual.mobile.checks !== (77 + incrementalVisualPages.length) * 4 * 2 ||
    JSON.stringify(report.featureVisual.mobile.incrementalPageIds) !==
      JSON.stringify(incrementalVisualPages)
  )
    throw new Error('Supplemental visual acceptance incomplete');
  await run(process.execPath, ['scripts/liekan-manual-refresh.mjs'], 'manual-refresh', {
    env: { ...process.env, LIEKAN_URL: baseUrl },
  });
  report.manualRefresh = JSON.parse(
    fs.readFileSync('test-results/liekan-manual-refresh/report.json', 'utf8'),
  );
  if (
    !report.manualRefresh.passed ||
    !report.manualRefresh.finalized ||
    report.manualRefresh.head !== head ||
    JSON.stringify(report.manualRefresh.featureIds) !==
      JSON.stringify(
        JSON.parse(
          fs.readFileSync('src/lib/liekan/contracts/feature-pages.json', 'utf8'),
        ).pages.map(page => page.id),
      ) ||
    report.manualRefresh.realIdle.length !== 4 ||
    !report.manualRefresh.cachedHistory?.passed ||
    !report.manualRefresh.noStoreHistory?.passed
  )
    throw new Error('Manual refresh acceptance incomplete');
  await run(process.execPath, ['scripts/liekan-ai-visual.mjs'], 'ai-visual', {
    env: { ...process.env, LIEKAN_URL: baseUrl },
  });
  await run(process.execPath, ['scripts/liekan-ai-home-visual.mjs'], 'ai-home-visual', {
    env: { ...process.env, LIEKAN_URL: baseUrl },
  });
  report.aiHomeVisual = JSON.parse(
    fs.readFileSync('test-results/liekan-ai-home-v3/report.json', 'utf8'),
  );
  if (
    !report.aiHomeVisual.passed ||
    report.aiHomeVisual.head !== head ||
    JSON.stringify(report.aiHomeVisual.checks.map(check => check.width)) !==
      JSON.stringify([1440, 1280, 375, 320]) ||
    report.aiHomeVisual.errors?.length
  )
    throw new Error('AI homepage visual acceptance incomplete');
  report.aiVisual = JSON.parse(fs.readFileSync('test-results/liekan-ai/report.json', 'utf8'));
  if (
    !report.aiVisual.passed ||
    report.aiVisual.head !== head ||
    report.aiVisual.checks.length !== 8 ||
    report.aiVisual.checks.some(check => check.passed !== true) ||
    report.aiVisual.errors?.length
  )
    throw new Error('AI visual acceptance incomplete');
  await run(process.execPath, ['scripts/liekan-help-visual.mjs'], 'help-visual', {
    env: { ...process.env, LIEKAN_URL: baseUrl },
  });
  report.helpVisual = JSON.parse(fs.readFileSync('test-results/liekan-help/report.json', 'utf8'));
  if (
    !report.helpVisual.passed ||
    report.helpVisual.head !== head ||
    report.helpVisual.checks.length !== 12 ||
    report.helpVisual.checks.some(check => !check.passed) ||
    report.helpVisual.errors.length
  )
    throw new Error('Help center acceptance incomplete');
  docker('rm', '-f', analyticsWorker);
  analyticsWorkerCreated = false;
  docker('rm', '-f', app);
  appCreated = false;
  psql('CREATE DATABASE liekan_restore');
  const input = fs.openSync(backup, 'r');
  let loaded;
  try {
    loaded = await runProcess(
      'docker',
      [
        'exec',
        '-i',
        db,
        'psql',
        '-U',
        'liekan_verify',
        '-d',
        'liekan_restore',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { stdio: [input, 'ignore', 'ignore'], signal: cancellation.signal },
    );
  } finally {
    fs.closeSync(input);
  }
  cancellation.checkpoint();
  assertProcessSuccess(loaded, 'Candidate backup restore');
  // Count the restored snapshot before upgrade, so concurrent source traffic cannot change this baseline.
  report.restoredUpstreamBefore = await officialHistory('liekan_restore', true);
  report.before = JSON.parse(psql(countsSQL, 'liekan_restore'));
  const migrationLedgerSql =
    "SELECT coalesce(json_agg(json_build_object('name',name,'checksum',checksum,'appliedAt',applied_at) ORDER BY name),'[]'::json) FROM liekan_migration";
  const beforeMigrations = JSON.parse(psql(migrationLedgerSql, 'liekan_restore'));
  report.installationBefore = installationSnapshot('liekan_restore');
  await startApp('liekan_restore');
  report.installationAfter = installationSnapshot('liekan_restore');
  if (
    !report.installationAfter.present ||
    (report.installationBefore.present
      ? report.installationBefore.sha256 !== report.installationAfter.sha256 ||
        report.installationBefore.count !== report.installationAfter.count
      : report.installationAfter.count !== 0)
  )
    throw new Error('Restore changed website installation records');
  report.restoredUpstreamAfter = await officialHistory('liekan_restore');
  report.after = JSON.parse(psql(countsSQL, 'liekan_restore'));
  if (
    Object.entries(report.before).some(
      ([table, count]) => table !== 'liekan_migration' && report.after[table] !== count,
    )
  )
    throw new Error('Restore changed data totals');
  const migrations = JSON.parse(psql(migrationLedgerSql, 'liekan_restore'));
  const lock = JSON.parse(fs.readFileSync('config/liekan/migrations.json', 'utf8'));
  report.preservedIndependentMigrations = assertMigrationUpgrade(
    beforeMigrations,
    migrations,
    lock,
  );
  report.migrations = migrations;
  await run('docker', ['exec', app, 'node', 'scripts/liekan-migrate.mjs'], 'migration-idempotency');
  const beforeLedger = psql(
    "SELECT json_agg(json_build_object('name',name,'checksum',checksum,'appliedAt',applied_at) ORDER BY name) FROM liekan_migration",
    'liekan_restore',
  );
  await run('docker', ['exec', app, 'node', 'scripts/liekan-migrate.mjs'], 'migration-repeat');
  if (
    psql(
      "SELECT json_agg(json_build_object('name',name,'checksum',checksum,'appliedAt',applied_at) ORDER BY name) FROM liekan_migration",
      'liekan_restore',
    ) !== beforeLedger
  )
    throw new Error('Repeated migration modified the ledger');
  await run(
    'docker',
    ['exec', app, 'node', '--experimental-strip-types', 'scripts/liekan-restored-check.mjs'],
    'restored-auth',
  );
  report.restoredAuth = JSON.parse(
    fs
      .readFileSync(`${directory}/restored-auth.txt`, 'utf8')
      .split('\n')
      .filter(line => line.startsWith('{'))
      .at(-1),
  );
  await run(process.execPath, ['--import', 'tsx', 'scripts/liekan-visual.mjs'], 'visual', {
    env: { ...process.env, LIEKAN_URL: baseUrl },
  });
  report.visual = JSON.parse(fs.readFileSync('test-results/liekan-visual/geometry.json', 'utf8'));
  if (!report.visual.passed || report.visual.head !== head)
    throw new Error('Visual evidence is not bound to the candidate');
  if (
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== head ||
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
  )
    throw new Error('Candidate source changed during acceptance');
} catch (error) {
  report.error = error.message;
  save();
  throw error;
} finally {
  cleaning = true;
  // Names are invocation-unique and flags are set only after successful creation.
  const cleanupErrors = [];
  if (analyticsWorkerCreated) {
    try {
      docker('rm', '-f', analyticsWorker);
    } catch {
      cleanupErrors.push(analyticsWorker);
    }
  }
  if (appCreated) {
    try {
      docker('rm', '-f', app);
    } catch {
      cleanupErrors.push(app);
    }
  }
  if (dbCreated) {
    try {
      docker('rm', '-fv', db);
    } catch {
      cleanupErrors.push(db);
    }
  }
  if (networkCreated) {
    try {
      docker('network', 'rm', network);
    } catch {
      cleanupErrors.push(network);
    }
  }
  report.cleanup = { passed: cleanupErrors.length === 0, remaining: cleanupErrors };
  if (cancellation.signal.aborted) report.error = cancellation.signal.reason.message;
  save();
  cancellation.dispose();
}
if (!report.cleanup.passed) {
  report.error = 'Acceptance resource cleanup failed';
  save();
  throw new Error(report.error);
}
cancellation.checkpoint();
report.passed = true;
report.finalized = true;
report.finishedAt = new Date().toISOString();
save();
fs.writeFileSync('outputs/acceptance.json', JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    head,
    image,
    imageId: report.imageId,
    passed: true,
    report: `${directory}/report.json`,
  }),
);
