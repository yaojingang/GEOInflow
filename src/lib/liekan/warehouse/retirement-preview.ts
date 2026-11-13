import { sourceTables } from './catalog';
import type { ControlDatabase } from './control-db';

/** Read-only inventory for a separately approved PG cleanup. Never emits or
 * executes DROP/TRUNCATE/DELETE: retained metadata can reference migrated rows. */
export async function warehouseRetirementPreview(db: ControlDatabase) {
  return db.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const [installation] = (
      await tx.query<{
        authority: string;
        facts_fenced: boolean;
        identity_bound: boolean;
        revision: string;
      }>(
        'SELECT authority,facts_fenced,identity_bound,revision FROM liekan_warehouse_installation WHERE id=1',
      )
    ).rows;
    const [transition] = (
      await tx.query<{
        state: string;
        verified: boolean;
      }>(`SELECT t.state,coalesce(b.status='ready' AND b.verified_digest=m.verified_digest
      AND b.migration_id=t.migration_id AND m.phase='exited',false) AS verified
      FROM liekan_warehouse_transition t LEFT JOIN liekan_warehouse_transition_baseline b ON b.id=t.id
      LEFT JOIN liekan_warehouse_migration m ON m.migration_id=t.migration_id WHERE t.id=1`)
    ).rows;
    const blockers: string[] = [];
    if (installation?.authority !== 'clickhouse') blockers.push('postgres-still-authoritative');
    if (!installation?.facts_fenced) blockers.push('postgres-fact-writers-not-fenced');
    if (!installation?.identity_bound) blockers.push('warehouse-identity-not-bound');
    if (transition && transition.state !== 'closed') blockers.push('transition-not-closed');
    if (transition && !transition.verified)
      blockers.push('historical-migration-not-verified-and-exited');
    const candidates = sourceTables.filter(t => ['clickhouse', 'retire'].includes(t.ownership));
    const sizes = (
      await tx.query<{
        name: string;
        total_bytes: string;
        estimated_rows: string | null;
        relations: number;
      }>(
        `WITH RECURSIVE relations(root,oid) AS (
      SELECT c.oid,c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relkind IN('r','p')
      UNION SELECT r.root,i.inhrelid FROM relations r JOIN pg_inherits i ON i.inhparent=r.oid
    ) SELECT root.relname AS name,sum(pg_total_relation_size(c.oid))::text AS total_bytes,
      CASE WHEN bool_and(c.reltuples>=0 OR c.relkind='p') THEN
        sum(CASE WHEN c.relkind='r' THEN c.reltuples::bigint ELSE 0 END)::text ELSE NULL END AS estimated_rows,
      count(*)::integer AS relations
      FROM relations r JOIN pg_class c ON c.oid=r.oid JOIN pg_class root ON root.oid=r.root
      GROUP BY root.relname ORDER BY root.relname`,
        [candidates.map(t => t.name)],
      )
    ).rows;
    const references = (
      await tx.query<{
        target: string;
        schema: string;
        table: string;
        constraint: string;
        delete_action: string;
      }>(
        `SELECT target.relname AS target,n.nspname AS schema,c.relname AS table,
      k.conname AS constraint,k.confdeltype AS delete_action
      FROM pg_constraint k JOIN pg_class target ON target.oid=k.confrelid
      JOIN pg_namespace tn ON tn.oid=target.relnamespace
      JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE k.contype='f' AND tn.nspname='public' AND target.relname=ANY($1::text[])
      ORDER BY target.relname,n.nspname,c.relname,k.conname`,
        [candidates.map(t => t.name)],
      )
    ).rows;
    return {
      status: blockers.length ? 'blocked' : 'ready-for-review',
      blockers,
      deletionAuthorized: false,
      databaseWrites: false,
      installationRevision: installation?.revision ?? null,
      candidates: candidates.map(t => {
        const size = sizes.find(s => s.name === t.name);
        return {
          table: t.name,
          disposition: t.ownership === 'clickhouse' ? 'migrated-facts' : 'retired-derived-data',
          present: !!size,
          physicalBytes: size?.total_bytes ?? null,
          estimatedRows: size?.estimated_rows ?? null,
          physicalRelations: size?.relations ?? 0,
          referencedBy: references.filter(r => r.target === t.name).map(({ target: _, ...r }) => r),
        };
      }),
      preserveBusinessMetadata: sourceTables
        .filter(t => t.ownership === 'transform')
        .map(t => t.name),
      requiredReview: [
        'verify-current-cold-backup-and-restoration',
        'approve-end-of-online-rollback',
        'review-inbound-foreign-keys-and-business-evidence',
        'preserve-table-schema-and-required-business-metadata',
        'approve-specific-row-or-partition-cleanup-separately',
      ],
      note: 'Physical bytes include indexes, TOAST and partitions; row counts are planner estimates, not migration verification. Deleting rows does not immediately return disk space. This command never clears source data.',
    };
  });
}
