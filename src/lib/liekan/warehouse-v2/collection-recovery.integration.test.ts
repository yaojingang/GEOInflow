import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogRecord } from '../ingest';
import type { V2LogRow } from './ingest';
import type { WarehouseV2Runtime } from './runtime';
import { WarehouseCollectionPackage } from '../upstream/warehouse-collection-package';
import { createV2ClickHouseClient, ensureV2Schema, insertV2Rows } from './client';
import { v2EventDetailRelation } from './relations';
import { v2Tables } from './schema';
import { submitV2BrowserCollection, submitV2LogUpload } from './write-adapters';

let runtime: Partial<WarehouseV2Runtime>;
vi.mock('./runtime', () => ({ warehouseV2Runtime: () => runtime }));

// Supply a disposable PG database. Only the suite's uniquely named schema is used.
const databaseUrl = process.env.LIEKAN_V2_RECEIPT_TEST_PG;
const schema = 'receipts_' + randomUUID().replaceAll('-', '');
describe.skipIf(!databaseUrl)('warehouse v2 submission fencing', () => {
  let pgPool: pg.Pool;
  let admin: pg.Pool;
  let site: string;
  let batchId: string;
  let facts: V2LogRow[];
  let failAfterInsert: boolean;
  let failLookup: boolean;
  let writes: number;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pgPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pgPool.query(`CREATE TABLE website(website_id uuid PRIMARY KEY, deleted_at timestamptz);
      CREATE TABLE liekan_log_state(website_id uuid PRIMARY KEY, epoch bigint DEFAULT 1, data_revision bigint DEFAULT 0);
      CREATE TABLE liekan_warehouse_upload(batch_id uuid PRIMARY KEY,website_id uuid,warehouse_epoch bigint,source_id uuid,
        kind text,status text,expected int,queued bool,processed int,inserted int,duplicates int,conflicts int,updated_at timestamptz);
      CREATE TABLE liekan_ingest_batch(id uuid PRIMARY KEY,website_id uuid,state text,inserted int,duplicates int,rejected int DEFAULT 0,processed_at timestamptz);
      CREATE TABLE liekan_collection_policy(website_id uuid PRIMARY KEY, revision int);
      CREATE TABLE liekan_import(id uuid PRIMARY KEY,website_id uuid,accepted int,inserted int);`);
  });

  afterAll(async () => {
    await pgPool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    site = randomUUID();
    batchId = randomUUID();
    facts = [];
    writes = 0;
    failAfterInsert = false;
    failLookup = false;
    await pgPool.query('INSERT INTO website VALUES ($1)', [site]);
    await pgPool.query('INSERT INTO liekan_log_state(website_id) VALUES($1)', [site]);
    await pgPool.query(
      `INSERT INTO liekan_warehouse_upload(batch_id,website_id,warehouse_epoch,kind,status,expected)
      VALUES ($1,$2,1,'automatic','pending',2)`,
      [batchId, site],
    );
    await pgPool.query(
      "INSERT INTO liekan_ingest_batch(id,website_id,state) VALUES ($1,$2,'pending')",
      [batchId, site],
    );
    await pgPool.query('INSERT INTO liekan_import(id,website_id) VALUES ($1,$2)', [batchId, site]);
    runtime = {
      pg: pgPool,
      ensureReady: async () => {},
      ch: {
        query: async () => {
          if (failLookup) throw Error('lookup unavailable');
          return { json: async () => facts };
        },
      } as unknown as WarehouseV2Runtime['ch'],
      logBatcher: {
        enqueue: async (rows: V2LogRow[]) => {
          writes++;
          facts.push(...rows);
          if (failAfterInsert) throw Error('lost write response');
        },
      } as unknown as WarehouseV2Runtime['logBatcher'],
    };
  });

  function send() {
    const records = ['a', 'b'].map(
      id =>
        ({
          id,
          time: '2026-01-01T10:00:00Z',
          path: '/',
          method: 'GET',
          status: 200,
          type: 'ai',
        }) as LogRecord,
    );
    return submitV2LogUpload({ batchId, websiteId: site, records });
  }

  it('serializes simultaneous requests from separate PG clients and confirms once', async () => {
    await Promise.all([send(), send(), send()]);
    expect(writes).toBe(1);
    expect(facts).toHaveLength(2);
    expect(
      (
        await pgPool.query('SELECT data_revision::int FROM liekan_log_state WHERE website_id=$1', [
          site,
        ])
      ).rows[0].data_revision,
    ).toBe(1);
  });

  it('recovers the original rows and counters after a lost CH response', async () => {
    failAfterInsert = true;
    await expect(send()).rejects.toThrow('lost write response');
    failAfterInsert = false;
    failLookup = true;
    await expect(send()).rejects.toThrow('lookup unavailable');
    failLookup = false;
    await send();
    expect(writes).toBe(1);
    expect(
      (
        await pgPool.query(
          'SELECT processed,inserted,duplicates,status FROM liekan_warehouse_upload WHERE batch_id=$1',
          [batchId],
        )
      ).rows[0],
    ).toEqual({ processed: 2, inserted: 2, duplicates: 0, status: 'processed' });
  });

  it.each(['cancel', 'reset', 'remove'])('refuses admission after %s', async action => {
    if (action === 'cancel')
      await pgPool.query("UPDATE liekan_ingest_batch SET state='cancelled' WHERE id=$1", [batchId]);
    if (action === 'reset')
      await pgPool.query('UPDATE liekan_log_state SET epoch=2 WHERE website_id=$1', [site]);
    if (action === 'remove')
      await pgPool.query('DELETE FROM liekan_warehouse_upload WHERE batch_id=$1', [batchId]);
    await expect(send()).rejects.toMatchObject({ status: 409 });
    expect(writes).toBe(0);
  });

  it('confirms a manual upload without an automatic ingest batch', async () => {
    await pgPool.query("UPDATE liekan_warehouse_upload SET kind='manual' WHERE batch_id=$1", [
      batchId,
    ]);
    await pgPool.query('DELETE FROM liekan_ingest_batch WHERE id=$1', [batchId]);
    await send();
    expect(writes).toBe(1);
  });

  it.skipIf(!process.env.LIEKAN_V2_RECEIPT_TEST_CH).each([2, 10000])(
    'keeps %i log rows and both hourly counts after losing the response and retrying in reverse order',
    async size => {
      const url = process.env.LIEKAN_V2_RECEIPT_TEST_CH!;
      const chAdmin = createV2ClickHouseClient({ url });
      const db = 'log_' + randomUUID().replaceAll('-', '');
      const ch = createV2ClickHouseClient({ url, database: db });
      try {
        await chAdmin.command({ query: `CREATE DATABASE ${db}` });
        await ensureV2Schema(ch);
        const otherBatch = randomUUID();
        await pgPool.query('UPDATE liekan_warehouse_upload SET expected=$2 WHERE batch_id=$1', [
          batchId,
          size,
        ]);
        await pgPool.query(
          `INSERT INTO liekan_warehouse_upload(batch_id,website_id,warehouse_epoch,kind,status,expected)
          VALUES($1,$2,1,'automatic','pending',$3)`,
          [otherBatch, site, size],
        );
        await pgPool.query(
          "INSERT INTO liekan_ingest_batch(id,website_id,state) VALUES($1,$2,'pending')",
          [otherBatch, site],
        );
        await pgPool.query('INSERT INTO liekan_import(id,website_id) VALUES($1,$2)', [
          otherBatch,
          site,
        ]);
        const input = Array.from(
          { length: size },
          (_, i) =>
            ({
              id: createHash('sha256').update(String(i)).digest('hex'),
              time: '2026-01-01T10:00:00Z',
              path: '/',
              method: 'GET',
              status: 200,
              type: 'ai',
            }) as LogRecord,
        );
        const write = (batch: string, records: LogRecord[]) =>
          submitV2LogUpload({ batchId: batch, websiteId: site, records });
        let loseReply = true;
        runtime = {
          pg: pgPool,
          ch,
          ensureReady: async () => {},
          logBatcher: {
            enqueue: async (rows: V2LogRow[]) => {
              const held = await pgPool.query(
                "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND classid=12800115 AND granted",
              );
              expect(held.rows[0].n).toBeGreaterThan(0);
              expect(held.rows[0].n).toBeLessThanOrEqual(256);
              await insertV2Rows(ch, v2Tables.logs, rows);
              if (loseReply) throw new Error('confirmed CH insert, lost response');
            },
          } as WarehouseV2Runtime['logBatcher'],
        };
        await expect(write(batchId, input)).rejects.toThrow('lost response');
        loseReply = false;
        await Promise.all([write(batchId, input), write(otherBatch, [...input].reverse())]);
        const receipts = await pgPool.query(
          'SELECT batch_id,inserted,duplicates FROM liekan_warehouse_upload WHERE website_id=$1',
          [site],
        );
        expect(receipts.rows).toEqual(
          expect.arrayContaining([
            { batch_id: batchId, inserted: size, duplicates: 0 },
            { batch_id: otherBatch, inserted: 0, duplicates: size },
          ]),
        );
        const rows = await ch.query({
          query: `SELECT count() AS n FROM ${v2Tables.logs}`,
          format: 'JSONEachRow',
        });
        expect(Number((await rows.json<{ n: number }>())[0].n)).toBe(size);
        for (const table of [v2Tables.logHourAgg, v2Tables.logPathHourAgg]) {
          const result = await ch.query({
            query: `SELECT countMerge(requests) AS hits FROM ${table}`,
            format: 'JSONEachRow',
          });
          expect(Number((await result.json<{ hits: number }>())[0].hits)).toBe(size);
        }
      } finally {
        await ch.close();
        await chAdmin.command({ query: `DROP DATABASE IF EXISTS ${db} SYNC` });
        await chAdmin.close();
      }
    },
    30000,
  );

  it.skipIf(!process.env.LIEKAN_V2_RECEIPT_TEST_CH)(
    'recovers a single atomic UUID purchase with its original identity, preserving historical detail rows',
    async () => {
      const url = process.env.LIEKAN_V2_RECEIPT_TEST_CH!;
      const chAdmin = createV2ClickHouseClient({ url });
      const db = 'receipt_' + randomUUID().replaceAll('-', '');
      const ch = createV2ClickHouseClient({ url, database: db });
      try {
        await chAdmin.command({ query: `CREATE DATABASE ${db}` });
        await ensureV2Schema(ch);
        await ensureV2Schema(ch);
        let loseReply = true;
        runtime = {
          pg: pgPool,
          ch,
          ensureReady: async () => {},
          browserBatcher: {
            enqueue: async rows => {
              await insertV2Rows(ch, v2Tables.browserEvents, rows);
              if (loseReply) throw new Error('lost browser response');
            },
          } as WarehouseV2Runtime['browserBatcher'],
        };
        const clientId = randomUUID();
        const receivedAt = new Date('2026-11-01T09:10:00Z');
        async function purchase(fingerprint: string) {
          const sessionId = randomUUID(),
            visitId = randomUUID();
          const pkg = new WarehouseCollectionPackage(
            { websiteId: site, eventId: clientId, fingerprint },
            receivedAt,
          );
          await pkg.saveEvent({
            websiteId: site,
            sessionId,
            visitId,
            eventType: 2,
            eventName: 'purchase',
            urlPath: '/checkout',
            eventData: { currency: 'CNY', revenue: 12.34, item: 'sample' },
          });
          return { pkg, sessionId, visitId };
        }
        const first = await purchase('payload-one');
        const sendPurchase = (p: typeof first) =>
          submitV2BrowserCollection(p.pkg, 'website', p.sessionId, p.visitId, receivedAt);
        await expect(sendPurchase(first)).rejects.toThrow('lost browser response');
        loseReply = false;
        const retry = await purchase('payload-one');
        const results = await Promise.all([sendPurchase(retry), sendPurchase(retry)]);
        for (const result of results)
          expect(result).toEqual({
            status: 'duplicate',
            eventId: first.pkg.eventId,
            sessionId: first.sessionId,
            visitId: first.visitId,
          });
        await expect(sendPurchase(await purchase('changed-payload'))).rejects.toMatchObject({
          code: 'COLLECTION_CONFLICT',
        });
        const raw = await ch.query({
          query: `SELECT count() AS n FROM ${v2Tables.browserEvents}`,
          format: 'JSONEachRow',
        });
        expect(Number((await raw.json<{ n: number }>())[0].n)).toBe(1);
        // Older demo/import rows still contribute through the same production relation.
        await insertV2Rows(ch, v2Tables.revenue, [
          {
            website_id: site,
            epoch: 1,
            revenue_id: randomUUID(),
            session_id: first.sessionId,
            event_id: randomUUID(),
            event_name: 'legacy',
            currency: 'CNY',
            revenue: '10.25',
            created_at: '2026-11-01 09:00:00',
            _ver: 1,
          },
        ]);
        const totals = await ch.query({
          query: `SELECT toString(sum(revenue)) AS amount FROM ${v2EventDetailRelation('revenue')}`,
          query_params: { wh_site: site, wh_epoch: '1' },
          format: 'JSONEachRow',
        });
        expect(Number((await totals.json<{ amount: string }>())[0].amount)).toBe(22.59);
        const props = await ch.query({
          query: `SELECT data_key FROM ${v2EventDetailRelation('event_data')} ORDER BY data_key`,
          query_params: { wh_site: site, wh_epoch: '1' },
          format: 'JSONEachRow',
        });
        expect((await props.json<{ data_key: string }>()).map(p => p.data_key)).toEqual([
          'currency',
          'item',
          'revenue',
        ]);
      } finally {
        await ch.close();
        await chAdmin.command({ query: `DROP DATABASE IF EXISTS ${db} SYNC` });
        await chAdmin.close();
      }
    },
    30000,
  );
});
