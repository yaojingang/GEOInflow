import { sendBrowserFixture } from './seed/ingest';
import { expect, test } from './fixtures';
import { createWebsite, deleteWebsite } from './helpers/entities';
import { pageReportParts } from '../../src/lib/liekan/contracts/page-report';

test('creates team accounts atomically, scopes roles and rejects duplicate and non-session writes', async ({
  admin,
  user,
  api,
  apiKey,
  share,
}) => {
  const teamResponse = await admin.post('/api/teams', { name: `team-user-${crypto.randomUUID()}` });
  expect(teamResponse.status).toBe(200);
  const teamId = teamResponse.body[0].id;
  const endpoint = `/api/liekan/teams/${teamId}/users/create`;
  const createdIds: string[] = [];
  const makeBody = (teamRole = 'team-view-only') => ({
    userId: crypto.randomUUID(),
    username: `team-account-${crypto.randomUUID()}`,
    password: 'test-team-password-1',
    teamRole,
  });
  try {
    const body = makeBody();
    for (const client of [api, apiKey, await share()])
      expect((await client.post(endpoint, body)).status).toBe(401);
    expect((await user.post(endpoint, body)).status).toBe(403);
    expect((await admin.post(endpoint, { ...body, role: 'admin' })).status).toBe(400);
    expect((await admin.post(endpoint, { ...body, password: '中'.repeat(25) })).status).toBe(400);
    for (const role of ['team-manager', 'team-member', 'team-view-only']) {
      const input = makeBody(role);
      const response = await admin.post(endpoint, input);
      expect(response.status, response.text).toBe(200);
      createdIds.push(input.userId);
      expect(response.body).toMatchObject({
        state: 'created',
        user: { id: input.userId, role: 'user' },
        member: { teamId, role },
      });
      expect(response.body.user).not.toHaveProperty('password');
      const login = await api.post('/api/auth/login', {
        username: input.username,
        password: input.password,
      });
      expect(login.status).toBe(200);
      const memberClient = api.bearer(login.body.token);
      const site = await memberClient.post('/api/websites', {
        name: 'team account permission',
        domain: 'team-user.test',
        teamId,
      });
      if (role === 'team-view-only') expect(site.status).toBe(401);
      else {
        expect(site.status, site.text).toBe(200);
        expect((await memberClient.del(`/api/websites/${site.body.id}`)).status).toBe(200);
      }
      expect((await admin.get(endpoint, { params: { userId: input.userId } })).body).toMatchObject({
        state: 'created',
        member: { role },
      });
      expect((await admin.post(endpoint, input)).status).toBe(409);
    }
    const concurrent = makeBody();
    for (const username of ['Ω', '%', '_', '\\']) {
      const input = { ...makeBody(), username };
      const literal = await admin.post(endpoint, input);
      expect(literal.status, literal.text).toBe(200);
      createdIds.push(input.userId);
      expect(literal.body.user.username).toBe(username.toLowerCase());
      expect(
        (await api.post('/api/auth/login', { username, password: input.password })).status,
      ).toBe(200);
    }
    const other = { ...concurrent, userId: crypto.randomUUID() };
    const responses = await Promise.all([
      admin.post(endpoint, concurrent),
      admin.post(endpoint, other),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = responses.find(response => response.status === 200).body;
    createdIds.push(winner.user.id);
    const loserId = winner.user.id === concurrent.userId ? other.userId : concurrent.userId;
    expect((await admin.get(endpoint, { params: { userId: loserId } })).body).toEqual({
      state: 'unconfirmed',
    });
    const manager = (await admin.get(`/api/teams/${teamId}/users`)).body.data.find(
      member => member.role === 'team-manager',
    );
    const managerUser = (await admin.get(`/api/users/${manager.userId}`)).body;
    const managerLogin = await api.post('/api/auth/login', {
      username: managerUser.username,
      password: 'test-team-password-1',
    });
    const managerClient = api.bearer(managerLogin.body.token);
    expect(
      (
        await managerClient.post(`/api/teams/${teamId}/users/${winner.user.id}`, {
          role: 'team-manager',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await managerClient.post(`/api/teams/${teamId}/users/${winner.user.id}`, {
          role: 'team-member',
        })
      ).status,
    ).toBe(200);
    await admin.del(`/api/teams/${teamId}/users/${winner.user.id}`);
    expect((await admin.get(endpoint, { params: { userId: winner.user.id } })).body.state).toBe(
      'changed',
    );
  } finally {
    await admin.del(`/api/teams/${teamId}`);
    for (const id of createdIds) await admin.del(`/api/users/${id}`);
  }
});

test('identifies source keywords through real collection, scopes access, pages and exports the complete population', async ({
  admin,
  user,
  api,
  share,
}) => {
  const website = await createWebsite(admin, {
    name: '隔离关键词验收',
    domain: 'keyword-fixture.test',
  });
  const base = `/api/liekan/websites/${website.id}`;
  const midnight = Math.floor((Date.now() - 86400000) / 86400000) * 86400000;
  const params = {
    resource: 'human/keywords',
    startAt: midnight,
    endAt: midnight + 3600000,
    timezone: 'UTC',
    sort: 'keyword',
    direction: 'asc',
  };
  const send = async (
    id: string,
    referrer: string,
    timestamp: number,
    url = '/',
    cache?: string,
    name?: string,
  ) => {
    const response = await sendBrowserFixture(
      api,
      {
        type: 'event',
        payload: {
          website: website.id,
          hostname: website.domain,
          url,
          referrer,
          timestamp: Math.floor(timestamp / 1000),
          id,
          ip: '10.90.0.1',
          userAgent: 'Mozilla/5.0 Chrome/124.0.0.0',
          screen: '1440x900',
          language: 'zh-CN',
          ...(name ? { name } : {}),
        },
      },
      { headers: cache ? { 'x-umami-cache': cache } : {} },
    );
    expect(response.status).toBe(200);
    expect(response.body.cache).toBeTruthy();
    return response.body.cache as string;
  };
  try {
    for (let i = 0; i < 25; i++)
      await send(
        `keyword-${i}`,
        `https://www.google.com/search?q=word${String(i).padStart(2, '0')}`,
        midnight + 60000 + i * 1000,
      );
    // The first browser entry predates the window; later pages and repeated goals keep that entry.
    const first = await send(
      'cross-midnight',
      'https://www.baidu.com/s?wd=%E7%8C%8E%E7%9C%8B',
      midnight - 1000,
    );
    const second = await send(
      'cross-midnight',
      'https://www.bing.com/search?q=later',
      midnight + 1000,
      '/',
      first,
    );
    await send('cross-midnight', '', midnight + 2000, '/', second, 'keyword-goal');
    await send('cross-midnight', '', midnight + 3000, '/', second, 'keyword-goal');
    await send(
      'manual',
      'https://www.google.com/search?q=real',
      midnight + 4000,
      '/?utm_source=google&utm_term=manual',
    );
    await send(
      'conflict',
      'https://www.google.com/search?q=real',
      midnight + 5000,
      '/?utm_source=bing',
    );
    await send(
      'utm',
      'https://www.bing.com/',
      midnight + 6000,
      '/?utm_source=bing&utm_term=C%2B%2B%2520guide',
    );
    await send('missing', 'https://www.baidu.com/', midnight + 7000);
    await send('private', 'https://www.google.com/search?q=person%40example.test', midnight + 8000);
    for (const [index, referrer, url] of [
      [0, 'https://www.baidu.com/s?ie=gbk&wd=%C2%A9', '/'],
      [1, 'https://www.baidu.com/s?ie=utf-8&wd=%E7%8C', '/'],
      [2, 'https://www.baidu.com/s?ie=utf-8&ie=gbk&wd=%C2%A9', '/'],
      [
        3,
        'https://www.google.com/search?q=person%40example.test',
        '/?utm_source=google&utm_term=safe-manual',
      ],
    ] as const) {
      await send(`keyword-review-${index}`, referrer, midnight + 10000 + index * 1000, url);
    }
    await send(
      'nonsearch',
      'https://www.google.com/search?q=ignore',
      midnight + 9000,
      '/?utm_source=google&utm_medium=email',
    );
    const before = await admin.get(`${base}/page-report`, { params });
    expect(before.status, before.text).toBe(200);
    expect((await admin.get(`${base}/report`, { params })).status).toBe(400);
    expect(before.body.meta.tablePages.keywordBody.total).toBe(35);
    expect(before.body.cards.map(c => c.value)).toEqual([35, 28, 2, 85.71]);
    expect(before.body.tables.keywordBody).toHaveLength(20);
    expect(before.body.tables.keywordBody.every(r => r.conversionRate === null)).toBe(true);
    const page2 = await admin.get(`${base}/page-report`, {
      params: { ...params, page: 2, keywordSnapshot: before.body.meta.keywordSnapshot },
    });
    expect(page2.status).toBe(200);
    expect(page2.body.tables.keywordBody).toHaveLength(15);
    const rows = [...before.body.tables.keywordBody, ...page2.body.tables.keywordBody];
    expect(new Set(rows.map(r => r.id)).size).toBe(35);
    expect(rows).toContainEqual(
      expect.objectContaining({ engine: '百度', keyword: '漏', evidence: 'referrer' }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ engine: '百度', keyword: null, status: 'invalid' }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ engine: '百度', keyword: null, status: 'conflict' }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ engine: 'Google', keyword: 'safe-manual', evidence: 'utm' }),
    );
    const matched = await admin.get(`${base}/page-report`, {
      params: { ...params, search: 'word24', page: 2 },
    });
    expect(matched.body.tables.keywordBody[0].keyword).toBe('word24');
    const source = await admin.get(`${base}/page-report`, {
      params: { ...params, resource: 'human/sources' },
    });
    expect(
      source.body.tables.srcBody
        .filter(r => r.channel === '传统搜索')
        .reduce((n, r) => n + r.sessions, 0),
    ).toBe(35);
    const engineParams = { ...params, resource: 'human/search-engines' };
    const engines = await admin.get(`${base}/page-report`, { params: engineParams });
    expect(engines.status, engines.text).toBe(200);
    expect(engines.body.tables.searchEngineBody.reduce((sum, row) => sum + row.sessions, 0)).toBe(
      35,
    );
    expect(engines.body.charts.se2.state).toBe('empty');
    expect((await api.get(`${base}/page-report`, { params: engineParams })).status).toBe(401);
    expect((await user.get(`${base}/page-report`, { params: engineParams })).status).toBe(403);
    expect(
      (await (await share()).get(`${base}/page-report`, { params: engineParams })).status,
    ).toBe(401);
    expect((await api.get(`${base}/page-report`, { params })).status).toBe(401);
    expect((await user.get(`${base}/page-report`, { params })).status).toBe(403);
    expect((await (await share()).get(`${base}/page-report`, { params })).status).toBe(401);
    expect(
      (await api.post(`${base}/exports`, { kind: 'source-keywords', format: 'csv', ...params }))
        .status,
    ).toBe(401);
    const goal = await admin.post(`/api/websites/${website.id}/goals`, {
      name: '关键词验收目标',
      parameters: { type: 'event', value: 'keyword-goal' },
    });
    expect(goal.status).toBe(200);
    const converted = await admin.get(`${base}/page-report`, {
      params: { ...params, engine: '百度', refresh: '1' },
    });
    const baidu = converted.body.tables.keywordBody.find(r => r.keyword === '猎看');
    expect(baidu).toMatchObject({
      sessions: 1,
      conversions: 1,
      bounceRate: 0,
      conversionRate: 100,
    });
    const reset = await admin.get(`${base}/page-report`, {
      params: { ...params, page: 2, keywordSnapshot: before.body.meta.keywordSnapshot },
    });
    expect(reset.body.meta.keywordReset).toBe(true);
    expect(reset.body.meta.tablePages.keywordBody.page).toBe(1);
    const exported = await admin.post(`${base}/exports`, {
      kind: 'source-keywords',
      format: 'csv',
      startAt: params.startAt,
      endAt: params.endAt,
      timezone: 'UTC',
      search: 'word',
      sort: 'keyword',
      direction: 'asc',
    });
    expect(exported.status, exported.text).toBe(200);
    const frames = exported.text
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(frames.at(-1).type).toBe('complete');
    expect(frames.find(frame => frame.type === 'file').manifest.rows).toBe(25);
    const csv = Buffer.concat(
      frames.filter(f => f.type === 'chunk').map(f => Buffer.from(f.data, 'base64')),
    ).toString();
    expect(csv).toContain('word00');
    expect(csv).toContain('word24');
    expect(csv).toContain('统计读取时间');
    expect(csv).not.toContain('person@example.test');
    const englishExport = await admin.post(`${base}/exports`, {
      kind: 'source-keywords',
      format: 'csv',
      startAt: params.startAt,
      endAt: params.endAt,
      timezone: 'UTC',
      search: 'word',
      sort: 'keyword',
      direction: 'asc',
      locale: 'en-US',
    });
    expect(englishExport.status, englishExport.text).toBe(200);
    const englishFrames = englishExport.text
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(englishFrames.at(-1).type).toBe('complete');
    expect(englishFrames.find(frame => frame.type === 'file').manifest.rows).toBe(25);
    const englishCsv = Buffer.concat(
      englishFrames.filter(f => f.type === 'chunk').map(f => Buffer.from(f.data, 'base64')),
    ).toString();
    expect(englishCsv).toContain('Statistics read at');
    expect(englishCsv).toContain('Keyword / status');
    expect(englishCsv).toContain('word00');
    expect(englishCsv).toContain('word24');
    expect(englishCsv).not.toContain('统计读取时间');
    expect(englishCsv).not.toContain('person@example.test');
    expect(
      (
        await admin.post(`${base}/exports`, {
          kind: 'source-keywords',
          format: 'csv',
          startAt: params.startAt,
          endAt: params.endAt,
          locale: 'fr-FR',
        })
      ).status,
    ).toBe(400);
  } finally {
    await deleteWebsite(admin, website.id);
  }
});

test('keeps the deployed shared overview scoped and aggregate-only', async ({
  admin,
  user,
  api,
  share,
  seed,
}) => {
  const path = `/api/liekan/websites/${seed.website.id}/shared-report`;
  const params = { ...seed.range, timezone: 'Asia/Shanghai', chartPeriod: '30d' };
  const privateReport = await admin.get(`/api/liekan/websites/${seed.website.id}/report`, {
    params: { ...params, resource: 'human/geo' },
  });
  expect(privateReport.status).toBe(200);
  expect((await api.get(path, { params })).status).toBe(401);
  expect((await user.get(path, { params })).status).toBe(403);
  for (const client of [admin, await share()]) {
    const result = await client.get(path, { params });
    expect(result.status).toBe(200);
    expect(result.body.website.id).toBe(seed.website.id);
    expect(Object.keys(result.body.website).sort()).toEqual(['domain', 'id', 'name']);
    expect(Object.keys(result.body.tables).sort()).toEqual(['cityBody', 'envGrid']);
    expect(Object.keys(result.body.charts).sort()).toEqual([
      'd1',
      'd2',
      'd3',
      'g1',
      'g2',
      'h1',
      'h2',
      'h3',
    ]);
    expect(params.endAt - params.startAt).toBeLessThan(30 * 86400000);
    if (seed.db === 'postgres') expect(result.body.meta.trendPopulation.range.startAt).toBe(params.startAt);
    expect(result.body.meta).toEqual({
      geographyCoverage: privateReport.body.meta.geographyCoverage,
      ...(seed.db === 'postgres' ? { population: privateReport.body.meta.population } : {}),
      ...(privateReport.body.meta.trendPopulation
        ? { trendPopulation: privateReport.body.meta.population }
        : {}),
      aiCrawlerEnabled: true,
      demo: false,
      canManage: false,
      latestImportAt: null,
      ruleCount: 0,
      geography: {
        cards: {},
        charts: { g1: [], g2: [] },
        tables: { cityBody: [] },
      },
    });
    expect((await client.get(path, { params: { ...params, resource: 'logs' } })).status).toBe(400);
  }
  const publicClient = await share();
  const settings = `/api/liekan/websites/${seed.website.id}/settings`;
  try {
    expect((await admin.put(settings, { aiCrawlerEnabled: false })).status).toBe(200);
    for (let i = 0; i < 2; i++) {
      const hidden = await publicClient.get(path, { params });
      expect(hidden.status).toBe(200);
      expect(hidden.body.meta.aiCrawlerEnabled).toBe(false);
      expect(hidden.body.states.logs).toBe('unsupported');
      expect(hidden.body.states.catalog).toBe('unsupported');
      expect(hidden.body.cards.some(card => card.label === 'AI 蜘蛛请求')).toBe(false);
      expect(hidden.body.meta.logsConfigured).toBeUndefined();
    }
  } finally {
    expect((await admin.put(settings, { aiCrawlerEnabled: true })).status).toBe(200);
  }
  expect((await publicClient.get(path, { params })).body.meta.aiCrawlerEnabled).toBe(true);
  expect(
    (
      await (
        await share()
      ).get(`/api/liekan/websites/${seed.website2.id}/shared-report`, { params })
    ).status,
  ).toBe(403);
});

test.describe('Liekan evidence and website boundary', () => {
  test.describe.configure({ mode: 'serial' });
  let id = '',
    domain = '';
  const report = (extra: Record<string, string | number> = {}) => ({
    resource: 'logs',
    startAt: Date.now() - 2 * 86400000,
    endAt: Date.now() + 1000,
    timezone: 'Asia/Shanghai',
    ...extra,
  });
  test.beforeAll(async ({ admin }) => {
    const website = await createWebsite(admin);
    id = website.id;
    domain = website.domain;
  });
  test.afterAll(async ({ admin }) => {
    if (id) await deleteWebsite(admin, id);
  });
  test('requires full website access for every owned endpoint', async ({ api, user, share }) => {
    const path = `/api/liekan/websites/${id}`;
    expect((await api.get(`${path}/report`, { params: report() })).status).toBe(401);
    expect((await user.get(`${path}/report`, { params: report() })).status).toBe(403);
    expect((await (await share()).get(`${path}/report`, { params: report() })).status).toBe(401);
    expect((await api.post(`${path}/logs/import`, {})).status).toBe(401);
    expect((await api.put(`${path}/catalog`, {})).status).toBe(401);
    expect((await api.put(`${path}/settings`, {})).status).toBe(401);
  });
  test('serves an aggregate shared overview to authorized website readers', async ({
    api,
    user,
    admin,
  }) => {
    const url = `/api/liekan/websites/${id}/shared-report`;
    const params = {
      startAt: Date.now() - 86400000,
      endAt: Date.now() + 1000,
      timezone: 'Asia/Shanghai',
    };
    expect((await api.get(url, { params })).status).toBe(401);
    expect((await user.get(url, { params })).status).toBe(403);
    const response = await admin.get(url, { params });
    expect(response.status).toBe(200);
    expect(response.body.website.id).toBe(id);
    expect(response.body.tables.logBody).toBeUndefined();
  });
  test('enforces rule classes and separates missing evidence from zero', async ({ admin }) => {
    const path = `/api/liekan/websites/${id}`;
    const empty = await admin.get(`${path}/report`, { params: report() });
    expect(empty.status).toBe(200);
    expect(empty.body.states.logs).toBe('not_connected');
    expect(empty.body.charts.d2.series).toEqual([]);
    const settings = await admin.get(`${path}/settings`);
    expect(settings.status).toBe(200);
    expect(
      (
        await admin.put(`${path}/settings`, {
          rules: [{ name: 'x', vendor: 'x', type: 'x'.repeat(31), pattern: 'x' }],
        })
      ).status,
    ).toBe(400);
    const { robots, allowlist, rules } = settings.body;
    expect((await admin.put(`${path}/settings`, { robots, allowlist, rules })).status).toBe(200);
    expect(
      (
        await admin.put(`${path}/catalog`, {
          format: 'sitemap',
          content: `<sitemapindex><sitemap><loc>https://${domain}/sitemap.xml</loc></sitemap></sitemapindex>`,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin.put(`${path}/catalog`, {
          format: 'json',
          content: JSON.stringify([
            { path: '/a', updatedAt: '2026-01-01', linkDepth: 3, source: 'API fixture' },
          ]),
        })
      ).body.accepted,
    ).toBe(1);
  });
  test('imports partial batches, deduplicates and paginates with stable cursors', async ({
    admin,
  }) => {
    const path = `/api/liekan/websites/${id}`;
    const now = Date.now() - 20000;
    const range = report();
    const records = Array.from({ length: 150 }, (_, index) => ({
      time: new Date(now + index).toISOString(),
      ip: '203.0.113.9',
      method: 'GET',
      path: index === 0 ? '/literal_%' : '/plain',
      status: index % 4 === 0 ? 404 : 200,
      userAgent: 'GPTBot/1.0',
    }));
    const input = { format: 'json', records: [...records, null] };
    const result = await admin.post(`${path}/logs/import`, input);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ accepted: 150, rejected: 1, inserted: 150 });
    expect(result.body.errors[0].line).toBe(151);
    expect((await admin.post(`${path}/logs/import`, input)).body).toMatchObject({
      duplicate: true,
      inserted: 0,
    });
    const first = await admin.get(`${path}/report`, { params: range });
    expect(first.status).toBe(200);
    expect(first.body.tables.logBody).toHaveLength(100);
    const changedRange = await admin.get(`${path}/report`, {
      params: { ...range, endAt: Number(range.endAt) + 1, cursor: first.body.meta.nextCursor },
    });
    expect(changedRange.status).toBe(409);
    expect(changedRange.body.error.code).toBe('history-repair-cursor-conflict');
    const second = await admin.get(`${path}/report`, {
      params: { ...range, page: 2, cursor: first.body.meta.nextCursor },
    });
    expect(second.status).toBe(200);
    expect(second.body.tables.logBody).toHaveLength(50);
    expect(
      new Set([...first.body.tables.logBody, ...second.body.tables.logBody].map(r => r.recordId))
        .size,
    ).toBe(150);
    const back = await admin.get(`${path}/report`, {
      params: { ...range, page: 1, cursor: second.body.meta.previousCursor, seek: 'before' },
    });
    expect(back.body.tables.logBody.map(r => r.recordId)).toEqual(
      first.body.tables.logBody.map(r => r.recordId),
    );
    for (const search of ['_', '%']) {
      const matching = await admin.get(`${path}/report`, { params: { ...range, search } });
      expect(matching.body.meta.totalLogs).toBe(1);
      expect(matching.body.tables.logBody[0].path).toBe('/literal_%');
    }
    const status = await admin.get(`${path}/report`, { params: { ...range, search: '404' } });
    expect(status.body.meta.totalLogs).toBe(38);
    expect(
      (await admin.get(`${path}/report`, { params: { ...range, cursor: 'bad' } })).status,
    ).toBe(409);
  });
  test('merges independent settings edits and honors an explicitly empty rule list', async ({
    admin,
    user,
  }) => {
    const path = `/api/liekan/websites/${id}`;
    const initial = await admin.get(`${path}/settings`);
    expect(initial.status).toBe(200);
    for (const invalid of [{}, { isDemo: true }, { robots: '', unexpected: '' }])
      expect((await admin.put(`${path}/settings`, invalid)).status).toBe(400);
    expect((await user.put(`${path}/settings`, { rules: [] })).status).toBe(403);
    const rule = { name: 'FixtureBot', vendor: 'Fixture', type: '搜索', pattern: 'FixtureBot' };
    const results = await Promise.all([
      admin.put(`${path}/settings`, { rules: [rule] }),
      admin.put(`${path}/settings`, { robots: 'User-agent: *\nDisallow: /private' }),
    ]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect((await admin.get(`${path}/settings`)).body).toMatchObject({
      robots: 'User-agent: *\nDisallow: /private',
      rules: [rule],
      isDemo: initial.body.isDemo,
    });
    const cleared = await admin.put(`${path}/settings`, { rules: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.rules).toEqual([]);
    expect((await admin.get(`${path}/settings`)).body.rules).toEqual([]);
    const imported = await admin.post(`${path}/logs/import`, {
      format: 'json',
      records: [
        {
          time: new Date().toISOString(),
          ip: '192.0.2.9',
          path: '/rules-cleared',
          status: 200,
          userAgent: 'GPTBot/1.0',
        },
      ],
    });
    expect(imported.status).toBe(200);
    const log = await admin.get(`${path}/report`, { params: report({ search: '/rules-cleared' }) });
    expect(log.status).toBe(200);
    expect(log.body.tables.logBody).toHaveLength(1);
    expect(log.body.tables.logBody[0]).toMatchObject({ bot: '其他', botType: '其他' });
    const { robots, allowlist, rules } = initial.body;
    expect((await admin.put(`${path}/settings`, { robots, allowlist, rules })).status).toBe(200);
  });
  test('preserves catalog evidence across sitemap and partial metadata imports', async ({
    admin,
  }) => {
    const path = `/api/liekan/websites/${id}`;
    const updatedAt = new Date(Date.now() - 5 * 86400000).toISOString();
    const rich = await admin.put(`${path}/catalog`, {
      format: 'json',
      content: JSON.stringify([
        {
          path: '/plain',
          title: 'Fixture page',
          type: '文章',
          wordCount: 500,
          structureScore: 75,
          structured: true,
          updatedAt,
          linkDepth: 2,
          source: 'API evidence fixture',
        },
      ]),
    });
    expect(rich.status).toBe(200);
    const before = await admin.get(`${path}/report`, { params: report() });
    expect(before.status).toBe(200);
    expect(before.body.charts.pf2.rows).toContainEqual(
      expect.objectContaining({ path: '/plain', words: 500, structureScore: 75 }),
    );
    const sitemap = await admin.put(`${path}/catalog`, {
      format: 'sitemap',
      content: `<urlset><url><loc>https://${domain}/plain</loc></url><url><loc>https://${domain}/sitemap-new</loc></url></urlset>`,
    });
    expect(sitemap.status).toBe(200);
    expect(sitemap.body.accepted).toBe(2);
    const preserved = await admin.get(`${path}/report`, { params: report() });
    expect(preserved.status).toBe(200);
    expect(preserved.body.charts.pf2.rows).toContainEqual(
      expect.objectContaining({ path: '/plain', words: 500, structureScore: 75 }),
    );
    expect(preserved.body.charts.pf1.labels).toContain('文章');
    expect(preserved.body.charts.pf1.labels).toContain('未分类');
    expect(preserved.body.tables.apBody.find(row => row.path === '/plain').freshness).toBe(
      before.body.tables.apBody.find(row => row.path === '/plain').freshness,
    );
    const partial = await admin.put(`${path}/catalog`, {
      format: 'json',
      content: JSON.stringify([{ path: '/plain', wordCount: 750 }]),
    });
    expect(partial.status).toBe(200);
    const updated = await admin.get(`${path}/report`, { params: report() });
    expect(updated.status).toBe(200);
    expect(updated.body.charts.pf2.rows).toContainEqual(
      expect.objectContaining({ path: '/plain', words: 750, structureScore: 75 }),
    );
    const clear = await admin.put(`${path}/catalog`, {
      format: 'json',
      content: JSON.stringify([{ path: '/plain', structureScore: null, updatedAt: null }]),
    });
    expect(clear.status).toBe(200);
    const cleared = await admin.get(`${path}/report`, { params: report() });
    expect(cleared.status).toBe(200);
    expect(cleared.body.charts.pf2.rows.some(row => row.path === '/plain')).toBe(false);
    expect(cleared.body.tables.apBody.find(row => row.path === '/plain').freshness).toBeNull();
  });
  test('keeps installation metadata readable and persists setup changes', async ({ admin }) => {
    const path = `/api/liekan/websites/${id}/installation`;
    const before = await admin.get(path);
    expect(before.status).toBe(200);
    expect(before.body.canManage).toBe(true);
    expect(before.body.logs.total).toBeGreaterThan(0);
    const saved = await admin.post(path, { action: 'select-method', method: 'manual' });
    expect(saved.status).toBe(200);
    expect(saved.body.progress).toMatchObject({ method: 'manual', lastStep: 'logs' });
    const after = await admin.get(path);
    expect(after.body.progress).toEqual(saved.body.progress);
    expect(after.body.logs.total).toBe(before.body.logs.total);
  });

  test('clears statistics on reset and removes owned evidence on UUID reuse', async ({ admin }) => {
    const path = `/api/liekan/websites/${id}`;
    expect((await admin.post(`/api/websites/${id}/reset`, {})).status).toBe(200);
    const reset = await admin.get(`${path}/report`, { params: report() });
    expect(reset.body.meta.totalLogs).toBe(0);
    expect(reset.body.states.catalog).toBe('available');
    await deleteWebsite(admin, id);
    await createWebsite(admin, { id, domain });
    const fresh = await admin.get(`${path}/report`, { params: report() });
    expect(fresh.body.states.catalog).toBe('not_connected');
    expect(fresh.body.meta.latestImportAt).toBeNull();
  });
});

test.describe('Liekan statistics cache', () => {
  test('keeps every page consistent with the complete report and shares concurrent reads', async ({
    admin,
    seed,
  }) => {
    const path = `/api/liekan/websites/${seed.website.id}`;
    const params = { ...seed.range, timezone: 'Asia/Shanghai' };
    const full = await admin.get(`${path}/report`, { params: { ...params, resource: 'overview' } });
    expect(full.status).toBe(200);
    for (const [resource, parts] of Object.entries(pageReportParts).filter(
      ([resource]) => resource !== 'human/keywords',
    )) {
      const page = await admin.get(`${path}/page-report`, { params: { ...params, resource } });
      expect(page.status, resource).toBe(200);
      expect(page.body.cards).toEqual(
        full.body.cards.filter(card => parts.cards.includes(card.label as never)),
      );
      for (const name of parts.charts)
        expect(page.body.charts[name], `${resource}:${name}`).toEqual(full.body.charts[name]);
      for (const name of parts.tables)
        expect(page.body.tables[name], `${resource}:${name}`).toEqual(full.body.tables[name]);
    }
    const range = { ...params, startAt: params.startAt + 7, resource: 'overview' };
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () => admin.get(`${path}/page-report`, { params: range })),
    );
    expect(concurrent.every(row => row.status === 200)).toBe(true);
    expect(concurrent.filter(row => row.headers['x-liekan-cache'] === 'miss')).toHaveLength(1);
    expect(new Set(concurrent.map(row => row.body.meta.generatedAt)).size).toBe(1);
    const warm = await admin.get(`${path}/page-report`, { params: range });
    expect(warm.headers['x-liekan-cache']).toBe('hit');
    expect(warm.body.meta.expiresAt).toBe(concurrent[0].body.meta.expiresAt);
    const fresh = await admin.get(`${path}/page-report`, { params: { ...range, refresh: '1' } });
    expect(fresh.headers['x-liekan-cache']).toBe('miss');
    expect(fresh.body.meta.generatedAt).toBeGreaterThan(warm.body.meta.generatedAt);
    const expanded = await admin.get(`/api/websites/${seed.website.id}/metrics/expanded`, {
      params: { ...params, type: 'path' },
    });
    expect(expanded.status).toBe(200);
    expect(expanded.body.length).toBeGreaterThan(0);
    expect(Number(expanded.headers['x-liekan-expires-at'])).toBeGreaterThan(0);
  });

  test('invalidates writes and checks revoked access before returning cached statistics', async ({
    admin,
    user,
    api,
    share,
    seed,
  }) => {
    const website = await createWebsite(user);
    const path = `/api/liekan/websites/${website.id}`;
    const params = {
      startAt: Date.now() - 86400000,
      endAt: Date.now() + 1000,
      timezone: 'Asia/Shanghai',
      resource: 'ai/pages',
    };
    try {
      for (const client of [api, await share()]) {
        expect((await client.get(`${path}/page-report`, { params })).status).toBe(401);
        expect(
          (
            await client.get('/api/liekan/websites/summary', {
              params: { ...params, ids: website.id },
            })
          ).status,
        ).toBe(401);
      }
      expect((await user.get(`${path}/page-report`, { params })).body.states.catalog).toBe(
        'not_connected',
      );
      expect((await user.get(`${path}/page-report`, { params })).headers['x-liekan-cache']).toBe(
        'hit',
      );
      expect(
        (
          await user.post(`${path}/logs/import`, {
            format: 'json',
            records: [
              {
                time: new Date(params.endAt - 1000).toISOString(),
                ip: '203.0.113.9',
                method: 'GET',
                path: '/seen',
                status: 200,
                userAgent: 'GPTBot/1.0',
              },
            ],
          })
        ).status,
      ).toBe(200);
      const imported = await user.get(`${path}/page-report`, { params });
      expect(imported.headers['x-liekan-cache']).toBe('miss');
      expect(imported.body.states.logs).toBe('available');
      expect(
        (
          await user.put(`${path}/catalog`, {
            format: 'json',
            content: JSON.stringify([{ path: '/new-page' }]),
          })
        ).status,
      ).toBe(200);
      const updated = await user.get(`${path}/page-report`, { params });
      expect(updated.headers['x-liekan-cache']).toBe('miss');
      expect(updated.body.states.catalog).toBe('available');
      expect(updated.body.tables.blindList).toContainEqual(
        expect.objectContaining({ path: '/new-page' }),
      );
      const summary = await user.get('/api/liekan/websites/summary', {
        params: { ...params, ids: website.id },
      });
      expect(summary.status).toBe(200);
      expect(
        (await admin.post(`/api/websites/${website.id}/transfer`, { userId: seed.admin.id }))
          .status,
      ).toBe(200);
      expect((await user.get(`${path}/page-report`, { params })).status).toBe(403);
      expect(
        (await user.get('/api/liekan/websites/summary', { params: { ...params, ids: website.id } }))
          .status,
      ).toBe(403);
      expect((await admin.get(`${path}/page-report`, { params })).status).toBe(200);
    } finally {
      await deleteWebsite(admin, website.id);
    }
  });
});

test('keeps empty search redirects in traffic totals and exposes their status in filters and exports', async ({
  admin,
  api,
}) => {
  const website = await createWebsite(admin, {
    name: '来源缺词状态（隔离验收）',
    domain: 'keyword-status-fixture.test',
  });
  const base = `/api/liekan/websites/${website.id}`;
  const now = Date.now();
  const params = {
    resource: 'human/keywords',
    keywordStatusVersion: '2',
    startAt: now - 60000,
    endAt: now + 60000,
    timezone: 'UTC',
  };
  try {
    const sources = [
      ['https://cn.bing.com/', '/'],
      ['https://www.baidu.com/link?url=opaque&wd=&eqid=example', '/'],
      ['https://www.so.com/link?m=opaque', '/'],
      ['https://www.sogou.com/link?url=opaque', '/'],
      ['https://tieba.baidu.com/s?wd=forum', '/'],
      ['https://www.baidu.com/link?url=opaque&wd=', '/?utm_term=manual-example'],
    ];
    for (const [i, [referrer, url]] of sources.entries()) {
      const response = await sendBrowserFixture(api, {
        type: 'event',
        payload: {
          website: website.id,
          hostname: website.domain,
          referrer,
          url,
          id: `keyword-status-${i}`,
          timestamp: Math.floor(now / 1000),
          ip: '10.90.0.1',
          userAgent: 'Mozilla/5.0 Chrome/124.0.0.0',
        },
      });
      expect(response.status).toBe(200);
    }
    const report = await admin.get(`${base}/page-report`, { params });
    expect(report.status, report.text).toBe(200);
    expect(report.body.cards.map(card => card.value)).toEqual([6, 0, 1, 16.67]);
    expect(report.body.tables.keywordBody.filter(row => row.status === 'redirect')).toHaveLength(3);
    expect(report.body.tables.keywordBody).toContainEqual(
      expect.objectContaining({ engine: 'Bing', status: 'missing', keyword: null }),
    );
    expect(report.body.tables.keywordBody).toContainEqual(
      expect.objectContaining({ engine: '百度', status: 'unsupported', keyword: null }),
    );
    expect(report.body.tables.keywordBody).toContainEqual(
      expect.objectContaining({ engine: '百度', evidence: 'utm', keyword: 'manual-example' }),
    );
    const legacy = await admin.get(`${base}/page-report`, {
      params: { ...params, keywordStatusVersion: undefined, status: 'unsupported' },
    });
    expect(legacy.status, legacy.text).toBe(200);
    expect(legacy.body.cards.map(card => card.value)).toEqual([6, 0, 1, 16.67]);
    expect(legacy.body.tables.keywordBody).toHaveLength(3);
    expect(
      legacy.body.tables.keywordBody.every(
        row => row.status === 'unsupported' && row.keyword === null,
      ),
    ).toBe(true);
    expect(legacy.body.tables.keywordBody.find(row => row.engine === '百度').sessions).toBe(2);
    expect(new Set(legacy.body.tables.keywordBody.map(row => row.id)).size).toBe(3);
    const oldText = await admin.get(`${base}/page-report`, {
      params: { ...params, keywordStatusVersion: undefined, search: '来源不支持' },
    });
    expect(oldText.status, oldText.text).toBe(200);
    expect(oldText.body.tables.keywordBody.reduce((total, row) => total + row.sessions, 0)).toBe(4);
    const oldExport = await admin.post(`${base}/exports`, {
      ...params,
      keywordStatusVersion: undefined,
      kind: 'source-keywords',
      format: 'csv',
      search: '来源不支持',
    });
    expect(oldExport.status, oldExport.text).toBe(200);
    const oldFrames = oldExport.text
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(oldFrames.find(frame => frame.type === 'file').manifest.rows).toBe(3);
    const oldCsv = Buffer.concat(
      oldFrames
        .filter(frame => frame.type === 'chunk')
        .map(frame => Buffer.from(frame.data, 'base64')),
    ).toString();
    expect(oldCsv).toContain('来源格式不支持,百度,无可用关键词,2,33.33,100,');
    expect(oldCsv).not.toContain('跳转链接无可用搜索词');
    for (const filter of [{ status: 'redirect' }, { search: '跳转链接' }]) {
      const selected = await admin.get(`${base}/page-report`, { params: { ...params, ...filter } });
      expect(selected.status, selected.text).toBe(200);
      expect(selected.body.tables.keywordBody).toHaveLength(3);
      expect(selected.body.cards.map(card => card.value)).toEqual([6, 0, 1, 16.67]);
      expect(selected.body.tables.keywordBody.every(row => row.keyword === null)).toBe(true);
    }
    const exported = await admin.post(`${base}/exports`, {
      kind: 'source-keywords',
      format: 'csv',
      ...params,
      status: 'redirect',
    });
    expect(exported.status, exported.text).toBe(200);
    const frames = exported.text
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(frames.at(-1).type).toBe('complete');
    expect(frames.find(frame => frame.type === 'file').manifest.rows).toBe(3);
    const csv = Buffer.concat(
      frames
        .filter(frame => frame.type === 'chunk')
        .map(frame => Buffer.from(frame.data, 'base64')),
    ).toString();
    expect(csv).toContain('跳转链接无可用搜索词');
    expect(csv).toContain('百度');
    expect(csv).toContain('360');
    expect(csv).toContain('搜狗');
    expect(csv).not.toContain('opaque');
  } finally {
    await deleteWebsite(admin, website.id);
  }
});

test('traffic evidence keeps private identities, explicit empty states and validated context inputs', async ({
  admin,
  user,
  api,
  apiKey,
  share,
}) => {
  const site = await createWebsite(admin, { domain: 'evidence.example' });
  const base = `/api/liekan/websites/${site.id}`;
  const range = {
    startAt: Date.now() - 86400000,
    endAt: Date.now() - 1000,
    timezone: 'UTC',
    crawlerMetricsVersion: 1,
  };
  try {
    const readers = [
      ['crawler-analysis/evidence', range],
      ['crawler-analysis/performance', { ...range, sourceId: 'manual' }],
      ['crawler-analysis/outcomes', { ...range, sourceId: 'manual' }],
      [
        'traffic-quality/reconciliation',
        { ...range, sourceId: 'manual', hostname: 'evidence.example' },
      ],
      ['traffic-quality/observations', { timezone: 'UTC' }],
      ['crawler-context', { startAt: range.startAt, endAt: range.endAt }],
    ] as const;
    const denied = await share();
    for (const [path, params] of readers) {
      for (const client of [api, apiKey, denied])
        expect((await client.get(`${base}/${path}`, { params })).status).toBe(401);
      expect((await user.get(`${base}/${path}`, { params })).status).toBe(404);
      const response = await admin.get(`${base}/${path}`, { params });
      expect(response.status, response.text).toBe(200);
      expect(response.headers['cache-control'], path).toMatch(/private.*no-store/);
      if (path === 'crawler-analysis/evidence') expect(response.body.totals.requests).toBe(0);
      expect(response.body.rows).toEqual([]);
    }
    expect(
      (await admin.get(`${base}/crawler-context`, { params: { startAt: 'invalid' } })).status,
    ).toBe(400);
    expect(
      (
        await admin.post(`${base}/crawler-context/invalid/void`, {
          requestId: crypto.randomUUID(),
          reason: 'Correction',
        })
      ).status,
    ).toBe(400);
    const body = {
      requestId: crypto.randomUUID(),
      title: 'Test release',
      note: 'Manual context',
      occurredAt: new Date(range.endAt - 1000).toISOString(),
    };
    const created = await admin.post(`${base}/crawler-context`, body);
    expect(created.status, created.text).toBe(200);
    expect((await admin.post(`${base}/crawler-context`, body)).body).toEqual(created.body);
    expect((await admin.post(`${base}/crawler-context`, { ...body, note: 'changed' })).status).toBe(
      409,
    );
    expect(
      (
        await admin.post(`${base}/crawler-context/${created.body.id}/void`, {
          requestId: crypto.randomUUID(),
          reason: 'Test correction',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin.request('PATCH', `${base}/crawler-findings/cr_${'a'.repeat(64)}/workflow`, {
          data: {
            requestId: crypto.randomUUID(),
            expectedWorkflowRevision: 0,
            occurrenceVersion: 1,
            factVersion: 'a'.repeat(64),
            action: 'view',
          },
        })
      ).status,
    ).toBe(404);
    for (const [endpoint, kind, path, query] of [
      ['crawler-analysis/export', 'evidence', 'crawler-analysis/evidence', range],
      [
        'traffic-quality/export-evidence',
        'observations',
        'traffic-quality/observations',
        { timezone: 'UTC' },
      ],
    ] as const) {
      const view = await admin.get(`${base}/${path}`, { params: query });
      const payload = {
        kind,
        query: { ...query, ...view.body.meta.conditions },
        locale: 'en-US',
        viewSnapshot: view.body.meta.snapshot,
        policySnapshot: view.body.meta.policySnapshot,
      };
      for (const client of [api, apiKey, denied])
        expect((await client.post(`${base}/${endpoint}`, payload)).status).toBe(401);
      const csv = await admin.post(`${base}/${endpoint}`, payload);
      expect(csv.status, csv.text).toBe(200);
      expect(csv.text).toContain('exportReadAt');
      expect(csv.text).toContain('en-US');
    }
  } finally {
    await deleteWebsite(admin, site.id);
  }
});
