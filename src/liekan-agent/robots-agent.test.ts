// @vitest-environment node
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
  chmod,
  stat,
  rename,
  link,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, afterEach, expect, it } from 'vitest';
import {
  pinFile,
  readPinned,
  applyJob,
  recoverJournal,
  atomicJson,
  digest,
  runOnce,
  preparePrivateState,
  denyOnlyDirectoryAcl,
  endpoint,
} from '../../public/liekan-robots-agent.mjs';
let folder: string, state: string, path: string, pin: any;
const old = 'User-agent: *\nAllow: /\n',
  next = 'User-agent: GPTBot\nDisallow: /\n';
const job = (before: string | null = old, after: string | null = next) => ({
  id: randomUUID(),
  expectedHash: digest(before),
  targetHash: digest(after),
  content: after,
  expiresAt: new Date(Date.now() + 30000).toISOString(),
});
beforeEach(async () => {
  folder = await realpath(await mkdtemp(join(tmpdir(), 'liekan-robots-')));
  state = join(folder, 'state');
  await mkdir(state, { mode: 0o700 });
  await mkdir(join(folder, 'web'));
  path = join(folder, 'web', 'robots.txt');
  await writeFile(path, old);
  pin = await pinFile(path);
});
afterEach(() => rm(folder, { recursive: true, force: true }));
it('atomically writes the pinned file, preserves permissions, backs up and replays receipts', async () => {
  await chmod(path, 0o640);
  const task = job();
  expect(await applyJob(pin, state, task)).toMatchObject({
    id: task.id,
    state: 'applied',
    hash: digest(next),
  });
  expect(await readFile(path, 'utf8')).toBe(next);
  expect((await stat(path)).mode & 0o777).toBe(0o640);
  expect(JSON.parse(await readFile(join(state, 'backups', task.id + '.json'), 'utf8')).before).toBe(
    old,
  );
  await writeFile(path, 'manual edit after publication');
  expect(await applyJob(pin, state, task)).toMatchObject({ state: 'applied' });
  expect(await readFile(path, 'utf8')).toBe('manual edit after publication');
});
it('persists conflicts without changing a file edited after preview', async () => {
  await writeFile(path, 'manually changed');
  const task = job();
  expect(await applyJob(pin, state, task)).toMatchObject({ state: 'conflict' });
  expect(await recoverJournal(pin, state)).toMatchObject({ state: 'conflict' });
  expect(await readFile(path, 'utf8')).toBe('manually changed');
});
it.each([
  ['target', 'applied'],
  ['original', 'failed'],
  ['other', 'unknown'],
])('recovers a prepared journal against %s content as %s', async (content, result) => {
  const task = job();
  await atomicJson(join(state, 'pending.json'), { job: task, before: old });
  await writeFile(
    path,
    content === 'target' ? next : content === 'original' ? old : 'external edit',
  );
  expect(await recoverJournal(pin, state)).toMatchObject({ id: task.id, state: result });
});
it('creates a missing robots file and rolls back by deleting it', async () => {
  await rm(path);
  expect((await readPinned(pin)).content).toBeNull();
  expect(await applyJob(pin, state, job(null, next))).toMatchObject({ state: 'applied' });
  await rm(join(state, 'pending.json'));
  expect(await applyJob(pin, state, job(next, null))).toMatchObject({ state: 'applied' });
  expect((await readPinned(pin)).content).toBeNull();
});
it('rejects final symlinks, hard links and replaced parent directories', async () => {
  const other = join(folder, 'other');
  await writeFile(other, old);
  await rm(path);
  await symlink(other, path);
  await expect(readPinned(pin)).rejects.toBeDefined();
  await rm(path);
  await link(other, path);
  await expect(readPinned(pin)).rejects.toBeDefined();
  await rm(path);
  await writeFile(path, old);
  await rename(join(folder, 'web'), join(folder, 'retired'));
  await mkdir(join(folder, 'web'));
  await expect(readPinned(pin)).rejects.toThrow('directory-changed');
});
it('rejects symlinked parents, large files and expired jobs', async () => {
  const alias = join(folder, 'alias');
  await symlink(join(folder, 'web'), alias);
  await expect(pinFile(join(alias, 'robots.txt'))).rejects.toThrow('symlink-directory');
  await writeFile(path, 'x'.repeat(262145));
  await expect(readPinned(pin)).rejects.toThrow('invalid-file');
  await writeFile(path, old);
  const task = job();
  task.expiresAt = new Date(0).toISOString();
  await expect(applyJob(pin, state, task)).rejects.toThrow('invalid-job');
  expect(await readFile(path, 'utf8')).toBe(old);
});
it('retries receipts after disconnect and clears them only after acknowledgement', async () => {
  const task = job();
  await applyJob(pin, state, task);
  const config = { pin, stateDir: state, url: 'https://analytics.example', token: 'not-logged' };
  await expect(
    runOnce(config, async () => {
      throw new Error('offline');
    }),
  ).rejects.toThrow('offline');
  expect(await recoverJournal(pin, state)).toMatchObject({ id: task.id, state: 'applied' });
  expect(
    await runOnce(config, async (_url, body) => {
      expect(body.receipt.id).toBe(task.id);
      return { ack: task.id, revoked: true, job: null };
    }),
  ).toBe(false);
  expect(await recoverJournal(pin, state)).toBeNull();
});
it('distinguishes a missing file from an empty robots file', () =>
  expect(digest(null)).not.toBe(digest('')));

it('rejects mutable target ancestors before a deletion rollback can change any file', async () => {
  const task = job(old, null);
  const tenant = join(folder, 'tenant');
  const target = join(tenant, 'public');
  await mkdir(tenant);
  await mkdir(target);
  const targetFile = join(target, 'robots.txt');
  await writeFile(targetFile, old);
  const targetPin = await pinFile(targetFile);
  const outside = join(folder, 'outside');
  await mkdir(outside);
  const outsideFile = join(outside, 'robots.txt');
  await writeFile(outsideFile, old);
  await chmod(tenant, 0o777);
  try {
    await expect(applyJob(targetPin, state, task)).rejects.toThrow(
      'untrusted-directory-permissions',
    );
    expect(await readFile(outsideFile, 'utf8')).toBe(old);
    expect(await readFile(targetFile, 'utf8')).toBe(old);
    await expect(pinFile(targetFile)).rejects.toThrow('untrusted-directory-permissions');
    await expect(readFile(join(state, 'pending.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await chmod(tenant, 0o700);
  }
});

it('rejects shared pinned parents, including sticky ones', async () => {
  await chmod(join(folder, 'web'), 0o1777);
  await expect(readPinned(pin)).rejects.toThrow('untrusted-directory-permissions');
  expect(await readFile(path, 'utf8')).toBe(old);
});

it('accepts a trusted-owned child under a sticky ancestor', async () => {
  await chmod(folder, 0o1777);
  expect((await readPinned(pin)).content).toBe(old);
});

it('rejects unsafe state ancestry before creating directories or consuming a job', async () => {
  const shared = join(folder, 'shared');
  await mkdir(shared);
  await chmod(shared, 0o777);
  const unsafeState = join(shared, 'private');
  await expect(preparePrivateState(unsafeState)).rejects.toThrow('untrusted-directory-permissions');
  await expect(stat(unsafeState)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(applyJob(pin, unsafeState, job())).rejects.toThrow(
    'untrusted-directory-permissions',
  );
  expect(await readFile(path, 'utf8')).toBe(old);
});

it('requires existing state directories to remain private and rejects state symlinks', async () => {
  await chmod(state, 0o755);
  await expect(applyJob(pin, state, job())).rejects.toThrow('untrusted-state-directory');
  await chmod(state, 0o700);
  const alias = join(folder, 'state-alias');
  await symlink(state, alias);
  await expect(preparePrivateState(alias)).rejects.toThrow('untrusted-directory');
  expect(await readFile(path, 'utf8')).toBe(old);
});

it('parses deny-only Darwin ACL output and fails closed on grants or ambiguous entries', () => {
  const header = 'drwx------+ 2 owner group 64 Nov 1 10:00 /trusted/path';
  expect(denyOnlyDirectoryAcl(header + '\n 0: group:everyone deny delete\n')).toBe(true);
  expect(denyOnlyDirectoryAcl(header + '\n 0: group:everyone allow delete_child\n')).toBe(false);
  expect(denyOnlyDirectoryAcl(header + '\n 1: group:everyone deny delete\n')).toBe(false);
  expect(denyOnlyDirectoryAcl(header + '\n 0: group:everyone deny unknown_permission\n')).toBe(
    false,
  );
  expect(denyOnlyDirectoryAcl(header + '\n malformed ACL\n')).toBe(false);
  expect(denyOnlyDirectoryAcl(header + '\n')).toBe(false);
});

it.skipIf(process.platform !== 'darwin')(
  'rejects Darwin ACL write grants that leave mode bits unchanged',
  async () => {
    const execute = promisify(execFile);
    const directory = join(folder, 'web');
    const before = (await stat(directory)).mode & 0o777;
    await execute('/bin/chmod', [
      '+a',
      'everyone allow add_file,add_subdirectory,delete_child',
      directory,
    ]);
    expect((await stat(directory)).mode & 0o777).toBe(before);
    await expect(readPinned(pin)).rejects.toThrow('untrusted-directory-acl');
    await expect(applyJob(pin, state, job(old, null))).rejects.toThrow('untrusted-directory-acl');
    expect(await readFile(path, 'utf8')).toBe(old);
  },
);

it.each([
  ['https://analytics.example.com', 'https://analytics.example.com/api/liekan/robots-agent'],
  ['https://analytics.example.com/', 'https://analytics.example.com/api/liekan/robots-agent'],
  [
    'https://analytics.example.com/analytics/',
    'https://analytics.example.com/analytics/api/liekan/robots-agent',
  ],
  [
    'https://analytics.example.com/analytics/api/liekan/robots-agent',
    'https://analytics.example.com/analytics/api/liekan/robots-agent',
  ],
  [
    'https://analytics.example.com/backend/v2/liekan/robots-agent/',
    'https://analytics.example.com/backend/v2/liekan/robots-agent',
  ],
  [
    'https://analytics.example.com/%E7%BB%9F%E8%AE%A1',
    'https://analytics.example.com/%E7%BB%9F%E8%AE%A1/api/liekan/robots-agent',
  ],
])('maps a supported helper URL %s to its exact endpoint', (input, expected) => {
  expect(endpoint(input)).toBe(expected);
});

it.each([
  'http://analytics.example.com',
  'https://user:password@analytics.example.com',
  'https://analytics.example.com/?token=value',
  'https://analytics.example.com/#fragment',
  'https://analytics.example.com/?',
  'https://analytics.example.com/#',
  'https://analytics.example.com/one/../two',
  'https://analytics.example.com/%2e%2e',
  'https://analytics.example.com/one%2ftwo',
  'https://analytics.example.com/one%5ctwo',
  'https://analytics.example.com/%252e%252e',
  'https://analytics.example.com/%zz',
  'https://analytics.example.com/one//two',
  'https://analytics.example.com/liekan/%72obots-agent',
  'https://analytics.example.com\\other',
])('rejects an ambiguous or credential-bearing helper URL %s', input => {
  expect(() => endpoint(input)).toThrow('invalid-url');
});
