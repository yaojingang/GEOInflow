import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import { createWebsite, deleteWebsite } from './helpers/entities';

test('manages an owned acceleration build with revisions, replay and captured locale', async ({
  admin,
  seed,
}) => {
  test.skip(seed.db === 'clickhouse', 'PostgreSQL acceleration management');
  const website = await createWebsite(admin);
  const root = `/api/liekan/websites/${website.id}/analytics-acceleration`;
  try {
    const list = await admin.get('/api/liekan/analytics-acceleration');
    expect(list.status).toBe(200);
    expect(list.body.supported).toBe(true);
    expect(list.body.websites.some(row => row.id === website.id)).toBe(true);
    expect(
      (await admin.get('/api/liekan/analytics-acceleration', { params: { cursor: 'invalid' } }))
        .status,
    ).toBe(400);
    const state = await admin.get(root);
    expect(state.status).toBe(200);
    expect(state.headers['cache-control']).toMatch(/private.*no-store/);
    expect(state.body).toMatchObject({
      websiteId: website.id,
      supported: true,
      mode: 'live',
      builds: [],
    });
    const disable = {
      action: 'disable',
      requestId: randomUUID(),
      expectedRevision: state.body.revision,
    };
    const disabled = await admin.post(`${root}/action`, disable);
    expect(disabled.status).toBe(200);
    expect(disabled.body.mode).toBe('disabled');
    expect((await admin.post(`${root}/action`, disable)).body).toEqual(disabled.body);
    expect((await admin.post(`${root}/action`, { ...disable, action: 'enable' })).status).toBe(409);
    expect(
      (await admin.post(`${root}/action`, { ...disable, requestId: randomUUID() })).status,
    ).toBe(409);
    const enabled = await admin.post(`${root}/action`, {
      action: 'enable',
      requestId: randomUUID(),
      expectedRevision: disabled.body.revision,
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.mode).toBe('live');
    const endAt = Math.floor(Date.now() / 3600000) * 3600000 - 3600000;
    const build = {
      preset: 'custom',
      startAt: endAt - 3600000,
      endAt,
      timezone: 'UTC',
      locale: 'en-US',
      requestId: randomUUID(),
      expectedRevision: enabled.body.revision,
    };
    const created = await admin.post(`${root}/build`, build);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ timezone: 'UTC', locale: 'en-US' });
    expect(created.body.id).toMatch(/^[a-f0-9-]{36}$/);
    expect((await admin.post(`${root}/build`, build)).body.id).toBe(created.body.id);
    expect((await admin.post(`${root}/build`, { ...build, startAt: endAt + 1 })).status).toBe(400);
    expect((await admin.post(`${root}/action`, { action: 'erase' })).status).toBe(400);
    const final = await admin.get(root);
    expect(
      final.body.builds.some(row => row.id === created.body.id && row.locale === 'en-US'),
    ).toBe(true);
  } finally {
    await deleteWebsite(admin, website.id);
  }
});

test('requires a full authorized session on acceleration and result endpoints', async ({
  admin,
  api,
  apiKey,
  share,
  user,
  seed,
}) => {
  test.skip(seed.db === 'clickhouse', 'PostgreSQL acceleration authority');
  const website = await createWebsite(admin);
  const root = `/api/liekan/websites/${website.id}`;
  const endAt = Date.now() - 3600000;
  const action = { action: 'disable', requestId: randomUUID(), expectedRevision: 0 };
  const build = {
    preset: 'custom',
    startAt: endAt - 3600000,
    endAt,
    timezone: 'UTC',
    requestId: randomUUID(),
    expectedRevision: 0,
  };
  try {
    const job = randomUUID();
    const shared = await share();
    for (const client of [api, apiKey, shared, user]) {
      const responses = [
        await client.get(`${root}/analytics-acceleration`),
        await client.post(`${root}/analytics-acceleration/action`, action),
        await client.post(`${root}/analytics-acceleration/build`, build),
        await client.get(`${root}/analytics-jobs/${job}`),
        await client.get(`${root}/analytics-jobs/${job}/result`),
        await client.delete(`${root}/analytics-jobs/${job}`, {
          headers: { 'X-Liekan-View': randomUUID() },
        }),
      ];
      for (const result of responses) expect([401, 403, 404]).toContain(result.status);
    }
    for (const client of [api, apiKey, shared])
      expect([401, 403]).toContain((await client.get('/api/liekan/analytics-acceleration')).status);
    const ownList = await user.get('/api/liekan/analytics-acceleration');
    expect(ownList.status).toBe(200);
    expect(ownList.body.websites.some(row => row.id === website.id)).toBe(false);
    expect((await admin.get(`${root}/analytics-jobs/not-a-uuid`)).status).toBe(400);
    expect((await admin.get(`${root}/analytics-jobs/${job}`)).status).toBe(410);
    expect((await admin.get(`${root}/analytics-jobs/${job}/result`)).status).toBe(410);
  } finally {
    await deleteWebsite(admin, website.id);
  }
});

test('reads an asynchronous analytics job and its private result within the owning website', async ({
  admin,
  seed,
}) => {
  test.skip(seed.db === 'clickhouse', 'PostgreSQL background analytics');
  test.setTimeout(60000);
  const website = await createWebsite(admin);
  const other = await createWebsite(admin);
  try {
    const endAt = Date.now() - 86400000;
    const accepted = await admin.get(`/api/websites/${website.id}/stats`, {
      params: { startAt: endAt - 3600000, endAt, timezone: 'UTC' },
      headers: { prefer: 'respond-async' },
    });
    expect(accepted.status).toBe(202);
    const jobId = accepted.body.analysisJob.id;
    const root = `/api/liekan/websites/${website.id}/analytics-jobs/${jobId}`;
    const status = await admin.get(root);
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toMatch(/private.*no-store/);
    expect(status.body.analysisJob).toMatchObject({ id: jobId, websiteId: website.id });
    expect((await admin.delete(root, { headers: { 'X-Liekan-View': 'invalid' } })).status).toBe(
      400,
    );
    const released = await admin.delete(root, { headers: { 'X-Liekan-View': randomUUID() } });
    expect(released.status).toBe(200);
    expect(released.body).toEqual({ released: true });
    const first = await admin.get(`${root}/result`);
    expect([200, 202]).toContain(first.status);
    expect(first.headers['cache-control']).toMatch(/private.*no-store/);
    expect(
      (await admin.get(`/api/liekan/websites/${other.id}/analytics-jobs/${jobId}`)).status,
    ).toBe(410);
    expect(
      (await admin.get(`/api/liekan/websites/${other.id}/analytics-jobs/${jobId}/result`)).status,
    ).toBe(410);
    await expect
      .poll(async () => (await admin.get(`${root}/result`)).status, {
        timeout: 45000,
        intervals: [500, 1000, 2000],
      })
      .toBe(200);
  } finally {
    await deleteWebsite(admin, website.id);
    await deleteWebsite(admin, other.id);
  }
});
