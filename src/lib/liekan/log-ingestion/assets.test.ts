import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { readAgentManifest, readDockerManifest } from './assets';
const files = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('node:fs/promises', () => {
  const mocked = {
    readFile: vi.fn(async (path: string) => {
      const file = files.get(path.split('/').pop()!);
      if (!file) throw new Error('missing');
      return file;
    }),
    stat: vi.fn(async (path: string) => {
      if (!files.has(path.split('/').pop()!)) throw new Error('missing');
      return { isFile: () => true };
    }),
  };
  return { ...mocked, default: mocked };
});
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
beforeEach(() => {
  files.clear();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  for (const name of ['install.sh', 'install-docker.sh', 'agent-docker.tar.gz', 'agent-docker.zip'])
    files.set(name, Buffer.from(name));
  const bytes = Buffer.from(
    JSON.stringify({
      version: '1.0.0',
      protocol: 1,
      runtime: '22.23.4',
      installerSha256: sha(files.get('install.sh')!),
      platforms: Object.fromEntries(
        ['x64', 'arm64'].map(arch => [
          arch,
          { file: `agent-linux-${arch}.tar.gz`, sha256: 'a'.repeat(64) },
        ]),
      ),
      docker: {
        file: 'agent-docker.tar.gz',
        sha256: sha(files.get('agent-docker.tar.gz')!),
        zipFile: 'agent-docker.zip',
        zipSha256: sha(files.get('agent-docker.zip')!),
        installerSha256: sha(files.get('install-docker.sh')!),
      },
    }),
  );
  files.set('manifest.json', bytes);
  files.set('manifest.sig', sign(null, bytes, privateKey));
  files.set('manifest.pub', Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })));
});
it('verifies Docker delivery without native archives or native installer', async () => {
  files.delete('install.sh');
  await expect(readDockerManifest()).resolves.toMatchObject({
    docker: { file: 'agent-docker.tar.gz' },
  });
  await expect(readAgentManifest()).rejects.toThrow();
});
it.each([
  'manifest.json',
  'manifest.sig',
  'agent-docker.tar.gz',
  'agent-docker.zip',
  'install-docker.sh',
])('rejects tampered delivery file %s', async name => {
  files.set(name, Buffer.from('tampered'));
  await expect(readDockerManifest()).rejects.toThrow();
});
