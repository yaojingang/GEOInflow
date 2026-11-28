import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Prototype, OUTPUT, PROJECT, ROUND2, delay } from './core.ts';
import { DATA_RUN, prepareData } from './round2-data.ts';

assert.ok(ROUND2);
let p = new Prototype(DATA_RUN);
const report: any = {
  started: new Date().toISOString(),
  scope: 'frozen backup projection backfill and resume, not live production cutover',
};
const children = new Set<ChildProcess>();
const exec = promisify(execFile),
  id = `backfill_${Date.now()}`;

/** Launch the bounded importer with an optional externally controlled crash boundary. */
function launch(crash = false) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      resolve('experiments/ch-prototype/node_modules/tsx/dist/loader.mjs'),
      'experiments/ch-prototype/round2-data.ts',
    ],
    {
      env: {
        ...process.env,
        PROTO_ROUND: '2',
        PROTO_ACTOR_ID: id,
        PROTO_FAULT: crash ? 'after_backfill_page' : '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  child.stdout.on('data', b => process.stdout.write(b));
  let error = '';
  child.stderr.on('data', b => {
    error += b.toString();
  });
  const ended = new Promise<{ code: number | null; signal: string | null }>(r =>
    child.once('exit', (code, signal) => {
      children.delete(child);
      r({ code, signal });
    }),
  );
  return { child, ended, error: () => error };
}
try {
  await p.connect();
  await prepareData(p);
  const before = (await p.pool.query('SELECT count(*)::int n FROM r2_page')).rows[0].n;
  const job = launch(true);
  let hit = false;
  for (let i = 0; i < 1200; i++) {
    hit = await readFile(resolve(OUTPUT, `fault-${id}-after_backfill_page.json`)).then(
      () => true,
      () => false,
    );
    if (hit) break;
    if (job.child.exitCode !== null)
      throw new Error(job.error() || 'backfill ended before crash point');
    await delay(500);
  }
  assert.ok(hit, 'backfill never reached durable CH page');
  job.child.kill('SIGKILL');
  assert.equal((await job.ended).signal, 'SIGKILL');
  assert.equal((await p.pool.query('SELECT count(*)::int n FROM r2_page')).rows[0].n, before);
  report.crash = { signal: 'SIGKILL', beforePublishedPages: before, afterPublishedPages: before };
  await p.disconnect();
  const name = `${PROJECT}-pg-1`,
    state = JSON.parse((await exec('docker', ['inspect', name])).stdout)[0];
  assert.equal(state.Config.Labels['com.docker.compose.project'], PROJECT);
  await exec('docker', ['restart', name], { timeout: 60000 });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    const result = await exec('docker', [
      'exec',
      name,
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-U',
      'liekan_ch_proto',
      '-d',
      'liekan_ch_proto',
    ]).then(
      () => true,
      () => false,
    );
    if (result) {
      ready = true;
      break;
    }
    await delay(500);
  }
  assert.ok(ready, 'clone did not restart');
  p = new Prototype(DATA_RUN);
  await p.connect();
  report.cloneRestarted = true;
  const resumed = launch();
  const result = await resumed.ended;
  assert.equal(result.code, 0, resumed.error());
  const pages = (
    await p.pool.query(
      'SELECT kind,count(*)::int pages,sum(rows)::text rows FROM r2_page GROUP BY kind ORDER BY kind',
    )
  ).rows;
  const candidates = (await p.pool.query('SELECT candidate FROM r2_page')).rows.map(
    r => r.candidate,
  );
  const physical = Number(
    (await p.rows('SELECT count() n FROM liekan_ch_proto.backup_facts'))[0].n,
  );
  const published = Number(
    (
      await p.rows(
        'SELECT count() n FROM liekan_ch_proto.backup_facts WHERE candidate IN {ids:Array(String)}',
        { ids: candidates },
      )
    )[0].n,
  );
  assert.ok(physical > published, 'unpublished failed candidate must remain physically present');
  assert.equal(
    published,
    pages.reduce((n, r) => n + Number(r.rows), 0),
  );
  report.pages = pages;
  report.physicalRows = physical;
  report.publishedRows = published;
  report.failedCandidateRows = physical - published;
  report.status = 'pass';
} catch (e) {
  report.status = 'fail';
  report.error = e instanceof Error ? e.message : String(e);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGKILL');
  await p.disconnect();
  report.completed = new Date().toISOString();
  await writeFile(resolve(OUTPUT, 'round2-backfill-report.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
}
