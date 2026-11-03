import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { sqlStatements } from '../../scripts/liekan-sql-statements.mjs';
import { assertMigrationUpgrade } from '../../scripts/liekan-migration-upgrade-check.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const quote = name => `"${name}"`;
const at = '2026-01-02T01:10:00.000Z';

async function journal(client, schema) {
  return (
    await client.query(
      `SELECT name,checksum,applied_at::text AS "appliedAt" FROM ${quote(schema)}.liekan_migration ORDER BY name`,
    )
  ).rows;
}

async function historical(client, schema, names, migrations) {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL search_path TO ${quote(schema)}`);
    await client.query('SELECT pg_advisory_xact_lock(12800001)');
    await client.query(
      'CREATE TABLE liekan_migration(name text PRIMARY KEY,checksum varchar(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of names) {
      for (const statement of sqlStatements(migrations.get(name).sql))
        await client.query(statement);
      await client.query('INSERT INTO liekan_migration(name,checksum)VALUES($1,$2)', [
        name,
        migrations.get(name).checksum,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function seed(client, schema, history) {
  const ids = {
    owner: randomUUID(),
    site: randomUUID(),
    session: randomUUID(),
    visit: randomUUID(),
    events: [randomUUID(), randomUUID()],
    import: randomUUID(),
    generation: randomUUID(),
  };
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL search_path TO ${quote(schema)}`);
    await client.query(
      `INSERT INTO "user"(user_id,username,password,role)VALUES($1,$2,'synthetic-upgrade-sentinel','user')`,
      [ids.owner, `upgrade-${history}-${ids.owner}`],
    );
    await client.query(
      `INSERT INTO website(website_id,user_id,name,domain)VALUES($1,$2,$3,'upgrade.invalid')`,
      [ids.site, ids.owner, `Synthetic migration upgrade ${history}`],
    );
    await client.query(
      `INSERT INTO session(session_id,website_id,browser,country,created_at)VALUES($1,$2,'Legacy browser','CN',$3)`,
      [ids.session, ids.site, at],
    );
    await client.query(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,event_type,url_path,hostname,created_at)
       SELECT e.id,$1,$2,$3,1,'/synthetic-upgrade','upgrade.invalid',$4::timestamptz+e.i*interval '10 minutes'
       FROM unnest($5::uuid[]) WITH ORDINALITY e(id,i)`,
      [ids.site, ids.session, ids.visit, at, ids.events],
    );
    await client.query(
      `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname)
       SELECT unnest($1::uuid[]),$2,'browser','browser','{synthetic-upgrade}','upgrade-fixture','missing','upgrade.invalid'`,
      [ids.events, ids.site],
    );
    await client.query(
      'INSERT INTO liekan_log_state(website_id)VALUES($1) ON CONFLICT DO NOTHING',
      [ids.site],
    );
    await client.query(
      'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected)VALUES($1,$2,$3,1,0)',
      [ids.import, ids.site, hash(`synthetic-upgrade-${history}`)],
    );
    await client.query(
      `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification)
       VALUES($1,$2,$3,$4,'/synthetic-upgrade','GET',200,12,'synthetic-masked',$5,'Synthetic migration fixture','synthetic','GPTBot','OpenAI','训练','unverified')`,
      [hash(ids.import), ids.site, ids.import, at, hash('synthetic-upgrade-ip')],
    );
    if (history === 'main42') {
      await client.query(
        `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser)
         VALUES($1,$2,'browser','upgrade-identity-v1',true,'Firefox')`,
        [ids.events[0], ids.site],
      );
    } else {
      await client.query(
        `CREATE TABLE liekan_analysis_visit_upgrade_fixture PARTITION OF liekan_analysis_visit
         FOR VALUES FROM ('2026-01-01Z') TO ('2026-02-01Z')`,
      );
      await client.query(
        `INSERT INTO liekan_analysis_generation(website_id,generation,estimated_bytes)VALUES($1,$2,1024)`,
        [ids.site, ids.generation],
      );
      await client.query(
        `INSERT INTO liekan_analysis_visit(website_id,generation,bucket,session_id,visit_id,hostname,dimensions,dimension_key,pageviews,has_custom,min_time,max_time)
         VALUES($1,$2,'2026-01-02T01:00Z',$3,$4,'upgrade.invalid',$5::jsonb,md5($5::jsonb::text),2,false,'2026-01-02T01:20Z','2026-01-02T01:30Z')`,
        [
          ids.site,
          ids.generation,
          ids.session,
          ids.visit,
          JSON.stringify({
            sessionPresent: true,
            browser: 'Legacy browser',
            os: null,
            device: null,
            screen: null,
            language: null,
            country: 'CN',
            region: null,
            city: null,
          }),
        ],
      );
      await client.query(
        `INSERT INTO liekan_analysis_manifest(website_id,epoch,family,bucket,bucket_end,generation,fingerprint,versions,row_count)
         SELECT $1,epoch,'visit','2026-01-02T01:00Z','2026-01-02T02:00Z',$2,
          liekan_analysis_fingerprint($1,epoch,'visit','2026-01-02T01:00Z','2026-01-02T02:00Z'),
          liekan_analysis_versions($1,'analysis-rollups-v1','traffic-quality-browser-source-v2','crawler-qualification-v1'),1
         FROM liekan_analysis_site WHERE website_id=$1`,
        [ids.site, ids.generation],
      );
      const [legacy] = (
        await client.query(
          `SELECT m.versions,
           liekan_analysis_versions($1,'analysis-rollups-v1','traffic-quality-browser-source-v2','crawler-qualification-v1') AS expected
           FROM liekan_analysis_manifest m WHERE m.website_id=$1 AND m.generation=$2`,
          [ids.site, ids.generation],
        )
      ).rows;
      assert.deepEqual(legacy.versions, legacy.expected);
      assert.equal(legacy.versions.engine, 'analysis-rollups-v1');
      assert.equal(legacy.versions.traffic, 'traffic-quality-browser-source-v2');
      assert.equal(legacy.versions.population, 'crawler-qualification-v1');
    }
    await client.query('COMMIT');
    return ids;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function facts(client, schema, ids, history) {
  const output = {};
  for (const [key, table, column, id] of [
    ['owner', 'user', 'user_id', ids.owner],
    ['website', 'website', 'website_id', ids.site],
    ['session', 'session', 'website_id', ids.site],
    ['events', 'website_event', 'website_id', ids.site],
    ['quality', 'liekan_event_quality', 'website_id', ids.site],
    ['logs', 'liekan_log', 'website_id', ids.site],
    ['import', 'liekan_import', 'website_id', ids.site],
    ...(history === 'main42'
      ? [['environment', 'liekan_event_environment', 'website_id', ids.site]]
      : []),
    ...(history === 'feature52'
      ? [
          ['generation', 'liekan_analysis_generation', 'website_id', ids.site],
          ['manifest', 'liekan_analysis_manifest', 'website_id', ids.site],
          ['visit', 'liekan_analysis_visit', 'website_id', ids.site],
        ]
      : []),
  ]) {
    const { rows } = await client.query(
      `SELECT to_jsonb(t)-'eligible_events' AS value FROM ${quote(schema)}.${quote(table)} t WHERE ${quote(column)}=$1 ORDER BY to_jsonb(t)::text`,
      [id],
    );
    assert.ok(rows.length > 0, `Missing ${history} ${key} fixture`);
    output[key] = rows.map(row => row.value);
  }
  return output;
}

async function populationProof(client, schema, ids, history) {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL search_path TO ${quote(schema)}`);
    await client.query('SELECT website_id FROM website WHERE website_id=$1 FOR UPDATE', [ids.site]);
    const { rows } = await client.query(
      `SELECT e.event_id::text,env.browser,coalesce(env.scope='browser' AND env.identity_available,false) AS qualified
       FROM liekan_observed_browser_event e
       LEFT JOIN liekan_event_environment env ON env.website_id=e.website_id AND env.event_id=e.event_id
       WHERE e.website_id=$1 ORDER BY e.created_at,e.event_id`,
      [ids.site],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].browser, history === 'main42' ? 'Firefox' : null);
    assert.equal(rows[0].qualified, history === 'main42');
    assert.equal(rows[1].browser, null);
    assert.equal(rows[1].qualified, false);
    const qualifiedIds = async () => (await client.query(
      'SELECT event_id::text FROM liekan_geographic_website_event WHERE website_id=$1 ORDER BY created_at,event_id',
      [ids.site],
    )).rows.map(row => row.event_id);
    assert.deepEqual(await qualifiedIds(), history === 'main42' ? [ids.events[0]] : []);

    const revision = async () =>
      (
        await client.query(
          `SELECT coalesce((SELECT revision FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1),0)::text AS value`,
          [ids.site],
        )
      ).rows[0].value;
    const fingerprint = async () =>
      (
        await client.query(
          `SELECT liekan_analysis_fingerprint(website_id,epoch,'visit','2026-01-02T01:00Z','2026-01-02T02:00Z') AS value FROM liekan_analysis_site WHERE website_id=$1`,
          [ids.site],
        )
      ).rows[0].value;
    const before = { revision: await revision(), fingerprint: await fingerprint() };
    await client.query(
      `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser)
       VALUES($1,$2,'browser','upgrade-identity-v2',true,'Firefox')`,
      [ids.events[1], ids.site],
    );
    assert.ok(
      BigInt(await revision()) > BigInt(before.revision),
      'Late environment must fence cached results',
    );
    assert.notEqual(
      await fingerprint(),
      before.fingerprint,
      'Environment must dirty the covered visit',
    );
    assert.deepEqual(await qualifiedIds(), history === 'main42' ? ids.events : [ids.events[1]]);
    const after = { revision: await revision(), fingerprint: await fingerprint() };
    await client.query('INSERT INTO liekan_traffic_governance(website_id,revision)VALUES($1,0)', [
      ids.site,
    ]);
    assert.equal(await revision(), after.revision, 'Preview revision zero stays inert');
    assert.equal(await fingerprint(), after.fingerprint, 'Preview preserves coverage');
    await client.query(
      `UPDATE liekan_traffic_governance SET revision=9007199254740993 WHERE website_id=$1`,
      [ids.site],
    );
    const versions = (
      await client.query(
        `SELECT liekan_analysis_versions($1,'upgrade-current','upgrade-current','upgrade-current') AS value`,
        [ids.site],
      )
    ).rows[0].value;
    assert.equal(versions.governance, '9007199254740993');
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM liekan_analysis_visit_guard WHERE website_id=$1',
          [ids.site],
        )
      ).rows[0].n,
      32,
    );
    if (history === 'feature52')
      assert.equal(
        (
          await client.query(
            'SELECT eligible_events::text AS n FROM liekan_analysis_visit WHERE website_id=$1',
            [ids.site],
          )
        ).rows[0].n,
        '0',
      );
    const bindings = (
      await client.query(
        `SELECT proname,proconfig FROM pg_proc WHERE pronamespace=$1::regnamespace
       AND proname=ANY($2::text[]) ORDER BY proname`,
        [
          schema,
          [
            'liekan_analysis_visit_evidence_capture',
            'liekan_analysis_truncate_capture',
            'liekan_analysis_environment_revision_capture',
            'liekan_analysis_governance_capture',
          ],
        ],
      )
    ).rows;
    assert.equal(bindings.length, 4);
    for (const row of bindings)
      assert.ok(
        row.proconfig?.some(
          value =>
            value.startsWith('search_path=') && value.includes(schema) && value.includes('pg_temp'),
        ),
        `${row.proname} must bind its owning schema`,
      );
    await client.query('COMMIT');
    return { rows, before, after, governance: versions.governance, bindings };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Called only by the ordinary owned-container harness, after its fresh migration replay. */
export async function verifyAnalysisUpgradeHistories({ run, env, folder }) {
  const url = new URL(env.DATABASE_URL),
    primary = url.searchParams.get('schema');
  const output = resolve(folder);
  if (
    env.LIEKAN_ANALYSIS_ROLLUPS_TEST !== '1' ||
    env.LIEKAN_ANALYSIS_ROLLUPS_BENCHMARK ||
    env.LIEKAN_ANALYSIS_CAPTURE_BENCHMARK ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '15462' ||
    url.username !== 'analysis_test' ||
    url.pathname !== '/liekan_analysis_rollups_test' ||
    !/^analysis_[a-f0-9]{32}$/.test(primary || '') ||
    output !== resolve(env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT) ||
    !/^[-a-f0-9]{36}$/.test(output.slice(resolve(root, '.local/analysis-rollups').length + 1)) ||
    !output.startsWith(resolve(root, '.local/analysis-rollups') + '/') ||
    typeof run !== 'function'
  )
    throw new Error('owned-analysis-upgrade-harness-required');
  const declared = JSON.parse(
    await readFile(resolve(root, 'config/liekan/migrations.json'), 'utf8'),
  );
  const names = (await readdir(resolve(root, 'db/liekan/migrations')))
    .filter(name => name.endsWith('.sql'))
    .sort();
  assert.deepEqual(names, Object.keys(declared).sort());
  assert.ok(names.includes('047_analytics_browser_population.sql'));
  const migrations = new Map();
  for (const name of names) {
    const sql = await readFile(resolve(root, 'db/liekan/migrations', name), 'utf8');
    assert.equal(hash(sql), declared[name], `Immutable SQL checksum differs: ${name}`);
    migrations.set(name, { sql, checksum: declared[name] });
  }
  const histories = [
    {
      name: 'main42',
      count: 42,
      files: names.filter(name => name < '036_' || name === '037_browser_population.sql'),
    },
    {
      name: 'feature52',
      count: 52,
      files: names.filter(name => name < '047_' && name !== '037_browser_population.sql'),
    },
  ];
  url.searchParams.delete('schema');
  const client = new Client({ connectionString: url.toString() });
  const created = new Set(),
    report = { status: 'running', histories: [], cleanup: [] };
  let failure,
    connected = false,
    stage = 'connect';
  try {
    await client.connect();
    connected = true;
    await client.query("SET statement_timeout='30s'");
    const fresh = await journal(client, primary);
    assertMigrationUpgrade([], fresh, declared);
    report.fresh = { migrations: fresh.length, journalHash: hash(JSON.stringify(fresh)) };
    for (const history of histories) {
      assert.equal(history.files.length, history.count);
      const schema = `analysis_${randomBytes(16).toString('hex')}`;
      assert.notEqual(schema, primary);
      stage = `${history.name}:create`;
      await client.query(`CREATE SCHEMA ${quote(schema)}`);
      created.add(schema);
      const scoped = new URL(env.DATABASE_URL);
      scoped.searchParams.set('schema', schema);
      const scopedEnv = { ...env, DATABASE_URL: scoped.toString() };
      await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env: scopedEnv });
      stage = `${history.name}:historical-setup`;
      await historical(client, schema, history.files, migrations);
      const ids = await seed(client, schema, history.name);
      const before = await facts(client, schema, ids, history.name);
      const oldJournal = await journal(client, schema);
      assert.equal(oldJournal.length, history.count);
      stage = `${history.name}:candidate-upgrade`;
      await run('node', ['scripts/liekan-migrate.mjs'], { env: scopedEnv });
      const upgraded = await journal(client, schema);
      assertMigrationUpgrade(oldJournal, upgraded, declared);
      assert.deepEqual(
        await facts(client, schema, ids, history.name),
        before,
        `${history.name} original facts changed`,
      );
      const proof = await populationProof(client, schema, ids, history.name);
      const afterProbe = await facts(client, schema, ids, history.name);
      stage = `${history.name}:candidate-replay`;
      await run('node', ['scripts/liekan-migrate.mjs'], { env: scopedEnv });
      assert.deepEqual(await journal(client, schema), upgraded);
      assert.deepEqual(await facts(client, schema, ids, history.name), afterProbe);
      report.histories.push({
        history: history.name,
        schema,
        before: oldJournal.length,
        after: upgraded.length,
        originalFactsHash: hash(JSON.stringify(before)),
        replayFactsHash: hash(JSON.stringify(afterProbe)),
        proof,
      });
    }
    assert.deepEqual(await journal(client, primary), fresh, 'Primary fresh schema changed');
    report.status = 'passed';
  } catch (error) {
    failure = error;
    report.status = 'failed';
    report.failure = {
      stage,
      name: error.name,
      code: error.code,
      message: error.message,
      stack: error.stack,
    };
  } finally {
    if (connected) {
      await client.query('ROLLBACK').catch(() => {});
      for (const schema of created) {
        try {
          await client.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
          report.cleanup.push({ schema, removed: true });
        } catch (error) {
          failure ||= error;
          report.status = 'failed';
          report.cleanup.push({ schema, removed: false, code: error.code, message: error.message });
        }
      }
      await client.end();
    }
    await writeFile(`${output}/migration-upgrade-histories.json`, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
  }
  if (failure)
    throw new Error(
      `Migration upgrade ${stage} failed; protected evidence: ${output}/migration-upgrade-histories.json`,
      { cause: failure },
    );
  return report;
}
