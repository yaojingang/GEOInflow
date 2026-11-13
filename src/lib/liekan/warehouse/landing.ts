import { createHash } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { canonicalWireRow } from './candidate';
import type { WireRow } from './codec';
import type { Attempt } from './control';
import type { PublicationEffect } from './effects';
import { stableOperation } from './identifiers';
import type { MigrationRow } from './migration-source';
import { boundaryParameters, type ReadBoundary } from './read';
import { type InputEnvelope, routingKey, validateEnvelope } from './routing';

export type FactMutation = {
  family: string;
  row: WireRow;
  retainCreatedAt?: boolean;
  deleted?: boolean;
  // Internal derived rows without their own session column retain the parent
  // session for deletion fencing (for example an exclusion membership).
  sessionId?: string;
  // Only a PG authoritative result may carry this committed-row proof.
  propertyProof?: { sourceHash: string; dataHash: string };
};
export type InputPosition = { partition: number; offset: string; envelope: InputEnvelope };
export type LandedDecision = {
  input: InputPosition;
  status: 'new' | 'duplicate' | 'conflict' | 'cancelled';
  sessionId: string | null;
  visitId: string | null;
  facts: FactMutation[];
  effects?: PublicationEffect[];
};
type LandingRow = {
  website_id: string;
  epoch: string;
  attempt_id: string;
  input_id: string;
  topic_id: string;
  partition: number;
  offset: string;
  identity_key: string;
  payload_hash: string;
  decision: string;
  original_session: string | null;
  original_visit: string | null;
  envelope: string;
  received_at: string;
};
type HistoricalReceipt = {
  kind: 'historical-receipt';
  migrationId: string;
  eventId: string | null;
  source: string | null;
  scope: string | null;
};
export type Receipt = {
  identity_key: string;
  payload_hash: string;
  original_session: string | null;
  original_visit: string | null;
  source: string | null;
  scope: string | null;
  version: string;
};

export function receiptOutcome(
  receipt: Receipt,
  input: Pick<InputEnvelope, 'fingerprint' | 'collectionSource' | 'collectionScope'>,
) {
  if (
    receipt.payload_hash !== input.fingerprint ||
    receipt.source !== input.collectionSource ||
    receipt.scope !== input.collectionScope
  )
    return 'conflict' as const;
  if (!receipt.original_session || !receipt.original_visit) return 'unavailable' as const;
  return 'duplicate' as const;
}

export function inputDigest(inputs: InputPosition[]): string {
  const hash = createHash('sha256');
  for (const input of [...inputs].sort((a, b) =>
    BigInt(a.offset) < BigInt(b.offset) ? -1 : BigInt(a.offset) > BigInt(b.offset) ? 1 : 0,
  )) {
    hash.update(JSON.stringify([input.partition, input.offset, input.envelope])).update('\n');
  }
  return hash.digest('hex');
}

function landingRow(attempt: Attempt, decision: LandedDecision): LandingRow {
  const e = validateEnvelope(decision.input.envelope);
  if (
    e.websiteId !== attempt.website_id ||
    e.topicId !== attempt.topic_id ||
    decision.input.partition !== attempt.partition
  )
    throw new Error('Landing attempt boundary mismatch');
  const facts = decision.facts.map(fact => {
    const row = canonicalWireRow(fact.family, fact.row);
    if (row.website_id !== e.websiteId) throw new Error('Cross-site warehouse fact');
    return { ...fact, row };
  });
  return {
    website_id: e.websiteId,
    epoch: attempt.epoch,
    attempt_id: attempt.attempt_id,
    input_id: e.inputId,
    topic_id: e.topicId,
    partition: decision.input.partition,
    offset: decision.input.offset,
    identity_key: routingKey(e),
    payload_hash: e.fingerprint,
    decision: decision.status,
    original_session: decision.sessionId,
    original_visit: decision.visitId,
    envelope: JSON.stringify({ ...decision, facts }),
    received_at: new Date(e.receivedAt).toISOString().replace('T', ' ').replace('Z', '000'),
  };
}

function landingDigest(rows: LandingRow[]): string {
  const hash = createHash('sha256');
  const keys: (keyof LandingRow)[] = [
    'website_id',
    'epoch',
    'attempt_id',
    'input_id',
    'topic_id',
    'partition',
    'offset',
    'identity_key',
    'payload_hash',
    'decision',
    'original_session',
    'original_visit',
    'envelope',
    'received_at',
  ];
  for (const row of [...rows].sort((a, b) => a.input_id.localeCompare(b.input_id)))
    hash.update(JSON.stringify(keys.map(k => row[k]))).update('\n');
  return hash.digest('hex');
}

export class LandingStore {
  constructor(private readonly ch: ClickHouseClient) {}

  async stage(attempt: Attempt, decisions: LandedDecision[]) {
    if (
      decisions.length !== attempt.input_count ||
      inputDigest(decisions.map(d => d.input)) !== attempt.input_digest
    )
      throw new Error('Landing input digest mismatch');
    const values = decisions.map(d => landingRow(attempt, d));
    await this.writePackage(attempt.website_id, attempt.epoch, attempt.attempt_id, values);
  }

  private async writePackage(
    site: string,
    epoch: string,
    attemptId: string,
    values: LandingRow[],
    verifyOnly = false,
  ) {
    if (!values.length || values.length > 10000) throw new Error('Invalid landing package size');
    if (!verifyOnly)
      await this.ch.insert({ table: 'warehouse_landing', values, format: 'JSONEachRow' });
    const rows = await this.ch
      .query({
        query: `SELECT DISTINCT * FROM warehouse_landing
      WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND attempt_id={attempt:UUID} LIMIT {limit:UInt32}`,
        query_params: {
          site,
          epoch,
          attempt: attemptId,
          limit: values.length + 1,
        },
        format: 'JSONEachRow',
      })
      .then(r => r.json<LandingRow>());
    if (rows.length !== values.length || landingDigest(rows) !== landingDigest(values))
      throw new Error('Landing package verification failed');
  }

  // Receipts precede fact backfill. Their response identity comes from the immutable
  // source snapshot, not from a partially populated target event/session table.
  async importReceipts(
    migrationId: string,
    attemptId: string,
    site: string,
    epoch: string,
    rows: MigrationRow[],
    verifyOnly = false,
  ) {
    const values: LandingRow[] = rows.map(item => {
      if (
        item.websiteId !== site ||
        !item.receipt ||
        typeof item.row.client_event_id !== 'string' ||
        typeof item.row.payload_hash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(item.row.payload_hash)
      )
        throw new Error('Invalid historical receipt');
      const historical: HistoricalReceipt = {
        kind: 'historical-receipt',
        migrationId,
        eventId: item.row.event_id as string | null,
        source: item.receipt.source,
        scope: item.receipt.scope,
      };
      return {
        website_id: site,
        epoch,
        attempt_id: attemptId,
        input_id: stableOperation([migrationId, 'receipt', item.key]),
        topic_id: `history:${migrationId}`,
        partition: 0,
        offset: '0',
        identity_key: routingKey({
          websiteId: site,
          sessionId: site,
          clientEventId: item.row.client_event_id,
        }),
        payload_hash: item.row.payload_hash,
        decision: 'new',
        original_session: item.sessionId,
        original_visit: item.visitId,
        envelope: JSON.stringify(historical),
        received_at: item.recordTime,
      };
    });
    await this.writePackage(site, epoch, attemptId, values, verifyOnly);
    await this.projectDecision(
      {
        website_id: site,
        epoch,
        attempt_id: attemptId,
        version: '0',
        status: 'confirmed',
        input_count: values.length,
        input_digest: landingDigest(values),
      },
      verifyOnly,
    );
  }

  async projectDecision(
    attempt: Pick<
      Attempt,
      'website_id' | 'epoch' | 'attempt_id' | 'version' | 'status' | 'input_count' | 'input_digest'
    >,
    recheck = false,
  ) {
    if (!['confirmed', 'projected'].includes(attempt.status) || !attempt.version)
      throw new Error('Unconfirmed landing decision');
    const existing = await this.ch
      .query({
        query: `SELECT DISTINCT version,input_count,digest FROM warehouse_decision
      WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND attempt_id={attempt:UUID}`,
        query_params: {
          site: attempt.website_id,
          epoch: attempt.epoch,
          attempt: attempt.attempt_id,
        },
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ version: string; input_count: number; digest: string }>());
    if (existing.length) {
      if (
        existing.length !== 1 ||
        existing[0].version !== attempt.version ||
        existing[0].input_count !== attempt.input_count ||
        existing[0].digest !== attempt.input_digest
      )
        throw new Error('Conflicting durable decision');
      return;
    }
    if (recheck) throw new Error('Confirmed decision projection is not visible');
    await this.ch.insert({
      table: 'warehouse_decision',
      values: [
        {
          website_id: attempt.website_id,
          epoch: attempt.epoch,
          attempt_id: attempt.attempt_id,
          version: attempt.version,
          input_count: attempt.input_count,
          digest: attempt.input_digest,
          confirmed_at: new Date().toISOString().replace('T', ' ').replace('Z', '000'),
        },
      ],
      format: 'JSONEachRow',
    });
    // Verify even after an acknowledged write; this is the barrier releasing a key.
    await this.projectDecision(attempt, true);
  }

  async recover(attempt: Attempt): Promise<LandedDecision[]> {
    if (!['confirmed', 'projected'].includes(attempt.status))
      throw new Error('Unconfirmed landing recovery');
    const rows = await this.ch
      .query({
        query: `SELECT DISTINCT input_id,envelope FROM warehouse_landing
      WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND attempt_id={attempt:UUID} LIMIT {limit:UInt32}`,
        query_params: {
          site: attempt.website_id,
          epoch: attempt.epoch,
          attempt: attempt.attempt_id,
          limit: attempt.input_count + 1,
        },
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ input_id: string; envelope: string }>());
    if (rows.length !== attempt.input_count)
      throw new Error('Incomplete confirmed landing package');
    const decisions = rows.map(r => JSON.parse(r.envelope) as LandedDecision);
    if (inputDigest(decisions.map(d => d.input)) !== attempt.input_digest)
      throw new Error('Confirmed landing source mismatch');
    return decisions;
  }

  async deletedInputs(boundary: ReadBoundary, inputs: InputPosition[]): Promise<Set<string>> {
    if (boundary.deletionRevision === '0' || !inputs.length) return new Set();
    if (inputs.length > 1000) throw new Error('Deletion check batch too large');
    // Resolve a retry's canonical receipt as it existed immediately before each
    // deletion. Current receipts alone would miss deleted UUID retries; an old
    // receipt alone would also delete a UUID reused after a previous deletion.
    const beforeReceipt = `arrayElement(arrayFilter(r -> r.2<d.2 AND NOT arrayExists(p -> p.6<d.6
      AND (isNull(p.1) OR p.1=r.1) AND (r.2<p.2 OR (r.3=p.3 AND arrayExists(b -> b.1=r.4 AND r.5<b.2,arrayZip(p.4,p.5)))),ds),ifNull(h.rs,[])),1).1`;
    const found = await this.ch
      .query({
        query: `WITH
      candidates AS (SELECT * FROM warehouse_landing WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64}
        AND decision='new' AND identity_key IN {deleteKeys:Array(String)}),
      deletions AS (SELECT groupArray(tuple(session_id,version,topic_id,partitions,offsets,revision)) AS ds FROM warehouse_deletion
        WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND revision<={wh_deletion:UInt64}),
      history AS (SELECT l.identity_key,arraySort(r -> r.2,groupArray(tuple(l.original_session,a.version,l.topic_id,l.partition,l.offset))) AS rs
        FROM candidates l INNER JOIN (SELECT attempt_id,max(version) AS version FROM warehouse_decision
          WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64}
            AND attempt_id IN (SELECT attempt_id FROM candidates) GROUP BY attempt_id) a ON a.attempt_id=l.attempt_id
        WHERE l.website_id={wh_site:UUID} AND l.epoch={wh_epoch:UInt64} AND l.decision='new' AND l.identity_key IN {deleteKeys:Array(String)} GROUP BY l.identity_key),
      wanted AS (SELECT arrayJoin(arrayZip({deleteIds:Array(String)},{deleteKeys:Array(String)},{deleteSessions:Array(String)},
        {deleteTopics:Array(String)},{deleteParts:Array(UInt32)},arrayMap(x->toUInt64(x),{deleteOffsets:Array(String)}))) AS w)
      SELECT w.1 AS id FROM wanted LEFT JOIN history h ON h.identity_key=w.2 CROSS JOIN deletions
      WHERE arrayExists(d -> d.3=w.4 AND arrayExists(b -> b.1=w.5 AND w.6<b.2,arrayZip(d.4,d.5))
        AND (isNull(d.1) OR toString(d.1)=coalesce(toString(${beforeReceipt}),w.3)),ds)`,
        query_params: {
          ...boundaryParameters(boundary),
          deleteIds: inputs.map(i => i.envelope.inputId),
          deleteKeys: inputs.map(i => routingKey(i.envelope)),
          deleteSessions: inputs.map(i => i.envelope.sessionId),
          deleteTopics: inputs.map(i => i.envelope.topicId),
          deleteParts: inputs.map(i => i.partition),
          deleteOffsets: inputs.map(i => i.offset),
        },
        clickhouse_settings: { join_use_nulls: 0 },
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ id: string }>());
    return new Set(found.map(r => r.id));
  }

  async acceptedInputs(
    boundary: ReadBoundary,
    inputs: InputPosition[],
  ): Promise<Map<string, LandedDecision>> {
    if (!inputs.length) return new Map();
    if (inputs.length > 1000) throw new Error('warehouse-input-receipt-batch-too-large');
    const rows = await this.ch
      .query({
        query: `WITH candidates AS (SELECT * FROM warehouse_landing
        WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64}
          AND input_id IN {ids:Array(UUID)} AND identity_key IN {keys:Array(String)})
      SELECT l.input_id,l.payload_hash,l.decision,l.original_session,l.original_visit,
      JSONExtractString(l.envelope,'input','envelope','collectionSource') AS source,
      JSONExtractString(l.envelope,'input','envelope','collectionScope') AS scope,
      JSONExtractString(l.envelope,'input','envelope','kind') AS kind
      FROM candidates l INNER JOIN (SELECT attempt_id,max(version) AS version FROM warehouse_decision
        WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64}
          AND attempt_id IN (SELECT attempt_id FROM candidates) GROUP BY attempt_id) d ON d.attempt_id=l.attempt_id
      WHERE l.website_id={wh_site:UUID} AND l.epoch={wh_epoch:UInt64} AND l.input_id IN {ids:Array(UUID)}
        AND l.identity_key IN {keys:Array(String)} ORDER BY d.version ASC LIMIT 1 BY l.input_id`,
        query_params: {
          ...boundaryParameters(boundary),
          ids: inputs.map(i => i.envelope.inputId),
          keys: inputs.map(i => routingKey(i.envelope)),
        },
        format: 'JSONEachRow',
      })
      .then(r =>
        r.json<{
          input_id: string;
          payload_hash: string;
          decision: LandedDecision['status'];
          original_session: string | null;
          original_visit: string | null;
          source: string;
          scope: string;
          kind: string;
        }>(),
      );
    return new Map(
      rows.map(row => {
        const input = inputs.find(i => i.envelope.inputId === row.input_id),
          e = input.envelope;
        const conflict =
          row.payload_hash !== e.fingerprint ||
          row.source !== e.collectionSource ||
          row.scope !== e.collectionScope ||
          row.kind !== e.kind;
        return [
          row.input_id,
          {
            input,
            status: conflict ? 'conflict' : row.decision === 'new' ? 'duplicate' : row.decision,
            sessionId: row.original_session,
            visitId: row.original_visit,
            facts: [],
          },
        ];
      }),
    );
  }

  async receipts(boundary: ReadBoundary, keys: string[]): Promise<Receipt[]> {
    if (!keys.length) return [];
    if (keys.length > 10000) throw new Error('Receipt lookup batch too large');
    const rows = await this.ch
      .query({
        query: `WITH candidates AS (SELECT * FROM warehouse_landing
        WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64}
          AND identity_key IN {keys:Array(String)} AND decision='new')
      SELECT l.identity_key,l.payload_hash,l.original_session,l.original_visit,l.envelope,d.version
      FROM candidates l INNER JOIN (
        SELECT attempt_id,max(version) AS version FROM warehouse_decision
        WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64}
          AND attempt_id IN (SELECT attempt_id FROM candidates) GROUP BY attempt_id
      ) d ON d.attempt_id=l.attempt_id
      WHERE l.website_id={wh_site:UUID} AND l.epoch={wh_epoch:UInt64}
        AND l.identity_key IN {keys:Array(String)} AND l.decision='new'
        AND NOT arrayExists(x -> (isNull(tupleElement(x,1)) OR tupleElement(x,1)=l.original_session)
          AND (d.version<tupleElement(x,2) OR (l.topic_id=tupleElement(x,3) AND arrayExists(
            p->tupleElement(p,1)=l.partition AND l.offset<tupleElement(p,2),arrayZip(tupleElement(x,4),tupleElement(x,5))))),
          (SELECT groupArray(tuple(session_id,version,topic_id,partitions,offsets)) FROM warehouse_deletion
            WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND revision<={wh_deletion:UInt64}))
      ORDER BY d.version ASC LIMIT 1 BY l.identity_key`,
        query_params: { ...boundaryParameters(boundary), keys },
        format: 'JSONEachRow',
      })
      .then(r =>
        r.json<{
          identity_key: string;
          payload_hash: string;
          original_session: string | null;
          original_visit: string | null;
          envelope: string;
          version: string;
        }>(),
      );
    return rows.map(({ envelope, ...r }) => {
      const value = JSON.parse(envelope) as HistoricalReceipt | LandedDecision;
      const historical = 'kind' in value && value.kind === 'historical-receipt';
      return {
        ...r,
        source: historical
          ? value.source
          : (value as LandedDecision).input.envelope.collectionSource,
        scope: historical ? value.scope : (value as LandedDecision).input.envelope.collectionScope,
      };
    });
  }
}
