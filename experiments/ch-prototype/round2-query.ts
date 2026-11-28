import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Prototype, OUTPUT, ROUND2, digest } from './core.ts';
import { DATA_RUN, sourceClient } from './round2-data.ts';

assert.ok(ROUND2);
const p = new Prototype(DATA_RUN);
const report: any = {
  started: new Date().toISOString(),
  tests: [],
  scope: 'restored backup projection; local warm-cache measurements, not target-scale acceptance',
};
let deletionTarget: { site: string; session: string } | undefined;

/** Compare ordered SQL outputs; both engines do filtering and aggregation themselves. */
async function compare(name: string, select: string, group = '', limit = '') {
  const pages = (await p.pool.query('SELECT candidate FROM r2_page ORDER BY kind,cursor')).rows.map(
    r => r.candidate,
  );
  const deletions = (await p.pool.query('SELECT * FROM r2_delete')).rows;
  const epochs = (await p.pool.query('SELECT * FROM r2_fence')).rows;
  const pgSql = `SELECT ${select} FROM r2_facts f JOIN r2_fence s ON s.site=f.site AND s.epoch=f.epoch
    WHERE eligible=1 AND NOT EXISTS (SELECT 1 FROM r2_delete d WHERE d.site=f.site AND d.session=f.session AND f.version<=d.version) ${group} ${limit}`;
  const chSql = `SELECT ${select} FROM liekan_ch_proto.backup_facts f
    WHERE eligible=1 AND candidate IN {pages:Array(String)}
    AND has(arrayZip({sites:Array(String)},{epochs:Array(UInt32)}),(site,epoch))
    AND NOT arrayExists((ds,dss,dv)->ds=f.site AND dss=f.session AND f.version<=dv,{ds:Array(String)},{dss:Array(String)},{dv:Array(UInt64)}) ${group} ${limit}`;
  const timings = { pg: [] as number[], ch: [] as number[] };
  let output: any;
  // SELECT aliases use simple integer aggregates; normalize driver integer representations.
  const canonical = (rows: any[]) =>
    rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])));
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const pgRows = canonical((await p.pool.query(pgSql)).rows);
    timings.pg.push(performance.now() - start);
    const chStart = performance.now();
    const chRows = canonical(
      await p.rows(chSql, {
        pages,
        sites: epochs.map(e => e.site),
        epochs: epochs.map(e => e.epoch),
        ds: deletions.map(d => d.site),
        dss: deletions.map(d => d.session),
        dv: deletions.map(d => d.version),
      }),
    );
    timings.ch.push(performance.now() - chStart);
    assert.deepEqual(chRows, pgRows, `${name} output mismatch`);
    output = { rows: pgRows.length, hash: digest(pgRows) };
  }
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      samplesMs: values.map(Math.round),
      p50Ms: Math.round(sorted[2]),
      maxMs: Math.round(sorted[4]),
    };
  };
  report.tests.push({ name, status: 'pass', output, pg: stats(timings.pg), ch: stats(timings.ch) });
  console.log(`PASS ${name}`);
}

try {
  await p.connect();
  const c = await sourceClient();
  try {
    const baseline = (
      await c.query(`SELECT 'log' AS kind,count(*)::text n,coalesce(sum(bytes),0)::text bytes,
      count(*) FILTER(WHERE ai_eligible)::text ai FROM liekan_reporting_log UNION ALL
      SELECT 'browser',count(*)::text,'0','0' FROM liekan_effective_browser_event ORDER BY kind`)
    ).rows;
    const projected = (
      await p.pool.query(
        `SELECT k.kind,count(f.id)::text n,coalesce(sum(f.bytes),0)::text bytes,coalesce(sum(f.ai),0)::text ai
         FROM (VALUES ('log'),('browser')) k(kind) LEFT JOIN r2_facts f ON f.kind=k.kind AND f.eligible=1
         GROUP BY k.kind ORDER BY k.kind`,
      )
    ).rows;
    assert.deepEqual(projected, baseline);
    report.sourceBaseline = baseline;
    report.rawCounts = (
      await c.query(
        "SELECT 'liekan_log' AS table_name,count(*)::text n FROM liekan_log UNION ALL SELECT 'website_event',count(*)::text FROM website_event",
      )
    ).rows;
    report.scopeCounts = (
      await p.pool.query(
        'SELECT kind,scope,classification,rule,eligible,count(*)::text n FROM r2_facts GROUP BY kind,scope,classification,rule,eligible ORDER BY kind,scope,classification,rule,eligible',
      )
    ).rows;
    report.readOnly = (await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    await assert.rejects(
      () => c.query('CREATE TABLE public.must_not_write_round2(id int)'),
      /read.only|permission denied/,
    );
  } finally {
    await c.end();
  }
  report.rows = (
    await p.pool.query('SELECT kind,count(*)::text n FROM r2_facts GROUP BY kind ORDER BY kind')
  ).rows;
  report.pages = (await p.pool.query('SELECT count(*)::int n FROM r2_page')).rows[0].n;
  await p.pool.query('ANALYZE r2_facts; ANALYZE r2_fence; ANALYZE r2_delete');
  assert.equal(
    (await p.pool.query('SELECT count(*)::int n FROM r2_fence WHERE epoch<>1')).rows[0].n,
    0,
  );
  assert.equal((await p.pool.query('SELECT count(*)::int n FROM r2_delete')).rows[0].n, 0);
  await compare(
    'qualified totals by event family',
    'kind,count(*) AS n,sum(bytes) AS bytes,sum(ai) AS ai',
    'GROUP BY kind ORDER BY kind',
  );
  await compare(
    'full path ranking with publication and quality filters',
    'kind,path,count(*) AS n',
    'GROUP BY kind,path ORDER BY n DESC,kind,path',
    'LIMIT 30',
  );
  await compare(
    'daily site totals',
    'kind,f.site AS site,substring(CAST(occurred AS text),1,10) AS day,count(*) AS n',
    'GROUP BY kind,f.site,day ORDER BY kind,site,day',
  );
  const target = (
    await p.pool.query(
      `SELECT site,session FROM r2_facts WHERE eligible=1 AND site IN
       (SELECT site FROM r2_facts WHERE eligible=1 GROUP BY site HAVING count(DISTINCT session)>1)
       ORDER BY site,session LIMIT 1`,
    )
  ).rows[0];
  assert.ok(target, 'deletion scenario needs an eligible source fact');
  deletionTarget = target;
  report.deletedRows = Number(
    (
      await p.pool.query(
        'SELECT count(*)::text n FROM r2_facts WHERE eligible=1 AND site=$1 AND session=$2',
        [target.site, target.session],
      )
    ).rows[0].n,
  );
  assert.ok(report.deletedRows > 0);
  await p.pool.query('INSERT INTO r2_delete VALUES($1,$2,1) ON CONFLICT DO NOTHING', [
    target.site,
    target.session,
  ]);
  await compare(
    'session deletion excludes old versions in SQL',
    'kind,count(*) AS n,sum(bytes) AS bytes,sum(ai) AS ai',
    'GROUP BY kind ORDER BY kind',
  );
  await p.pool.query('UPDATE r2_fence SET epoch=2 WHERE site=$1', [target.site]);
  report.resetAdditionalRows = Number(
    (
      await p.pool.query(
        'SELECT count(*)::text n FROM r2_facts WHERE eligible=1 AND site=$1 AND session<>$2',
        [target.site, target.session],
      )
    ).rows[0].n,
  );
  assert.ok(report.resetAdditionalRows > 0, 'reset must exercise additional facts beyond deletion');
  await compare(
    'site reset filters old epoch in SQL',
    'kind,count(*) AS n,sum(bytes) AS bytes,sum(ai) AS ai',
    'GROUP BY kind ORDER BY kind',
  );
  await p.pool.query('UPDATE r2_fence SET epoch=1 WHERE site=$1', [target.site]);
  await p.pool.query('DELETE FROM r2_delete WHERE site=$1 AND session=$2', [
    target.site,
    target.session,
  ]);
  report.storage = (
    await p.rows(
      "SELECT table,sum(rows) AS rows,sum(bytes_on_disk) AS disk_bytes,sum(data_compressed_bytes) AS compressed_bytes FROM system.parts WHERE active AND database='liekan_ch_proto' AND table='backup_facts' GROUP BY table",
    )
  )[0];
  report.summary = { passed: report.tests.length, failed: 0 };
} catch (e) {
  report.error = e instanceof Error ? e.message : String(e);
  report.summary = { passed: report.tests.length, failed: 1 };
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (deletionTarget) {
    await p.pool.query('UPDATE r2_fence SET epoch=1 WHERE site=$1', [deletionTarget.site]);
    await p.pool.query('DELETE FROM r2_delete WHERE site=$1 AND session=$2', [
      deletionTarget.site,
      deletionTarget.session,
    ]);
  }
  await p.disconnect();
  report.completed = new Date().toISOString();
  await writeFile(resolve(OUTPUT, 'round2-query-report.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
}
