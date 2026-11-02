import { beforeEach, expect, it, vi } from 'vitest';
import { createPairing, exchangePairing } from './pairing';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  sourceWebsite: vi.fn(),
  createSource: vi.fn(),
  capabilities: vi.fn(),
}));
vi.mock('../upstream/server', () => ({
  LiekanError: class extends Error {
    constructor(
      message: string,
      readonly status = 400,
    ) {
      super(message);
    }
  },
  transaction: (work: any) =>
    work({ $queryRawUnsafe: mocks.query, $executeRawUnsafe: mocks.execute }),
  sourceWebsite: mocks.sourceWebsite,
}));
vi.mock('./service', () => ({
  publicUrl: () => 'https://stats.example.com',
  ensureState: async () => ({ epoch: 1 }),
  createSource: mocks.createSource,
}));
vi.mock('./capabilities', () => ({ getLogCapabilities: mocks.capabilities }));
vi.mock('./assets', () => ({
  readAgentManifest: async () => ({ version: '1.0.0', installerSha256: 'a'.repeat(64) }),
  readDockerManifest: async () => ({
    version: '1.0.0',
    docker: { installerSha256: 'b'.repeat(64) },
  }),
}));
const website = '95c63874-b7d6-4370-b7fa-46f9d4624dc3';
const other = 'af3c5f8a-cf47-47b5-b611-66161b55069e';
const grant = {
  id: other,
  website_id: website,
  created_by: other,
  domain: 'example.com',
  epoch: 1,
  expires_at: new Date(Date.now() + 600000),
  consumed_at: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.sourceWebsite.mockResolvedValue({ domain: 'example.com' });
  mocks.query.mockResolvedValue([grant]);
  mocks.createSource.mockResolvedValue({
    source: { id: other, domain: 'example.com' },
    token: 'c'.repeat(43),
  });
  mocks.capabilities.mockResolvedValue({
    server: { available: true, runtimes: { docker: true, systemd: true } },
  });
});
it('rejects a code bound to another website before consuming it or creating a source', async () => {
  await expect(exchangePairing({ code: 'a'.repeat(43), websiteId: other })).rejects.toThrow(
    '配对码与当前部署的网站不一致',
  );
  expect(mocks.createSource).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
});
it('accepts explicit website binding and preserves legacy code-only exchange', async () => {
  for (const input of [{ code: 'a'.repeat(43), websiteId: website }, { code: 'a'.repeat(43) }])
    expect(await exchangePairing(input)).toMatchObject({
      websiteId: website,
      sourceId: other,
      epoch: 1,
    });
});
it('preserves legacy command generation and offers Docker explicitly', async () => {
  mocks.query.mockResolvedValue([{ count: 0 }]);
  const legacy = await createPairing(website, { userId: other });
  if (!('command' in legacy)) throw new Error('legacy pairing must not be manual');
  expect(legacy.runtime).toBe('systemd');
  expect(legacy.command.includes('/liekan-agent/install.sh')).toBe(true);
  const docker = await createPairing(website, { userId: other }, { runtime: 'docker' });
  if (!('command' in docker)) throw new Error('docker pairing must not be manual');
  expect(docker.runtime).toBe('docker');
  expect(docker.command.includes(`/liekan-agent/install-docker.sh`)).toBe(true);
  expect(docker.command.includes(`--website '${website}'`)).toBe(true);
});
it('issues a manual pairing code without app-served installer assets', async () => {
  mocks.query.mockResolvedValue([{ count: 0 }]);
  mocks.capabilities.mockResolvedValue({
    server: {
      available: false,
      reason: '采集器部署包尚未准备完成',
      runtimes: { docker: false, systemd: false },
      checks: [
        { id: 'public-url', state: 'ready' },
        { id: 'queue', state: 'ready' },
        { id: 'worker', state: 'ready' },
        { id: 'agent-package', state: 'missing' },
      ],
    },
  });
  const manual = await createPairing(website, { userId: other }, { manual: true });
  expect(manual).toMatchObject({
    manual: true,
    websiteId: website,
    url: 'https://stats.example.com',
  });
  expect(manual.pairingCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((manual as { command?: string }).command).toBeUndefined();
});
it('keeps manual pairing gated on shared ingestion prerequisites', async () => {
  mocks.capabilities.mockResolvedValue({
    server: {
      available: false,
      checks: [
        { id: 'public-url', state: 'ready' },
        { id: 'queue', state: 'unverified' },
        { id: 'worker', state: 'ready' },
      ],
    },
  });
  await expect(createPairing(website, { userId: other }, { manual: true })).rejects.toThrow(
    '日志队列尚未初始化',
  );
  expect(mocks.query).not.toHaveBeenCalled();
});
