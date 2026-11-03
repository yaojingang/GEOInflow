import { testClickHouseURL } from './warehouse-test-target';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import {
  CandidateWriter,
  candidateDigest,
  storedFact,
} from '../../src/lib/liekan/warehouse/candidate';
import { factTables } from '../../src/lib/liekan/warehouse/catalog';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { WarehouseControl } from '../../src/lib/liekan/warehouse/control';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import {
  inputDigest,
  type LandedDecision,
  LandingStore,
  receiptOutcome,
} from '../../src/lib/liekan/warehouse/landing';
import { MigrationPages } from '../../src/lib/liekan/warehouse/migration-page';
import { repairLogSourceRelation } from '../../src/lib/liekan/warehouse/log-scope-proof';
import { MigrationSource } from '../../src/lib/liekan/warehouse/migration-source';
import { WarehousePublisher } from '../../src/lib/liekan/warehouse/publication';
import { boundaryParameters, factRelation } from '../../src/lib/liekan/warehouse/read';
import { normalizedHostnameRelation } from '../../src/lib/liekan/warehouse/reporting-relations';
import { riskRelation } from '../../src/lib/liekan/warehouse/risk-proof';
import { type InputEnvelope, routingKey } from '../../src/lib/liekan/warehouse/routing';
import { warehouseDDL } from '../../src/lib/liekan/warehouse/schema';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_control_${Date.now()}`;
const password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const connection = { host: '127.0.0.1', port: 25459, user: 'liekan_ch_proto', password };
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' });
const url = new URL(`postgresql://127.0.0.1:25459/${run}`);
url.username = connection.user;
url.password = password;
const db = new ControlDatabase(url.toString());
const control = new WarehouseControl(db);
const chAdmin = createWarehouseClient({ url: testClickHouseURL, request_timeout: 30000 });
const ch = createWarehouseClient({
  url: testClickHouseURL,
  database: run,
  request_timeout: 30000,
  clickhouse_settings: { max_threads: 1, max_memory_usage: '268435456' },
});
const source = new MigrationSource(url.toString());
const site = randomUUID(),
  session = randomUUID(),
  owner = randomUUID();
const cases: object[] = [];
const digest = 'a'.repeat(64);
const reference = (offset: string, key: string) => ({
  offset,
  inputId: randomUUID(),
  websiteId: site,
  sessionId: session,
  identityKey: key,
});

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${run}" TEMPLATE liekan_ch_catalog_20261103`);
  for (const file of (await readdir('db/liekan/migrations'))
    .filter(f => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) >= 57)
    .sort()) {
    const sql = await readFile(`db/liekan/migrations/${file}`, 'utf8');
    await db.transaction(async tx => {
      await tx.query(sql);
      await tx.query('INSERT INTO liekan_migration(name,checksum) VALUES($1,$2)', [
        file,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    });
  }
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO website(website_id,name,domain) VALUES($1::uuid,'CH control isolated fixture','warehouse-test.invalid')",
      [site],
    );
    await tx.query('INSERT INTO liekan_warehouse_site(website_id) VALUES($1::uuid)', [site]);
    await tx.query(
      `INSERT INTO liekan_warehouse_installation
      (id,installation_id,schema_version,routing_version,topic_name,topic_id,partition_count,authority,transition)
      VALUES(1,$1::uuid,1,1,'isolated','11111111111111111111111111111111',2,'clickhouse','none')`,
      [randomUUID()],
    );
    await tx.query(
      "INSERT INTO liekan_warehouse_partition(topic_id,partition) VALUES('11111111111111111111111111111111',0),('11111111111111111111111111111111',1)",
    );
  });
  cases.push({ name: 'incremental migration on full empty source schema', status: 'pass' });
  const a = await control.claim('11111111111111111111111111111111', 0, owner);
  const b = await control.claim('11111111111111111111111111111111', 1, owner);
  await assert.rejects(
    () => control.claim('11111111111111111111111111111111', 0, randomUUID()),
    /warehouse-partition-owned/,
  );
  await control.discover(
    a,
    [reference('0', 'same-key'), reference('1', 'same-key'), reference('2', 'independent')],
    '2',
  );
  await control.discover(b, [reference('0', 'other-partition')], '0');
  const first = await control.intent(a, site, ['0'], digest);
  await assert.rejects(() => control.intent(a, site, ['1'], digest), /warehouse-key-busy/);
  const second = await control.intent(b, site, ['0'], digest);
  const confirmed = await Promise.all([
    control.confirm(a, first.attempt_id, digest),
    control.confirm(b, second.attempt_id, digest),
  ]);
  assert.deepEqual(confirmed.map(a => a.version).sort(), ['1', '2']);
  const again = await control.confirm(a, first.attempt_id, digest);
  assert.equal(again.version, confirmed[0].version);
  // Confirmation alone does not release a key: CH's receipt journal must be ready.
  await assert.rejects(() => control.intent(a, site, ['1'], digest), /warehouse-key-busy/);
  await control.decisionProjected(a, first.attempt_id);
  const retry = await control.intent(a, site, ['1'], digest);
  assert.equal(retry.status, 'intent');
  cases.push({
    name: 'concurrent site versions, idempotent confirmation, receipt projection barrier',
    status: 'pass',
  });

  // Lower unrelated offsets cannot allow another key to jump over its own earlier input.
  await control.discover(
    a,
    [reference('3', 'waiting'), reference('4', 'fresh'), reference('5', 'waiting')],
    '5',
  );
  await assert.rejects(() => control.intent(a, site, ['2', '5'], digest), /warehouse-key-busy/);
  cases.push({ name: 'per-key ordering across mixed batch offsets', status: 'pass' });

  await db.transaction(tx =>
    tx.query(
      "UPDATE liekan_warehouse_partition SET lease_until=clock_timestamp()-interval '1 second' WHERE partition=0",
    ),
  );
  const successor = await control.claim('11111111111111111111111111111111', 0, randomUUID());
  await assert.rejects(
    () => control.confirm(a, retry.attempt_id, digest),
    /warehouse-owner-fenced/,
  );
  const recovered = await control.intent(successor, site, ['1'], digest);
  assert.notEqual(recovered.attempt_id, retry.attempt_id);
  assert.equal(
    (
      await db.read('SELECT status FROM liekan_warehouse_attempt WHERE attempt_id=$1::uuid', [
        retry.attempt_id,
      ])
    )[0].status,
    'aborted',
  );
  cases.push({ name: 'lease takeover aborts only undecided intents', status: 'pass' });

  await db.transaction(tx =>
    tx.query(
      'UPDATE liekan_warehouse_site SET deletion_revision=deletion_revision+1 WHERE website_id=$1::uuid',
      [site],
    ),
  );
  await assert.rejects(
    () => control.confirm(successor, recovered.attempt_id, digest),
    /warehouse-site-changed/,
  );
  cases.push({
    name: 'deletion revision fences a decision made against old input',
    status: 'pass',
  });

  const blocker = new pg.Client({ ...connection, database: run });
  await blocker.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT 1 FROM liekan_warehouse_site WHERE website_id=$1::uuid FOR UPDATE',
      [site],
    );
    const started = performance.now();
    await assert.rejects(
      () => control.intent(successor, site, ['2'], digest),
      /warehouse-control-busy/,
    );
    assert.ok(performance.now() - started < 4000);
  } finally {
    await blocker.query('ROLLBACK');
    await blocker.end();
  }
  const afterLock = await control.intent(successor, site, ['2'], digest);
  assert.equal(afterLock.status, 'intent');
  cases.push({ name: 'bounded transient lock contention and recovery', status: 'pass' });
  await chAdmin.command({ query: `CREATE DATABASE "${run}"` });
  for (const ddl of warehouseDDL()) await ch.command({ query: ddl });
  await source.connect();
  assert.deepEqual((await source.inspect()).errors, []);
  for (const table of factTables) assert.equal(await source.page(table.name), null);
  cases.push({
    name: 'all 26 source projections parse against actual restored schema',
    status: 'pass',
  });
  await db.transaction(tx =>
    tx.query(
      `INSERT INTO liekan_collection_diagnostic
    (website_id,bucket,shard,written,with_uuid,duplicate,first_at,last_at)
    SELECT $1::uuid,t,0,9223372036854775807,0,0,t,t FROM generate_series(
      '2026-10-26 10:00:00+00'::timestamptz,'2026-10-26 10:02:00+00'::timestamptz,interval '1 minute') t`,
      [site],
    ),
  );
  const migration = new MigrationPages(db, ch);
  const state = await migration.register('isolated-persistent-fixture', 'b'.repeat(64), {
    [site]: '0',
  });
  const firstPage = await source.page('liekan_collection_diagnostic', null, 2);
  assert.ok(firstPage);
  assert.equal(firstPage.rows.length, 2);
  const checkpoint = await migration.apply(state.migration_id, firstPage);
  assert.equal(checkpoint.status, 'published');
  assert.equal(
    (await migration.apply(state.migration_id, firstPage)).candidate_id,
    checkpoint.candidate_id,
  );
  const cursor = await migration.cursor(state.migration_id, firstPage.family);
  assert.deepEqual(cursor, firstPage.after);
  const secondPage = await source.page(firstPage.family, cursor, 2);
  assert.ok(secondPage);
  assert.equal(secondPage.rows.length, 1);
  await migration.apply(state.migration_id, secondPage);
  assert.equal(
    await source.page(
      firstPage.family,
      await migration.cursor(state.migration_id, firstPage.family),
      2,
    ),
    null,
  );
  const [head] = await db.read<{ publication: string }>(
    'SELECT publication FROM liekan_warehouse_site WHERE website_id=$1::uuid',
    [site],
  );
  const result = await ch
    .query({
      query: `SELECT written FROM ${factRelation(firstPage.family)}`,
      query_params: boundaryParameters({
        websiteId: site,
        epoch: '0',
        publication: head.publication,
        deletionRevision: '1',
      }),
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ written: string }>());
  assert.equal(result.length, 3);
  assert.ok(result.every(r => r.written === '9223372036854775807'));
  await assert.rejects(
    () => migration.apply(state.migration_id, { ...firstPage, digest: 'c'.repeat(64) }),
    /warehouse-source-page-changed/,
  );
  const progress = await db.read<{ pages: string; rows: string }>(
    'SELECT pages,rows FROM liekan_warehouse_migration_family WHERE migration_id=$1::uuid',
    [state.migration_id],
  );
  assert.deepEqual(progress, [{ pages: '2', rows: '3' }]);
  cases.push({
    name: 'exact Int64 source cursor, verified publication, idempotent page and durable resume',
    status: 'pass',
  });
  const envelope: InputEnvelope = {
    version: 1,
    routingVersion: 1,
    topicId: successor.topicId,
    websiteId: site,
    sessionId: session,
    clientEventId: randomUUID(),
    inputId: randomUUID(),
    eventId: randomUUID(),
    visitId: randomUUID(),
    epoch: '0',
    policyRevision: '0',
    kind: 'identify',
    fingerprint: 'd'.repeat(64),
    collectionSource: 'browser',
    collectionScope: 'browser',
    receivedAt: new Date().toISOString(),
    data: { noop: true },
  };
  const position = { partition: 0, offset: '10', envelope };
  await control.renew(successor);
  await control.discover(
    successor,
    [
      {
        offset: '10',
        inputId: envelope.inputId,
        websiteId: site,
        sessionId: session,
        identityKey: routingKey(envelope),
      },
    ],
    '10',
  );
  const intent = await control.intent(successor, site, ['10'], inputDigest([position]));
  const landing = new LandingStore(ch);
  const decision: LandedDecision = {
    input: position,
    status: 'new',
    sessionId: session,
    visitId: envelope.visitId,
    facts: [],
  };
  await landing.stage(intent, [decision]);
  const boundary = {
    websiteId: site,
    epoch: '0',
    publication: head.publication,
    deletionRevision: '1',
  };
  assert.equal((await landing.receipts(boundary, [routingKey(envelope)])).length, 0);
  const accepted = await control.confirm(successor, intent.attempt_id, intent.input_digest);
  await landing.projectDecision(accepted);
  await control.decisionProjected(successor, accepted.attempt_id);
  assert.equal(
    (await landing.receipts(boundary, [routingKey(envelope)]))[0].original_visit,
    envelope.visitId,
  );
  assert.deepEqual(await landing.recover(accepted), [decision]);
  await landing.stage(intent, [decision]);
  await landing.projectDecision(accepted);
  assert.equal((await landing.receipts(boundary, [routingKey(envelope)])).length, 1);
  cases.push({
    name: 'durable landing verification, confirmed-only receipt lookup, replay and recovery',
    status: 'pass',
  });
  const orphan = storedFact(firstPage.family, firstPage.rows[0].row, {
    _website_id: site,
    _record_time: firstPage.rows[0].recordTime,
    _session_id: null,
    _epoch: '0',
    _version: '4',
    _ordinal: 0,
    _attempt_id: afterLock.attempt_id,
    _candidate_id: randomUUID(),
    _topic_id: successor.topicId,
    _partition: 0,
    _offset: '2',
    _deleted: false,
  });
  const candidateWriter = new CandidateWriter(ch);
  await candidateWriter.append(firstPage.family, [orphan]);
  const publisher = new WarehousePublisher(db, ch);
  await assert.rejects(
    () =>
      publisher.reserve(site, '0', [
        {
          attemptId: afterLock.attempt_id,
          family: firstPage.family,
          candidateId: orphan._candidate_id,
          rowCount: '1',
          digest: candidateDigest(firstPage.family, [orphan]),
        },
      ]),
    /warehouse-publication-unconfirmed/,
  );
  assert.equal(
    (
      await db.read<{ publication: string }>(
        'SELECT publication FROM liekan_warehouse_site WHERE website_id=$1::uuid',
        [site],
      )
    )[0].publication,
    head.publication,
  );
  cases.push({ name: 'verified CH bytes cannot publish an unconfirmed attempt', status: 'pass' });
  const historical = {
    event: randomUUID(),
    client: randomUUID(),
    visit: randomUUID(),
    missing: randomUUID(),
  };
  await db.transaction(async tx => {
    await tx.query('INSERT INTO session(session_id,website_id) VALUES($1::uuid,$2::uuid)', [
      session,
      site,
    ]);
    await tx.query(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'2026-10-20 10:12:13.123456+00','/historical',1)`,
      [historical.event, site, session, historical.visit],
    );
    await tx.query(
      `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status)
      VALUES($1::uuid,$2::uuid,'browser','browser',ARRAY[]::text[],'fixture','missing')`,
      [historical.event, site],
    );
    await tx.query(
      `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available)
      VALUES($1::uuid,$2::uuid,'browser_unresolved','fixture',false)`,
      [historical.event, site],
    );
    await tx.query(
      `INSERT INTO liekan_collection_receipt(website_id,client_event_id,payload_hash,event_id)
      VALUES($1::uuid,$2::uuid,$3,$4::uuid),($1::uuid,$5::uuid,$3,NULL)`,
      [site, historical.client, 'f'.repeat(64), historical.event, historical.missing],
    );
  });
  const receiptPage = await source.page('liekan_collection_receipt');
  assert.ok(receiptPage);
  assert.equal(receiptPage.rows.length, 2);
  await migration.apply(state.migration_id, receiptPage);
  await migration.apply(state.migration_id, receiptPage);
  const oldKey = routingKey({
    websiteId: site,
    sessionId: session,
    clientEventId: historical.client,
  });
  const oldReceipt = (await landing.receipts(boundary, [oldKey]))[0];
  assert.equal(oldReceipt.original_session, session);
  assert.equal(oldReceipt.original_visit, historical.visit);
  assert.equal(oldReceipt.scope, 'browser_unresolved');
  assert.equal(oldReceipt.source, 'browser');
  const oldInput = {
    fingerprint: 'f'.repeat(64),
    collectionSource: 'browser',
    collectionScope: 'browser_unresolved',
  };
  assert.equal(receiptOutcome(oldReceipt, oldInput), 'duplicate');
  assert.equal(receiptOutcome(oldReceipt, { ...oldInput, collectionScope: 'browser' }), 'conflict');
  assert.equal(
    receiptOutcome(oldReceipt, { ...oldInput, fingerprint: 'e'.repeat(64) }),
    'conflict',
  );
  const unknown = (
    await landing.receipts(boundary, [
      routingKey({ websiteId: site, sessionId: session, clientEventId: historical.missing }),
    ])
  )[0];
  assert.equal(unknown.original_session, null);
  assert.equal(unknown.scope, null);
  assert.equal(receiptOutcome({ ...oldReceipt, original_session: null }, oldInput), 'unavailable');
  assert.equal(
    (
      await ch
        .query({ query: 'SELECT count() AS n FROM warehouse_website_event', format: 'JSONEachRow' })
        .then(r => r.json<{ n: string }>())
    )[0].n,
    '0',
  );
  cases.push({
    name: 'historical receipts precede facts, preserve response and scope, reject conflicts and unknown identity',
    status: 'pass',
  });
  await db.transaction(async tx => {
    for (const key of ['valid', 'invalid']) {
      await tx.query(
        `INSERT INTO session_data(session_data_id,website_id,session_id,data_key,number_value,date_value,data_type,created_at)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,1234567890.1234,'2026-11-03 10:11:12.123456+00',2,'2026-11-03 00:00:00.654321+00')`,
        [randomUUID(), site, session, key],
      );
      await tx.query(
        `INSERT INTO liekan_session_data_source(website_id,session_id,data_key,scope,classification,row_digest)
        SELECT website_id,session_id,data_key,'browser','browser',CASE WHEN data_key='valid' THEN liekan_session_data_digest(d) ELSE repeat('0',64) END
        FROM session_data d WHERE website_id=$1::uuid AND data_key=$2`,
        [site, key],
      );
    }
  });
  const propertyPage = await source.page('liekan_session_data_source');
  assert.equal(propertyPage.rows.filter(r => r.propertyProof).length, 1);
  const originalDigest = propertyPage.rows.find(r => r.row.data_key === 'valid').row.row_digest;
  await migration.apply(state.migration_id, propertyPage);
  await migration.apply(state.migration_id, propertyPage);
  const proofs = await ch
    .query({
      query:
        "SELECT DISTINCT key,value FROM warehouse_control_projection WHERE kind='pg-session-property-v2'",
      format: 'JSONEachRow',
    })
    .then(r => r.json());
  assert.equal(proofs.length, 1);
  assert.equal(
    (await source.page('liekan_session_data_source')).rows.find(r => r.row.data_key === 'valid').row
      .row_digest,
    originalDigest,
  );
  cases.push({
    name: 'historical property proof preserves PG digest, exact decimal/microseconds and rejects mismatched evidence; retry is idempotent',
    status: 'pass',
  });
  await db.transaction(tx =>
    tx.query('UPDATE website_event SET hostname=$2 WHERE event_id=$1::uuid', [
      historical.event,
      'https://WWW.Example.COM.:443/path',
    ]),
  );
  const hostPage = await source.page('website_event');
  assert.equal(hostPage.rows[0].hostnameProof.normalized, 'example.com');
  await migration.apply(state.migration_id, hostPage);
  const publishedState = await control.site(site);
  const hostParameters = boundaryParameters({
    websiteId: site,
    epoch: publishedState.epoch,
    publication: publishedState.publication,
    deletionRevision: publishedState.deletion_revision,
  });
  await ch.insert({
    table: 'warehouse_control_projection',
    format: 'JSONEachRow',
    values: [
      {
        website_id: site,
        epoch: '0',
        revision: '0',
        kind: 'event-host-v1',
        key: hostPage.rows[0].hostnameProof.sourceHash,
        value: JSON.stringify({ candidateId: randomUUID(), value: 'unpublished.invalid' }),
        created_at: hostPage.rows[0].recordTime,
      },
    ],
  });
  const normalized = await ch
    .query({
      query: `SELECT hostname FROM ${normalizedHostnameRelation()}`,
      query_params: hostParameters,
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ hostname: string }>());
  assert.deepEqual(normalized, [{ hostname: 'example.com' }]);
  cases.push({
    name: 'historical hostname normalization is batch-projected and ignores unpublished proof candidates',
    status: 'pass',
  });
  const qualityPage = await source.page('liekan_event_quality');
  assert.ok(qualityPage.rows.every(r => r.recordTime === r.row.created_at));
  const riskWindow = '2026-11-03 00:01:00.123456+00';
  await db.transaction(async tx => {
    await tx.query(
      `INSERT INTO liekan_browser_risk_window(website_id,window_end,epoch,rule_version,coverage,events,visits,insufficient,flagged,computed_at)
      VALUES($1,$2,1,'fixture-risk','observed',120,1,0,1,'2026-11-03 00:03:00.654321+00')`,
      [site, riskWindow],
    );
    await tx.query(
      "INSERT INTO liekan_browser_risk(website_id,window_end,session_id,visit_id,reasons,features) VALUES($1,$2,$3,$4,ARRAY['regular-timing'],'{}')",
      [site, riskWindow, session, randomUUID()],
    );
  });
  const riskPage = await source.page('liekan_browser_risk');
  assert.equal(riskPage.rows[0].riskProof.computedAt, '2026-11-03 00:03:00.654321');
  await migration.apply(state.migration_id, riskPage);
  const riskState = await control.site(site),
    riskParams = {
      ...hostParameters,
      wh_publication: riskState.publication,
      riskRule: 'fixture-risk',
      riskEpoch: '1',
    };
  const proved = await ch
    .query({
      query: `SELECT count() AS n FROM ${riskRelation()}`,
      query_params: riskParams,
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ n: string }>());
  assert.equal(proved[0].n, '1');
  const wrongEpoch = await ch
    .query({
      query: `SELECT count() AS n FROM ${riskRelation()}`,
      query_params: { ...riskParams, riskEpoch: '2' },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ n: string }>());
  assert.equal(wrongEpoch[0].n, '0');
  cases.push({
    name: 'migration preserves risk-window proof, microseconds and received-time partitioning; old epochs stay invisible',
    status: 'pass',
  });
  await db.transaction(async tx => {
    for (const frozen of [true, false]) {
      const batch = randomUUID();
      await tx.query(
        'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected,repair_scope_id) VALUES($1,$2,$3,1,0,$4)',
        [
          batch,
          site,
          createHash('sha256').update(batch).digest('hex'),
          frozen ? null : randomUUID(),
        ],
      );
      await tx.query(
        `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification)
        VALUES($1,$2,$3,'2026-11-03 00:00:00.000001+00','/frozen','GET',200,0,'','','isolated','','其他','','其他','unverified')`,
        [createHash('sha256').update(batch).digest('hex'), site, batch],
      );
    }
  });
  const logPage = await source.page('liekan_log');
  assert.equal(logPage.rows.length, 2);
  assert.ok(logPage.rows.every(r => r.logScopeProof.present));
  await migration.apply(state.migration_id, logPage);
  await migration.apply(state.migration_id, logPage);
  const logState = await control.site(site);
  const frozen = await ch
    .query({
      query: `SELECT count() AS n FROM ${repairLogSourceRelation()}`,
      query_params: {
        ...hostParameters,
        wh_publication: logState.publication,
        wh_interval_source: [],
        wh_interval_start: [],
        wh_interval_end: [],
      },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ n: string }>());
  assert.equal(frozen[0].n, '1');
  cases.push({
    name: 'migration binds log import scope to published candidates; new repair-scope logs stay outside frozen history',
    status: 'pass',
  });
  await migration.apply(state.migration_id, qualityPage);
  const environmentPage = await source.page('liekan_event_environment');
  await migration.apply(state.migration_id, environmentPage);
  process.env.DATABASE_URL = url.toString();
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  process.env.LIEKAN_CLICKHOUSE_URL = testClickHouseURL;
  process.env.LIEKAN_CLICKHOUSE_DATABASE = run;
  delete process.env.CLICKHOUSE_URL;
  const { warehouseReportMetadata } = await import(
    '../../src/lib/liekan/upstream/warehouse-report-snapshot'
  );
  const {
    warehouseRepairEvents,
    warehouseRepairLogs,
    warehouseRepairUndatedEvents,
    warehouseRepairEvidence,
    warehouseRepairSourceCounts,
  } = await import('../../src/lib/liekan/upstream/warehouse-history-repair-read');
  const sourceMetadata = await warehouseReportMetadata(site);
  const repairRow: any = {
    id: randomUUID(),
    website_id: site,
    generation: randomUUID(),
    batch_size: 2000,
    cursor: {},
    snapshot: {
      timezone: 'UTC',
      rulepack: { hash: 'fixture' },
      warehouseSource: sourceMetadata.boundary,
    },
  };
  const events = await warehouseRepairEvents(repairRow),
    logs = await warehouseRepairLogs(repairRow);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, historical.event);
  assert.equal(events[0].identity_available, false);
  assert.equal(events[0].identity_scope, 'browser_unresolved');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].path, '/frozen');
  assert.equal(logs[0].time, '2026-11-03T00:00:00.000001Z');
  assert.deepEqual(await warehouseRepairUndatedEvents(repairRow), []);
  assert.deepEqual(await warehouseRepairEvidence(repairRow, [historical.event]), []);
  assert.deepEqual(
    await warehouseRepairSourceCounts(repairRow),
    (
      await db.read(
        `SELECT
    (SELECT count(*)::text FROM liekan_event_quality WHERE website_id=$1 AND repair_scope_id IS NULL) AS events,
    (SELECT count(*)::text FROM liekan_effective_log l JOIN liekan_import i ON i.website_id=l.website_id AND i.id=l.import_id WHERE l.website_id=$1 AND i.repair_scope_id IS NULL) AS logs,
    (SELECT count(*)::text FROM website_event e WHERE e.website_id=$1 AND NOT EXISTS(SELECT 1 FROM liekan_event_quality q WHERE q.event_id=e.event_id)) AS missing`,
        [site],
      )
    )[0],
  );
  repairRow.cursor = { time: events[0].time, id: events[0].id };
  assert.deepEqual(await warehouseRepairEvents(repairRow), []);
  await assert.rejects(
    () =>
      warehouseRepairEvents({
        ...repairRow,
        snapshot: {
          ...repairRow.snapshot,
          warehouseSource: { ...sourceMetadata.boundary, deletionRevision: '999' },
        },
      }),
    /冻结后的历史输入/,
  );
  cases.push({
    name: 'frozen repair CH event/log batches, microsecond cursor, unknown identity and source counts agree with PG; changed deletion boundary is rejected',
    status: 'pass',
  });
  await ch.insert({
    table: 'warehouse_deletion',
    format: 'JSONEachRow',
    values: [
      {
        website_id: site,
        epoch: '0',
        revision: '2',
        operation_id: randomUUID(),
        session_id: session,
        version: '100',
        topic_id: successor.topicId,
        partitions: [0, 1],
        offsets: ['20', '20'],
        created_at: '2026-11-03 10:00:00.000000',
      },
    ],
  });
  assert.equal(
    (await landing.receipts({ ...boundary, deletionRevision: '2' }, [oldKey])).length,
    0,
  );
  assert.equal((await landing.receipts({ ...boundary, epoch: '1' }, [oldKey])).length, 0);
  assert.equal((await landing.receipts(boundary, [oldKey])).length, 1);
  cases.push({
    name: 'deletion and reset hide imported version-zero receipts without changing previous boundary',
    status: 'pass',
  });
  console.log(`PASS ${cases.length} formal warehouse control cases`);
} catch (error) {
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
  console.error(error instanceof Error ? error.message : 'Warehouse control test failed');
  process.exitCode = 1;
} finally {
  if (process.env.LIEKAN_CLICKHOUSE_DATABASE === run)
    await (await import('../../src/lib/liekan/warehouse/reader-runtime')).warehouseReader().close();
  await Promise.allSettled([admin.end(), db.close(), source.close(), ch.close(), chAdmin.close()]);
  await mkdir('.local/ch-implementation', { recursive: true, mode: 0o700 });
  await writeFile(
    `.local/ch-implementation/${run}.json`,
    JSON.stringify({ run, cases, fullUpgradeValidated: false }, null, 2),
    { mode: 0o600 },
  );
}
