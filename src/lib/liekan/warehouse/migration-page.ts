import { createHash, randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { CandidateWriter, candidateDigest, type StoredFact, storedFact } from './candidate';
import { sourceFingerprint } from './catalog';
import { type ControlDatabase, WarehouseConflict } from './control-db';
import { stableOperation } from './identifiers';
import { LandingStore } from './landing';
import type { MigrationPage } from './migration-source';
import { WarehousePublisher } from './publication';

type MigrationState = {
  migration_id: string;
  source_identity: string;
  source_fingerprint: string;
  source_snapshot: string;
  transform_version: number;
  phase: string;
  boundary: { sites: Record<string, string> };
};
type Checkpoint = {
  migration_id: string;
  family: string;
  page_key: string;
  cursor_before: string[] | null;
  cursor_after: string[];
  candidate_id: string;
  row_count: string;
  digest: string;
  status: string;
};

// Increment independently of the source schema when conversion/key semantics change.
export const MIGRATION_TRANSFORM_VERSION = 7;

function pageFacts(
  id: string,
  page: MigrationPage,
  pageKey: string,
  candidateId: string,
  siteEpochs: Record<string, string>,
) {
  const groups = new Map<string, StoredFact[]>();
  for (const [index, item] of page.rows.entries()) {
    const epoch = siteEpochs[item.websiteId];
    if (epoch === undefined) throw new WarehouseConflict('warehouse-source-site-outside-boundary');
    const rows = groups.get(item.websiteId) ?? [];
    rows.push(
      storedFact(page.family, item.row, {
        _website_id: item.websiteId,
        _record_time: item.recordTime,
        _session_id: item.sessionId,
        _epoch: epoch,
        _version: '0',
        _ordinal: index,
        _attempt_id: stableOperation([id, page.family, pageKey]),
        _candidate_id: candidateId,
        _topic_id: '',
        _partition: 0,
        _offset: '0',
        _deleted: false,
      }),
    );
    groups.set(item.websiteId, rows);
  }
  return groups;
}

export class MigrationPages {
  private readonly writer: CandidateWriter;
  private readonly publisher: WarehousePublisher;
  private readonly landing: LandingStore;
  constructor(
    private readonly db: ControlDatabase,
    private readonly ch: ClickHouseClient,
  ) {
    this.writer = new CandidateWriter(ch);
    this.publisher = new WarehousePublisher(db, ch);
    this.landing = new LandingStore(ch);
  }

  async register(
    sourceIdentity: string,
    snapshotSHA256: string,
    siteEpochs: Record<string, string>,
    id: string = randomUUID(),
  ) {
    if (!/^[0-9a-f]{64}$/.test(snapshotSHA256) || !sourceIdentity)
      throw new Error('Invalid persistent source snapshot');
    return this.db.transaction(async tx => {
      const existing = (
        await tx.query<MigrationState>(
          'SELECT * FROM liekan_warehouse_migration WHERE migration_id=$1::uuid FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.source_identity !== sourceIdentity ||
          existing.source_snapshot !== snapshotSHA256 ||
          existing.source_fingerprint !== sourceFingerprint ||
          existing.transform_version !== MIGRATION_TRANSFORM_VERSION ||
          JSON.stringify(Object.entries(existing.boundary.sites).sort()) !==
            JSON.stringify(Object.entries(siteEpochs).sort())
        )
          throw new WarehouseConflict('warehouse-source-snapshot-changed');
        return existing;
      }
      return (
        await tx.query<MigrationState>(
          `INSERT INTO liekan_warehouse_migration
        (migration_id,source_identity,source_fingerprint,source_snapshot,transform_version,phase,boundary)
        VALUES($1::uuid,$2,$3,$4,$5,'prepared',$6::jsonb) RETURNING *`,
          [
            id,
            sourceIdentity,
            sourceFingerprint,
            snapshotSHA256,
            MIGRATION_TRANSFORM_VERSION,
            JSON.stringify({ sites: siteEpochs }),
          ],
        )
      ).rows[0];
    });
  }

  async apply(id: string, page: MigrationPage) {
    const pageKey = createHash('sha256')
      .update(JSON.stringify([page.family, page.before]))
      .digest('hex');
    const { migration, checkpoint } = await this.db.transaction(async tx => {
      const migration = (
        await tx.query<MigrationState>(
          'SELECT * FROM liekan_warehouse_migration WHERE migration_id=$1::uuid FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (
        !migration ||
        !['prepared', 'capturing', 'backfill'].includes(migration.phase) ||
        migration.source_fingerprint !== sourceFingerprint ||
        migration.transform_version !== MIGRATION_TRANSFORM_VERSION
      )
        throw new WarehouseConflict('warehouse-migration-not-writable');
      const existing = (
        await tx.query<Checkpoint>(
          'SELECT * FROM liekan_warehouse_checkpoint WHERE migration_id=$1::uuid AND family=$2 AND page_key=$3',
          [id, page.family, pageKey],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.digest !== page.digest ||
          Number(existing.row_count) !== page.rows.length ||
          JSON.stringify(existing.cursor_after) !== JSON.stringify(page.after)
        )
          throw new WarehouseConflict('warehouse-source-page-changed');
        return { migration, checkpoint: existing };
      }
      await tx.query(
        `INSERT INTO liekan_warehouse_migration_family(migration_id,family)
        VALUES($1::uuid,$2) ON CONFLICT DO NOTHING`,
        [id, page.family],
      );
      const progress = (
        await tx.query<{ cursor_value: string[] | null; status: string }>(
          `SELECT cursor_value,status
        FROM liekan_warehouse_migration_family WHERE migration_id=$1::uuid AND family=$2 FOR UPDATE`,
          [id, page.family],
        )
      ).rows[0];
      if (
        progress.status !== 'copying' ||
        JSON.stringify(progress.cursor_value) !== JSON.stringify(page.before)
      )
        throw new WarehouseConflict('warehouse-migration-cursor-conflict');
      const checkpoint = (
        await tx.query<Checkpoint>(
          `INSERT INTO liekan_warehouse_checkpoint
        (migration_id,family,page_key,cursor_before,cursor_after,candidate_id,row_count,digest,status)
        VALUES($1::uuid,$2,$3,$4::jsonb,$5::jsonb,$6::uuid,$7,$8,'intent') RETURNING *`,
          [
            id,
            page.family,
            pageKey,
            page.before ? JSON.stringify(page.before) : null,
            JSON.stringify(page.after),
            randomUUID(),
            page.rows.length,
            page.digest,
          ],
        )
      ).rows[0];
      await tx.query(
        "UPDATE liekan_warehouse_migration SET phase='backfill',updated_at=clock_timestamp() WHERE migration_id=$1::uuid",
        [id],
      );
      return { migration, checkpoint };
    });
    if (checkpoint.status === 'published') return checkpoint;
    const groups = pageFacts(id, page, pageKey, checkpoint.candidate_id, migration.boundary.sites);
    await this.writer.append(page.family, [...groups.values()].flat());
    await this.projectProofs(page, migration, checkpoint, true);
    for (const [site, rows] of groups) {
      await this.writer.verify(
        page.family,
        site,
        migration.boundary.sites[site],
        checkpoint.candidate_id,
        rows.length,
        candidateDigest(page.family, rows),
      );
      if (page.family === 'liekan_collection_receipt')
        await this.landing.importReceipts(
          id,
          stableOperation([id, page.family, pageKey]),
          site,
          migration.boundary.sites[site],
          page.rows.filter(r => r.websiteId === site),
        );
    }
    await this.db.transaction(async tx => {
      await tx.query(
        `UPDATE liekan_warehouse_checkpoint SET status='verified',updated_at=clock_timestamp()
        WHERE migration_id=$1::uuid AND family=$2 AND page_key=$3 AND status='intent'`,
        [id, page.family, pageKey],
      );
    });
    for (const [site, rows] of groups) {
      const operationId = stableOperation([id, page.family, pageKey, site, 'publish']);
      await this.publisher.reserve(
        site,
        migration.boundary.sites[site],
        [
          {
            attemptId: rows[0]._attempt_id,
            family: page.family,
            candidateId: checkpoint.candidate_id,
            rowCount: String(rows.length),
            digest: candidateDigest(page.family, rows),
          },
        ],
        operationId,
      );
      await this.publisher.project(operationId);
    }
    return this.db.transaction(async tx => {
      const head = (
        await tx.query<{ cursor_value: string[] | null }>(
          `SELECT cursor_value FROM liekan_warehouse_migration_family
        WHERE migration_id=$1::uuid AND family=$2 FOR UPDATE`,
          [id, page.family],
        )
      ).rows[0];
      const current = (
        await tx.query<Checkpoint>(
          `SELECT * FROM liekan_warehouse_checkpoint
        WHERE migration_id=$1::uuid AND family=$2 AND page_key=$3 FOR UPDATE`,
          [id, page.family, pageKey],
        )
      ).rows[0];
      if (current?.status === 'published') return current;
      if (
        !head ||
        current?.status !== 'verified' ||
        JSON.stringify(head.cursor_value) !== JSON.stringify(page.before)
      )
        throw new WarehouseConflict('warehouse-migration-cursor-conflict');
      await tx.query(
        `UPDATE liekan_warehouse_migration_family SET cursor_value=$3::jsonb,
        pages=pages+1,rows=rows+$4::bigint,updated_at=clock_timestamp()
        WHERE migration_id=$1::uuid AND family=$2`,
        [id, page.family, JSON.stringify(page.after), page.rows.length],
      );
      return (
        await tx.query<Checkpoint>(
          `UPDATE liekan_warehouse_checkpoint SET status='published',updated_at=clock_timestamp()
        WHERE migration_id=$1::uuid AND family=$2 AND page_key=$3 AND status IN ('verified','published') RETURNING *`,
          [id, page.family, pageKey],
        )
      ).rows[0];
    });
  }

  private async projectProofs(
    page: MigrationPage,
    migration: MigrationState,
    checkpoint: Checkpoint,
    write: boolean,
  ) {
    // Keep the historical PG digest untouched. A separate versioned proof binds
    // only pairs validated by PG in the immutable source snapshot, without
    // attempting to reproduce PostgreSQL's jsonb/Decimal hash formatting in CH.
    const proofs = [
      ...new Map(
        page.rows
          .flatMap(item => {
            const base = {
              website_id: item.websiteId,
              epoch: migration.boundary.sites[item.websiteId],
              revision: '0',
              created_at: item.recordTime,
            };
            const bound = (value: string) =>
              JSON.stringify({ candidateId: checkpoint.candidate_id, value });
            if (item.logScopeProof) {
              if (page.family !== 'liekan_log')
                throw new Error('warehouse-invalid-log-scope-proof');
              return [
                {
                  ...base,
                  kind: 'log-import-scope-v1',
                  key: String(item.row.import_id),
                  value: bound(JSON.stringify(item.logScopeProof)),
                },
              ];
            }
            if (item.riskProof) {
              if (page.family !== 'liekan_browser_risk')
                throw new Error('warehouse-invalid-risk-proof');
              return [
                {
                  ...base,
                  kind: 'browser-risk-window-v1',
                  key: String(item.row.window_end),
                  value: bound(JSON.stringify(item.riskProof)),
                },
              ];
            }
            if (item.propertyProof) {
              if (
                page.family !== 'liekan_session_data_source' ||
                item.propertyProof.sourceHash !== item.hash
              )
                throw new Error('warehouse-invalid-property-proof');
              return [
                {
                  ...base,
                  kind: 'pg-session-property-v2',
                  key: item.propertyProof.sourceHash,
                  value: bound(item.propertyProof.dataHash),
                },
              ];
            }
            if (item.hostnameProof) {
              if (
                page.family !== 'website_event' ||
                item.hostnameProof.sourceHash !==
                  createHash('sha256').update(String(item.row.hostname)).digest('hex')
              )
                throw new Error('warehouse-invalid-hostname-proof');
              return [
                {
                  ...base,
                  kind: 'event-host-v1',
                  key: item.hostnameProof.sourceHash,
                  value: bound(item.hostnameProof.normalized ?? ''),
                },
              ];
            }
            return [];
          })
          .map(p => [`${p.website_id}/${p.kind}/${p.key}`, p]),
      ).values(),
    ];
    if (proofs.length) {
      if (write)
        await this.ch.insert({
          table: 'warehouse_control_projection',
          values: proofs,
          format: 'JSONEachRow',
        });
      for (const site of new Set(proofs.map(p => p.website_id))) {
        for (const kind of new Set(proofs.filter(p => p.website_id === site).map(p => p.kind))) {
          const expected = new Map(
            proofs.filter(p => p.website_id === site && p.kind === kind).map(p => [p.key, p.value]),
          );
          const found = await this.ch
            .query({
              query: `SELECT DISTINCT key,value FROM warehouse_control_projection
            WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND kind={kind:String} AND revision=0
            AND JSONExtractString(value,'candidateId')={candidate:String} AND key IN {keys:Array(String)}`,
              query_params: {
                site,
                epoch: migration.boundary.sites[site],
                kind,
                candidate: checkpoint.candidate_id,
                keys: [...expected.keys()],
              },
              format: 'JSONEachRow',
            })
            .then(r => r.json<{ key: string; value: string }>());
          if (found.length !== expected.size || found.some(p => expected.get(p.key) !== p.value))
            throw new Error('warehouse-migration-proof-verification-failed');
        }
      }
    }
  }

  async verifyPage(id: string, page: MigrationPage) {
    const pageKey = createHash('sha256')
      .update(JSON.stringify([page.family, page.before]))
      .digest('hex');
    const [checkpoint] = await this.db.read<Checkpoint>(
      'SELECT * FROM liekan_warehouse_checkpoint WHERE migration_id=$1::uuid AND family=$2 AND page_key=$3',
      [id, page.family, pageKey],
    );
    const [migration] = await this.db.read<MigrationState>(
      'SELECT * FROM liekan_warehouse_migration WHERE migration_id=$1::uuid',
      [id],
    );
    if (
      !migration ||
      checkpoint?.status !== 'published' ||
      checkpoint.digest !== page.digest ||
      Number(checkpoint.row_count) !== page.rows.length ||
      JSON.stringify(checkpoint.cursor_after) !== JSON.stringify(page.after)
    )
      throw new WarehouseConflict('warehouse-migration-verification-mismatch');
    await this.projectProofs(page, migration, checkpoint, false);
    const groups = pageFacts(id, page, pageKey, checkpoint.candidate_id, migration.boundary.sites);
    for (const [site, rows] of groups) {
      if (page.family === 'liekan_collection_receipt')
        await this.landing.importReceipts(
          id,
          stableOperation([id, page.family, pageKey]),
          site,
          migration.boundary.sites[site],
          page.rows.filter(r => r.websiteId === site),
          true,
        );
      const digest = candidateDigest(page.family, rows);
      await this.writer.verify(
        page.family,
        site,
        migration.boundary.sites[site],
        checkpoint.candidate_id,
        rows.length,
        digest,
      );
      const [publication] = await this.db.read<{
        publication: string;
        manifest: { candidateId: string; digest: string; rowCount: string }[];
      }>(
        "SELECT publication,manifest FROM liekan_warehouse_publication WHERE operation_id=$1 AND status='published'",
        [stableOperation([id, page.family, pageKey, site, 'publish'])],
      );
      if (
        !publication ||
        publication.manifest.length !== 1 ||
        publication.manifest[0].digest !== digest ||
        publication.manifest[0].candidateId !== checkpoint.candidate_id ||
        publication.manifest[0].rowCount !== String(rows.length)
      )
        throw new WarehouseConflict('warehouse-migration-publication-mismatch');
      const projected = await this.ch
        .query({
          query: `SELECT DISTINCT candidate_id,digest,row_count FROM warehouse_publication
        WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND publication={publication:UInt64}`,
          query_params: {
            site,
            epoch: migration.boundary.sites[site],
            publication: publication.publication,
          },
          format: 'JSONEachRow',
        })
        .then(r => r.json<{ candidate_id: string; digest: string; row_count: string }>());
      if (
        projected.length !== 1 ||
        projected[0].candidate_id !== checkpoint.candidate_id ||
        projected[0].digest !== digest ||
        projected[0].row_count !== String(rows.length)
      )
        throw new WarehouseConflict('warehouse-migration-publication-projection-mismatch');
    }
    return checkpoint;
  }

  async cursor(id: string, family: string): Promise<string[] | null> {
    const [head] = await this.db.read<{ cursor_value: string[] | null }>(
      `SELECT cursor_value FROM liekan_warehouse_migration_family
      WHERE migration_id=$1::uuid AND family=$2`,
      [id, family],
    );
    return head?.cursor_value ?? null;
  }
}
