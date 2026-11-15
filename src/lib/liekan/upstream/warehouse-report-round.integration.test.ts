// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { ControlDatabase } from '../warehouse/control-db';

const harness = vi.hoisted(() => ({ db: undefined as any }));
vi.mock('../warehouse/reader-runtime', () => ({ warehouseReader: () => ({ db: harness.db }) }));
vi.mock('./warehouse-analysis-model', () => ({ analysisModelVersion: 'analysis-model-v1' }));

import {
  acquireReportRound,
  finishReportRound,
  reportAnalysisKinds,
  saveRoundPreparation,
  reportRoundMetrics,
} from './warehouse-report-round';

it('declares real data dependencies including browser population on AI and log summaries on human pages', () => {
  expect(reportAnalysisKinds({ resource: 'human/sources' } as any)).toEqual(['browser', 'log']);
  expect(reportAnalysisKinds({ resource: 'ai/bots' } as any)).toEqual(['browser', 'log']);
  expect(reportAnalysisKinds({ resource: 'human/search-engines' } as any)).toEqual(['browser']);
  expect(reportAnalysisKinds({ resource: 'human/overview', nativeRetention: {} } as any)).toEqual([
    'browser',
  ]);
});

it.skipIf(process.env.LIEKAN_REPORT_PLAN_PAGES !== '1')(
  'recovers a pinned round across connections, advances families independently and rejects lost references or superseded writers',
  async () => {
    const admin = new pg.Client('postgresql://postgres@127.0.0.1:25489/postgres');
    const name = `report_round_${randomUUID().replaceAll('-', '')}`;
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    let db = new ControlDatabase(`postgresql://postgres@127.0.0.1:25489/${name}`);
    harness.db = db;
    try {
      await db.read(`CREATE TABLE website(website_id uuid PRIMARY KEY);
      CREATE TABLE liekan_warehouse_site(website_id uuid PRIMARY KEY,epoch bigint,publication bigint,deletion_revision bigint,state text);
      CREATE TABLE liekan_warehouse_reference(reference_id uuid PRIMARY KEY,website_id uuid,epoch bigint,publication bigint,kind text,owner_id uuid,expires_at timestamptz);`);
      for (const file of [
        '092_warehouse_overview_snapshots.sql',
        '097_warehouse_report_rounds.sql',
        '098_warehouse_round_metrics.sql',
      ])
        await db.read(await readFile(`db/liekan/migrations/${file}`, 'utf8'));
      const site = randomUUID(),
        catalog = randomUUID(),
        ids = [randomUUID(), randomUUID(), randomUUID()];
      await db.read('INSERT INTO website VALUES($1)', [site]);
      await db.read("INSERT INTO liekan_warehouse_site VALUES($1,0,10,0,'active')", [site]);
      for (const id of ids)
        await db.read(
          `INSERT INTO liekan_warehouse_overview_snapshot
      (id,website_id,query_key,parameters,catalog_version,format_version,preset,control_version)
      VALUES($1::uuid,$2,$1::text,$3,$4,2,true,'control')`,
          [id, site, { endAt: Date.now() + 86400000 }, catalog],
        );
      const job = (i: number) => ({ id: ids[i], website_id: site, catalog_version: catalog });
      const metadata = {
        boundary: { websiteId: site, epoch: '0', publication: '10', deletionRevision: '0' },
      } as any;
      const first = await acquireReportRound(job(0), metadata, 'control', 2, Date.now());
      const prepared = {
        site,
        control: 'model-control',
        browser: [],
        log: [],
        publication: { browser: '10', log: '7' },
      };
      await saveRoundPreparation(first, prepared);
      await finishReportRound(first, ids[0]);
      await db.read('UPDATE liekan_warehouse_site SET publication=20');
      metadata.boundary.publication = '20';
      await db.close();
      db = new ControlDatabase(`postgresql://postgres@127.0.0.1:25489/${name}`);
      harness.db = db;
      await reportRoundMetrics(first).save('a'.repeat(64), { pv: 3 });
      const resumed = await acquireReportRound(job(1), metadata, 'control', 2, Date.now());
      expect(resumed.id).toBe(first.id);
      expect(String(resumed.publication)).toBe('10');
      expect(resumed.cutoff_at).toEqual(first.cutoff_at);
      expect(resumed.prepared).toEqual(prepared);
      expect(resumed.metrics['a'.repeat(64)]).toEqual({ pv: 3 });
      expect(resumed.pending).not.toContain(ids[0]);
      // A failed log-dependent task does not prevent an independent task completing.
      await finishReportRound(resumed, ids[2]);
      expect(
        (await db.read<any>('SELECT pending FROM liekan_warehouse_report_round'))[0].pending,
      ).toEqual([ids[1]]);
      // Control changes replace the round even if the source publication is unchanged.
      const changed = await acquireReportRound(job(1), metadata, 'control-v2', 2, Date.now());
      expect(changed.id).not.toBe(first.id);
      await expect(saveRoundPreparation(first, prepared)).rejects.toMatchObject({
        code: 'warehouse-read-reference-lost',
      });
      await db.read(
        "UPDATE liekan_warehouse_reference SET expires_at=now()-interval '1 second' WHERE reference_id=$1",
        [changed.reference_id],
      );
      await expect(saveRoundPreparation(changed, prepared)).rejects.toMatchObject({
        code: 'warehouse-read-reference-lost',
      });
      const recovered = await acquireReportRound(job(1), metadata, 'control-v2', 2, Date.now());
      expect(recovered.id).not.toBe(changed.id);
      // Transaction rollback must not mark a result's round membership complete.
      await expect(
        db.transaction(async tx => {
          await finishReportRound(recovered, ids[1], tx);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(
        (await db.read<any>('SELECT pending FROM liekan_warehouse_report_round'))[0].pending,
      ).toContain(ids[1]);
      for (const id of recovered.pending) await finishReportRound(recovered, id);
      expect(await db.read('SELECT * FROM liekan_warehouse_report_round')).toEqual([]);
      expect(await db.read('SELECT * FROM liekan_warehouse_reference')).toEqual([]);
      // Long-failing members cannot indefinitely hold back later refresh cycles.
      const aged = await acquireReportRound(job(0), metadata, 'control-v2', 2, Date.now());
      await db.read(
        "UPDATE liekan_warehouse_report_round SET created_at=now()-interval '31 minutes'",
      );
      const next = await acquireReportRound(job(1), metadata, 'control-v2', 2, Date.now());
      expect(next.id).not.toBe(aged.id);
      await expect(saveRoundPreparation(aged, prepared)).rejects.toMatchObject({
        code: 'warehouse-read-reference-lost',
      });
      await db.read('UPDATE liekan_warehouse_site SET deletion_revision=1');
      await expect(
        acquireReportRound(job(2), metadata, 'control-v2', 2, Date.now()),
      ).rejects.toMatchObject({
        code: 'warehouse-read-boundary-changed',
      });
      metadata.boundary.deletionRevision = '1';
      const deleted = await acquireReportRound(
        job(2),
        metadata,
        'control-after-delete',
        2,
        Date.now(),
      );
      expect(deleted.id).not.toBe(next.id);
      expect(deleted.prepared).toBeNull();
      await finishReportRound(next, ids[2]);
      expect(
        (await db.read<any>('SELECT pending FROM liekan_warehouse_report_round'))[0].pending,
      ).toContain(ids[2]);
    } finally {
      await db.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
  30000,
);
