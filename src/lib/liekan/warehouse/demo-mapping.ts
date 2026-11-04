import { createHash } from 'node:crypto';
import { v5 } from 'uuid';
import { sourceTables } from './catalog';
import { recordKey, rowDigest } from './codec';
import { factInput, warehouseTime } from './fact-input';
import type { MigrationRow } from './migration-source';

export function warehouseDemoFamily(table: string): string | null {
  const entry = sourceTables.find(item => item.name === table);
  if (!entry || !['postgres', 'clickhouse'].includes(entry.ownership))
    throw new Error('warehouse-demo-unregistered-table');
  return entry.ownership === 'clickhouse' ? entry.name : null;
}

// Compact reference metadata avoids retaining the 642k complete event payloads.
// The bounded, signed fixture stores ordinal references; no production input
// can select this importer or establish identity evidence through it.
export class DemoFactMapping {
  private readonly eventTimes: Float64Array;
  private readonly eventSessions: Uint32Array;
  private readonly eventVisits: Uint32Array;
  private readonly logTimes: Float64Array;
  private readonly replayOwners = new Map<string, string | null>();

  constructor(
    counts: { event: number; log: number },
    private readonly site: string,
    private readonly hostname: string,
    private readonly anchor: number,
  ) {
    this.eventTimes = new Float64Array(counts.event).fill(NaN);
    this.eventSessions = new Uint32Array(counts.event).fill(0xffffffff);
    this.eventVisits = new Uint32Array(counts.event).fill(0xffffffff);
    this.logTimes = new Float64Array(counts.log).fill(NaN);
  }

  facts(family: string, raw: Record<string, any>, values: Record<string, any>): MigrationRow[] {
    if (family === 'liekan_session_source')
      values = {
        ...values,
        created_at: new Date(this.anchor).toISOString(),
        updated_at: new Date(this.anchor).toISOString(),
      };
    if (family === 'website_event') {
      this.eventTimes[raw.event_id] = Date.parse(values.created_at);
      this.eventSessions[raw.event_id] = raw.session_id ?? 0xffffffff;
      this.eventVisits[raw.event_id] = raw.visit_id ?? 0xffffffff;
    }
    if (family === 'liekan_log') this.logTimes[raw.id] = Date.parse(values.created_at);
    if (family === 'session_replay')
      values = { ...values, events: values.events.replace(/^\\x/, '') };
    const row = factInput(family, values);
    if (family === 'session_replay') {
      const visit = row.visit_id as string,
        session = row.session_id as string;
      if (!visit || !session) throw new Error('warehouse-demo-replay-owner-missing');
      if (this.replayOwners.has(visit) && this.replayOwners.get(visit) !== session) {
        this.replayOwners.set(visit, null);
        throw new Error('warehouse-demo-replay-owner-ambiguous');
      }
      this.replayOwners.set(visit, session);
    }
    const event = family === 'website_event' ? undefined : (raw.event_id ?? raw.website_event_id);
    const uuid = (group: string, value: number) =>
      value === 0xffffffff ? null : v5(`${group}:${value}`, this.site);
    let time =
      values.created_at ?? values.updated_at ?? values.processed_at ?? '1970-01-01T00:00:00Z';
    let sessionId = values.session_id ?? null;
    let visitId = values.visit_id ?? null;
    if (event !== undefined) {
      if (!Number.isFinite(this.eventTimes[event]))
        throw new Error('warehouse-demo-event-parent-missing');
      if (family !== 'liekan_event_quality') time = new Date(this.eventTimes[event]).toISOString();
      sessionId ??= uuid('session', this.eventSessions[event]);
      visitId ??= uuid('visit', this.eventVisits[event]);
    }
    if (family === 'liekan_crawler_evidence') {
      if (!Number.isFinite(this.logTimes[raw.log_id]))
        throw new Error('warehouse-demo-log-parent-missing');
      time = new Date(this.logTimes[raw.log_id]).toISOString();
    }
    const record: MigrationRow = {
      row,
      key: recordKey(family, row),
      hash: rowDigest(family, row),
      websiteId: this.site,
      sessionId,
      visitId,
      recordTime: warehouseTime(time),
      ...(family === 'website_event'
        ? {
            hostnameProof: {
              sourceHash: createHash('sha256').update(this.hostname).digest('hex'),
              normalized: this.hostname,
            },
          }
        : {}),
      ...(family === 'liekan_log' ? { logScopeProof: { present: true, repairScopeId: null } } : {}),
    };
    const result = [record];
    if (family === 'session_data' && values.proof) {
      const proof = factInput('liekan_session_data_source', {
        website_id: this.site,
        session_id: values.session_id,
        data_key: values.data_key,
        scope: 'browser',
        hostname: this.hostname,
        classification: 'browser',
        row_digest: record.hash,
        updated_at: values.created_at,
      });
      const hash = rowDigest('liekan_session_data_source', proof);
      result.push({
        ...record,
        row: proof,
        key: recordKey('liekan_session_data_source', proof),
        hash,
        propertyProof: { sourceHash: hash, dataHash: record.hash },
      });
    }
    return result;
  }

  replayBookmarkOwner(row: Record<string, unknown>) {
    if (row.website_id !== this.site) throw new Error('warehouse-demo-bookmark-site-changed');
    const session = this.replayOwners.get(row.visit_id as string);
    if (!session) throw new Error('warehouse-demo-replay-owner-missing');
    return {
      saved_replay_id: row.saved_replay_id as string,
      website_id: this.site,
      visit_id: row.visit_id as string,
      session_id: session,
    };
  }
}
