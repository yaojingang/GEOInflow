import { randomUUID } from 'node:crypto';
import { type ControlDatabase, type ControlSQL, WarehouseConflict } from './control-db';
import { type PublicationEffect, validateEffects } from './effects';

export type Ownership = { topicId: string; partition: number; ownerId: string; generation: string };
export type SiteState = {
  website_id: string;
  epoch: string;
  version: string;
  publication: string;
  deletion_revision: string;
  policy_revision: string;
  governance_revision: string;
  repair_revision: string;
  state: string;
};
export type WorkReference = {
  offset: string;
  inputId: string;
  websiteId: string;
  sessionId: string | null;
  identityKey: string;
  quarantineReason?: string;
};
export type PendingWork = {
  offset_id: string;
  input_id: string;
  website_id: string;
  session_id: string | null;
  identity_key: string;
};
export type Attempt = {
  attempt_id: string;
  website_id: string;
  epoch: string;
  deletion_revision: string;
  policy_revision: string;
  topic_id: string;
  partition: number;
  generation: string;
  owner_id: string;
  first_offset: string;
  last_offset: string;
  input_count: number;
  input_digest: string;
  version: string | null;
  status: string;
  decision_projected: boolean;
  effects?: PublicationEffect[];
};

async function requireOwner(tx: ControlSQL, owner: Ownership) {
  const { rows } = await tx.query(
    `SELECT generation FROM liekan_warehouse_partition
    WHERE topic_id=$1 AND partition=$2 AND owner_id=$3::uuid
      AND generation=$4::bigint AND lease_until > clock_timestamp() FOR UPDATE`,
    [owner.topicId, owner.partition, owner.ownerId, owner.generation],
  );
  if (!rows.length) throw new WarehouseConflict('warehouse-owner-fenced');
}

async function requireAuthority(
  tx: ControlSQL,
  topicId: string,
  authority: 'postgres' | 'clickhouse',
) {
  const { rows } = await tx.query(
    `SELECT id FROM liekan_warehouse_installation
    WHERE id=1 AND authority=$2 AND topic_id=$1 FOR SHARE`,
    [topicId, authority],
  );
  if (!rows.length) throw new WarehouseConflict('warehouse-authority-frozen');
}

export class WarehouseControl {
  constructor(
    readonly db: ControlDatabase,
    readonly authority: 'postgres' | 'clickhouse' = 'clickhouse',
  ) {}

  async claim(
    topicId: string,
    partition: number,
    ownerId: string,
    leaseSeconds = 30,
  ): Promise<Ownership> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 120)
      throw new Error('Invalid ownership lease');
    return this.db.transaction(async tx => {
      await requireAuthority(tx, topicId, this.authority);
      const { rows } = await tx.query<{ generation: string }>(
        `UPDATE liekan_warehouse_partition
        SET generation=generation+1, owner_id=$3::uuid,
          lease_until=clock_timestamp()+$4*interval '1 second', updated_at=clock_timestamp()
        WHERE topic_id=$1 AND partition=$2 AND (owner_id IS NULL OR lease_until <= clock_timestamp() OR owner_id=$3::uuid)
        RETURNING generation`,
        [topicId, partition, ownerId, leaseSeconds],
      );
      if (!rows.length) throw new WarehouseConflict('warehouse-partition-owned');
      await tx.query(
        `UPDATE liekan_warehouse_attempt SET status='aborted',updated_at=clock_timestamp()
        WHERE topic_id=$1 AND partition=$2 AND status='intent'`,
        [topicId, partition],
      );
      await tx.query(
        `UPDATE liekan_warehouse_work w SET status='pending',attempt_id=NULL,updated_at=clock_timestamp()
        FROM liekan_warehouse_attempt a WHERE w.attempt_id=a.attempt_id
          AND a.topic_id=$1 AND a.partition=$2 AND a.status='aborted' AND w.status='working'`,
        [topicId, partition],
      );
      // Confirmed attempts retain their single-flight work until the decision
      // journal is restored in CH. A takeover cannot decide the same UUID twice.
      return { topicId, partition, ownerId, generation: rows[0].generation };
    });
  }

  async renew(owner: Ownership, seconds = 30) {
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 120)
      throw new Error('Invalid ownership lease');
    return this.db.transaction(async tx => {
      await requireOwner(tx, owner);
      await tx.query(
        `UPDATE liekan_warehouse_partition SET lease_until=clock_timestamp()+$5*interval '1 second'
        WHERE topic_id=$1 AND partition=$2 AND owner_id=$3::uuid AND generation=$4::bigint`,
        [owner.topicId, owner.partition, owner.ownerId, owner.generation, seconds],
      );
    });
  }

  async release(owner: Ownership) {
    await this.db.transaction(tx =>
      tx.query(
        `UPDATE liekan_warehouse_partition SET owner_id=NULL,lease_until=NULL
      WHERE topic_id=$1 AND partition=$2 AND owner_id=$3::uuid AND generation=$4::bigint`,
        [owner.topicId, owner.partition, owner.ownerId, owner.generation],
      ),
    );
  }

  async abort(owner: Ownership, attemptId: string) {
    await this.db.transaction(async tx => {
      await requireOwner(tx, owner);
      const result = await tx.query(
        `UPDATE liekan_warehouse_attempt SET status='aborted',updated_at=clock_timestamp()
        WHERE attempt_id=$1::uuid AND topic_id=$2 AND partition=$3 AND status='intent' RETURNING attempt_id`,
        [attemptId, owner.topicId, owner.partition],
      );
      if (result.rowCount)
        await tx.query(
          `UPDATE liekan_warehouse_work SET status='pending',attempt_id=NULL,updated_at=clock_timestamp()
        WHERE attempt_id=$1::uuid AND status='working'`,
          [attemptId],
        );
    });
  }

  async site(websiteId: string) {
    return (
      await this.db.read<SiteState>(
        'SELECT * FROM liekan_warehouse_site WHERE website_id=$1::uuid',
        [websiteId],
      )
    )[0];
  }

  async ready(owner: Ownership, limit = 500, excludedSites: string[] = []): Promise<PendingWork[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
      throw new Error('Invalid work limit');
    return this.db.read<PendingWork>(
      `SELECT w.offset_id,w.input_id,w.website_id,w.session_id,w.identity_key
      FROM liekan_warehouse_work w JOIN liekan_warehouse_site s USING(website_id)
      WHERE w.topic_id=$1 AND w.partition=$2 AND w.status='pending' AND s.state='active'
        AND NOT EXISTS(SELECT 1 FROM liekan_warehouse_barrier b CROSS JOIN LATERAL jsonb_array_elements(b.boundary) p
          WHERE b.status='draining' AND b.topic_id=w.topic_id AND (p->>'partition')::integer=w.partition AND w.offset_id>=(p->>'offset')::bigint)
        AND NOT(w.website_id=ANY($4::uuid[]))
        AND (SELECT true FROM liekan_warehouse_work e WHERE e.topic_id=w.topic_id AND e.identity_key=w.identity_key
          AND e.status IN ('pending','working','quarantined')
          AND (e.status='working' OR (e.status IN ('pending','quarantined') AND e.offset_id<w.offset_id)) LIMIT 1) IS NULL
        AND NOT EXISTS(SELECT 1 FROM liekan_warehouse_deletion d WHERE d.website_id=w.website_id
          AND d.status NOT IN ('active','reclaimed') AND (d.session_id IS NULL OR d.session_id=w.session_id))
      ORDER BY w.offset_id LIMIT $3`,
      [owner.topicId, owner.partition, limit, excludedSites],
    );
  }

  async recovery(owner: Ownership, limit = 50): Promise<Attempt[]> {
    return this.db.read<Attempt>(
      `SELECT * FROM liekan_warehouse_attempt WHERE topic_id=$1 AND partition=$2
      AND ((status='confirmed' AND ($4='clickhouse' OR NOT decision_projected)) OR (status='projected' AND NOT decision_projected)) ORDER BY created_at LIMIT $3`,
      [owner.topicId, owner.partition, limit, this.authority],
    );
  }

  async fault(owner: Ownership, offset: string, reason: string) {
    if (!/^\d+$/.test(offset) || !/^warehouse-[a-z-]+$/.test(reason))
      throw new Error('Invalid queue fault');
    await this.db.transaction(async tx => {
      await requireOwner(tx, owner);
      await tx.query(
        `INSERT INTO liekan_warehouse_queue_fault(topic_id,partition,offset_id,reason)
        SELECT $1,$2,$3::bigint,$4 WHERE $3::bigint>(SELECT reclaimed_offset FROM liekan_warehouse_partition WHERE topic_id=$1 AND partition=$2) ON CONFLICT DO NOTHING`,
        [owner.topicId, owner.partition, offset, reason],
      );
    });
  }

  async safeOffset(owner: Ownership): Promise<string> {
    return this.db.transaction(async tx => {
      await requireOwner(tx, owner);
      const [p] = (
        await tx.query<{ safe_offset: string }>(
          `UPDATE liekan_warehouse_partition p SET
        safe_offset=least(p.discovered_offset,
          coalesce((SELECT min(w.offset_id)-1 FROM liekan_warehouse_work w LEFT JOIN liekan_warehouse_attempt a USING(attempt_id)
            WHERE w.topic_id=p.topic_id AND w.partition=p.partition AND
              (w.status NOT IN ('confirmed','cancelled') OR (w.status='confirmed' AND $3='clickhouse' AND a.status<>'projected'))),p.discovered_offset),
          coalesce((SELECT min(f.offset_id)-1 FROM liekan_warehouse_queue_fault f
            WHERE f.topic_id=p.topic_id AND f.partition=p.partition AND f.resolved_at IS NULL),p.discovered_offset))
        WHERE p.topic_id=$1 AND p.partition=$2 RETURNING safe_offset`,
          [owner.topicId, owner.partition, this.authority],
        )
      ).rows;
      return p.safe_offset;
    });
  }

  async discover(owner: Ownership, inputs: WorkReference[], readThrough: string) {
    if (inputs.length > 10000 || !/^\d+$/.test(readThrough))
      throw new Error('Invalid discovery batch');
    return this.db.transaction(async tx => {
      await requireAuthority(tx, owner.topicId, this.authority);
      await requireOwner(tx, owner);
      if (new Set(inputs.map(i => i.offset)).size !== inputs.length)
        throw new Error('Duplicate discovery offset');
      for (const input of inputs) {
        if (!/^\d+$/.test(input.offset) || BigInt(input.offset) > BigInt(readThrough))
          throw new Error('Invalid input offset');
      }
      const [{ reclaimed_offset: reclaimed }] = (
        await tx.query<{ reclaimed_offset: string }>(
          'SELECT reclaimed_offset FROM liekan_warehouse_partition WHERE topic_id=$1 AND partition=$2',
          [owner.topicId, owner.partition],
        )
      ).rows;
      // A broker/group rewind can still deliver a trimmed prefix from an old
      // fetch. The durable floor prevents rebuilding already completed work.
      const retained = inputs.filter(i => BigInt(i.offset) > BigInt(reclaimed));
      const records = retained.map(i => ({
        offset_id: i.offset,
        input_id: i.inputId,
        website_id: i.websiteId,
        session_id: i.sessionId,
        identity_key: i.identityKey,
        status: i.quarantineReason ? 'quarantined' : 'pending',
        reason: i.quarantineReason ?? null,
      }));
      const inserted = await tx.query(
        `WITH incoming AS (
          SELECT r.*,row_number() OVER(PARTITION BY input_id ORDER BY offset_id) AS occurrence
          FROM jsonb_to_recordset($3::jsonb) AS r(offset_id bigint,input_id uuid,website_id uuid,
            session_id uuid,identity_key text,status text,reason text)
        ) INSERT INTO liekan_warehouse_work AS old
        (topic_id,partition,offset_id,input_id,website_id,session_id,identity_key,status,reason)
        SELECT $1,$2,r.offset_id,r.input_id,r.website_id,r.session_id,r.identity_key,
          CASE WHEN r.status='pending' AND (r.occurrence>1 OR EXISTS(
            SELECT 1 FROM liekan_warehouse_work prior WHERE prior.topic_id=$1 AND prior.input_id=r.input_id
              AND prior.status<>'cancelled' AND prior.website_id=r.website_id AND prior.identity_key=r.identity_key
              AND (prior.partition<>$2 OR prior.offset_id<>r.offset_id))) THEN 'cancelled' ELSE r.status END,r.reason
        FROM incoming r
        ON CONFLICT(topic_id,partition,offset_id) DO UPDATE SET input_id=old.input_id
        WHERE old.input_id=excluded.input_id AND old.website_id=excluded.website_id
          AND old.session_id IS NOT DISTINCT FROM excluded.session_id
          AND old.identity_key=excluded.identity_key
        RETURNING input_id`,
        [owner.topicId, owner.partition, JSON.stringify(records)],
      );
      if (inserted.rowCount !== retained.length)
        throw new WarehouseConflict('warehouse-input-reference-conflict');
      await tx.query(
        `UPDATE liekan_warehouse_partition SET discovered_offset=greatest(discovered_offset,$3::bigint),updated_at=clock_timestamp()
        WHERE topic_id=$1 AND partition=$2`,
        [owner.topicId, owner.partition, readThrough],
      );
    });
  }

  async intent(
    owner: Ownership,
    websiteId: string,
    offsets: string[],
    digest: string,
    attemptId: string = randomUUID(),
  ): Promise<Attempt> {
    if (
      !offsets.length ||
      offsets.length > 10000 ||
      !/^[0-9a-f]{64}$/.test(digest) ||
      offsets.some(o => !/^\d+$/.test(o))
    )
      throw new Error('Invalid decision batch');
    return this.db.transaction(async tx => {
      await requireAuthority(tx, owner.topicId, this.authority);
      await requireOwner(tx, owner);
      const existing = await tx.query<Attempt>(
        'SELECT * FROM liekan_warehouse_attempt WHERE attempt_id=$1::uuid',
        [attemptId],
      );
      if (existing.rows.length) {
        const attempt = existing.rows[0];
        if (
          attempt.input_digest !== digest ||
          attempt.website_id !== websiteId ||
          attempt.input_count !== offsets.length ||
          attempt.owner_id !== owner.ownerId ||
          attempt.generation !== owner.generation
        )
          throw new WarehouseConflict('warehouse-attempt-conflict');
        return attempt;
      }
      // Take the attempt foreign key's lock before the lifecycle guard. It is
      // compatible with the ordinary confirmation and publication counter writes.
      const siteKey = await tx.query(
        'SELECT website_id FROM liekan_warehouse_site WHERE website_id=$1::uuid FOR KEY SHARE',
        [websiteId],
      );
      if (!siteKey.rowCount) throw new WarehouseConflict('warehouse-site-frozen');
      const guard = await tx.query(
        'SELECT website_id FROM liekan_warehouse_claim_guard WHERE website_id=$1::uuid FOR SHARE',
        [websiteId],
      );
      if (!guard.rowCount) throw new WarehouseConflict('warehouse-claim-guard-missing');
      // Take the state snapshot after acquiring the guard, in case it waited for
      // a deletion or policy change to commit.
      const { rows: sites } = await tx.query<SiteState>(
        'SELECT * FROM liekan_warehouse_site WHERE website_id=$1::uuid',
        [websiteId],
      );
      const site = sites[0];
      if (site?.state !== 'active') throw new WarehouseConflict('warehouse-site-frozen');
      const { rows: work } = await tx.query<{
        identity_key: string;
        offset_id: string;
        session_id: string | null;
      }>(
        `SELECT identity_key,offset_id,session_id
        FROM liekan_warehouse_work w WHERE topic_id=$1 AND partition=$2 AND website_id=$3::uuid
          AND offset_id=ANY($4::bigint[]) AND status='pending'
          AND NOT EXISTS(SELECT 1 FROM liekan_warehouse_barrier b CROSS JOIN LATERAL jsonb_array_elements(b.boundary) p
            WHERE b.status='draining' AND b.topic_id=w.topic_id AND (p->>'partition')::integer=w.partition AND w.offset_id>=(p->>'offset')::bigint)
          ORDER BY offset_id FOR UPDATE`,
        [owner.topicId, owner.partition, websiteId, offsets],
      );
      if (
        work.length !== offsets.length ||
        new Set(work.map(w => w.identity_key)).size !== work.length
      )
        throw new WarehouseConflict('warehouse-work-not-ready');
      const busy = await tx.query(
        // Materialize one active-key summary. With stale idle-queue statistics,
        // correlated probes can scan all pending work once per selected key,
        // holding the partition and claim guard until the statement times out.
        // The keys and offsets come from the same already-locked rows, and the
        // topic-wide scope preserves ordering across partitions.
        `WITH active AS MATERIALIZED (
          SELECT identity_key,min(offset_id) AS first_offset,bool_or(status='working') AS working
          FROM liekan_warehouse_work WHERE topic_id=$1 AND identity_key=ANY($2::text[])
            AND status IN ('pending','working','quarantined') GROUP BY identity_key
        ) SELECT 1 FROM unnest($2::text[],$3::bigint[]) chosen(identity_key,offset_id)
        JOIN active USING(identity_key)
        WHERE active.working OR active.first_offset<chosen.offset_id LIMIT 1`,
        [owner.topicId, work.map(w => w.identity_key), work.map(w => w.offset_id)],
      );
      if (busy.rows.length) throw new WarehouseConflict('warehouse-key-busy');
      const pending = await tx.query(
        `SELECT 1 FROM liekan_warehouse_deletion WHERE website_id=$1::uuid
        AND status NOT IN ('active','reclaimed') AND (session_id IS NULL OR session_id=ANY($2::uuid[])) LIMIT 1`,
        [websiteId, work.map(w => w.session_id).filter(Boolean)],
      );
      if (pending.rows.length) throw new WarehouseConflict('warehouse-delete-pending');
      const { rows } = await tx.query<Attempt>(
        `INSERT INTO liekan_warehouse_attempt
        (attempt_id,topic_id,partition,generation,owner_id,website_id,epoch,deletion_revision,policy_revision,first_offset,last_offset,input_count,input_digest,status)
        VALUES($1::uuid,$2,$3,$4::bigint,$5::uuid,$6::uuid,$7::bigint,$8::bigint,$9::bigint,$10::bigint,$11::bigint,$12,$13,'intent') RETURNING *`,
        [
          attemptId,
          owner.topicId,
          owner.partition,
          owner.generation,
          owner.ownerId,
          websiteId,
          site.epoch,
          site.deletion_revision,
          site.policy_revision,
          work[0].offset_id,
          work.at(-1).offset_id,
          work.length,
          digest,
        ],
      );
      await tx.query(
        `UPDATE liekan_warehouse_work SET status='working',attempt_id=$5::uuid,updated_at=clock_timestamp()
        WHERE topic_id=$1 AND partition=$2 AND website_id=$3::uuid AND offset_id=ANY($4::bigint[])`,
        [owner.topicId, owner.partition, websiteId, offsets, attemptId],
      );
      return rows[0];
    });
  }

  // The caller must first verify the whole durable landing package. No CH or broker
  // I/O runs inside this transaction. Site version allocation follows commit order.
  async confirm(
    owner: Ownership,
    attemptId: string,
    digest: string,
    receiptSessions: string[] = [],
    effects: PublicationEffect[] = [],
    validateAuthority?: (tx: ControlSQL, attempt: Attempt) => Promise<void>,
    acceptResult?: (tx: ControlSQL, attempt: Attempt) => Promise<void>,
  ): Promise<Attempt> {
    return this.db.transaction(async tx => {
      await requireAuthority(tx, owner.topicId, this.authority);
      await requireOwner(tx, owner);
      const { rows } = await tx.query<Attempt>(
        'SELECT * FROM liekan_warehouse_attempt WHERE attempt_id=$1::uuid FOR UPDATE',
        [attemptId],
      );
      const a = rows[0];
      if (
        !a ||
        a.topic_id !== owner.topicId ||
        a.partition !== owner.partition ||
        a.input_digest !== digest
      )
        throw new WarehouseConflict('warehouse-attempt-conflict');
      if (['confirmed', 'projected'].includes(a.status)) return a;
      validateEffects(effects, a.input_count);
      if (
        a.status !== 'intent' ||
        a.generation !== owner.generation ||
        a.owner_id !== owner.ownerId
      )
        throw new WarehouseConflict('warehouse-owner-fenced');
      if (validateAuthority) await validateAuthority(tx, a);
      const { rows: sites } = await tx.query<SiteState>(
        'SELECT * FROM liekan_warehouse_site WHERE website_id=$1::uuid FOR NO KEY UPDATE',
        [a.website_id],
      );
      const site = sites[0];
      if (
        site?.state !== 'active' ||
        site.epoch !== a.epoch ||
        site.deletion_revision !== a.deletion_revision ||
        site.policy_revision !== a.policy_revision
      )
        throw new WarehouseConflict('warehouse-site-changed');
      const pending = await tx.query(
        `SELECT 1 FROM liekan_warehouse_deletion d WHERE d.website_id=$1::uuid
        AND d.status NOT IN ('active','reclaimed') AND (d.session_id IS NULL OR d.session_id=ANY($3::uuid[]) OR d.session_id IN (
          SELECT session_id FROM liekan_warehouse_work WHERE attempt_id=$2::uuid)) LIMIT 1`,
        [a.website_id, attemptId, receiptSessions],
      );
      if (pending.rows.length) throw new WarehouseConflict('warehouse-delete-pending');
      const version = (
        await tx.query<{ version: string }>(
          `UPDATE liekan_warehouse_site SET version=version+1,updated_at=clock_timestamp()
        WHERE website_id=$1::uuid RETURNING version`,
          [a.website_id],
        )
      ).rows[0].version;
      const accepted = (
        await tx.query<Attempt>(
          `UPDATE liekan_warehouse_attempt SET version=$2::bigint,status='confirmed',effects=$3::jsonb,updated_at=clock_timestamp()
        WHERE attempt_id=$1::uuid RETURNING *`,
          [attemptId, version, JSON.stringify(effects)],
        )
      ).rows[0];
      if (acceptResult) await acceptResult(tx, accepted);
      return accepted;
    });
  }

  async decisionProjected(owner: Ownership, attemptId: string) {
    return this.db.transaction(async tx => {
      await requireOwner(tx, owner);
      const result = await tx.query(
        `UPDATE liekan_warehouse_attempt SET decision_projected=true,updated_at=clock_timestamp()
        WHERE attempt_id=$1::uuid AND topic_id=$2 AND partition=$3 AND status IN ('confirmed','projected') RETURNING attempt_id`,
        [attemptId, owner.topicId, owner.partition],
      );
      if (!result.rows.length) throw new WarehouseConflict('warehouse-attempt-not-confirmed');
      await tx.query(
        `UPDATE liekan_warehouse_work SET status='confirmed',updated_at=clock_timestamp()
        WHERE attempt_id=$1::uuid AND status='working'`,
        [attemptId],
      );
    });
  }
}
