import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { ControlDatabase } from '../warehouse/control-db';
const harness = vi.hoisted(() => ({ db: undefined as ControlDatabase | undefined, policy: 'v1' }));
vi.mock('../warehouse/authority-routing', () => ({ warehouseEnabled: () => true }));
vi.mock('../warehouse/reader-runtime', () => ({
  warehouseReader: () => ({ db: harness.db, verifyIdentity: async () => {} }),
}));
vi.mock('../warehouse/reporting-context', () => ({
  readReportingMetadata: async (_db: unknown, site: string) => {
    const [row] = await harness.db.read<any>(
      `SELECT epoch::text,publication::text,deletion_revision::text FROM liekan_warehouse_site WHERE website_id=$1`,
      [site],
    );
    return {
      boundary: {
        websiteId: site,
        epoch: row.epoch,
        publication: row.publication,
        deletionRevision: row.deletion_revision,
      },
      policy: harness.policy,
    };
  },
}));
import { parseLogRead } from './log-read-boundary';
import { withWarehouseLogBoundary, pinnedLogBoundary } from './warehouse-log-boundary';
import { warehouseReportMetadata } from './warehouse-report-snapshot';
import { withSessionReadBoundary } from './warehouse-session-boundary';
const database = process.env.LIEKAN_LOG_BOUNDARY_TEST_URL;
it.skipIf(!database)(
  'protects concurrent log parts across appends and rejects controls, scope changes and expiry',
  async () => {
    const url = new URL(database);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/log_boundary_test');
    const db = (harness.db = new ControlDatabase(database));
    const site = '22222222-2222-4222-8222-222222222222';
    const p = parseLogRead({ startAt: 1000, endAt: 2000, timezone: 'UTC' });
    try {
      await db.read(`CREATE TABLE website(website_id uuid PRIMARY KEY);
      CREATE TABLE liekan_warehouse_site(website_id uuid PRIMARY KEY,epoch bigint,publication bigint,deletion_revision bigint,state text);
      CREATE TABLE liekan_warehouse_reference(reference_id uuid PRIMARY KEY,website_id uuid,epoch bigint,publication bigint,kind text,owner_id uuid,expires_at timestamptz);`);
      await db.read(
        await readFile('db/liekan/migrations/096_warehouse_report_boundaries.sql', 'utf8'),
      );
      await db.read(`INSERT INTO website VALUES($1)`, [site]);
      await db.read(`INSERT INTO liekan_warehouse_site VALUES($1,0,12,0,'active')`, [site]);
      const first = await withWarehouseLogBoundary(site, p, async () => ({
        token: pinnedLogBoundary(site, p),
        publication: (await warehouseReportMetadata(site)).boundary.publication,
      }));
      expect(first.publication).toBe('12');
      await db.read(`UPDATE liekan_warehouse_site SET publication=13`);
      const next = { ...p, readBoundary: first.token, page: 2, cursor: 'next' };
      const parts = await Promise.all(
        Array.from({ length: 3 }, () =>
          withWarehouseLogBoundary(site, next, async () => {
            expect(pinnedLogBoundary(site, next)).toBe(first.token);
            return (await warehouseReportMetadata(site)).boundary.publication;
          }),
        ),
      );
      expect(parts).toEqual(['12', '12', '12']);
      expect(
        await db.read(`SELECT kind,publication::text FROM liekan_warehouse_reference`),
      ).toEqual([{ kind: 'query', publication: '12' }]);
      const sessionQuery = { startAt: 1000, endAt: 2000, timezone: 'UTC', page: 1 };
      const readSessions = async () => ({
        publication: (await warehouseReportMetadata(site)).boundary.publication,
      });
      const sessions = await withSessionReadBoundary(site, sessionQuery, readSessions);
      expect(sessions.publication).toBe('13');
      expect('readBoundary' in sessions).toBe(true);
      const sessionPage = {
        ...sessionQuery,
        page: 2,
        readBoundary: sessions.readBoundary,
      };
      await db.read('UPDATE liekan_warehouse_site SET publication=14');
      expect((await withSessionReadBoundary(site, sessionPage, readSessions)).publication).toBe(
        '13',
      );
      await expect(
        withSessionReadBoundary(site, { ...sessionPage, search: 'changed' }, readSessions),
      ).rejects.toMatchObject({ status: 409, code: 'session-read-boundary-conflict' });
      await expect(
        withWarehouseLogBoundary(site, { ...next, search: 'changed' }, async () => 1),
      ).rejects.toMatchObject({ status: 409 });
      harness.policy = 'v2';
      await expect(withSessionReadBoundary(site, sessionPage, readSessions)).rejects.toMatchObject({
        status: 409,
        code: 'session-read-boundary-conflict',
      });
      await expect(withWarehouseLogBoundary(site, next, async () => 1)).rejects.toMatchObject({
        status: 409,
      });
      harness.policy = 'v1';
      await db.read(`UPDATE liekan_warehouse_site SET deletion_revision=1`);
      await expect(withWarehouseLogBoundary(site, next, async () => 1)).rejects.toMatchObject({
        status: 409,
      });
      await db.read(`UPDATE liekan_warehouse_site SET deletion_revision=0`);
      await db.read(
        `UPDATE liekan_warehouse_report_boundary SET expires_at=now()-interval '1 second'`,
      );
      await expect(withWarehouseLogBoundary(site, next, async () => 1)).rejects.toMatchObject({
        status: 409,
      });
      await db.read(`DELETE FROM liekan_warehouse_reference`);
      expect(await db.read(`SELECT * FROM liekan_warehouse_report_boundary`)).toEqual([]);
    } finally {
      await db
        .read(
          `DROP TABLE IF EXISTS liekan_warehouse_report_boundary,liekan_warehouse_reference,liekan_warehouse_site,website`,
        )
        .catch(() => {});
      await db.close();
    }
  },
  20000,
);
