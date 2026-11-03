import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { digest, type Event, fault, OUTPUT, Prototype, ROUND2 } from './core.ts';

export const DATA_RUN = 'proto_round2_backup';
/** Connect exclusively to the new restored clone, never to configured application databases. */
export async function sourceClient() {
  assert.ok(ROUND2);
  const restored = JSON.parse(await readFile(resolve(OUTPUT, 'restore-evidence.json'), 'utf8'));
  assert.equal(restored.evidence.database, 'liekan_source_round2');
  assert.equal(restored.readOnlyRole, 'r2_reader');
  const c = new pg.Client({
    host: '127.0.0.1',
    port: 25449,
    user: 'r2_reader',
    database: 'liekan_source_round2',
    password: (await readFile(resolve(OUTPUT, 'pg-password'), 'utf8')).trim(),
    application_name: 'liekan_round2_readonly',
  });
  await c.connect();
  await c.query('SET max_parallel_workers_per_gather=0');
  await c.query("SET statement_timeout='300s'");
  assert.equal(
    (await c.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,
    'on',
  );
  return c;
}

/** Create experiment-only targets; production schemas and clone rows remain untouched. */
export async function prepareData(p: Prototype, namespace: 'r2' | 'r3' = 'r2') {
  assert.ok(['r2', 'r3'].includes(namespace));
  await p.pool.query(`CREATE TABLE IF NOT EXISTS ${namespace}_page(kind text,cursor text,rows int,hash text,candidate text,PRIMARY KEY(kind,cursor));
    CREATE TABLE IF NOT EXISTS ${namespace}_facts(kind text,id text,site text,session text,occurred text,path text,status int,bytes bigint,
      ai int,eligible int,scope text,classification text,rule text,epoch int,version int,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS ${namespace}_fence(site text PRIMARY KEY,epoch int NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS ${namespace}_delete(site text,session text,version int,PRIMARY KEY(site,session));`);
  const table = namespace === 'r2' ? 'backup_facts' : 'proof_facts';
  await p.ch.command({
    query: `CREATE TABLE IF NOT EXISTS liekan_ch_proto.${table}(
    kind LowCardinality(String), id String, site String, session String, occurred DateTime64(3,'UTC'),path String,
    status Nullable(UInt16),bytes UInt64,ai UInt8,eligible UInt8,scope LowCardinality(String),classification LowCardinality(String),
    rule String,epoch UInt32,version UInt64,candidate String)
    ENGINE=MergeTree PARTITION BY toYYYYMM(occurred) ORDER BY (kind,site,occurred,id,candidate)
    SETTINGS fsync_after_insert=1,fsync_part_directory=1`,
  });
  // Verification addresses one newly written candidate; skip parts that cannot contain it.
  await p.ch.command({
    query: `ALTER TABLE liekan_ch_proto.${table} ADD INDEX IF NOT EXISTS candidate_bloom candidate TYPE bloom_filter(0.001) GRANULARITY 1`,
  });
}

/** Publish a verified immutable page and all reference sub-batches in one transaction.
 * A recovered commit returns the original candidate; conflicting source content is rejected.
 */
export async function commitBackfillPage(
  p: Pick<Prototype, 'tx'>,
  page: { kind: string; cursor: string; candidate: string; hash: string; values: any[] },
  namespace: 'r2' | 'r3' = 'r2',
) {
  assert.ok(['r2', 'r3'].includes(namespace));
  return p.tx(async tx => {
    // A page has one publisher, including when a caller retries an uncertain COMMIT.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `${namespace}:${page.kind}:${page.cursor}`,
    ]);
    const old = (
      await tx.query(`SELECT * FROM ${namespace}_page WHERE kind=$1 AND cursor=$2`, [
        page.kind,
        page.cursor,
      ])
    ).rows[0];
    if (old) {
      assert.equal(old.hash, page.hash, 'backfill source changed');
      assert.equal(old.rows, page.values.length, 'backfill page size changed');
      return old.candidate as string;
    }
    for (let offset = 0; offset < page.values.length; offset += 5000) {
      await tx.query(
        `INSERT INTO ${namespace}_facts SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text,site text,session text,occurred text,path text,status int,bytes bigint,
        ai int,eligible int,scope text,classification text,rule text,epoch int,version int) ON CONFLICT DO NOTHING`,
        [JSON.stringify(page.values.slice(offset, offset + 5000))],
      );
      await fault('after_backfill_subbatch');
    }
    await tx.query(`INSERT INTO ${namespace}_page VALUES($1,$2,$3,$4,$5)`, [
      page.kind,
      page.cursor,
      page.values.length,
      page.hash,
      page.candidate,
    ]);
    await tx.query(
      `INSERT INTO ${namespace}_fence(site) SELECT DISTINCT unnest($1::text[]) ON CONFLICT DO NOTHING`,
      [[...new Set(page.values.map(r => r.site))]],
    );
    await fault('before_backfill_commit');
    return page.candidate;
  });
}

/** Open a read-only ordered stream; one view expansion serves all fetch batches.
 * The durable cursor is the last published source ID, so a reconnect resumes with a keyset bound.
 */
async function openSourceCursor(c: pg.Client, kind: string, cursor: string, salt: string) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query('SET LOCAL cursor_tuple_fraction=1');
  await c.query("SET LOCAL work_mem='16MB'");
  const sql =
    kind === 'log'
      ? `SELECT l.id AS cursor,'log' AS kind,md5($2||l.id) AS id,md5($2||l.website_id::text) AS site,
    md5($2||coalesce(l.ip_hash,l.id)) AS session,to_char(l.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.MS') AS occurred,
    md5($2||l.path) AS path,l.status,coalesce(l.bytes,0)::text AS bytes,
    CASE WHEN l.ai_eligible THEN 1 ELSE 0 END AS ai,1 AS eligible,'log' AS scope,coalesce(l.recognition_state,'unknown') AS classification,
    coalesce(l.verification_version,'unknown') AS rule,1 AS epoch,1 AS version
    FROM liekan_reporting_log l WHERE l.id>$1 ORDER BY l.id`
      : `SELECT e.event_id::text AS cursor,'browser' AS kind,md5($2||e.event_id::text) AS id,md5($2||e.website_id::text) AS site,
    md5($2||e.session_id::text) AS session,to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.MS') AS occurred,
    md5($2||coalesce(e.url_path,'')) AS path,0 AS status,'0' AS bytes,0 AS ai,
    CASE WHEN v.event_id IS NULL THEN 0 ELSE 1 END AS eligible,coalesce(env.scope,'unknown') AS scope,
    coalesce(q.classification,'unknown') AS classification,coalesce(q.rule_version,'unknown') AS rule,1 AS epoch,1 AS version
    FROM website_event e LEFT JOIN liekan_effective_browser_event v ON v.event_id=e.event_id AND v.website_id=e.website_id
    LEFT JOIN liekan_event_environment env ON env.event_id=e.event_id
    LEFT JOIN liekan_reporting_event_quality q ON q.event_id=e.event_id
    WHERE e.event_id>coalesce(nullif($1,''),'00000000-0000-0000-0000-000000000000')::uuid ORDER BY e.event_id`;
  await c.query(`DECLARE source_rows NO SCROLL CURSOR FOR ${sql}`, [cursor, salt]);
}

/** Backfill immutable pages; publish the candidate and comparison rows in one PG transaction. */
export async function backfill(p: Prototype, onlyKind?: string) {
  const c = await sourceClient();
  const salt = (await readFile(resolve(OUTPUT, 'pg-password'), 'utf8')).trim();
  try {
    for (const kind of onlyKind ? [onlyKind] : ['log', 'browser']) {
      let cursor =
        (
          await p.pool.query(
            'SELECT cursor FROM r2_page WHERE kind=$1 ORDER BY cursor DESC LIMIT 1',
            [kind],
          )
        ).rows[0]?.cursor ?? '';
      await openSourceCursor(c, kind, cursor, salt);
      while (true) {
        const source = (await c.query('FETCH FORWARD 50000 FROM source_rows')).rows;
        if (!source.length) break;
        const next = source.at(-1).cursor,
          candidate = randomUUID();
        const values = source.map(({ cursor: _cursor, ...r }) => r);
        const hash = digest(values);
        if (values.length)
          await p.ch.insert({
            table: 'liekan_ch_proto.backup_facts',
            values: values.map(r => ({ ...r, candidate })),
            format: 'JSONEachRow',
          });
        const roundtrip = await p.rows(
          `SELECT kind,id,site,session,formatDateTime(occurred,'%Y-%m-%d %H:%i:%S.%f') occurred,path,status,bytes,
          ai,eligible,scope,classification,rule,epoch,version FROM liekan_ch_proto.backup_facts WHERE candidate={candidate:String} ORDER BY id`,
          { candidate },
        );
        // DateTime64 formatting varies by fractional width; compare canonical millisecond text.
        const canonical = (rows: any[]) =>
          rows
            .map(r => ({
              ...r,
              occurred: r.occurred.slice(0, 23),
              bytes: String(r.bytes),
              version: Number(r.version),
            }))
            .sort((a, b) => a.id.localeCompare(b.id));
        assert.equal(
          digest(canonical(roundtrip)),
          digest(canonical(values)),
          'CH page differs from restored source',
        );
        await fault('after_backfill_page');
        await commitBackfillPage(p, { kind, cursor: next, values, hash, candidate });
        cursor = next;
        console.log(`PAGE ${kind} ${values.length}`);
      }
      await c.query('CLOSE source_rows');
      await c.query('COMMIT');
    }
  } finally {
    await c.end();
  }
}

/** Obtain real-data samples for protocol fault tests with no original identifiers or URLs. */
export async function samples(p: Prototype): Promise<Event[]> {
  const rows = (
    await p.pool.query(`SELECT DISTINCT ON(kind,site) * FROM r2_facts ORDER BY kind,site,id`)
  ).rows;
  return rows.map((r, i) => ({
    id: `sample_${i}_${r.id}`,
    uuid: `receipt_${r.id}`,
    site: r.site,
    session: r.session,
    visit: `visit_${r.id}`,
    path: r.path,
    cents: 0,
    properties: { status: String(r.status) },
    kind: r.kind,
    source: r.kind === 'log' ? 'server_log' : 'browser',
    scope: r.scope,
    policyVersion: 1,
    occurredAt: r.occurred,
  }));
}

if (process.argv[1]?.endsWith('round2-data.ts')) {
  const p = new Prototype(DATA_RUN);
  try {
    await p.connect();
    await prepareData(p);
    await backfill(p, process.argv[2]);
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'backfill failed');
    process.exitCode = 1;
  } finally {
    await p.disconnect();
  }
}
