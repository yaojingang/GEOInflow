// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiTransaction } from './ai-db';
import { tokenHash } from '../log-ingestion/secrets';
import { saveSettings } from '../store';
import { stopWebsiteSources } from './lifecycle';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinFile, runOnce } from '../../../../public/liekan-robots-agent.mjs';
const mocks = vi.hoisted(() => ({ probe: vi.fn(), verify: vi.fn() }));
vi.mock('../crawler-control/public-probe', () => ({ publicCrawlerProbe: mocks.probe }));
vi.mock('../crawler-control/diagnostics', () => ({ verifyCrawlerDomain: mocks.verify }));
import {
  changeRobotsManagement as change,
  getRobotsManagement as get,
  robotsAgentRequest as agent,
  processRobotsManagement as work,
  robotsDigest,
  pauseRobotsForRestore,
} from './robots-management';
const enabled = process.env.LIEKAN_ROBOTS_TEST === '1';
describe.skipIf(!enabled)('robots lifecycle on isolated PostgreSQL', () => {
  const owner = randomUUID(),
    stranger = randomUUID(),
    site = randomUUID();
  const actor = { id: owner, role: 'user' };
  const q = (sql: string, ...args: unknown[]) => aiTransaction(tx => tx.query(sql, ...args));
  const original = 'User-agent: *\nAllow: /\n';
  const changed = 'User-agent: GPTBot\nDisallow: /private\n';
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL || 'http://invalid');
    if (
      target.hostname !== '127.0.0.1' ||
      target.port !== '15441' ||
      target.pathname !== '/liekan_robots_acceptance'
    )
      throw new Error('Only isolated DB15441 is allowed');
    for (const id of [owner, stranger])
      await q(
        `INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$2,'test-demo-no-login','user')`,
        id,
        'test-demo-robots-' + id,
      );
    await q(
      `INSERT INTO website(website_id,name,domain,user_id) VALUES($1::uuid,'test-demo-robots','example.com',$2::uuid)`,
      site,
      owner,
    );
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.verify.mockResolvedValue('verified');
    mocks.probe.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: original,
    });
    await q('DELETE FROM liekan_robots_deployment WHERE website_id=$1::uuid', site);
    await q('DELETE FROM liekan_robots_snapshot WHERE website_id=$1::uuid', site);
    await q('DELETE FROM liekan_robots_state WHERE website_id=$1::uuid', site);
    await q('DELETE FROM liekan_setting WHERE website_id=$1::uuid', site);
    await q(
      `UPDATE website SET domain='example.com',user_id=$2::uuid WHERE website_id=$1::uuid`,
      site,
      owner,
    );
  });
  afterAll(async () => {
    await q('DELETE FROM website WHERE website_id=$1::uuid', site);
    for (const id of [owner, stranger]) await q('DELETE FROM "user" WHERE user_id=$1::uuid', id);
  });
  const save = async (content = changed) =>
    change(actor, site, { action: 'save', content, revision: (await get(actor, site)).revision });
  async function connect(content: string | null = original) {
    const pairing: any = await change(actor, site, { action: 'pair' });
    const result: any = await agent({
      action: 'pair',
      code: pairing.code,
      path: '/var/www/site/robots.txt',
    });
    await agent({ action: 'poll', content }, result.token);
    return { ...result, code: pairing.code };
  }
  async function queued(content: string | null = original) {
    const connection = await connect(content);
    await save();
    const preview: any = await change(actor, site, { action: 'preview' });
    await change(actor, site, { action: 'confirm', id: preview.id });
    return { ...connection, id: preview.id };
  }
  async function changeWebsiteContext(field: 'domain' | 'owner', away: boolean) {
    await aiTransaction(async tx => {
      await stopWebsiteSources({ $queryRawUnsafe: tx.query, $executeRawUnsafe: tx.execute }, site);
      if (field === 'domain')
        await tx.execute(
          'UPDATE website SET domain=$2 WHERE website_id=$1::uuid',
          site,
          away ? 'new.example.com' : 'example.com',
        );
      else
        await tx.execute(
          'UPDATE website SET user_id=$2::uuid WHERE website_id=$1::uuid',
          site,
          away ? stranger : owner,
        );
    });
  }
  it('preserves drafts on live reads, records changes and keeps failures distinct', async () => {
    await save();
    await change(actor, site, { action: 'read' });
    expect((await get(actor, site)).draft).toBe(changed);
    await change(actor, site, { action: 'monitor', enabled: true, interval: 15 });
    mocks.probe.mockResolvedValueOnce({ status: 200, headers: {}, body: changed });
    await work();
    let state = await get(actor, site);
    expect(state.changePending).toBe(true);
    expect(state.snapshots).toHaveLength(2);
    expect(state.observedContent).toBe(changed);
    await change(actor, site, { action: 'acknowledge' });
    mocks.probe.mockRejectedValueOnce(new Error('offline'));
    await q('UPDATE liekan_robots_state SET next_check=now() WHERE website_id=$1::uuid', site);
    await work();
    state = await get(actor, site);
    expect(state.lastError).toBe('public-check-unavailable');
    expect(state.observedContent).toBe(changed);
    expect(state.changePending).toBe(false);
  });
  it('synchronizes legacy settings edits and invalidates an earlier publish preview', async () => {
    await connect();
    await save();
    const before = await get(actor, site);
    const preview: any = await change(actor, site, { action: 'preview' });
    await saveSettings(site, { robots: original }, { userId: owner });
    const current = await get(actor, site);
    expect(current.draft).toBe(original);
    expect(current.revision).toBe(before.revision + 1);
    expect(
      (await q('SELECT robots FROM liekan_setting WHERE website_id=$1::uuid', site))[0].robots,
    ).toBe(original);
    await expect(change(actor, site, { action: 'confirm', id: preview.id })).rejects.toMatchObject({
      status: 409,
    });
    const fresh: any = await change(actor, site, { action: 'preview' });
    expect(fresh.data.deployments.find(job => job.id === fresh.id).content).toBe(original);
  });
  it('rejects a contended legacy draft update without waiting for the helper state lock', async () => {
    await save();
    let release: () => void;
    let locked: () => void;
    const ready = new Promise<void>(resolve => {
      locked = resolve;
    });
    const untilReleased = new Promise<void>(resolve => {
      release = resolve;
    });
    const holder = aiTransaction(async tx => {
      await tx.query(
        'SELECT website_id FROM liekan_robots_state WHERE website_id=$1::uuid FOR UPDATE',
        site,
      );
      locked();
      await untilReleased;
    });
    await ready;
    try {
      await expect(
        saveSettings(site, { robots: original }, { userId: owner }),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      release();
      await holder;
    }
    expect((await get(actor, site)).draft).toBe(changed);
    expect(
      (await q('SELECT robots FROM liekan_setting WHERE website_id=$1::uuid', site))[0].robots,
    ).toBe(changed);
    await saveSettings(site, { robots: original }, { userId: owner });
    expect((await get(actor, site)).draft).toBe(original);
  });
  it('inherits a legacy edit when robots management state is initialized later', async () => {
    await saveSettings(site, { robots: changed }, { userId: owner });
    expect(
      await q('SELECT website_id FROM liekan_robots_state WHERE website_id=$1::uuid', site),
    ).toHaveLength(0);
    expect((await get(actor, site)).draft).toBe(changed);
    await connect();
    const current = await get(actor, site);
    expect(current.draft).toBe(changed);
    expect(current.revision).toBe(1);
  });
  it('leaves a managed draft and preview unchanged on an unrelated legacy settings edit', async () => {
    await connect();
    await save();
    const before = await get(actor, site);
    const preview: any = await change(actor, site, { action: 'preview' });
    await saveSettings(site, { allowlist: ['192.0.2.0/24'] }, { userId: owner });
    const current = await get(actor, site);
    expect(current.draft).toBe(before.draft);
    expect(current.revision).toBe(before.revision);
    await change(actor, site, { action: 'confirm', id: preview.id });
    expect((await get(actor, site)).deployments.find(job => job.id === preview.id).state).toBe(
      'queued',
    );
  });
  it('runs the real file helper through publication, public verification and rollback', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'robots-lifecycle-')));
    try {
      const file = join(directory, 'robots.txt'),
        stateDir = join(directory, 'state');
      await mkdir(stateDir, { mode: 0o700 });
      await writeFile(file, original);
      const connection = await connect();
      await save();
      const config = {
        pin: await pinFile(file),
        stateDir,
        url: 'https://analytics.example',
        token: connection.token,
      };
      const fetcher = async (_url: string, body: any, token: string) => agent(body, token);
      const preview: any = await change(actor, site, { action: 'preview' });
      await change(actor, site, { action: 'confirm', id: preview.id });
      await runOnce(config, fetcher);
      await runOnce(config, fetcher);
      expect(await readFile(file, 'utf8')).toBe(changed);
      mocks.probe.mockImplementation(async () => ({
        status: 200,
        headers: {},
        body: await readFile(file, 'utf8'),
      }));
      await work();
      expect((await get(actor, site)).deployments[0].state).toBe('verified');
      const rollback: any = await change(actor, site, {
        action: 'preview',
        rollbackOf: preview.id,
      });
      await change(actor, site, { action: 'confirm', id: rollback.id });
      await runOnce(config, fetcher);
      await runOnce(config, fetcher);
      await work();
      expect(await readFile(file, 'utf8')).toBe(original);
      expect((await get(actor, site)).deployments.find(job => job.id === rollback.id).state).toBe(
        'verified',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('rejects draft races, unrelated users and invalid syntax at publication', async () => {
    await save();
    await expect(
      change(actor, site, { action: 'save', content: original, revision: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(get({ id: stranger, role: 'user' }, site)).rejects.toMatchObject({ status: 404 });
    await connect();
    await save('Invalid robots content');
    await expect(change(actor, site, { action: 'preview' })).rejects.toMatchObject({ status: 400 });
  });
  it('bounds manual checks and distinguishes a missing file from an empty file', async () => {
    mocks.probe.mockResolvedValueOnce({ status: 404, headers: {}, body: null });
    await change(actor, site, { action: 'read' });
    const missing = await get(actor, site);
    expect(missing.observedStatus).toBe(404);
    expect(missing.observedContent).toBeNull();
    await expect(change(actor, site, { action: 'read' })).rejects.toMatchObject({ status: 429 });
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    await q(
      "UPDATE liekan_robots_state SET last_read_at=now()-interval '2 minutes' WHERE website_id=$1::uuid",
      site,
    );
    mocks.probe.mockResolvedValueOnce({ status: 200, headers: {}, body: '' });
    await change(actor, site, { action: 'read' });
    const empty = await get(actor, site);
    expect(empty.observedStatus).toBe(200);
    expect(empty.observedContent).toBe('');
    expect(empty.changePending).toBe(true);
  });
  it('stores only credential hashes and consumes pairing codes once', async () => {
    const connection = await connect();
    const [stored] = await q('SELECT * FROM liekan_robots_state WHERE website_id=$1::uuid', site);
    expect(stored.credential_hash).toBe(tokenHash(connection.token));
    expect(stored.pair_hash).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(connection.token);
    await expect(
      agent({ action: 'pair', code: connection.code, path: '/var/www/site/robots.txt' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(JSON.stringify(await get(actor, site))).not.toContain(connection.token);
  });
  it('requires confirmation, returns one job, verifies publication and previews rollback', async () => {
    const connection = await connect();
    await save();
    const preview: any = await change(actor, site, { action: 'preview' });
    expect(
      ((await agent({ action: 'poll', content: original }, connection.token)) as any).job,
    ).toBeNull();
    await change(actor, site, { action: 'confirm', id: preview.id });
    const response: any = await agent({ action: 'poll', content: original }, connection.token);
    expect(response.job).toMatchObject({
      id: preview.id,
      expectedHash: robotsDigest(original),
      targetHash: robotsDigest(changed),
      content: changed,
    });
    expect(
      ((await agent({ action: 'poll', content: changed }, connection.token)) as any).job,
    ).toBeNull();
    await agent(
      {
        action: 'poll',
        content: changed,
        receipt: { id: preview.id, state: 'applied', hash: robotsDigest(changed) },
      },
      connection.token,
    );
    mocks.probe.mockResolvedValue({ status: 200, headers: {}, body: changed });
    await work();
    expect((await get(actor, site)).deployments[0].state).toBe('verified');
    const rollback: any = await change(actor, site, { action: 'preview', rollbackOf: preview.id });
    expect(rollback.data.deployments.find((d: any) => d.id === rollback.id)).toMatchObject({
      before_content: changed,
      content: original,
      rollback_of: preview.id,
    });
  });
  it('preserves a missing original file as a deletion rollback', async () => {
    const connection = await queued(null);
    const response: any = await agent({ action: 'poll', content: null }, connection.token);
    await agent(
      {
        action: 'poll',
        content: changed,
        receipt: { id: connection.id, state: 'applied', hash: robotsDigest(changed) },
      },
      connection.token,
    );
    mocks.probe.mockResolvedValue({ status: 200, headers: {}, body: changed });
    await work();
    const rollback: any = await change(actor, site, {
      action: 'preview',
      rollbackOf: connection.id,
    });
    expect(response.job.expectedHash).toBe(robotsDigest(null));
    expect(rollback.data.deployments.find((d: any) => d.id === rollback.id).content).toBeNull();
  });
  it('blocks stale previews and intervening server file edits', async () => {
    const connection = await connect();
    await save();
    const preview: any = await change(actor, site, { action: 'preview' });
    await save(original);
    await expect(change(actor, site, { action: 'confirm', id: preview.id })).rejects.toMatchObject({
      status: 409,
    });
    const next: any = await change(actor, site, { action: 'preview' });
    await change(actor, site, { action: 'confirm', id: next.id });
    expect(
      (
        (await agent(
          { action: 'poll', content: 'User-agent: *\nDisallow: /' },
          connection.token,
        )) as any
      ).job,
    ).toBeNull();
    expect((await get(actor, site)).deployments.find(d => d.id === next.id).state).toBe('conflict');
  });
  it('quarantines missing receipts without reissuing writes and reconciles fresh helper evidence', async () => {
    const connection = await queued();
    await agent({ action: 'poll', content: original }, connection.token);
    await q(
      "UPDATE liekan_robots_deployment SET lease_until=now()-interval '1 second' WHERE id=$1::uuid",
      connection.id,
    );
    await work();
    expect((await get(actor, site)).deployments[0].state).toBe('unknown');
    await expect(change(actor, site, { action: 'preview' })).rejects.toMatchObject({ status: 409 });
    const poll: any = await agent({ action: 'poll', content: changed }, connection.token);
    expect(poll.job).toBeNull();
    await change(actor, site, { action: 'reconcile', id: connection.id });
    expect((await get(actor, site)).deployments[0].state).toBe('applied');
  });
  it('keeps an older active deployment visible through bounded history and recovery', async () => {
    const connection = await connect();
    await save();
    const preview: any = await change(actor, site, { action: 'preview' });
    for (let index = 0; index < 20; index++) await change(actor, site, { action: 'preview' });
    const history = (await get(actor, site)).deployments;
    expect(history).toHaveLength(20);
    expect(history.some(job => job.id === preview.id)).toBe(false);
    const expectVisible = (data: Awaited<ReturnType<typeof get>>, state: string) => {
      expect(data.deployments).toHaveLength(20);
      expect(data.deployments[0]).toMatchObject({ id: preview.id, state });
      expect(data.deployments.slice(1).map(job => job.id)).toEqual(
        history.slice(0, 19).map(job => job.id),
      );
    };
    const confirmed: any = await change(actor, site, { action: 'confirm', id: preview.id });
    expectVisible(confirmed.data, 'queued');
    expectVisible(await get(actor, site), 'queued');
    expect(await agent({ action: 'poll', content: original }, connection.token)).toMatchObject({
      job: { id: preview.id },
    });
    expectVisible(await get(actor, site), 'leased');
    await q(
      "UPDATE liekan_robots_deployment SET lease_until=now()-interval '1 second' WHERE id=$1::uuid",
      preview.id,
    );
    await work();
    expectVisible(await get(actor, site), 'unknown');
    await expect(change(actor, site, { action: 'preview' })).rejects.toMatchObject({ status: 409 });
    await agent({ action: 'poll', content: changed }, connection.token);
    const reconciled: any = await change(actor, site, { action: 'reconcile', id: preview.id });
    expectVisible(reconciled.data, 'applied');
    expectVisible(await get(actor, site), 'applied');
    mocks.probe.mockResolvedValue({ status: 200, headers: {}, body: changed });
    await work();
    expect(
      (await q('SELECT state FROM liekan_robots_deployment WHERE id=$1::uuid', preview.id))[0]
        .state,
    ).toBe('verified');
    expect((await get(actor, site)).deployments.map(job => job.id)).toEqual(
      history.map(job => job.id),
    );
    const resumed: any = await change(actor, site, { action: 'preview' });
    expect(resumed.id).toBeTruthy();
  });
  it('rechecks owner authority and domain before server commands', async () => {
    const connection = await queued();
    await q("UPDATE website SET domain='new.example.com' WHERE website_id=$1::uuid", site);
    const poll: any = await agent({ action: 'poll', content: original }, connection.token);
    expect(poll).toMatchObject({ revoked: true, job: null });
    await expect(
      change(actor, site, { action: 'confirm', id: connection.id }),
    ).resolves.toBeDefined();
    expect((await get(actor, site)).agent.contextValid).toBe(false);
  });
  it.each(['domain', 'owner'] as const)(
    'keeps robots authority revoked after a %s round trip through website lifecycle',
    async field => {
      const connection = await connect();
      await save();
      const preview: any = await change(actor, site, { action: 'preview' });
      const publishing: any = await change(actor, site, { action: 'preview' });
      await change(actor, site, { action: 'confirm', id: publishing.id });
      await change(actor, site, { action: 'monitor', enabled: true, interval: 15 });
      await q(
        "UPDATE liekan_robots_state SET check_lease=$2::uuid,checking_until=now()+interval '1 minute' WHERE website_id=$1::uuid",
        site,
        randomUUID(),
      );
      await changeWebsiteContext(field, true);
      await changeWebsiteContext(field, false);
      const current = await get(actor, site);
      expect(current.agent).toMatchObject({ connected: false, contextValid: false });
      expect(current.monitor).toBe(false);
      expect(current.deployments.find(job => job.id === preview.id).state).toBe('cancelled');
      expect(current.deployments.find(job => job.id === publishing.id).state).toBe('cancelled');
      const [stored] = await q('SELECT * FROM liekan_robots_state WHERE website_id=$1::uuid', site);
      expect(stored).toMatchObject({
        check_lease: null,
        checking_until: null,
        agent_id: connection.agentId,
        credential_hash: tokenHash(connection.token),
      });
      expect(await agent({ action: 'poll', content: original }, connection.token)).toMatchObject({
        revoked: true,
        job: null,
      });
      await expect(change(actor, site, { action: 'preview' })).rejects.toMatchObject({
        status: 409,
      });
    },
  );
  it('expires pairing codes permanently when website context changes', async () => {
    await connect();
    const pairing: any = await change(actor, site, { action: 'pair' });
    await changeWebsiteContext('domain', true);
    await changeWebsiteContext('domain', false);
    await expect(
      agent({ action: 'pair', code: pairing.code, path: '/var/www/site/robots.txt' }),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('retains in-flight receipts after website lifecycle invalidates the binding', async () => {
    const connection = await queued();
    await agent({ action: 'poll', content: original }, connection.token);
    await changeWebsiteContext('domain', true);
    await changeWebsiteContext('domain', false);
    expect((await get(actor, site)).deployments[0].state).toBe('unknown');
    const receipt: any = await agent(
      {
        action: 'poll',
        content: changed,
        receipt: { id: connection.id, state: 'applied', hash: robotsDigest(changed) },
      },
      connection.token,
    );
    expect(receipt).toMatchObject({ ack: connection.id, revoked: true, job: null });
    expect((await get(actor, site)).deployments[0].state).toBe('applied');
    const [stored] = await q(
      'SELECT applied_at FROM liekan_robots_deployment WHERE id=$1::uuid',
      connection.id,
    );
    expect(stored.applied_at).toBeTruthy();
  });
  it('rejects lifecycle changes without waiting when a helper holds the state lock', async () => {
    await connect();
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => {
      locked = resolve;
    });
    const untilReleased = new Promise<void>(resolve => {
      release = resolve;
    });
    const holder = aiTransaction(async tx => {
      await tx.query(
        'SELECT website_id FROM liekan_robots_state WHERE website_id=$1::uuid FOR UPDATE',
        site,
      );
      locked();
      await untilReleased;
    });
    await ready;
    try {
      await expect(changeWebsiteContext('domain', true)).rejects.toMatchObject({ status: 409 });
    } finally {
      release();
      await holder;
    }
    expect((await get(actor, site)).hostname).toBe('example.com');
    expect((await get(actor, site)).agent.connected).toBe(true);
    await changeWebsiteContext('domain', true);
  });
  it.each(['domain', 'owner'] as const)(
    'fences an in-flight monitor result when the %s monitor configuration is replaced',
    async field => {
      await change(actor, site, { action: 'monitor', enabled: true, interval: 15 });
      let entered!: () => void, release!: (value: any) => void;
      const probing = new Promise<void>(resolve => {
        entered = resolve;
      });
      const result = new Promise(resolve => {
        release = resolve;
      });
      mocks.probe.mockImplementationOnce(() => {
        entered();
        return result;
      });
      const running = work();
      await probing;
      try {
        if (field === 'domain')
          await q("UPDATE website SET domain='new.example.com' WHERE website_id=$1::uuid", site);
        else
          await q('UPDATE website SET user_id=$2::uuid WHERE website_id=$1::uuid', site, stranger);
        await change(field === 'domain' ? actor : { id: stranger, role: 'user' }, site, {
          action: 'monitor',
          enabled: true,
          interval: 15,
        });
      } finally {
        release({ status: 200, headers: {}, body: changed });
        await running;
      }
      const nextActor = field === 'domain' ? actor : { id: stranger, role: 'user' };
      const current = await get(nextActor, site);
      expect(current.monitor).toBe(true);
      expect(current.lastError).toBeNull();
      expect(current.checkedAt).toBeNull();
      expect(current.snapshots).toHaveLength(0);
      await work();
      expect(mocks.probe).toHaveBeenLastCalledWith(
        field === 'domain' ? 'new.example.com' : 'example.com',
        '/robots.txt',
        expect.any(String),
        true,
      );
      expect((await get(nextActor, site)).observedContent).toBe(original);
    },
  );
  it('pauses restored credentials and reconciles old evidence without restoring write authority', async () => {
    const connection = await queued();
    await agent({ action: 'poll', content: original }, connection.token);
    await aiTransaction(tx => pauseRobotsForRestore(tx));
    expect((await get(actor, site)).deployments[0].state).toBe('unknown');
    const response: any = await agent({ action: 'poll', content: original }, connection.token);
    expect(response).toMatchObject({ revoked: true, job: null });
    await change(actor, site, { action: 'reconcile', id: connection.id });
    expect((await get(actor, site)).deployments[0].state).toBe('failed');
    await expect(change(actor, site, { action: 'preview' })).rejects.toMatchObject({ status: 409 });
  });
  it('quarantines a restored queued job and accepts its post-backup applied receipt', async () => {
    const connection = await queued();
    // A restored queued row can precede a helper lease and write performed after the backup.
    await aiTransaction(tx => pauseRobotsForRestore(tx));
    expect((await get(actor, site)).deployments[0].state).toBe('unknown');
    await expect(change(actor, site, { action: 'pair' })).rejects.toMatchObject({ status: 409 });
    const receipt: any = await agent(
      {
        action: 'poll',
        content: changed,
        receipt: { id: connection.id, state: 'applied', hash: robotsDigest(changed) },
      },
      connection.token,
    );
    expect(receipt).toMatchObject({ ack: connection.id, revoked: true, job: null });
    const current = await get(actor, site);
    expect(current.deployments[0].state).toBe('applied');
    expect(current.agent.connected).toBe(false);
    const [stored] = await q(
      'SELECT applied_at FROM liekan_robots_deployment WHERE id=$1::uuid',
      connection.id,
    );
    expect(stored.applied_at).toBeTruthy();
  });
  it('revokes queued work and still accepts in-flight receipts for audit', async () => {
    const connection = await queued();
    await agent({ action: 'poll', content: original }, connection.token);
    await change(actor, site, { action: 'revoke' });
    const poll: any = await agent(
      {
        action: 'poll',
        content: changed,
        receipt: { id: connection.id, state: 'applied', hash: robotsDigest(changed) },
      },
      connection.token,
    );
    expect(poll).toMatchObject({ ack: connection.id, revoked: true, job: null });
    expect((await get(actor, site)).deployments[0].state).toBe('applied');
  });
  it('keeps cache mismatches pending and allows explicit verification retry', async () => {
    const connection = await queued();
    await agent({ action: 'poll', content: original }, connection.token);
    await agent(
      {
        action: 'poll',
        content: changed,
        receipt: { id: connection.id, state: 'applied', hash: robotsDigest(changed) },
      },
      connection.token,
    );
    await work();
    expect((await get(actor, site)).deployments[0].state).toBe('applied');
    await q(
      "UPDATE liekan_robots_deployment SET verify_after=now(),verify_deadline=now()-interval '1 second' WHERE id=$1::uuid",
      connection.id,
    );
    await work();
    expect((await get(actor, site)).deployments[0].state).toBe('verification_failed');
    await change(actor, site, { action: 'verify', id: connection.id });
    mocks.probe.mockResolvedValue({ status: 200, headers: {}, body: changed });
    await work();
    expect((await get(actor, site)).deployments[0].state).toBe('verified');
  });
});
