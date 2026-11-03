import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseReportQuery } from '../../src/lib/liekan/contracts/query';
import { buildReport } from '../../src/lib/liekan/report';
import { withPublishedRegistry } from '../../src/lib/liekan/upstream/crawler-registry-context';
import { prepareWarehouseAiPageReport } from '../../src/lib/liekan/upstream/warehouse-ai-page-report';
import { withinWarehouseReport } from '../../src/lib/liekan/upstream/warehouse-report-snapshot';

const normalize = (value: any) => JSON.parse(JSON.stringify(value));
export async function verifyWarehouseAiPages({ db, site, batch, put, run }: any) {
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  const [website] = await db.read(
    'SELECT website_id AS id,name,domain FROM website WHERE website_id=$1',
    [site],
  );
  const large = process.env.WAREHOUSE_AI_PAGE_LARGE;
  const startAt = +new Date(
    large === 'catalog'
      ? '2026-11-02T00:00:00Z'
      : large
        ? '2026-11-03T02:00:00Z'
        : '2026-11-03T00:00:00Z',
  );
  const endAt = large ? startAt + 1000 : +new Date('2026-11-03T08:00:00Z');
  const query = (page = 1, blind = 1, resource = 'ai/pages') => {
    const parsed = parseReportQuery({
      resource,
      startAt,
      endAt,
      timezone: 'UTC',
      crawlerMetricsVersion: 1,
      crawlerIdentityScope: 'all',
      tp_apBody: page,
      tp_blindList: blind,
    });
    assert.equal(
      parsed.success,
      true,
      JSON.stringify({ resource, page, blind, error: parsed.success ? null : parsed.error.issues }),
    );
    if (!parsed.success) throw new Error('fixture-query');
    return parsed.data;
  };
  if (!large) {
    const prefix = 'ai-page-' + randomUUID();
    for (let i = 0; i < 47; i++) {
      const id = prefix + '-' + i,
        path = '/' + prefix + '/' + String(i).padStart(2, '0');
      await put('liekan_log', {
        id,
        website_id: site,
        import_id: batch,
        created_at: '2026-11-03T03:07:00Z',
        path,
        method: 'GET',
        status: 200,
        bytes: 1,
        ip_masked: 'synthetic',
        ip_hash: '8'.repeat(64),
        user_agent: 'SyntheticAiPage',
        location: 'unknown',
        bot: 'GPTBot',
        vendor: 'OpenAI',
        bot_type: '训练',
        verification: 'verified_range',
        source_id: null,
        ai_eligible: true,
        recognition_state: 'recognized',
      });
      await db.transaction((tx: any) =>
        tx.query(
          "INSERT INTO liekan_catalog(website_id,path,title,content_type,link_depth) VALUES($1,$2,'Synthetic AI','article',$3),($1,$4,'Synthetic blind','article',NULL)",
          [site, path, 1 + (i % 3), '/' + prefix + '/blind-' + String(i).padStart(2, '0')],
        ),
      );
    }
  }
  await db.transaction((tx: any) =>
    tx.query(
      'UPDATE liekan_import SET accepted=greatest(accepted,1) WHERE id=$1 AND website_id=$2',
      [batch, site],
    ),
  );
  const compare = async (label: string, page = 1, blind = 1, resource = 'ai/pages') =>
    withPublishedRegistry(() =>
      withinWarehouseReport(async () => {
        const p = query(page, blind, resource);
        const expected = large ? null : await buildReport(website, false, p, true, false);
        const prepared = await prepareWarehouseAiPageReport(site, website.domain, p);
        try {
          const actual = await buildReport(website, false, p, true, false, undefined, prepared);
          if (expected) assert.deepEqual(normalize(actual), normalize(expected), label);
          if (resource === 'ai/pages') {
            assert.ok(actual.tables.apBody.length <= 20);
            assert.ok(actual.tables.blindList.length <= 20);
          }
          return actual;
        } finally {
          await prepared.dispose?.();
        }
      }),
    );
  const first = await compare('first');
  if (large) {
    if (large === 'catalog') {
      const [{ total }] = await db.read(
        'SELECT count(*)::int AS total FROM liekan_catalog WHERE website_id=$1',
        [site],
      );
      assert.equal(first.meta.tablePages.blindList.total, total);
      assert.equal(first.cards.find((c: any) => c.label === '从未被抓页面').value, total);
      assert.equal(first.tables.blindList.length, 20);
      const last = await compare('last', 1, Math.ceil(total / 20));
      assert.equal(last.tables.blindList.length, total % 20 || 20);
    } else {
      assert.equal(first.meta.tablePages.apBody.total, 100005);
      assert.equal(first.cards.find((c: any) => c.label === '被 AI 抓取页面').value, 100005);
      assert.equal(first.tables.apBody.length, 20);
      const last = await compare('last', 5001, 1);
      assert.equal(last.tables.apBody.length, 5);
    }
    console.log(JSON.stringify({ run, aiPagesLarge: large, tablePages: first.meta.tablePages }));
    return;
  }
  for (const resource of ['ai/overview', 'ai/bots'])
    await compare(resource + ' first', 1, 1, resource);
  await compare('second', 2, 2);
  await compare(
    'last',
    Math.max(1, Math.ceil(first.meta.tablePages.apBody.total / 20)),
    Math.max(1, Math.ceil(first.meta.tablePages.blindList.total / 20)),
  );
  const catalog = await db.read('SELECT * FROM liekan_catalog WHERE website_id=$1', [site]);
  await db.transaction((tx: any) =>
    tx.query('DELETE FROM liekan_catalog WHERE website_id=$1', [site]),
  );
  for (const resource of ['ai/pages', 'ai/overview', 'ai/bots'])
    await compare(resource + ' no-catalog', 1, 1, resource);
  for (const row of catalog)
    await db.transaction((tx: any) =>
      tx.query(
        'INSERT INTO liekan_catalog SELECT * FROM jsonb_populate_record(NULL::liekan_catalog,$1::jsonb)',
        [JSON.stringify(row)],
      ),
    );
  const imports = await db.read('SELECT id,accepted FROM liekan_import WHERE website_id=$1', [
    site,
  ]);
  await db.transaction((tx: any) =>
    tx.query('UPDATE liekan_import SET accepted=0 WHERE website_id=$1', [site]),
  );
  for (const resource of ['ai/pages', 'ai/overview', 'ai/bots'])
    await compare(resource + ' no-log-connection', 1, 1, resource);
  // Only this owned synthetic fixture was changed; restore its control metadata.
  for (const entry of imports)
    await db.transaction((tx: any) =>
      tx.query('UPDATE liekan_import SET accepted=$2 WHERE id=$1', [entry.id, entry.accepted]),
    );
  console.log(
    JSON.stringify({
      run,
      aiPagesParity: ['first', 'second', 'last', 'no-catalog', 'no-log-connection'],
    }),
  );
}
