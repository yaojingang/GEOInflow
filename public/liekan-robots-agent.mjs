#!/usr/bin/env node
// Copyright (c) Liekan contributors. MIT License.
// The local administrator pins one file; remote jobs contain content and hashes only.
import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, realpath, lstat, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, basename, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const digest = content =>
  createHash('sha256')
    .update(content === null ? 'missing\0' : `present\0${content}`)
    .digest('hex');
const maxBytes = 262144;
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const executeFile = promisify(execFile);
const aclPermissions = new Set([
  'read',
  'write',
  'execute',
  'delete',
  'append',
  'readattr',
  'writeattr',
  'readextattr',
  'writeextattr',
  'readsecurity',
  'writesecurity',
  'chown',
  'list',
  'search',
  'add_file',
  'add_subdirectory',
  'delete_child',
  'read_data',
  'write_data',
  'append_data',
  'file_inherit',
  'directory_inherit',
  'limit_inherit',
  'only_inherit',
  'inherited',
]);
const safetyErrors = new Set([
  'unsupported-filesystem-platform',
  'untrusted-directory',
  'untrusted-directory-owner',
  'untrusted-directory-permissions',
  'untrusted-directory-acl',
  'untrusted-state-directory',
  'untrusted-state-file',
  'invalid-url',
]);
const safetyCode = error =>
  safetyErrors.has(error?.message) ? error.message : 'operation-unavailable';

export function denyOnlyDirectoryAcl(output) {
  const [header, ...entries] = output.trimEnd().split('\n');
  if (!/^d[rwxStTs-]{9}[+@]?\s/.test(header ?? '')) return false;
  if (!entries.length) return header[10] !== '+';
  return entries.every((entry, index) => {
    const match = entry.match(
      /^\s+(\d+):\s+(?:user|group):(.+?)\s+(allow|deny)\s+([a-z_]+(?:,[a-z_]+)*)$/,
    );
    return (
      match &&
      Number(match[1]) === index &&
      match[3] === 'deny' &&
      match[4].split(',').every(permission => aclPermissions.has(permission))
    );
  });
}
async function checkDirectoryAcl(path) {
  if (process.platform !== 'darwin') return;
  try {
    const { stdout, stderr } = await executeFile('/bin/ls', ['-lde', '--', path], {
      encoding: 'utf8',
      env: { LC_ALL: 'C', LANG: 'C' },
      timeout: 5000,
      maxBuffer: 65536,
    });
    if (stderr.trim() || !denyOnlyDirectoryAcl(stdout)) throw new Error();
  } catch {
    throw new Error('untrusted-directory-acl');
  }
}
export async function trustedDirectory(path, { privateLeaf = false, creatingChild = false } = {}) {
  if (!['linux', 'darwin'].includes(process.platform) || typeof process.geteuid !== 'function')
    throw new Error('unsupported-filesystem-platform');
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('untrusted-directory');
  const effectiveUid = process.geteuid();
  let current = '/';
  let info;
  const chain = ['/', ...path.split('/').filter(Boolean)];
  for (let index = 0; index < chain.length; index++) {
    if (index) current = join(current, chain[index]);
    info = await lstat(current);
    const leaf = index === chain.length - 1;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('untrusted-directory');
    if (![0, effectiveUid].includes(info.uid)) throw new Error('untrusted-directory-owner');
    // Sticky ancestors protect a trusted-owned child; the final writable directory is rejected.
    if (info.mode & 0o022 && (!(info.mode & 0o1000) || (leaf && !creatingChild)))
      throw new Error('untrusted-directory-permissions');
    if (leaf && privateLeaf && (info.mode & 0o7777) !== 0o700)
      throw new Error('untrusted-state-directory');
    await checkDirectoryAcl(current);
  }
  return info;
}
export async function preparePrivateState(path) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('untrusted-state-directory');
  const missing = [];
  let ancestor = path;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  await trustedDirectory(ancestor, { creatingChild: missing.length > 0 });
  for (const part of missing) {
    ancestor = join(ancestor, part);
    await mkdir(ancestor, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await trustedDirectory(ancestor, { privateLeaf: true });
  }
  await trustedDirectory(path, { privateLeaf: true });
}
async function readPrivateJson(path) {
  await trustedDirectory(dirname(path), { privateLeaf: true });
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      ![0, process.geteuid()].includes(info.uid) ||
      info.mode & 0o022 ||
      info.size > 16 * maxBytes
    )
      throw new Error('untrusted-state-file');
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function atomicJson(path, value) {
  await trustedDirectory(dirname(path), { privateLeaf: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export async function pinFile(path) {
  if (!isAbsolute(path) || basename(path) !== 'robots.txt' || resolve(path) !== path)
    throw new Error('invalid-path');
  const parent = dirname(path);
  if ((await realpath(parent)) !== parent) throw new Error('symlink-directory');
  const info = await trustedDirectory(parent);
  return { path, parent, dev: info.dev, ino: info.ino };
}
async function checkPin(pin) {
  const current = await pinFile(pin.path);
  if (current.dev !== pin.dev || current.ino !== pin.ino) throw new Error('directory-changed');
}
export async function readPinned(pin) {
  await checkPin(pin);
  let file;
  try {
    file = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return { content: null, info: null };
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new Error('invalid-file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('file-too-large');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, length),
    );
    if (content.includes('\0')) throw new Error('invalid-content');
    return { content, info };
  } finally {
    await file.close();
  }
}
function validJob(job) {
  return (
    validId(job?.id) &&
    /^[a-f0-9]{64}$/.test(job.expectedHash) &&
    /^[a-f0-9]{64}$/.test(job.targetHash) &&
    (job.content === null ||
      (typeof job.content === 'string' &&
        Buffer.byteLength(job.content) <= maxBytes &&
        !job.content.includes('\0'))) &&
    digest(job.content) === job.targetHash &&
    Number.isFinite(Date.parse(job.expiresAt))
  );
}
export async function recoverJournal(pin, stateDir) {
  await trustedDirectory(stateDir, { privateLeaf: true });
  let journal;
  try {
    journal = await readPrivateJson(join(stateDir, 'pending.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!validJob(journal.job)) throw new Error('invalid-journal');
  if (journal.receipt) return journal.receipt;
  const actual = digest((await readPinned(pin)).content);
  const receipt = {
    id: journal.job.id,
    hash: actual,
    state:
      actual === journal.job.targetHash
        ? 'applied'
        : actual === journal.job.expectedHash
          ? 'failed'
          : 'unknown',
  };
  await atomicJson(join(stateDir, 'pending.json'), { ...journal, receipt });
  return receipt;
}
export async function applyJob(pin, stateDir, job) {
  if (!validJob(job) || Date.parse(job.expiresAt) <= Date.now()) throw new Error('invalid-job');
  const previous = await recoverJournal(pin, stateDir);
  if (previous) {
    if (previous.id === job.id) return previous;
    throw new Error('receipt-pending');
  }
  const before = await readPinned(pin);
  const beforeHash = digest(before.content);
  if (beforeHash !== job.expectedHash) {
    const receipt = { id: job.id, state: 'conflict', hash: beforeHash };
    await atomicJson(join(stateDir, 'pending.json'), { job, receipt });
    return receipt;
  }
  await preparePrivateState(join(stateDir, 'backups'));
  const journal = { job, before: before.content };
  const backup = await open(join(stateDir, 'backups', `${job.id}.json`), 'wx', 0o600);
  try {
    await backup.writeFile(JSON.stringify(journal));
    await backup.sync();
  } finally {
    await backup.close();
  }
  await syncDirectory(join(stateDir, 'backups'));
  await atomicJson(join(stateDir, 'pending.json'), journal);
  let temporary;
  try {
    if (job.content !== null) {
      temporary = join(pin.parent, `.robots-${randomUUID()}.tmp`);
      const output = await open(temporary, 'wx', 0o600);
      try {
        await output.writeFile(job.content);
        if (before.info) {
          const created = await output.stat();
          if (created.uid !== before.info.uid || created.gid !== before.info.gid)
            await output.chown(before.info.uid, before.info.gid);
          await output.chmod(before.info.mode & 0o777);
        } else await output.chmod(0o644);
        await output.sync();
      } finally {
        await output.close();
      }
    }
    // Recheck immediately before replacement, including the pinned directory identity.
    if (
      Date.parse(job.expiresAt) <= Date.now() ||
      digest((await readPinned(pin)).content) !== job.expectedHash
    )
      throw new Error('file-changed');
    if (job.content === null) {
      if (before.content !== null) await unlink(pin.path);
    } else await rename(temporary, pin.path);
    await syncDirectory(pin.parent);
  } catch {
    // A crash or uncertain filesystem result is reconciled against both recorded versions.
  } finally {
    if (temporary)
      await unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
  return recoverJournal(pin, stateDir);
}
export function endpoint(url) {
  try {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject URL control characters before parsing.
    if (typeof url !== 'string' || /[\u0000-\u0020\u007f\\?#]/.test(url)) throw new Error();
    const raw = url.match(/^https:\/\/[^/?#]+(\/[^?#]*)?$/i);
    if (!raw) throw new Error();
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
    const rawPath = (raw[1] ?? '').replace(/\/+$/, '');
    const parts = rawPath ? rawPath.slice(1).split('/') : [];
    const decoded = parts.map(part => {
      const value = decodeURIComponent(part);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject decoded URL control characters and separators.
      if (!value || value === '.' || value === '..' || /[\/\\%?#\u0000-\u001f\u007f]/.test(value))
        throw new Error();
      return value;
    });
    const path = parsed.pathname.replace(/\/+$/, '');
    const exact = path.endsWith('/liekan/robots-agent');
    if (decoded.slice(-2).join('/') === 'liekan/robots-agent' && !exact) throw new Error();
    parsed.pathname = exact ? path : `${path}/api/liekan/robots-agent`;
    return parsed.href;
  } catch {
    throw new Error('invalid-url');
  }
}
async function request(url, body, token) {
  const response = await fetch(endpoint(url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 401 && token) return { ack: null, revoked: true, job: null };
  if (!response.ok) throw new Error('connection-failed');
  const data = await response.text();
  if (Buffer.byteLength(data) > 2 * maxBytes + 8192) throw new Error('response-too-large');
  return JSON.parse(data);
}
export async function runOnce(config, fetcher = request) {
  const receipt = await recoverJournal(config.pin, config.stateDir);
  const { content } = await readPinned(config.pin);
  const response = await fetcher(
    config.url,
    { action: 'poll', content, ...(receipt ? { receipt } : {}) },
    config.token,
  );
  if (receipt && response.ack === receipt.id) {
    await unlink(join(config.stateDir, 'pending.json'));
    await syncDirectory(config.stateDir);
  }
  if (response.revoked) return false;
  if (response.job) await applyJob(config.pin, config.stateDir, response.job);
  return true;
}
async function acquireLock(directory) {
  await trustedDirectory(dirname(directory));
  await mkdir(directory, { mode: 0o700 });
  await trustedDirectory(directory, { privateLeaf: true });
  const file = await open(join(directory, 'owner.json'), 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid }));
  } finally {
    await file.close();
  }
  return async () => {
    await unlink(join(directory, 'owner.json'));
    await rmdir(directory);
  };
}
async function main() {
  const args = process.argv.slice(2);
  const option = key => {
    const index = args.indexOf(key);
    if (index < 0 || !args[index + 1]) throw new Error('missing-option');
    return args[index + 1];
  };
  const stateDir = resolve(option('--state'));
  if (args[0] === 'pair') {
    const url = option('--url'),
      code = option('--code'),
      host = option('--hostname');
    endpoint(url);
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('invalid-code');
    const pin = await pinFile(option('--file'));
    await readPinned(pin);
    await preparePrivateState(stateDir);
    // Pairing a used state directory requires a separate directory, preserving pending receipts.
    const reserve = await open(join(stateDir, 'pairing.lock'), 'wx', 0o600);
    await reserve.close();
    try {
      try {
        await lstat(join(stateDir, 'config.json'));
        throw new Error('already-paired');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const paired = await request(url, { action: 'pair', code, path: pin.path });
      if (
        paired.hostname !== host ||
        !validId(paired.agentId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(paired.token)
      )
        throw new Error('pairing-mismatch');
      await atomicJson(join(stateDir, 'config.json'), {
        version: 1,
        url,
        token: paired.token,
        pin,
        stateDir,
      });
      console.log(
        `robots.txt authorized for ${paired.hostname}. Keep the state directory private.`,
      );
    } finally {
      await unlink(join(stateDir, 'pairing.lock'));
    }
    return;
  }
  if (args[0] !== 'run') throw new Error('invalid-command');
  const config = await readPrivateJson(join(stateDir, 'config.json'));
  if (config.version !== 1 || config.stateDir !== stateDir) throw new Error('invalid-config');
  endpoint(config.url);
  await checkPin(config.pin);
  const unlock = await acquireLock(join(config.pin.parent, '.geoinflow-robots.lock'));
  let stopped = false;
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      stopped = true;
      abort.abort();
    });
  try {
    while (!stopped) {
      try {
        if (!(await runOnce(config))) break;
      } catch (error) {
        console.error(
          `robots.txt synchronization paused (${safetyCode(error)}); retrying connection.`,
        );
      }
      await delay(10000, undefined, { signal: abort.signal }).catch(() => {});
    }
  } finally {
    await unlock();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => {
    console.error(
      `robots.txt helper stopped (${safetyCode(error)}). Check authorization, file permissions and the local lock.`,
    );
    process.exitCode = 1;
  });
