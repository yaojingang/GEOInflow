import { randomUUID } from 'node:crypto';
import { factInput, warehouseTime } from '../../src/lib/liekan/warehouse/fact-input';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';
import type { ClickHouseClient } from '@clickhouse/client';
import type { ReportingMetadata } from '../../src/lib/liekan/warehouse/reporting-relations';

export function reportFixture(ch: ClickHouseClient) {
  const site = randomUUID(),
    session = randomUUID(),
    visit = randomUUID();
  const metadata: ReportingMetadata = {
    boundary: { websiteId: site, epoch: '0', publication: '0', deletionRevision: '0' },
    resourceKind: 'website',
    controlRevision: '1',
    population: { resourceKind: 'website', policyRevision: '1' },
    reports: [],
    policyMode: 'balanced',
    allowedHostnames: [],
    hostnames: [],
    intervals: [],
    repairRunId: null,
    repairGeneration: null,
    exclusions: [],
  };
  async function put(
    family: string,
    fields: Record<string, unknown>[],
    options: { accepted?: boolean; deleted?: boolean } = {},
  ) {
    const attempt = randomUUID(),
      candidate = randomUUID(),
      pub = String(BigInt(metadata.boundary.publication) + 1n);
    await ch.insert({
      table: `warehouse_${family}`,
      format: 'JSONEachRow',
      values: fields.map((f, i) => {
        const row = factInput(family, { website_id: site, ...f });
        return storedFact(family, row, {
          _website_id: site,
          _record_time: warehouseTime(String(f.created_at ?? '2026-11-01T00:00:00Z')),
          _session_id: typeof f.session_id === 'string' ? f.session_id : null,
          _epoch: '0',
          _version: pub,
          _ordinal: i,
          _attempt_id: attempt,
          _candidate_id: candidate,
          _topic_id: 'fixture',
          _partition: 0,
          _offset: pub,
          _deleted: options.deleted ?? false,
        });
      }),
    });
    if (options.accepted === false) return;
    await ch.insert({
      table: 'warehouse_publication',
      format: 'JSONEachRow',
      values: [
        {
          website_id: site,
          epoch: '0',
          publication: pub,
          attempt_id: attempt,
          family,
          candidate_id: candidate,
          row_count: fields.length,
          digest: '0'.repeat(64),
          published_at: warehouseTime(new Date()),
        },
      ],
    });
    metadata.boundary.publication = pub;
  }
  async function event(fields: Record<string, unknown>, qualified = true) {
    const id = String(fields.event_id ?? randomUUID()),
      created = String(fields.created_at);
    await put('website_event', [
      {
        event_id: id,
        session_id: session,
        visit_id: visit,
        event_type: 1,
        url_path: '/fixture',
        ...fields,
      },
    ]);
    await put('liekan_event_quality', [
      {
        event_id: id,
        classification: 'browser',
        source: 'browser',
        reasons: [],
        rule_version: 'fixture',
        range_status: 'missing',
        hostname: fields.hostname ?? null,
        created_at: created,
      },
    ]);
    await put('liekan_event_environment', [
      {
        event_id: id,
        scope: qualified ? 'browser' : 'browser_unresolved',
        identity_available: qualified,
        identity_version: 'fixture',
        origin_hostname: fields.hostname ?? null,
        browser: 'Chrome',
        os: 'Linux',
        device: 'desktop',
        created_at: created,
      },
    ]);
    return id;
  }
  return { site, session, visit, metadata, put, event };
}
