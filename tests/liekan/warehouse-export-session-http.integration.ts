// Installed HTTP acceptance for browser export-cookie lifetime. Only the owned
// recovered synthetic installation is selected; no production credentials.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';

assert.equal(process.env.WAREHOUSE_DOCKER_TEST, 'isolated-new-project');
const directory = '.local/ch-deploy-validation';
const recovery = JSON.parse(await readFile(`${directory}/recovery.json`, 'utf8'));
assert.ok(recovery.steps.verify?.passed);
const env = Object.fromEntries(
  (await readFile(`${directory}/private.env`, 'utf8'))
    .split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const equal = line.indexOf('=');
      return [line.slice(0, equal), line.slice(equal + 1)];
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
const report: { cases: object[]; failed?: string } = { cases: [] };
const base = 'http://127.0.0.1:3002';
const site = randomUUID();
let token: string,
  cookie = '';
async function request(path: string, body?: object, authenticated = true) {
  return fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(65000),
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function applyCookie(response: Response) {
  const header = response.headers
    .getSetCookie()
    .find(value => value.startsWith('liekan_export_session='));
  assert.ok(header, 'Auth and export responses must set the known cookie');
  assert.match(header, /Path=\/api(?:;|$)/);
  assert.match(header, /HttpOnly/);
  cookie = /Max-Age=0(?:;|$)/.test(header) ? '' : header.split(';')[0];
  return header;
}
try {
  await db.connect();
  const installation = (
    await db.query('SELECT installation_id FROM liekan_warehouse_installation WHERE id=1')
  ).rows[0];
  assert.equal(installation.installation_id, recovery.initial.installation_id);
  const login = await request('/api/auth/login', { username: 'admin', password: 'liekan' }, false);
  assert.equal(login.status, 200);
  token = (await login.json()).token;
  applyCookie(login);
  assert.equal(cookie, '');
  const created = await request('/api/websites', {
    id: site,
    name: 'Export cookie (isolated synthetic)',
    domain: 'export-cookie.invalid',
  });
  assert.equal(created.status, 200);
  const exported = await request(`/api/liekan/websites/${site}/exports`, {
    startAt: Date.now() - 86400000,
    endAt: Date.now(),
    timezone: 'UTC',
    format: 'csv',
    sections: ['summary'],
    filters: {},
    locale: 'en-US',
  });
  assert.equal(exported.status, 200);
  const header = applyCookie(exported);
  assert.match(header, /SameSite=Strict/);
  assert.doesNotMatch(header, /Max-Age|Expires/);
  const frames = (await exported.text())
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(frames.at(-1).type, 'complete');
  const frame = frames.find(value => value.type === 'file');
  assert.ok(frame?.downloadUrl);
  const url = new URL(frame.downloadUrl, base);
  assert.equal(url.origin, base);
  const path = url.pathname + url.search;
  const download = await request(path, undefined, false);
  assert.equal(download.status, 200);
  assert.ok((await download.arrayBuffer()).byteLength > 0);
  report.cases.push({
    name: 'Session-only HttpOnly export cookie downloads the complete artifact',
    status: 'pass',
  });

  const invalid = await fetch(url, {
    headers: { Cookie: cookie, Authorization: 'Bearer invalid' },
  });
  assert.equal(invalid.status, 401, 'Explicit bad credentials must not fall back to the cookie');
  await invalid.arrayBuffer();
  const legacy = await fetch(url, {
    headers: {
      Cookie: `liekan_export_${url.pathname.split('/').at(-1)}=${encodeURIComponent(token)}`,
    },
  });
  assert.equal(legacy.status, 401, 'Old artifact-specific credentials are not accepted');
  await legacy.arrayBuffer();
  report.cases.push({
    name: 'Explicit invalid authorization and retired artifact cookies cannot authenticate',
    status: 'pass',
  });

  const logout = await request('/api/auth/logout', {});
  assert.equal(logout.status, 200);
  assert.match(applyCookie(logout), /Max-Age=0/);
  const afterLogout = await request(path, undefined, false);
  assert.equal(
    afterLogout.status,
    401,
    'The browser cookie jar no longer authenticates after logout',
  );
  await afterLogout.arrayBuffer();
  report.cases.push({
    name: 'Logout clears the export credential; the previous download URL requires login',
    status: 'pass',
  });
  const [facts] = (
    await db.query('SELECT count(*)::text AS n FROM website_event WHERE website_id=$1', [site])
  ).rows;
  assert.equal(facts.n, '0');
  console.log(`PASS ${report.cases.length} installed export session cases`);
} catch (error) {
  report.failed = error instanceof Error ? error.message : 'Export session acceptance failed';
  console.error(report.failed);
  process.exitCode = 1;
} finally {
  await db.end();
  await writeFile(`${directory}/export-session-http-report.json`, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
}
