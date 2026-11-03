import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const websiteId = '11111111-1111-4111-8111-111111111111';
const uuid = number =>
  `${String(number).padStart(8, '0')}-0000-4000-8000-${String(number).padStart(12, '0')}`;
const encoded = '/%E6%96%87%E6%A1%A3/AI%20%E5%85%A5%E9%97%A8';

export function createDataAdapters(query, { sourceRef } = {}) {
  if (sourceRef && !/^[a-f0-9]{40}$/.test(sourceRef))
    throw new Error('Source ref must be a commit SHA');
  const sources = new Map(),
    cache = new Map();
  const load = relative => {
    if (cache.has(relative)) return cache.get(relative);
    const source = sourceRef
      ? execFileSync('git', ['show', `${sourceRef}:${relative}`], { cwd: root, encoding: 'utf8' })
      : fs.readFileSync(path.join(root, relative), 'utf8');
    sources.set(relative, source);
    if (relative.endsWith('.json')) {
      const parsed = JSON.parse(source);
      cache.set(relative, parsed);
      return parsed;
    }
    const module = { exports: {} };
    cache.set(relative, module.exports);
    const code = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;
    const dependencies = id => {
      // This harness compares original source queries; rollup equivalence has its own database suite.
      if (id === './analysis-rollups')
        return { readAnalysisLogRollup: async () => null, readAnalysisLogSeries: async () => null };
      // Keep the raw SQL oracle independent of the persistent report-cache runtime.
      if (id === './report-fragments')
        return {
          reportFragmentsActive: () => false,
          readReportFragment: (_kind, _start, _end, _parameters, load) => load(),
        };
      if (id === './browser-detail-facts') return { readBrowserDetailFacts: async () => null };
      // This synthetic adapter checks SQL metric shapes; runtime population evidence has PostgreSQL integration coverage.
      if (id === './browser-population' && relative.startsWith('src/lib/liekan/upstream/'))
        return { readBrowserPopulation: async () => undefined };
      if (id === './native-snapshot') return { nativeSnapshot: work => work() };
      if (id === './server')
        return {
          query,
          LiekanError: class extends Error {},
          humanTotals: async () => ({
            pageviews: 3,
            visitors: 2,
            visits: 2,
            bounces: 1,
            totaltime: 120,
          }),
        };
      if (id === '@/queries/sql')
        return {
          getFunnel: () => {
            throw new Error('Fixture has no funnel');
          },
        };
      if (id === '@/lib/analytics-schema')
        return {
          funnelParametersSchema: {
            safeParse: () => {
              throw new Error('Fixture has no funnel');
            },
          },
        };
      if (id === '@/lib/country') return load('src/lib/country.ts');
      if (id === '@/lib/url') return load('src/lib/url.ts');
      if (id.startsWith('.'))
        return load(
          path.posix.normalize(
            path.posix.join(path.posix.dirname(relative), id.endsWith('.json') ? id : `${id}.ts`),
          ),
        );
      return require(id);
    };
    new Function('require', 'module', 'exports', code)(dependencies, module, module.exports);
    cache.set(relative, module.exports);
    return module.exports;
  };
  const analytics = load('src/lib/liekan/upstream/analytics.ts');
  const logs = load('src/lib/liekan/upstream/logs.ts');
  return {
    analytics,
    logs,
    geography: load('src/lib/country.ts'),
    sourceHash: () => {
      const hash = createHash('sha256');
      for (const [name, source] of [...sources].sort(([a], [b]) => a.localeCompare(b)))
        hash.update(name).update(source);
      return hash.digest('hex');
    },
  };
}

const sqlLiteral = value =>
  `'${String(value instanceof Date ? value.toISOString() : value).replaceAll("'", "''")}'`;
const relation = (name, columns, rows) =>
  `${name} AS (SELECT * FROM jsonb_to_recordset(${sqlLiteral(JSON.stringify(rows))}::jsonb) AS r(${columns}))`;
export function syntheticRelations() {
  const event = (number, session, visit, time, urlPath, type = 1, name = null) => ({
    event_id: uuid(number),
    website_id: websiteId,
    session_id: uuid(session),
    visit_id: uuid(visit),
    created_at: time,
    event_type: type,
    url_path: urlPath,
    event_name: name,
    referrer_domain: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
  });
  const events = [
    event(1, 11, 21, '2026-10-01T23:59:00+08:00', '/a'),
    event(2, 11, 21, '2026-10-02T00:01:00+08:00', '/b'),
    event(3, 11, 21, '2026-10-02T00:02:00+08:00', '/b', 2, 'download'),
    event(4, 12, 22, '2026-10-02T00:03:00+08:00', '/c'),
    event(5, 13, 23, '2026-09-01T10:00:00Z', '/文档/AI 入门'),
    event(6, 13, 24, '2026-09-03T10:00:00Z', '/文档/AI 入门'),
    event(7, 13, 25, '2026-09-01T10:00:00Z', '/literal%20space'),
    event(8, 13, 26, '2026-09-01T10:00:00Z', '/reserved%2Fslash'),
    { ...event(9, 14, 27, '2026-10-02T00:03:00+08:00', '/c'), website_id: uuid(900) },
  ];
  const sessions = [11, 12, 13, 14].map(number => ({
    session_id: uuid(number),
    website_id: number === 14 ? uuid(900) : websiteId,
    created_at: '2026-09-01T00:00:00Z',
    country: 'CN',
    region: 'CN-BJ',
    city: 'Fixture',
    browser: 'Chrome',
    os: 'Linux',
    device: 'desktop',
  }));
  const catalog = [encoded, '/literal%2520space', '/reserved%2Fslash'].map(page => ({
    website_id: websiteId,
    path: page,
    published_at: '2026-09-01T00:00:00Z',
  }));
  const log = (time, page, type = '训练') => ({
    website_id: websiteId,
    created_at: time,
    path: page,
    bot: type === '其他' ? '其他' : 'GPTBot',
    bot_type: type,
  });
  const logs = [
    log('2026-08-31T00:00:00Z', encoded),
    log('2026-09-02T00:00:00Z', encoded),
    log('2026-09-03T00:00:00Z', encoded),
    log('2026-09-04T00:00:00Z', encoded),
    log('2026-08-30T00:00:00Z', '/literal%2520space'),
    log('2026-09-02T00:00:00Z', '/literal%2520space'),
    log('2026-09-03T00:00:00Z', '/literal%2520space'),
    log('2026-09-02T00:00:00Z', '/reserved%2Fslash'),
    log('2026-10-01T00:00:00Z', '/a'),
    log('2026-10-01T00:00:00Z', '/a', '其他'),
    log('2025-07-01T07:30:00Z', '/dst', '其他'),
  ];
  return (
    'WITH ' +
    [
      relation(
        'website_event',
        'event_id uuid,website_id uuid,session_id uuid,visit_id uuid,created_at timestamptz,event_type integer,url_path text,event_name text,referrer_domain text,utm_source text,utm_medium text,utm_campaign text',
        events,
      ),
      relation(
        'session',
        'session_id uuid,website_id uuid,created_at timestamptz,country text,region text,city text,browser text,os text,device text',
        sessions,
      ),
      relation(
        'report',
        'report_id uuid,website_id uuid,type text,name text,parameters jsonb,created_at timestamptz',
        [
          {
            report_id: uuid(99),
            website_id: websiteId,
            type: 'goal',
            name: 'Download',
            parameters: { type: 'event', value: 'download' },
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      ),
      relation('liekan_catalog', 'website_id uuid,path text,published_at timestamptz', catalog),
      relation(
        'liekan_log',
        'website_id uuid,created_at timestamptz,path text,bot text,bot_type text,ai_eligible boolean',
        logs,
      ),
      'liekan_effective_log AS (SELECT * FROM liekan_log)',
      'liekan_reporting_log AS (SELECT * FROM liekan_effective_log)',
    ].join(',')
  );
}

export function readonlyFixtureSQL(sql, params) {
  if (!/^\s*(WITH|SELECT)\b/i.test(sql)) throw new Error('Fixture accepts read queries only');
  const actual = sql.trim();
  const fixture =
    syntheticRelations() + (actual.startsWith('WITH ') ? `,${actual.slice(5)}` : ` ${actual}`);
  return `BEGIN READ ONLY;\nPREPARE liekan_data_case AS SELECT coalesce(jsonb_agg(result),'[]'::jsonb)::text FROM (${fixture}) result;\nEXECUTE liekan_data_case(${params.map(sqlLiteral).join(',')});\nROLLBACK;\n`;
}

export async function runDataRegression(query, options = {}) {
  const { analytics, logs, geography, sourceHash } = createDataAdapters(query, options);
  const start = new Date('2026-10-01T00:00:00+08:00'),
    end = new Date('2026-10-02T23:59:59+08:00');
  const checks = [];
  const check = (name, actual, expected) => {
    assert.deepEqual(actual, expected, name);
    checks.push(name);
  };
  const metrics = result =>
    (Array.isArray(result) ? result : result.rows).map(({ day, pv, uv, sessions, bounces }) => ({ day, pv, uv, sessions, bounces }));
  check(
    'daily PV/UV by event time with visit-start session cohorts',
    metrics(await analytics.getHumanDays(websiteId, start, end, 'Asia/Shanghai')),
    [
      { day: '2026-10-01', pv: 1, uv: 1, sessions: 1, bounces: 0 },
      { day: '2026-10-02', pv: 2, uv: 2, sessions: 1, bounces: 1 },
    ],
  );
  check(
    'hourly PV/UV across midnight',
    metrics(await analytics.getHumanDays(websiteId, start, end, 'Asia/Shanghai', true)),
    [
      { day: '2026-10-01 23:00', pv: 1, uv: 1, sessions: 1, bounces: 0 },
      { day: '2026-10-02 00:00', pv: 2, uv: 2, sessions: 1, bounces: 1 },
    ],
  );
  check(
    'website timezone changes bins without leaking another website',
    metrics(await analytics.getHumanDays(websiteId, start, end, 'UTC')),
    [{ day: '2026-10-01', pv: 3, uv: 2, sessions: 2, bounces: 1 }],
  );
  const facts = await analytics.getHumanFacts(websiteId, start, end, 'Asia/Shanghai');
  const orderedFacts = [
    'geo',
    'sources',
    'environment',
    'pages',
    'journeys',
    'exits',
    'dailySources',
  ];
  const projected = await analytics.getHumanFacts(
    websiteId,
    start,
    end,
    'Asia/Shanghai',
    orderedFacts,
  );
  for (const limit of [
    { rows: 0, bytes: 50 * 1024 * 1024 },
    { rows: 100000, bytes: 1 },
  ]) {
    await assert.rejects(
      () => analytics.getHumanFacts(websiteId, start, end, 'Asia/Shanghai', ['geo'], limit),
      /地域处理数据超过/,
    );
    checks.push(`geography export read budget rows=${limit.rows},bytes=${limit.bytes}`);
  }
  check(
    'tied rankings remain consistent between full and page-specific facts',
    Object.fromEntries(orderedFacts.map(field => [field, projected[field]])),
    Object.fromEntries(orderedFacts.map(field => [field, facts[field]])),
  );
  check('equal-count exit pages use a stable path tie-breaker', facts.exits, [
    { path: '/b', count: 1 },
  ]);
  const countrySQL = geography.getPostgresCountrySQL('country');
  const regionSQL = geography.getPostgresRegionSQL('country', 'region');
  const geographyFixture = `FROM (VALUES ('CN','CN-BJ'),('TW','TW-TPE'),('TW',NULL),('TWN','KHH'),('CN','CN-HSZ'),('CN','CN-71'),('CN','CN-tpe'),('tw',NULL),('twn','unknown'),('JP','JP-13'),(NULL,NULL)) AS geography(country,region) WHERE $1::uuid = '${websiteId}'::uuid`;
  check(
    'Taiwan legacy countries merge into China without changing missing countries',
    await query(
      `SELECT ${countrySQL} AS country,count(*)::int AS visits ${geographyFixture} GROUP BY 1 ORDER BY 1`,
      websiteId,
    ),
    [
      { country: 'CN', visits: 9 },
      { country: 'JP', visits: 1 },
      { country: null, visits: 1 },
    ],
  );
  check(
    'Taiwan subdivisions and country-only records aggregate as one Chinese province',
    await query(
      `SELECT ${regionSQL} AS region,count(*)::int AS visits ${geographyFixture} GROUP BY 1 ORDER BY 1`,
      websiteId,
    ),
    [
      { region: 'CN-11', visits: 1 },
      { region: 'CN-71', visits: 8 },
      { region: 'JP-13', visits: 1 },
      { region: null, visits: 1 },
    ],
  );
  check(
    'Taiwan province filters include historical rows and exclude mainland provinces',
    await query(
      `SELECT count(*)::int AS visits ${geographyFixture} AND ${regionSQL} = 'CN-71'`,
      websiteId,
    ),
    [{ visits: 8 }],
  );
  check(
    'China filters include lowercase legacy country records',
    await query(
      `SELECT count(*)::int AS visits ${geographyFixture} AND ${countrySQL} = 'CN'`,
      websiteId,
    ),
    [{ visits: 9 }],
  );
  check(
    'negative province searches retain country-only Taiwan records',
    await query(
      `SELECT count(*)::int AS visits ${geographyFixture} AND (${regionSQL} NOT ILIKE '%CN-SH%' AND coalesce(region,${regionSQL}) NOT ILIKE '%CN-SH%')`,
      websiteId,
    ),
    [{ visits: 10 }],
  );
  check(
    'source-country grouping merges legacy countries by normalized projection',
    await query(
      `SELECT 'example.test' AS source,${countrySQL} AS country,count(*)::int AS visits ${geographyFixture} GROUP BY 1,2 ORDER BY 2`,
      websiteId,
    ),
    [
      { source: 'example.test', country: 'CN', visits: 9 },
      { source: 'example.test', country: 'JP', visits: 1 },
      { source: 'example.test', country: null, visits: 1 },
    ],
  );
  check('full human facts use the same daily event bins', metrics(facts.daily), [
    { day: '2026-10-01', pv: 1, uv: 1, sessions: 1, bounces: 0 },
    { day: '2026-10-02', pv: 2, uv: 2, sessions: 1, bounces: 1 },
  ]);
  const impact = await logs.getContentImpact(
    websiteId,
    new Date('2026-09-01'),
    new Date('2026-09-30'),
  );
  check(
    'human encoded-path compatibility and original log identity',
    impact.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: encoded, pv: 2, increment: 2 },
      { path: '/literal%2520space', pv: 1, increment: 1 },
      { path: '/reserved%2Fslash', pv: 1, increment: 1 },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  );
  check(
    'six consecutive natural months with zero-denominator gaps',
    await logs.getMonthlyAiShare(websiteId, end, 'Asia/Shanghai'),
    [
      { month: '2026-05', total: 0, ai: 0 },
      { month: '2026-06', total: 0, ai: 0 },
      { month: '2026-07', total: 0, ai: 0 },
      { month: '2026-08', total: 2, ai: 2 },
      { month: '2026-09', total: 6, ai: 6 },
      { month: '2026-10', total: 2, ai: 1 },
    ],
  );
  const dst = await logs.getMonthlyAiShare(
    websiteId,
    new Date('2025-12-15T00:00:00Z'),
    'America/Los_Angeles',
  );
  check('natural month lower bound follows historical DST offset', dst[0], {
    month: '2025-07',
    total: 1,
    ai: 0,
  });
  check(
    'timezone calendar survives a year boundary',
    (
      await logs.getMonthlyAiShare(
        websiteId,
        new Date('2026-01-01T04:00:00Z'),
        'America/Los_Angeles',
      )
    ).map(row => row.month),
    ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'],
  );
  return {
    passed: true,
    sourceHash: sourceHash(),
    checks,
    readOnly: true,
    fixture: 'synthetic-relations',
  };
}

async function main() {
  const args = process.argv.slice(2),
    options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--container', '--database', '--source-ref'].includes(key) || !args[index + 1])
      throw new Error('Use --container and --database; --source-ref is optional');
    options[key.slice(2)] = args[index + 1];
  }
  if (
    !/^liekan[-_][a-zA-Z0-9_.-]+$/.test(options.container ?? '') ||
    !/^liekan_(empty|restore|regression|candidate|verify)(?:_[a-zA-Z0-9_]+)?$/.test(
      options.database ?? '',
    )
  )
    throw new Error('Only named Liekan verification resources are accepted');
  const query = async (sql, ...params) => {
    const result = spawnSync(
      'docker',
      [
        'exec',
        '-i',
        options.container,
        'sh',
        '-c',
        'exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1"',
        'sh',
        options.database,
      ],
      { input: readonlyFixtureSQL(sql, params), encoding: 'utf8', cwd: root },
    );
    if (result.status !== 0)
      throw new Error(
        `Read-only fixture query failed (${result.status}); connection details withheld`,
      );
    return JSON.parse(result.stdout.trim());
  };
  console.log(JSON.stringify(await runDataRegression(query, { sourceRef: options['source-ref'] })));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
