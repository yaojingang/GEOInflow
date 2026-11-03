import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';

export async function verifyBudgetedAnalyticsWorker({
  root,
  env,
  folder,
  run,
  id,
  label,
  afterPublish,
}) {
  await run(process.execPath, ['scripts/liekan-queue-bootstrap.mjs']);
  const url = new URL(env.DATABASE_URL),
    schema = url.searchParams.get('schema');
  assert.match(schema, /^engine_[a-f0-9]{32}$/);
  url.searchParams.delete('schema');
  const pg = new Client({ connectionString: url.toString() });
  const name = `liekan-engine-worker-${id}`;
  try {
    await pg.connect();
    await pg.query(`SET search_path TO "${schema}"`);
    const {
      rows: [source],
    } = await pg.query('SELECT website_id,import_id FROM liekan_log LIMIT 1');
    assert(source);
    await pg.query(
      `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
      SELECT md5($1||g),$2::uuid,$3::uuid,'2026-01-01T02:15:00Z','/worker-smoke','GET',200,0,'','','Synthetic-Worker-Smoke/1.0','','GPTBot','Synthetic fixture','训练','verified_range',true,'recognized' FROM generate_series(1,6000) g`,
      [id, source.website_id, source.import_id],
    );
    const dockerEnv = {
      ...env,
      DATABASE_URL: env.DATABASE_URL,
      LIEKAN_ANALYTICS_CLICKHOUSE_URL: env.LIEKAN_ANALYTICS_CLICKHOUSE_URL,
      LIEKAN_ANALYTICS_ENGINE_TEST: '1',
      NODE_ENV: 'production',
    };
    const envFile = `${folder}/worker.env`;
    const keys = [
      'DATABASE_URL',
      'LIEKAN_ANALYTICS_CLICKHOUSE_URL',
      'APP_SECRET',
      'NODE_ENV',
      'REDIS_URL',
      'LIEKAN_ANALYTICS_REDIS_URL',
      'CLICKHOUSE_URL',
      'DATABASE_REPLICA_URL',
      'LIEKAN_ANALYTICS_ENGINE_TEST',
    ];
    await writeFile(envFile, keys.map(key => `${key}=${dockerEnv[key] || ''}`).join('\n'), {
      mode: 0o600,
    });
    await run('docker', [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `${label}=${id}`,
      '--cpus',
      '1',
      '--memory',
      '512m',
      '--env-file',
      envFile,
      '--mount',
      `type=bind,src=${root.replace(/\/$/, '')},dst=/app,readonly`,
      '--workdir',
      '/app',
      'node:22.23.3-alpine',
      'node',
      'tests/liekan/analytics-engine.worker-runtime.mjs',
    ]);
    const started = Date.now();
    let published = false;
    while (Date.now() - started < 120000) {
      const {
        rows: [unit],
      } = await pg.query(
        "SELECT row_count::text,verified_at FROM liekan_analytics_engine_unit WHERE website_id=$1::uuid AND bucket='2026-01-01T02:00:00Z'",
        [source.website_id],
      );
      if (unit?.row_count === '6000' && unit.verified_at) {
        published = true;
        break;
      }
      const state = await run('docker', ['inspect', '--format', '{{json .State}}', name]);
      assert.equal(JSON.parse(state.output).Running, true, 'Budgeted worker must remain running');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(published, true, 'Actual worker must publish the 6000-row multi-chunk fixture');
    await afterPublish?.();
    const state = JSON.parse(
      (await run('docker', ['inspect', '--format', '{{json .State}}', name])).output,
    );
    assert.equal(state.OOMKilled, false);
    const stats = (
      await run('docker', ['stats', '--no-stream', '--format', '{{json .}}', name])
    ).output.trim();
    await writeFile(
      `${folder}/worker-smoke.json`,
      JSON.stringify(
        {
          passed: true,
          rows: 6000,
          cpuLimit: 1,
          memoryMiB: 512,
          oomKilled: state.OOMKilled,
          elapsedMs: Date.now() - started,
          stats: JSON.parse(stats),
        },
        null,
        2,
      ),
    );
    console.log('Actual analytics worker passed: 6000 rows, 1 CPU / 512 MiB, no OOM');
  } finally {
    await pg.end();
    const inspection = await run(
      'docker',
      ['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name],
      { optional: true, cleanup: true },
    );
    if (!inspection.code && inspection.output.trim() === id) {
      const logs = await run('docker', ['logs', name], { optional: true, cleanup: true });
      await writeFile(`${folder}/worker.log`, logs.output, { mode: 0o600 });
      await run('docker', ['rm', '-fv', name], { optional: true, cleanup: true });
    }
  }
}
