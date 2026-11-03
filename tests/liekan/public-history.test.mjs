import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { checkPublicHistory, git } from '../../scripts/liekan-public-history.mjs';
import {
  deliverPublicPublication,
  preparePublicPublication,
} from '../../scripts/liekan-publish-public.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'geoinflow-history-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const create = name => {
    const path = join(root, name);
    mkdirSync(path);
    git(path, ['init', '--initial-branch=main']);
    git(path, ['config', 'user.name', name]);
    git(path, ['config', 'user.email', `${name}@example.test`]);
    git(path, ['config', 'commit.gpgsign', 'false']);
    return path;
  };
  const commit = (repo, name, files) => {
    for (const [file, value] of Object.entries(files)) writeFileSync(join(repo, file), value);
    git(repo, ['add', '--all', '--force']);
    git(repo, ['commit', '-m', name]);
    const sha = git(repo, ['rev-parse', 'HEAD']);
    if (repo.endsWith('/public')) git(repo, ['update-ref', 'refs/remotes/origin/main', sha]);
    return sha;
  };
  const source = create('development');
  const upstream = commit(source, 'upstream', { 'app.txt': 'upstream\n' });
  commit(source, 'project feature', { 'app.txt': 'GEOInflow\n' });
  const target = create('public');
  const baseline = commit(target, 'independent project', { 'app.txt': 'GEOInflow\n' });
  git(target, ['remote', 'add', 'origin', 'https://github.com/yaojingang/GEOInflow.git']);
  const policy = {
    version: 1,
    repository: 'https://github.com/yaojingang/GEOInflow.git',
    mirrorRepository: 'https://gitee.com/liekan/liekan-statistics.git',
    developmentRepository: 'https://gitee.com/liekan/liekan-statistics-history.git',
    baseline,
    allowedRoots: [baseline],
  };
  const prepare = (extra = {}) =>
    preparePublicPublication({ source, target, branch: 'feature/publication', policy, ...extra });
  return { root, source, target, upstream, baseline, policy, create, commit, prepare };
}

test('clean project history accepts later contributors', t => {
  const f = fixture(t);
  git(f.target, ['config', 'user.name', 'Community contributor']);
  f.commit(f.target, 'community change', { 'feature.txt': 'new\n' });
  assert.equal(checkPublicHistory({ repo: f.target, policy: f.policy }).valid, true);
});

test('the recurring development-history merge is rejected across all parents', t => {
  const f = fixture(t);
  git(f.target, ['fetch', '--no-tags', f.source, 'HEAD']);
  const development = git(f.target, ['rev-parse', 'FETCH_HEAD']);
  const tree = git(f.target, ['rev-parse', 'HEAD^{tree}']);
  const merged = git(f.target, ['commit-tree', tree, '-p', f.baseline, '-p', development], {
    input: 'align development histories\n',
  });
  assert.throws(
    () => checkPublicHistory({ repo: f.target, refs: [merged], policy: f.policy }),
    /Unexpected public history root/,
  );
  assert.equal(checkPublicHistory({ repo: f.target, policy: f.policy }).valid, true);
  git(f.target, ['replace', f.upstream, f.baseline]);
  assert.throws(
    () => checkPublicHistory({ repo: f.target, refs: [merged], policy: f.policy }),
    /Unexpected public history root/,
  );
});

test('truncated history fails closed', t => {
  const f = fixture(t);
  f.commit(f.target, 'second', { 'second.txt': 'second\n' });
  const shallow = join(f.root, 'shallow');
  execFileSync('git', ['clone', '--depth=1', `file://${f.target}`, shallow], { stdio: 'pipe' });
  assert.throws(() => checkPublicHistory({ repo: shallow, policy: f.policy }), /shallow/);
});

test('publication keeps the complete committed source tree and a clean parent', t => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'run.sh'), '#!/bin/sh\necho ready\n');
  chmodSync(join(f.source, 'run.sh'), 0o755);
  symlinkSync('app.txt', join(f.source, 'app-link'));
  f.commit(f.source, 'new source', {
    '.gitignore': '*.gz\n',
    'demo.gz': 'tracked demo\n',
    'app.txt': 'latest feature\n',
  });
  writeFileSync(join(f.source, '.env'), 'LOCAL_ONLY=true\n');
  const sourceHead = git(f.source, ['rev-parse', 'HEAD']);
  const main = git(f.target, ['rev-parse', 'HEAD']);
  const result = f.prepare();
  assert.equal(result.changed, true);
  assert.equal(
    git(f.target, ['rev-parse', `${result.commit}^{tree}`]),
    git(f.source, ['rev-parse', `${sourceHead}^{tree}`]),
  );
  assert.equal(git(f.target, ['show', '-s', '--format=%P', result.commit]), main);
  assert.equal(git(f.target, ['rev-parse', 'HEAD']), main);
  assert.equal(git(f.source, ['rev-parse', 'HEAD']), sourceHead);
  assert.equal(readFileSync(join(f.source, '.env'), 'utf8'), 'LOCAL_ONLY=true\n');
  assert.equal(git(f.target, ['status', '--porcelain=v1', '-uall']), '');
  assert.equal(git(f.target, ['ls-tree', result.commit, '.env']), '');
  assert.equal(
    checkPublicHistory({ repo: f.target, refs: [result.commit], policy: f.policy }).valid,
    true,
  );
  assert.equal(f.prepare().changed, false);
  assert.equal(git(f.target, ['rev-list', '--count', result.commit]), '2');
});

test('publication preserves unincorporated public work by refusing replacement', t => {
  const f = fixture(t);
  f.commit(f.target, 'public contribution', { 'public-only.txt': 'keep this\n' });
  f.commit(f.source, 'development update', { 'feature.txt': 'new feature\n' });
  const before = git(f.target, ['rev-parse', 'HEAD']);
  assert.throws(() => f.prepare(), /Public changes are absent/);
  assert.equal(git(f.target, ['rev-parse', 'HEAD']), before);
  assert.equal(readFileSync(join(f.target, 'public-only.txt'), 'utf8'), 'keep this\n');
  f.commit(f.source, 'incorporate community change', { 'public-only.txt': 'keep this\n' });
  assert.equal(f.prepare().changed, true);
});

test('conflicting public work and local files remain intact', t => {
  const f = fixture(t);
  f.commit(f.target, 'public update', { 'app.txt': 'public version\n' });
  f.commit(f.source, 'development update', { 'app.txt': 'development version\n' });
  assert.throws(() => f.prepare(), /Public changes conflict/);
  writeFileSync(join(f.target, 'notes.txt'), 'user work\n');
  assert.throws(() => f.prepare(), /local changes/);
  assert.equal(readFileSync(join(f.target, 'notes.txt'), 'utf8'), 'user work\n');
});

test('publication rejects an unsafe destination and checked-out candidate branch', t => {
  const f = fixture(t);
  assert.throws(() => f.prepare({ target: f.source }), /separate repositories/);
  assert.throws(() => f.prepare({ branch: 'main' }), /feature\//);
  git(f.target, ['remote', 'set-url', 'origin', 'https://gitee.com/liekan/liekan-statistics.git']);
  assert.throws(() => f.prepare(), /approved GitHub/);
  git(f.target, ['remote', 'set-url', 'origin', f.policy.repository]);
  git(f.target, ['remote', 'add', 'upstream', 'https://github.com/umami-software/umami.git']);
  assert.throws(() => f.prepare(), /only its GitHub origin/);
  git(f.target, ['remote', 'remove', 'upstream']);
  git(f.target, ['switch', '-c', 'feature/publication']);
  assert.throws(() => f.prepare(), /Keep the public checkout on main/);
});

test('CLI help and invalid arguments are explicit', () => {
  for (const file of ['liekan-public-history.mjs', 'liekan-publish-public.mjs']) {
    const path = resolve('scripts', file);
    const help = spawnSync(process.execPath, [path, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
    const invalid = spawnSync(process.execPath, [path, '--unknown'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Unknown option/);
  }
});

test('unverified publication metadata cannot authorize dropping public work', t => {
  const f = fixture(t);
  f.commit(f.target, 'docs: GEOInflow-Source-Revision: malformed', {
    'community.txt': 'preserve community work\n',
  });
  f.commit(f.source, 'new feature', { 'feature.txt': 'feature\n' });
  assert.throws(() => f.prepare(), /Public changes are absent/);
});

test('verified publication metadata supports incremental source publication', t => {
  const f = fixture(t);
  f.commit(f.source, 'first update', { 'feature.txt': 'first\n' });
  const first = f.prepare();
  f.commit(f.source, 'second update', { 'feature.txt': 'second\n' });
  const second = f.prepare();
  assert.equal(second.parent, first.commit);
  assert.equal(git(f.target, ['show', `${second.commit}:feature.txt`]), 'second');
});

test('publication preserves another worktree and its pending user changes', t => {
  const f = fixture(t);
  const other = join(f.root, 'other-worktree');
  git(f.target, ['worktree', 'add', '-b', 'feature/publication', other, 'main']);
  writeFileSync(join(other, 'app.txt'), 'user changes\n');
  const before = git(other, ['rev-parse', 'HEAD']);
  f.commit(f.source, 'new feature', { 'feature.txt': 'new\n' });
  assert.throws(() => f.prepare(), /checked out in another worktree/);
  assert.equal(git(other, ['rev-parse', 'HEAD']), before);
  assert.equal(readFileSync(join(other, 'app.txt'), 'utf8'), 'user changes\n');
});

test('a stale local main cannot hide fetched public contributions', t => {
  const f = fixture(t);
  const old = git(f.target, ['rev-parse', 'HEAD']);
  f.commit(f.target, 'remote community work', { 'community.txt': 'remote\n' });
  git(f.target, ['reset', '--hard', old]);
  f.commit(f.source, 'new feature', { 'feature.txt': 'feature\n' });
  assert.throws(() => f.prepare(), /main must match origin\/main/);
});

test('an unmerged stale candidate cannot replace newer public history', t => {
  const f = fixture(t);
  f.commit(f.source, 'first feature', { 'feature.txt': 'first\n' });
  const prepared = f.prepare();
  f.commit(f.target, 'new public work', { 'community.txt': 'community\n' });
  f.commit(f.source, 'next feature', { 'feature.txt': 'next\n' });
  assert.throws(() => f.prepare(), /candidate does not contain/);
  assert.equal(git(f.target, ['rev-parse', 'refs/heads/feature/publication']), prepared.commit);
});

test('CI requires the public history gate without path filters', () => {
  const workflow = readFileSync('.github/workflows/liekan-public-history.yml', 'utf8');
  assert.match(workflow, /name: GEOInflow public history/);
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /branches: \[main\]/);
  assert.doesNotMatch(workflow, /^ {2}pull_request:$/m);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /pull_request\.base\.sha/);
  assert.match(workflow, /node scripts\/liekan-public-history\.mjs/);
  assert.match(workflow, /createCommitStatus/);
  assert.match(workflow, /actions\/github-script@[a-f0-9]{40}/);
  assert.match(workflow, /sha: process\.env\.CANDIDATE/);
  assert.match(workflow, /if: always\(\) && github\.event_name == 'pull_request_target'/);
  assert.doesNotMatch(workflow, /paths(?:-ignore)?:/);
});

test('dual publication uses identical commits and preserves candidates on partial failure', t => {
  const f = fixture(t);
  f.commit(f.source, 'new source', { 'app.txt': 'new feature\n' });
  git(f.target, ['remote', 'add', 'gitee', f.policy.mirrorRepository]);
  const servers = ['github.git', 'gitee.git'].map(name => join(f.root, name));
  for (const server of servers) {
    git(f.root, ['init', '--bare', '--initial-branch=main', server]);
  }
  const candidate = f.prepare();
  const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const shim = join(f.root, 'git');
  writeFileSync(
    shim,
    `#!${process.execPath}
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
const command=args.indexOf('push')>=0?'push':args.indexOf('ls-remote')>=0?'ls-remote':null;
if(command){
 const i=args.indexOf(command)+1;
 if(args[i]==='origin')args[i]=${JSON.stringify(servers[0])};
 if(args[i]==='gitee')args[i]=${JSON.stringify(servers[1])};
}
const result=spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'});
process.exit(result.status??1);
`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${f.root}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const delivered = deliverPublicPublication({ target: f.target, ...candidate, policy: f.policy });
  assert.equal(delivered.delivered, true);
  for (const server of servers)
    assert.equal(git(server, ['rev-parse', 'refs/heads/feature/publication']), candidate.commit);
  assert.equal(
    deliverPublicPublication({ target: f.target, ...candidate, policy: f.policy }).delivered,
    true,
  );
  const conflict = git(
    servers[1],
    [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit-tree',
      git(f.target, ['rev-parse', `${candidate.commit}^{tree}`]),
    ],
    { input: 'unrelated mirror change\n' },
  );
  git(servers[1], ['update-ref', 'refs/heads/feature/publication', conflict]);
  const partial = deliverPublicPublication({ target: f.target, ...candidate, policy: f.policy });
  assert.equal(partial.delivered, false);
  assert.deepEqual(
    partial.deliveries.map(x => x.delivered),
    [true, false],
  );
  assert.equal(git(servers[1], ['rev-parse', 'refs/heads/feature/publication']), conflict);
  assert.equal(git(f.target, ['rev-parse', 'refs/heads/feature/publication']), candidate.commit);
});

test('CLI skips an already merged candidate without advancing an old feature reference', t => {
  const f = fixture(t);
  f.commit(f.source, 'new source', { 'app.txt': 'latest source\n' });
  const old = f.prepare();
  git(f.target, ['update-ref', 'refs/heads/main', old.commit]);
  git(f.target, ['reset', '--hard', 'main']);
  git(f.target, ['commit', '--allow-empty', '-m', 'accepted merge']);
  const main = git(f.target, ['rev-parse', 'HEAD']);
  git(f.target, ['update-ref', 'refs/remotes/origin/main', main]);
  mkdirSync(join(f.root, 'scripts'));
  mkdirSync(join(f.root, 'config', 'liekan'), { recursive: true });
  for (const file of ['liekan-public-history.mjs', 'liekan-publish-public.mjs'])
    cpSync(resolve('scripts', file), join(f.root, 'scripts', file));
  writeFileSync(join(f.root, 'config', 'liekan', 'public-history.json'), JSON.stringify(f.policy));
  const run = spawnSync(
    process.execPath,
    [
      join(f.root, 'scripts', 'liekan-publish-public.mjs'),
      '--target',
      f.target,
      '--source-ref',
      'HEAD',
      '--branch',
      'feature/publication',
      '--push',
    ],
    { cwd: f.source, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).skipped, 'Source already matches project main');
  assert.equal(git(f.target, ['rev-parse', 'refs/heads/feature/publication']), old.commit);
  assert.equal(git(f.target, ['rev-parse', 'HEAD']), main);
});

test('delivery rejects a concurrently changed prepared branch before either push', t => {
  const f = fixture(t);
  f.commit(f.source, 'new feature', { 'app.txt': 'new feature\n' });
  const candidate = f.prepare();
  git(f.target, ['update-ref', 'refs/heads/feature/publication', f.baseline]);
  assert.throws(
    () => deliverPublicPublication({ target: f.target, ...candidate, policy: f.policy }),
    /candidate changed before delivery/,
  );
});
