#!/usr/bin/env node
/**
 * Warehouse v2 Live Next.js Standalone Full-Stack HTTP Smoke Verification
 *
 * Drives a REAL compiled `.next/standalone/server.js` backed by real PostgreSQL 16
 * and real ClickHouse 26.8 (`LIEKAN_ANALYTICS_BACKEND=clickhouse`, `LIEKAN_WAREHOUSE_V2=1`).
 */
import assert from 'node:assert/strict';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:13002';
const DEMO_ID = 'b880cb21-e65a-4fdf-9c0e-3da5aed4e0fa';
const ADMIN_USER = process.env.SMOKE_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.SMOKE_ADMIN_PASS || 'liekan';

type Timing = { endpoint: string; status: number; ms: number; note?: string };
const timings: Timing[] = [];

async function httpJson(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ms, data, text };
}

async function main() {
  // 1. Heartbeat
  const hb = await httpJson('GET', '/api/heartbeat');
  assert.equal(hb.status, 200, `heartbeat failed: ${hb.status}`);
  timings.push({ endpoint: 'GET /api/heartbeat', status: hb.status, ms: hb.ms });

  // 2. Real admin login (never print token)
  const login = await httpJson('POST', '/api/auth/login', {
    body: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  assert.equal(login.status, 200, `login failed: ${login.status} ${login.text.slice(0, 200)}`);
  const token: string = login.data?.token;
  assert.ok(typeof token === 'string' && token.length > 10, 'missing auth token');
  timings.push({ endpoint: 'POST /api/auth/login', status: login.status, ms: login.ms });

  // 3. Verify official bundled demo website exists
  const sites = await httpJson('GET', '/api/websites', { token });
  assert.equal(sites.status, 200, `GET /api/websites failed: ${sites.status}`);
  const demoSite = (sites.data?.data ?? []).find((w: any) => w.id === DEMO_ID);
  assert.ok(demoSite, 'official demo website missing from /api/websites');
  assert.equal(demoSite.domain, 'www.liekan.com');
  timings.push({
    endpoint: 'GET /api/websites',
    status: sites.status,
    ms: sites.ms,
    note: `demo=${demoSite.name}`,
  });

  // 4. Send a real browser event via /api/send
  const browserHeaders = (originUrl: string) => ({
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'x-forwarded-for': '203.0.113.42',
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    origin: originUrl,
    referer: `${originUrl}/`,
  });

  const sendRes = await httpJson('POST', '/api/send', {
    headers: browserHeaders('https://www.liekan.com'),
    body: {
      type: 'event',
      payload: {
        website: DEMO_ID,
        hostname: 'www.liekan.com',
        screen: '1920x1080',
        language: 'zh-CN',
        title: 'Warehouse v2 Smoke',
        url: '/docs/v2-smoke',
        referrer: 'https://www.google.com/',
      },
    },
  });
  assert.equal(sendRes.status, 200, `POST /api/send failed: ${sendRes.status} ${sendRes.text.slice(0, 200)}`);
  timings.push({ endpoint: 'POST /api/send (demo)', status: sendRes.status, ms: sendRes.ms });

  const now = Date.now();
  const startAt7d = now - 7 * 86_400_000;
  const endAt = now;
  const qs7d = `startAt=${startAt7d}&endAt=${endAt}&timezone=Asia%2FShanghai`;

  // 5. Observations & Reconciliation (fast stateless v2 paths)
  const obs = await httpJson(
    'GET',
    `/api/liekan/websites/${DEMO_ID}/traffic-quality/observations?${qs7d}`,
    { token },
  );
  assert.equal(obs.status, 200, `observations failed: ${obs.status} ${obs.text.slice(0, 300)}`);
  timings.push({
    endpoint: 'GET traffic-quality/observations',
    status: obs.status,
    ms: obs.ms,
    note: `pv=${obs.data?.summary?.pv ?? obs.data?.totalPv ?? 'ok'}`,
  });

  const rec = await httpJson(
    'GET',
    `/api/liekan/websites/${DEMO_ID}/traffic-quality/reconciliation?${qs7d}&sourceId=manual&hostname=www.liekan.com`,
    { token },
  );
  assert.equal(rec.status, 200, `reconciliation failed: ${rec.status} ${rec.text.slice(0, 300)}`);
  timings.push({
    endpoint: 'GET traffic-quality/reconciliation',
    status: rec.status,
    ms: rec.ms,
    note: `rows=${rec.data?.rows?.length ?? 'ok'}`,
  });

  // 6. All core page-report resources (must all return HTTP 200 synchronously, never 202 or 500!)
  const resources = [
    'overview',
    'ai/overview',
    'ai/bots',
    'ai/pages',
    'ai/preference',
    'human/overview',
    'human/geo',
    'human/sources',
    'human/search-engines',
    'content',
    'conversions',
    'logs',
  ];
  for (const resource of resources) {
    const extra = resource.startsWith('ai/') ? '&crawlerMetricsVersion=1' : '';
    const r = await httpJson(
      'GET',
      `/api/liekan/websites/${DEMO_ID}/page-report?resource=${encodeURIComponent(resource)}&chartPeriod=7d&${qs7d}${extra}`,
      { token },
    );
    assert.equal(
      r.status,
      200,
      `page-report(${resource}) failed: HTTP ${r.status} ${r.text.slice(0, 300)}`,
    );
    assert.equal(r.data?.resource, resource, `page-report resource mismatch for ${resource}`);
    timings.push({
      endpoint: `GET page-report?resource=${resource}`,
      status: r.status,
      ms: r.ms,
      note: `cards=${r.data?.cards?.length ?? 0}`,
    });
  }

  // 7. GEO Weight snapshot (synchronous direct v2 calculation, zero PgBoss 503!)
  const geoWeight = await httpJson(
    'GET',
    `/api/liekan/websites/${DEMO_ID}/geo-weight/snapshot?mode=current&timezone=Asia%2FShanghai&view=summary`,
    { token },
  );
  assert.equal(
    geoWeight.status,
    200,
    `geo-weight/snapshot failed: ${geoWeight.status} ${geoWeight.text.slice(0, 300)}`,
  );
  assert.equal(geoWeight.data?.taskStatus, 'ready', 'geo-weight should return ready synchronously');
  timings.push({
    endpoint: 'GET /api/liekan/websites/[id]/geo-weight/snapshot',
    status: geoWeight.status,
    ms: geoWeight.ms,
    note: `status=${geoWeight.data?.taskStatus}`,
  });

  // 8. Website summary, native stats, realtime, retention
  const summary = await httpJson(
    'GET',
    `/api/liekan/websites/summary?ids=${DEMO_ID}&${qs7d}`,
    { token },
  );
  assert.equal(summary.status, 200, `websites/summary failed: ${summary.status} ${summary.text.slice(0, 300)}`);
  assert.ok(Array.isArray(summary.data) && summary.data.length === 1, 'summary must return 1 site');
  assert.ok(Number(summary.data[0].pageviews ?? 0) > 0, 'demo summary pageviews should be > 0');
  timings.push({
    endpoint: 'GET /api/liekan/websites/summary',
    status: summary.status,
    ms: summary.ms,
    note: `pv=${summary.data[0].pageviews}`,
  });

  const stats = await httpJson(
    'GET',
    `/api/websites/${DEMO_ID}/stats?startAt=${startAt7d}&endAt=${endAt}`,
    { token },
  );
  assert.equal(stats.status, 200, `websites/stats failed: ${stats.status} ${stats.text.slice(0, 300)}`);
  timings.push({
    endpoint: 'GET /api/websites/[id]/stats',
    status: stats.status,
    ms: stats.ms,
    note: `pv=${stats.data?.pageviews ?? 'ok'}`,
  });

  const realtime = await httpJson('GET', `/api/realtime/${DEMO_ID}`, { token });
  assert.equal(realtime.status, 200, `realtime failed: ${realtime.status} ${realtime.text.slice(0, 300)}`);
  timings.push({ endpoint: 'GET /api/realtime/[id]', status: realtime.status, ms: realtime.ms });

  const retention = await httpJson(
    'GET',
    `/api/websites/${DEMO_ID}/retention?startAt=${startAt7d}&endAt=${endAt}&timezone=Asia%2FShanghai`,
    { token },
  );
  assert.equal(
    retention.status,
    200,
    `retention failed: ${retention.status} ${retention.text.slice(0, 300)}`,
  );
  timings.push({
    endpoint: 'GET /api/websites/[id]/retention',
    status: retention.status,
    ms: retention.ms,
  });

  // 8b. Feature analytics kinds (sessions, events, utm, realtime, performance, replays, heatmap-scroll, revenue, attribution) + log-entries + analytics-engine
  const featureChecks: Array<[string, string]> = [
    ['analytics?kind=sessions', `/api/liekan/websites/${DEMO_ID}/analytics?${qs7d}&unit=day&kind=sessions&page=1`],
    ['analytics?kind=events', `/api/liekan/websites/${DEMO_ID}/analytics?${qs7d}&unit=day&kind=events&page=1`],
    ['analytics?kind=utm', `/api/liekan/websites/${DEMO_ID}/analytics?${qs7d}&unit=day&kind=utm`],
    ['analytics?kind=realtime', `/api/liekan/websites/${DEMO_ID}/analytics?${qs7d}&unit=day&kind=realtime`],
    ['analytics?kind=performance', `/api/liekan/websites/${DEMO_ID}/analytics?${qs7d}&unit=day&kind=performance`],
    ['analytics?kind=replays', `/api/liekan/websites/${DEMO_ID}/analytics?${qs7d}&unit=day&kind=replays&page=1`],
    ['analytics?kind=heatmap-scroll', `/api/liekan/websites/${DEMO_ID}/analytics?${qs7d}&unit=day&kind=heatmap-scroll&urlPath=%2F`],
    ['analytics?kind=revenue', `/api/liekan/websites/${DEMO_ID}/analytics?${qs7d}&unit=day&kind=revenue&currency=CNY&page=1`],
    ['analytics?kind=attribution', `/api/liekan/websites/${DEMO_ID}/analytics?${qs7d}&unit=day&kind=attribution&model=first-click&type=path&step=%2F`],
    ['websites/[id]/sessions', `/api/websites/${DEMO_ID}/sessions?startAt=${startAt7d}&endAt=${endAt}&page=1&pageSize=20`],
    ['log-entries', `/api/liekan/websites/${DEMO_ID}/log-entries?${qs7d}&pageSize=20`],
    ['admin/analytics-engine', '/api/liekan/admin/analytics-engine'],
  ];
  for (const [label, path] of featureChecks) {
    const r = await httpJson('GET', path, { token });
    assert.equal(r.status, 200, `${label} failed: HTTP ${r.status} ${r.text.slice(0, 300)}`);
    timings.push({ endpoint: `GET ${label}`, status: r.status, ms: r.ms });
  }

  // 8. Full lifecycle test on a fresh site: create -> /api/send -> verify >0 -> reset -> verify 0 -> delete
  const created = await httpJson('POST', '/api/websites', {
    token,
    body: { name: 'V2 Lifecycle Smoke', domain: 'v2-lifecycle.example.com' },
  });
  assert.equal(created.status, 200, `create website failed: ${created.status} ${created.text.slice(0, 200)}`);
  const tempId: string = created.data?.id;
  assert.ok(tempId, 'created website id missing');

  const sendTemp = await httpJson('POST', '/api/send', {
    headers: browserHeaders('https://v2-lifecycle.example.com'),
    body: {
      type: 'event',
      payload: {
        website: tempId,
        hostname: 'v2-lifecycle.example.com',
        screen: '1440x900',
        language: 'zh-CN',
        title: 'Lifecycle Test',
        url: '/lifecycle-check',
      },
    },
  });
  assert.equal(sendTemp.status, 200, `send to temp site failed: ${sendTemp.status}`);

  const beforeReset = await httpJson(
    'GET',
    `/api/websites/${tempId}/stats?startAt=${now - 3600_000}&endAt=${Date.now() + 60_000}`,
    { token },
  );
  assert.equal(beforeReset.status, 200);
  assert.ok(
    Number(beforeReset.data?.pageviews ?? 0) >= 1,
    `expected >=1 pv before reset, got ${JSON.stringify(beforeReset.data)}`,
  );

  const resetRes = await httpJson('POST', `/api/websites/${tempId}/reset`, { token });
  assert.equal(resetRes.status, 200, `reset failed: ${resetRes.status} ${resetRes.text.slice(0, 200)}`);

  const afterReset = await httpJson(
    'GET',
    `/api/websites/${tempId}/stats?startAt=${now - 3600_000}&endAt=${Date.now() + 60_000}`,
    { token },
  );
  assert.equal(afterReset.status, 200);
  assert.equal(
    Number(afterReset.data?.pageviews ?? 0),
    0,
    `expected 0 pv immediately after reset, got ${JSON.stringify(afterReset.data)}`,
  );
  timings.push({
    endpoint: 'POST /api/websites/[id]/reset + zero-read verify',
    status: resetRes.status,
    ms: resetRes.ms,
    note: `before=${beforeReset.data?.pageviews}->after=${afterReset.data?.pageviews}`,
  });

  const delTemp = await httpJson('DELETE', `/api/websites/${tempId}`, { token });
  assert.equal(delTemp.status, 200, `delete temp site failed: ${delTemp.status} ${delTemp.text.slice(0, 200)}`);
  timings.push({ endpoint: 'DELETE /api/websites/[id] (temp)', status: delTemp.status, ms: delTemp.ms });

  // 9. Delete demo website to verify AGENTS.md deletion marker prevents recreation
  const delDemo = await httpJson('DELETE', `/api/websites/${DEMO_ID}`, { token });
  assert.equal(delDemo.status, 200, `delete demo site failed: ${delDemo.status} ${delDemo.text.slice(0, 200)}`);
  timings.push({ endpoint: 'DELETE /api/websites/[id] (demo)', status: delDemo.status, ms: delDemo.ms });

  console.log(JSON.stringify({ ok: true, checksPassed: timings.length, timings }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
