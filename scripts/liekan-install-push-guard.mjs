import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitConfig } from './liekan-pre-push.mjs';
import { defaultPolicyPath, git, readPolicy, repositoryKey } from './liekan-public-history.mjs';

const marker = '# GEOInflow managed pre-push v1';
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

function ensureDirectory(path) {
  try {
    if (!lstatSync(path).isDirectory())
      throw new Error(
        'An existing guard or hooks directory is not a real directory; it was preserved',
      );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(path);
  }
}

export function installPushGuard({ repo = process.cwd(), policyPath = defaultPolicyPath } = {}) {
  repo = realpathSync(repo);
  const policy = readPolicy(policyPath);
  const origin = gitConfig(repo, ['--get', 'remote.origin.url']);
  const role =
    policy.developmentRepository &&
    repositoryKey(origin) === repositoryKey(policy.developmentRepository)
      ? 'development'
      : [policy.repository, policy.mirrorRepository]
            .filter(Boolean)
            .some(url => repositoryKey(origin) === repositoryKey(url))
        ? 'public'
        : null;
  if (!role)
    throw new Error('Origin is not a recognized GEOInflow development or public repository');
  const worktrees = git(repo, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter(field => field.startsWith('worktree '))
    .map(field => field.slice('worktree '.length));
  for (const worktree of worktrees) {
    try {
      gitConfig(worktree, ['--get', 'core.hooksPath']);
      throw new Error(
        'Custom hooksPath is configured in a linked worktree; preserve it and review hook integration first',
      );
    } catch (error) {
      if (error.status !== 1) throw error;
    }
  }
  const common = realpathSync(
    git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const hook = join(common, 'hooks', 'pre-push');
  ensureDirectory(dirname(hook));
  try {
    if (lstatSync(hook).isSymbolicLink())
      throw new Error('An existing pre-push symlink was preserved');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const previous = existsSync(hook) ? readFileSync(hook, 'utf8') : null;
  const managedDirectory = join(common, 'liekan-public-guard');
  const current = join(managedDirectory, 'current');
  const wrapper = `#!/bin/sh\n${marker}\nexec ${shellQuote(join(current, 'node'))} ${shellQuote(join(current, 'scripts', 'liekan-pre-push.mjs'))} --role ${role} "$@"\n`;
  if (previous !== null && previous !== wrapper)
    throw new Error(
      'An existing pre-push hook differs from the installed wrapper; it was preserved',
    );
  if (previous !== null) {
    try {
      accessSync(hook, constants.X_OK);
    } catch {
      throw new Error(
        'The managed pre-push hook is not executable; restore its permissions before reinstalling',
      );
    }
  }
  const files = new Map([
    ['scripts/liekan-pre-push.mjs', readFileSync(join(sourceDirectory, 'liekan-pre-push.mjs'))],
    [
      'scripts/liekan-public-history.mjs',
      readFileSync(join(sourceDirectory, 'liekan-public-history.mjs')),
    ],
    ['config/liekan/public-history.json', readFileSync(policyPath)],
  ]);
  const hash = createHash('sha256').update(role).update('\0').update(process.execPath);
  for (const [name, bytes] of files) hash.update(name).update('\0').update(bytes);
  const digest = hash.digest('hex');
  const snapshot = join(managedDirectory, digest);
  for (const path of [
    managedDirectory,
    snapshot,
    join(snapshot, 'scripts'),
    join(snapshot, 'config'),
    join(snapshot, 'config', 'liekan'),
  ])
    ensureDirectory(path);
  const runtime = join(snapshot, 'node');
  try {
    if (!lstatSync(runtime).isSymbolicLink() || readlinkSync(runtime) !== process.execPath)
      throw new Error('Installed guard runtime differs from its content digest');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    symlinkSync(process.execPath, runtime);
  }
  for (const [name, bytes] of files) {
    const destination = join(snapshot, name);
    if (existsSync(destination)) {
      if (!lstatSync(destination).isFile() || !readFileSync(destination).equals(bytes))
        throw new Error('Installed guard snapshot differs from its content digest');
    } else writeFileSync(destination, bytes, { flag: 'wx', mode: 0o644 });
  }
  let activeDigest;
  try {
    activeDigest = readlinkSync(current);
    if (!/^[a-f0-9]{64}$/.test(activeDigest))
      throw new Error('Existing guard snapshot pointer was preserved; review integration first');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (activeDigest !== digest) {
    const pointer = `${current}-${randomUUID()}`;
    try {
      symlinkSync(digest, pointer);
      renameSync(pointer, current);
    } finally {
      rmSync(pointer, { force: true });
    }
  }
  if (previous === null) {
    const temporary = `${hook}.geoinflow-${randomUUID()}`;
    try {
      writeFileSync(temporary, wrapper, { flag: 'wx', mode: 0o755 });
      // Creating a hard link fails atomically if another process installed a hook.
      linkSync(temporary, hook);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return { installed: true, role, hook, snapshot, digest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--help') {
      console.log('Usage: node scripts/liekan-install-push-guard.mjs [--repo DIR]');
    } else {
      if (
        args.length &&
        (args.length !== 2 || args[0] !== '--repo' || !args[1] || args[1].startsWith('-'))
      )
        throw new Error('Usage: node scripts/liekan-install-push-guard.mjs [--repo DIR]');
      console.log(
        JSON.stringify(installPushGuard({ repo: args[1] ? resolve(args[1]) : process.cwd() })),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
