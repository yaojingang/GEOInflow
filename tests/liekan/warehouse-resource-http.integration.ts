// Preserve link/pixel collection through the installed HTTP -> queue -> verified
// publication path. Only the independently restored synthetic installation runs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
assert.equal(process.env.WAREHOUSE_DOCKER_TEST, 'isolated-new-project');
const directory = '.local/ch-deploy-validation';
const recovery = JSON.parse(await readFile(`${directory}/recovery.json`, 'utf8'));
assert.ok(recovery.steps.verify?.passed);
const env = Object.fromEntries(
  (await readFile(`${directory}/private.env`, 'utf8'))
    .split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const n = l.indexOf('=');
      return [l.slice(0, n), l.slice(n + 1)];
    }),
);
const db = new pg.Client({
  host: '127.0.0.1',
  port: 25479,
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DB,
  options: '-c default_transaction_read_only=on -c statement_timeout=5000',
});
const report: any = { cases: [] };
let token = '';
async function post(path: string, body: object, authenticated = true) {
  const r = await fetch(`http://127.0.0.1:3002${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
try {
  await db.connect();
  assert.equal(
    (await db.query('SELECT installation_id FROM liekan_warehouse_installation WHERE id=1')).rows[0]
      .installation_id,
    recovery.initial.installation_id,
  );
  const login = await post('/api/auth/login', { username: 'admin', password: 'liekan' }, false);
  assert.equal(login.status, 200);
  token = login.body.token;
  for (const kind of ['link', 'pixel']) {
    const id = randomUUID();
    const created = await post(`/api/${kind}s`, {
      id,
      name: `Isolated ${kind} publication`,
      slug: randomUUID(),
      ...(kind === 'link' ? { url: 'https://fixture.invalid/' } : {}),
    });
    assert.equal(created.status, 200);
    const event = await post(
      '/api/send',
      {
        type: 'event',
        payload: {
          [kind]: id,
          hostname: 'fixture.invalid',
          url: '/resource-publication',
          language: 'en-US',
          screen: '1920x1080',
        },
      },
      false,
    );
    assert.equal(event.status, 200, `${kind} accepted`);
    assert.ok(event.body.sessionId);
    const start = Date.now();
    let published = false;
    while (Date.now() - start < 30000) {
      const rows = (
        await db.query(
          `SELECT manifest FROM liekan_warehouse_publication WHERE website_id=$1 AND status='published'`,
          [id],
        )
      ).rows;
      if (
        rows.some(r =>
          r.manifest.some((e: any) => e.family === 'website_event' && e.rowCount === '1'),
        )
      ) {
        published = true;
        break;
      }
      await delay(200);
    }
    assert.ok(published, `${kind} must publish a verified event, not only acknowledge it`);
    assert.equal((await db.query('SELECT 1 FROM website WHERE website_id=$1', [id])).rowCount, 0);
    assert.equal(
      (await db.query('SELECT 1 FROM website_event WHERE website_id=$1', [id])).rowCount,
      0,
    );
    report.cases.push({
      name: `${kind} HTTP collection publishes verified CH facts without a website row or PG event`,
      status: 'pass',
    });
  }
} catch (error) {
  report.cases.push({
    status: 'failed',
    error: error instanceof Error ? error.message : 'unknown',
  });
  process.exitCode = 1;
} finally {
  await db.end();
  await writeFile(`${directory}/resource-http-report.json`, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
