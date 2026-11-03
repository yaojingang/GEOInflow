import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import {
  demoKinds as kinds,
  demoSpecs,
  validateDemoRow,
  materializeDemoRow,
  insertDemoBatch,
  assertDemoPrivacy,
} from './liekan-demo-format.mjs';

export const DEFAULT_DEMO_ID = 'b880cb21-e65a-4fdf-9c0e-3da5aed4e0fa';
export const DEFAULT_DEMO_NAME = '猎看官网（示例数据）';
export const DEFAULT_DEMO_DOMAIN = 'www.liekan.com';
const directory = new URL('./liekan-demo-data/', import.meta.url);

export class DemoSeedError extends Error {}

export async function readDemoManifest() {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  if (
    manifest.formatVersion !== 2 ||
    manifest.websiteId !== DEFAULT_DEMO_ID ||
    manifest.name !== DEFAULT_DEMO_NAME ||
    manifest.domain !== DEFAULT_DEMO_DOMAIN ||
    manifest.isDemo !== true ||
    manifest.file !== 'official.ndjson.gz' ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.visits) ||
    manifest.visits < 1 ||
    kinds.some(kind => !Number.isSafeInteger(manifest.counts?.[kind]) || manifest.counts[kind] < 1)
  )
    throw new DemoSeedError('默认示例清单无效');
  assertDemoPrivacy('manifest', manifest.rules);
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(new URL(manifest.file, directory)))
    digest.update(bytes);
  if (digest.digest('hex') !== manifest.sha256) throw new DemoSeedError('默认示例数据校验失败');
  const catalogBytes = await readFile(new URL('catalog.json', directory));
  if (
    manifest.catalog?.file !== 'catalog.json' ||
    createHash('sha256').update(catalogBytes).digest('hex') !== manifest.catalog.sha256
  )
    throw new DemoSeedError('默认示例目录校验失败');
  const catalog = JSON.parse(catalogBytes);
  if (
    catalog.version !== manifest.catalog.version ||
    catalog.contentHash !== manifest.catalog.contentHash
  )
    throw new DemoSeedError('默认示例目录版本无效');
  return manifest;
}

export async function* readDemoRecords() {
  const input = createReadStream(new URL('official.ndjson.gz', directory));
  const decoded = createGunzip();
  input.on('error', error => decoded.destroy(error));
  input.pipe(decoded);
  const lines = createInterface({ input: decoded, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield JSON.parse(line);
  } finally {
    lines.close();
    input.destroy();
    decoded.destroy();
  }
}

export async function bindDemoCatalog(client, manifest) {
  const catalog = JSON.parse(await readFile(new URL('catalog.json', directory), 'utf8'));
  let current = (
    await client.query('SELECT version FROM liekan_crawler_registry_current WHERE id=1')
  ).rows[0];
  if (!current) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('liekan-crawler-registry-initialize',0))",
    );
    current = (
      await client.query(
        'SELECT version FROM liekan_crawler_registry_current WHERE id=1 FOR UPDATE',
      )
    ).rows[0];
  }
  if (!current) {
    // The normal bundled catalog initializes once; existing publication authority stays in place.
    await client.query(
      `INSERT INTO liekan_crawler_registry_version(version,revision,content_hash,payload,action,published_at)
      VALUES($1::uuid,1,$2,$3::jsonb,'seed',$4)`,
      [catalog.version, catalog.contentHash, JSON.stringify(catalog.payload), catalog.publishedAt],
    );
    await client.query(
      `INSERT INTO liekan_crawler_registry_current(id,version,revision,seed_hash,seed_payload)
      VALUES(1,$1::uuid,1,$2,$3::jsonb)`,
      [catalog.version, catalog.contentHash, JSON.stringify(catalog.payload)],
    );
  }
  const equal = (
    await client.query(
      'SELECT version FROM liekan_crawler_registry_version WHERE content_hash=$1 ORDER BY (version=$2::uuid) DESC,revision DESC LIMIT 1',
      [manifest.catalog.contentHash, current?.version || catalog.version],
    )
  ).rows[0];
  if (equal) return equal.version;
  const live = (
    await client.query(
      'SELECT version,payload FROM liekan_crawler_registry_version WHERE version=$1::uuid',
      [current.version],
    )
  ).rows[0];
  for (const [field, ids] of [
    ['identities', manifest.usedCrawlerIds],
    ['rangeSources', manifest.usedRangeSourceIds],
  ]) {
    if (!Array.isArray(ids)) return null;
    for (const id of ids) {
      const expected = catalog.payload[field].find(item => item.id === id);
      const actual = live.payload[field].find(item => item.id === id);
      if (!expected || !isDeepStrictEqual(expected, actual)) return null;
    }
  }
  return live.version;
}

export async function seedOfficialDemo(
  client,
  { secret, now = Date.now(), schema = 'public', automatic = false },
) {
  if (!secret) throw new DemoSeedError('缺少 APP_SECRET');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new DemoSeedError('数据库 schema 无效');
  const manifest = await readDemoManifest();
  const anchor = now - 300000;
  const counts = Object.fromEntries(kinds.map(kind => [kind, 0]));
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['liekan-default-demo']);
    const existing = (
      await client.query(
        'SELECT w.name,w.domain,w.deleted_at,s.is_demo FROM website w LEFT JOIN liekan_setting s USING(website_id) WHERE w.website_id=$1::uuid FOR UPDATE OF w',
        [DEFAULT_DEMO_ID],
      )
    ).rows[0];
    if (
      existing &&
      (existing.is_demo !== true ||
        existing.name !== DEFAULT_DEMO_NAME ||
        existing.domain !== DEFAULT_DEMO_DOMAIN)
    ) {
      if (automatic) {
        await client.query('COMMIT');
        return { websiteId: DEFAULT_DEMO_ID, status: 'customized', inserted: false };
      }
      throw new DemoSeedError('默认示例 ID 已被其他网站使用，现有数据保持完整');
    }
    if (existing?.deleted_at) {
      await client.query('COMMIT');
      return { websiteId: DEFAULT_DEMO_ID, status: 'deleted', inserted: false };
    }
    if (!existing) {
      const previous = (
        await client.query(
          "SELECT EXISTS(SELECT 1 FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1::uuid) AS previously_created",
          [DEFAULT_DEMO_ID],
        )
      ).rows[0].previously_created;
      if (previous) {
        await client.query('COMMIT');
        return { websiteId: DEFAULT_DEMO_ID, status: 'deleted', inserted: false };
      }
      if (automatic) {
        const installation = (
          await client.query(
            'SELECT EXISTS(SELECT 1 FROM website WHERE website_id<>$1::uuid) AS existing_installation',
            [DEFAULT_DEMO_ID],
          )
        ).rows[0];
        if (installation.existing_installation) {
          await client.query('COMMIT');
          return { websiteId: DEFAULT_DEMO_ID, status: 'existing-installation', inserted: false };
        }
      }
    }
    if (existing) {
      const occupied = (
        await client.query(
          `SELECT ${kinds
            .filter(kind => !demoSpecs[kind].global)
            .map(kind => `EXISTS(SELECT 1 FROM ${demoSpecs[kind].table} WHERE website_id=$1::uuid)`)
            .join(' OR ')} AS occupied`,
          [DEFAULT_DEMO_ID],
        )
      ).rows[0].occupied;
      if (occupied) {
        await client.query('COMMIT');
        return { websiteId: DEFAULT_DEMO_ID, status: 'existing', inserted: false };
      }
    }
    if (
      existing &&
      (
        await client.query(
          "SELECT EXISTS(SELECT 1 FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1::uuid) AS previously_created",
          [DEFAULT_DEMO_ID],
        )
      ).rows[0].previously_created
    ) {
      await client.query('COMMIT');
      return { websiteId: DEFAULT_DEMO_ID, status: 'cleared', inserted: false };
    }
    const admin = (
      await client.query(
        'SELECT user_id AS id FROM "user" WHERE role=\'admin\' AND deleted_at IS NULL ORDER BY created_at,user_id LIMIT 1',
      )
    ).rows[0];
    if (!admin) {
      if (automatic) {
        await client.query('COMMIT');
        return { websiteId: DEFAULT_DEMO_ID, status: 'no-administrator', inserted: false };
      }
      throw new DemoSeedError('初始化示例需要已有管理员，请先完成数据库迁移');
    }
    const catalogVersion = await bindDemoCatalog(client, manifest);
    if (!catalogVersion) {
      await client.query('COMMIT');
      return { websiteId: DEFAULT_DEMO_ID, status: 'incompatible-catalog', inserted: false };
    }
    if (!existing)
      await client.query(
        'INSERT INTO website(website_id,name,domain,user_id,created_by,created_at,updated_at) VALUES($1::uuid,$2,$3,$4::uuid,$4::uuid,now(),now())',
        [DEFAULT_DEMO_ID, DEFAULT_DEMO_NAME, DEFAULT_DEMO_DOMAIN, admin.id],
      );
    await client.query(
      'INSERT INTO liekan_setting(website_id,is_demo,rules) VALUES($1::uuid,true,$2::jsonb) ON CONFLICT(website_id) DO UPDATE SET is_demo=true,rules=EXCLUDED.rules',
      [DEFAULT_DEMO_ID, JSON.stringify(manifest.rules)],
    );
    // Bulk seed holds the site behind the existing analytics lifecycle fence until commit.
    const priorAnalysis = (
      await client.query(
        'SELECT mode FROM liekan_analysis_site WHERE website_id=$1::uuid FOR UPDATE',
        [DEFAULT_DEMO_ID],
      )
    ).rows[0];
    await client.query(
      "INSERT INTO liekan_analysis_site(website_id,mode) VALUES($1::uuid,'disabled') ON CONFLICT(website_id) DO UPDATE SET mode='disabled'",
      [DEFAULT_DEMO_ID],
    );
    let current;
    let batch = [];
    let sawMetadata = false;
    const flush = async () => {
      if (!batch.length) return;
      await insertDemoBatch(client, current, batch);
      batch = [];
    };
    for await (const record of readDemoRecords()) {
      const kind = record[0];
      if (kind === 'metadata') {
        if (sawMetadata || record[1].websiteId !== DEFAULT_DEMO_ID || record[1].isDemo !== true)
          throw new DemoSeedError('默认示例数据头无效');
        sawMetadata = true;
        continue;
      }
      if (!sawMetadata || !kinds.includes(kind)) throw new DemoSeedError('默认示例记录类型无效');
      if (current !== kind) {
        await flush();
        if (['session', 'event', 'log'].includes(current))
          await client.query(`ANALYZE ${demoSpecs[current].table}`);
        current = kind;
      }
      validateDemoRow(kind, record[1], manifest);
      const row = materializeDemoRow(kind, record[1], counts[kind], anchor, secret, admin.id);
      if (row.catalog_version) row.catalog_version = catalogVersion;
      batch.push(row);
      counts[kind] += 1;
      if (batch.length >= 5000) await flush();
    }
    await flush();
    if (!sawMetadata || kinds.some(kind => counts[kind] !== manifest.counts[kind]))
      throw new DemoSeedError('默认示例记录数量与清单不一致');
    await client.query(
      `UPDATE liekan_analysis_site SET mode=$2,archive_epoch=NULL,archive_next=NULL,archive_until=NULL,archive_build_id=NULL,archive_complete=false,archive_checked_at=NULL,dashboard_seed_checked_at=NULL,discovery_checked_at=NULL WHERE website_id=$1::uuid`,
      [DEFAULT_DEMO_ID, priorAnalysis?.mode || 'live'],
    );
    await client.query('SELECT liekan_analysis_invalidate($1::uuid)', [DEFAULT_DEMO_ID]);
    await client.query(
      `INSERT INTO liekan_dashboard_dirty(website_id,epoch,family,bucket,shard)
      SELECT website_id,epoch,f.kind,'-infinity',0 FROM liekan_analysis_site CROSS JOIN (VALUES('visit'),('detail')) f(kind)
      WHERE website_id=$1::uuid AND mode='live' ON CONFLICT DO NOTHING`,
      [DEFAULT_DEMO_ID],
    );
    await client.query(
      'INSERT INTO liekan_log_state(website_id,data_revision) VALUES($1::uuid,1) ON CONFLICT(website_id) DO UPDATE SET data_revision=liekan_log_state.data_revision+1,updated_at=now()',
      [DEFAULT_DEMO_ID],
    );
    await client.query(
      "INSERT INTO liekan_analytics_revision(resource_type,resource_id,revision) VALUES('website',$1::uuid,1) ON CONFLICT(resource_type,resource_id) DO UPDATE SET revision=liekan_analytics_revision.revision+1,updated_at=now()",
      [DEFAULT_DEMO_ID],
    );
    await client.query('COMMIT');
    return {
      websiteId: DEFAULT_DEMO_ID,
      name: DEFAULT_DEMO_NAME,
      demo: true,
      status: 'created',
      inserted: true,
      counts,
      pageviews: manifest.pageviews,
      visits: manifest.visits,
      conversionEvents: manifest.conversionEvents,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
