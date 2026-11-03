import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import 'dotenv/config';
import { bundledDemoCatalog } from './liekan-demo-catalog.mjs';
import {
  DEMO_ID,
  demoKinds,
  demoSpecs,
  exportedFields,
  validateDemoRow,
} from './liekan-demo-format.mjs';

const exportRoot = new URL('../.local/demo-exports/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = value => typeof value === 'string' && /^\/(?:[a-z0-9/_.-]*)$/.test(value);
const propertyValues = {
  account_tier: ['示例免费用户', '示例专业用户', '示例团队用户'],
  plan: ['专业版（示例）', '团队版（示例）'],
  channel: [
    'direct',
    'google',
    'baidu',
    'bing',
    'chatgpt',
    'perplexity',
    'claude',
    'kimi',
    'newsletter',
    'partner',
    'social',
  ],
  demo_generation: ['official-demo-20261024-v1'],
};
const textNode = (id, textContent) => ({ type: 3, id, textContent });
const element = (id, tagName, childNodes, attributes = {}) => ({
  type: 2,
  id,
  tagName,
  attributes,
  childNodes,
});
export const demoReplayDocument = {
  type: 0,
  id: 1,
  childNodes: [
    { type: 1, id: 2, name: 'html', publicId: '', systemId: '' },
    element(3, 'html', [
      element(4, 'head', [
        element(5, 'style', [
          textNode(
            6,
            'body{font:20px sans-serif;background:#f6f8fc;color:#16335c;padding:24px}main{background:white;padding:24px;border-radius:20px}button{padding:16px 30px;background:#1769ff;color:white;border:0;border-radius:10px}p{line-height:1.8}',
          ),
        ]),
      ]),
      element(7, 'body', [
        element(8, 'main', [
          element(9, 'h1', [textNode(10, '猎看官网 · 示例访问回放')]),
          element(11, 'p', [
            textNode(12, 'GEO 数据分析，让 AI 搜索流量和内容表现清晰可见。此回放由示例数据生成。'),
          ]),
          element(13, 'button', [textNode(14, '预约产品演示')]),
        ]),
      ]),
    ]),
  ],
};
export function portableReplay(bytes, anchor) {
  const events = JSON.parse(gunzipSync(bytes));
  if (
    events.length !== 6 ||
    events.map(e => e.type).join(',') !== '4,2,3,3,3,5' ||
    JSON.stringify(events[1].data.node) !== JSON.stringify(demoReplayDocument)
  )
    throw new Error('Replay is outside the approved synthetic template');
  const expected = [
    null,
    { initialOffset: { top: 0, left: 0 }, node: demoReplayDocument },
    { source: 1, positions: [{ x: 350, y: 260, id: 13, timeOffset: 0 }] },
    { source: 2, type: 2, id: 13, x: 350, y: 260 },
    { source: 3, id: 1, x: 0, y: 380 },
    { tag: '示例：完成产品体验', payload: { generation: 'official-demo-20261024-v1' } },
  ];
  const meta = events[0].data;
  const url = new URL(meta.href);
  if (
    url.origin !== 'https://www.liekan.com' ||
    url.username ||
    url.password ||
    !safePath(url.pathname) ||
    url.search ||
    url.hash ||
    ![390, 1440].includes(meta.width) ||
    ![844, 900].includes(meta.height)
  )
    throw new Error('Unsafe synthetic replay metadata');
  expected[0] = { href: url.toString(), width: meta.width, height: meta.height };
  for (let i = 1; i < events.length; i++)
    if (JSON.stringify(events[i].data) !== JSON.stringify(expected[i]))
      throw new Error('Unexpected replay input or DOM content');
  return events.map((e, i) => ({
    type: e.type,
    timestamp: Math.min(0, e.timestamp - anchor),
    data: expected[i],
  }));
}

/** Explicit maintainer operation: reads the isolated official synthetic site in one snapshot. */
export async function exportOfficialDemo(
  client,
  {
    schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public',
    outputRoot = exportRoot,
  } = {},
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error('Invalid export schema');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const directory = pathToFileURL((await mkdtemp(new URL('candidate-', outputRoot))) + '/');
  const tmp = new URL('official.ndjson.gz.next', directory);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const gzip = createGzip({ level: 9 }),
    output = createWriteStream(tmp);
  gzip.pipe(output);
  try {
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    const site = (
      await client.query(
        'SELECT w.name,w.domain,s.is_demo,s.rules FROM website w JOIN liekan_setting s USING(website_id) WHERE website_id=$1 AND w.deleted_at IS NULL',
        [DEMO_ID],
      )
    ).rows[0];
    if (
      !site ||
      site.name !== '猎看官网（示例数据）' ||
      site.domain !== 'www.liekan.com' ||
      !site.is_demo
    )
      throw new Error('Only the official isolated demo can be exported');
    const catalog = await bundledDemoCatalog();
    const catalogBytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
    const anchor = new Date(
      (
        await client.query(
          'SELECT greatest((SELECT max(created_at) FROM website_event WHERE website_id=$1),(SELECT max(created_at) FROM liekan_log WHERE website_id=$1)) AS anchor',
          [DEMO_ID],
        )
      ).rows[0].anchor,
    ).getTime();
    const refs = {};
    for (const [kind, entry] of Object.entries(demoSpecs)) {
      const primary = Object.entries(entry.refs).find(([, group]) => group === kind)?.[0];
      if (primary)
        refs[kind] = new Map(
          (
            await client.query(
              `SELECT ${primary} AS id FROM ${entry.table} WHERE website_id=$1 ORDER BY ${primary}`,
              [DEMO_ID],
            )
          ).rows.map((r, i) => [r.id, i]),
        );
    }
    refs.visit = new Map(
      (
        await client.query(
          'SELECT DISTINCT visit_id AS id FROM website_event WHERE website_id=$1 AND visit_id IS NOT NULL ORDER BY visit_id',
          [DEMO_ID],
        )
      ).rows.map((r, i) => [r.id, i]),
    );
    const counts = {};
    for (const kind of demoKinds)
      counts[kind] =
        kind === 'range'
          ? Number(
              (
                await client.query(
                  'SELECT count(*) FROM liekan_crawler_range_snapshot r WHERE EXISTS(SELECT 1 FROM liekan_log l WHERE l.website_id=$1 AND l.verification_version=r.version)',
                  [DEMO_ID],
                )
              ).rows[0].count,
            )
          : Number(
              (
                await client.query(
                  `SELECT count(*) FROM ${demoSpecs[kind].table} WHERE website_id=$1`,
                  [DEMO_ID],
                )
              ).rows[0].count,
            );
    const stats = (
      await client.query(
        'SELECT count(*) FILTER(WHERE event_type=1)::int AS pageviews,count(*) FILTER(WHERE event_type=2)::int AS "conversionEvents",count(*) FILTER(WHERE event_type=5)::int AS "performanceEvents" FROM website_event WHERE website_id=$1',
        [DEMO_ID],
      )
    ).rows[0];
    const manifest = {
      formatVersion: 2,
      websiteId: DEMO_ID,
      name: site.name,
      domain: site.domain,
      isDemo: true,
      sourceAnchor: new Date(anchor).toISOString(),
      rules: site.rules,
      file: 'official.ndjson.gz',
      counts,
      visits: refs.visit.size,
      ...stats,
      catalog: {
        file: 'catalog.json',
        sha256: hash(catalogBytes),
        version: catalog.version,
        contentHash: catalog.contentHash,
      },
      usedCrawlerIds: (
        await client.query(
          'SELECT DISTINCT crawler_id FROM liekan_crawler_evidence WHERE website_id=$1 AND crawler_id IS NOT NULL ORDER BY crawler_id',
          [DEMO_ID],
        )
      ).rows.map(r => r.crawler_id),
      usedRangeSourceIds: (
        await client.query(
          'SELECT DISTINCT source_id FROM liekan_crawler_range_snapshot r WHERE EXISTS(SELECT 1 FROM liekan_log l WHERE l.website_id=$1 AND l.verification_version=r.version) ORDER BY source_id',
          [DEMO_ID],
        )
      ).rows.map(r => r.source_id),
      catalogBinding:
        'Synthetic crawler rules reissued against the bundled catalog; missing historical verdicts stay unknown',
      capturedAt: new Date().toISOString(),
      privacy: {
        identifiers: 'Sequential references; installation-local UUIDs and keyed hashes',
        excluded: [
          'accounts',
          'credentials',
          'visitor IPs',
          'original IP hashes',
          'distinct IDs',
          'arbitrary URL queries',
          'connection secrets',
          'AI conversations',
          'permission-bound caches',
        ],
        replays: 'Fixed synthetic document and pointer actions only',
        crawlerIdentity:
          'Synthetic evidence; partial observation coverage; historical missing verdicts remain unknown',
      },
    };
    const emit = async record => {
      if (!gzip.write(JSON.stringify(record) + '\n')) await once(gzip, 'drain');
    };
    await emit(['metadata', { websiteId: DEMO_ID, isDemo: true, formatVersion: 2 }]);
    for (const kind of demoKinds) {
      const entry = demoSpecs[kind],
        fields = exportedFields(kind);
      const order = fields.filter(
        f =>
          entry.refs[f] === kind ||
          ['path', 'version', 'snapshot_at', 'starts_at', 'data_key', 'event_id'].includes(f),
      );
      const where =
        kind === 'range'
          ? 'EXISTS(SELECT 1 FROM liekan_log l WHERE l.website_id=$1 AND l.verification_version=t.version)'
          : 't.website_id=$1';
      await client.query(
        `DECLARE demo_export NO SCROLL CURSOR FOR SELECT ${fields.map(f => 't.' + f).join(',')} FROM ${entry.table} t WHERE ${where} ORDER BY ${order.length ? order.map(f => 't.' + f).join(',') : fields.map(f => 't.' + f).join(',')}`,
        [DEMO_ID],
      );
      let actual = 0;
      while (true) {
        const rows = (await client.query('FETCH 2000 FROM demo_export')).rows;
        if (!rows.length) break;
        for (const row of rows) {
          for (const [field, group] of Object.entries(entry.refs))
            if (row[field] != null) {
              const ref = refs[group]?.get(row[field]);
              if (ref === undefined)
                throw new Error(`Missing synthetic reference: ${kind}.${field}`);
              row[field] = ref;
            }
          for (const field of entry.dates)
            if (row[field] != null)
              row[field] = Math.min(0, new Date(row[field]).getTime() - anchor);
          if (row.catalog_version) row.catalog_version = catalog.version;
          if (kind === 'rule') {
            row.version = hash('bundled-synthetic-demo-v2:' + catalog.version + ':' + row.version);
            row.matcher_version = 'bundled-synthetic-demo-v2';
            row.rules = catalog.payload.identities.map(i => ({
              name: i.name,
              pattern: i.uaSelector || i.name,
              type: i.type,
              vendor: i.vendor,
            }));
            row.crawler_configuration = {
              synthetic: true,
              notice: '官方合成示例规则，随示例包重新生成',
            };
          }
          if (kind === 'evidence')
            row.classification_version = hash(
              'bundled-synthetic-demo-v2:' + catalog.version + ':' + row.classification_version,
            );
          for (const field of ['path', 'url_path'])
            if (row[field] != null && !safePath(row[field]))
              throw new Error(`Unexpected demo path: ${kind}.${field}`);
          if (kind === 'event') {
            if (!['liekan-demo-90d-v1', '示例数据 2026-10-24'].includes(row.tag))
              throw new Error('Unlabeled traffic cannot enter the official demo package');
            row.hostname = 'www.liekan.com';
            if (!['q=GEO+数据分析', 'wd=猎看统计'].includes(row.referrer_query))
              row.referrer_query = null;
            if (!['/', '/search', '/s', null].includes(row.referrer_path)) row.referrer_path = null;
          }
          if (kind === 'session-data' || kind === 'event-data') {
            if (
              !propertyValues[row.data_key]?.includes(row.string_value) ||
              row.number_value != null ||
              row.date_value != null
            )
              throw new Error('Unapproved demo property');
            if (kind === 'session-data') row.proof = true;
          }
          if (kind === 'coverage')
            row.evidence = {
              synthetic: true,
              reason: 'synthetic_dataset_without_live_file_coverage',
              basis: 'event_time',
            };
          if (kind === 'evidence') {
            if (
              row.measurement &&
              row.measurement.synthetic !== true &&
              row.measurement.simulation !== true
            )
              throw new Error('Non-synthetic crawler measurements');
            if (row.measurement?.simulation === true)
              row.measurement = {
                ...row.measurement,
                synthetic: true,
                hostBasis: 'declared_host',
                samplingBasis: 'synthetic_demo',
              };
            const measurement = row.measurement;
            row.measurement = measurement
              ? Object.fromEntries(
                  [
                    'host',
                    'bytesUnit',
                    'hostBasis',
                    'synthetic',
                    'generation',
                    'samplingRate',
                    'samplingBasis',
                    'bytesAvailability',
                    'samplingTimeBasis',
                  ]
                    .filter(k => k in measurement)
                    .map(k => [k, measurement[k]]),
                )
              : null;
            row.identity_evidence = {
              synthetic: true,
              provenance: 'bundled-official-demo',
              notice: '合成示例身份场景，所有数值仅用于演示',
            };
            if (row.edge_observation) {
              if (
                row.edge_observation.synthetic !== true &&
                row.edge_observation.simulation !== true
              )
                throw new Error('Non-synthetic edge observation');
              const allowed = [
                'BotScore',
                'BotScoreSrc',
                'edgeDurationMs',
                'VerifiedBotCategory',
                'OriginResponseStatus',
                'EdgeResponseContentType',
                'OriginResponseDurationMs',
              ];
              row.edge_observation = {
                synthetic: true,
                fields: Object.fromEntries(
                  Object.entries(row.edge_observation.fields || {}).filter(([key]) =>
                    allowed.includes(key),
                  ),
                ),
              };
            }
          }
          if (kind === 'replay') row.events = portableReplay(row.events, anchor);
          if (kind === 'report') row.description = '随系统分发的官方合成示例';
          validateDemoRow(kind, row, manifest);
          await emit([kind, row]);
          actual++;
        }
      }
      await client.query('CLOSE demo_export');
      if (actual !== counts[kind]) throw new Error('Demo changed during export');
    }
    gzip.end();
    await finished(output);
    const bytes = await readFile(tmp);
    manifest.sha256 = hash(bytes);
    await client.query('COMMIT');
    await writeFile(new URL('catalog.json', directory), catalogBytes);
    await rename(tmp, new URL(manifest.file, directory));
    await writeFile(new URL('manifest.json', directory), JSON.stringify(manifest, null, 2) + '\n');
    return {
      directory: fileURLToPath(directory),
      counts,
      bytes: bytes.length,
      sha256: manifest.sha256,
    };
  } catch (error) {
    gzip.destroy();
    output.destroy();
    await client.query('ROLLBACK').catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    console.log(JSON.stringify(await exportOfficialDemo(client)));
  } catch {
    console.error('官方示例导出失败；请检查隔离示例数据及允许字段。');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
