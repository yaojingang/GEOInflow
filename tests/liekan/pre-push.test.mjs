import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { installPushGuard } from '../../scripts/liekan-install-push-guard.mjs';
import { checkPush, isGitHubPush } from '../../scripts/liekan-pre-push.mjs';
import { git } from '../../scripts/liekan-public-history.mjs';

const github = 'https://github.com/yaojingang/GEOInflow.git';
const gitee = 'https://gitee.com/liekan/liekan-statistics.git';
const development = 'git@gitee.com:liekan/liekan-statistics-history.git';
const zero = '0'.repeat(40);

function fixture(t, role = 'public') {
  const root = mkdtempSync(join(tmpdir(), 'geoinflow-push-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo with spaces');
  const server = join(root, 'server.git');
  mkdirSync(repo);
  git(repo, ['init', '--initial-branch=main']);
  git(root, ['init', '--bare', '--initial-branch=main', server]);
  git(repo, ['config', 'user.name', 'Push fixture']);
  git(repo, ['config', 'user.email', 'fixture@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'app.txt'), 'project source\n');
  git(repo, ['add', 'app.txt']);
  git(repo, ['commit', '-m', 'clean project root']);
  const clean = git(repo, ['rev-parse', 'HEAD']);
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
  const upstream = git(repo, ['commit-tree', tree], { input: 'upstream root\n' });
  const dirty = git(repo, ['commit-tree', tree, '-p', clean, '-p', upstream], {
    input: 'mixed history\n',
  });
  git(repo, ['update-ref', 'refs/heads/feature/dirty', dirty]);
  git(repo, ['remote', 'add', 'origin', role === 'public' ? github : development]);
  git(repo, ['config', `url.${server}.insteadOf`, role === 'public' ? github : development]);
  git(repo, ['config', '--add', `url.${server}.insteadOf`, github]);
  const policy = {
    version: 1,
    repository: github,
    mirrorRepository: gitee,
    developmentRepository: 'https://gitee.com/liekan/liekan-statistics-history.git',
    baseline: clean,
    allowedRoots: [clean],
  };
  const policyPath = join(root, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(policy));
  const install = () => installPushGuard({ repo, policyPath });
  const push = (destination, ...refs) =>
    spawnSync('git', ['-C', repo, 'push', destination, ...refs], { encoding: 'utf8' });
  const remoteRef = ref => {
    const p = spawnSync('git', ['--git-dir', server, 'rev-parse', '--verify', '--quiet', ref], {
      encoding: 'utf8',
    });
    return p.status === 0 ? p.stdout.trim() : null;
  };
  return {
    root,
    repo,
    server,
    clean,
    dirty,
    upstream,
    policy,
    policyPath,
    install,
    push,
    remoteRef,
  };
}

test('explicit GitHub URL is rejected after guard installation', t => {
  const f = fixture(t);
  const before = f.push(github, `${f.dirty}:refs/heads/feature/before-guard`);
  assert.equal(before.status, 0, before.stderr);
  f.install();
  const after = f.push(github, `${f.dirty}:refs/heads/feature/after-guard`);
  assert.notEqual(after.status, 0);
  assert.match(after.stderr, /Unexpected public history root/);
  assert.equal(f.remoteRef('refs/heads/feature/after-guard'), null);
});

test('another remote name is checked and clean publication is allowed', t => {
  const f = fixture(t);
  f.install();
  git(f.repo, ['remote', 'add', 'alternate', github]);
  const bad = f.push('alternate', `${f.dirty}:refs/heads/feature/dirty`);
  assert.notEqual(bad.status, 0);
  assert.equal(f.remoteRef('refs/heads/feature/dirty'), null);
  const good = f.push('alternate', `${f.clean}:refs/heads/feature/clean`);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(f.remoteRef('refs/heads/feature/clean'), f.clean);
});

test('fully qualified DNS names and GitHub subdomains enforce the same history guard', t => {
  const f = fixture(t);
  f.install();
  for (const host of ['github.com.', 'www.github.com']) {
    const address = github.replace('github.com', host);
    git(f.repo, ['config', '--add', `url.${f.server}.insteadOf`, address]);
    const result = f.push(address, `${f.dirty}:refs/heads/feature/dns`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected public history root/);
    assert.equal(f.remoteRef('refs/heads/feature/dns'), null);
  }
});

test('every update is checked even when current HEAD is clean', t => {
  const f = fixture(t);
  f.install();
  const result = f.push(
    github,
    `${f.clean}:refs/heads/feature/first`,
    `${f.dirty}:refs/heads/feature/second`,
  );
  assert.notEqual(result.status, 0);
  assert.equal(f.remoteRef('refs/heads/feature/first'), null);
  assert.equal(f.remoteRef('refs/heads/feature/second'), null);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), f.clean);
});

test('development checkouts preserve complete Gitee pushes and reject GitHub routes', t => {
  const f = fixture(t, 'development');
  f.install();
  const good = f.push('origin', `${f.dirty}:refs/heads/feature/full-development`);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(f.remoteRef('refs/heads/feature/full-development'), f.dirty);
  const bad = f.push(github, `${f.clean}:refs/heads/feature/direct`);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /independent public checkout/);
  assert.equal(f.remoteRef('refs/heads/feature/direct'), null);
});

test('shared hook survives old worktrees with no checked-in guard scripts', t => {
  const f = fixture(t, 'development');
  f.install();
  const worktree = join(f.root, 'old-worktree');
  git(f.repo, ['worktree', 'add', '-b', 'feature/old', worktree, 'main']);
  assert.equal(existsSync(join(worktree, 'scripts/liekan-pre-push.mjs')), false);
  const result = spawnSync(
    'git',
    ['-C', worktree, 'push', github, `${f.clean}:refs/heads/feature/old`],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /independent public checkout/);
  assert.equal(f.remoteRef('refs/heads/feature/old'), null);
});

test('URL forms and SSH host aliases identify GitHub without leaking addresses', t => {
  const f = fixture(t);
  for (const address of [
    github,
    'https://user:password@GITHUB.COM/owner/project',
    'git@github.com:owner/project.git',
    'ssh://git@github.com:22/owner/project.git',
    'ssh://git@ssh.github.com:443/owner/project.git',
    'git@github.com.:owner/project.git',
    'ssh://git@ssh.github.com.:443/owner/project.git',
  ]) {
    assert.equal(
      isGitHubPush({ repo: f.repo, remoteName: address, remoteLocation: address }),
      true,
    );
  }
  assert.equal(
    isGitHubPush({
      repo: f.repo,
      remoteName: 'alias',
      remoteLocation: 'git@company-git:owner/project.git',
      resolveSshHost: () => 'github.com.',
    }),
    true,
  );
  assert.throws(
    () =>
      isGitHubPush({
        repo: f.repo,
        remoteName: 'alias',
        remoteLocation: 'git@unresolved:owner/project.git',
        resolveSshHost: () => {
          throw new Error('unresolved');
        },
      }),
    /unresolved/,
  );
  for (const address of [
    'git@gitee.com:owner/project.git',
    'ssh://git@company-git:443/owner/project.git',
  ]) {
    assert.equal(
      isGitHubPush({
        repo: f.repo,
        remoteName: address,
        remoteLocation: address,
        resolveSshHost: (host, options) => {
          assert.equal(options.user, 'git');
          if (host === 'company-git') assert.equal(options.port, '443');
          return 'github.com';
        },
      }),
      true,
    );
  }
});

test('annotated tags are checked, public deletions pass, malformed records fail', t => {
  const f = fixture(t);
  f.install();
  git(f.repo, ['tag', '-a', 'clean-release', f.clean, '-m', 'clean release']);
  git(f.repo, ['tag', '-a', 'dirty-release', f.dirty, '-m', 'dirty release']);
  assert.equal(f.push('origin', 'refs/tags/clean-release').status, 0);
  assert.notEqual(f.push('origin', 'refs/tags/dirty-release').status, 0);
  assert.equal(f.remoteRef('refs/tags/dirty-release'), null);
  const result = checkPush({
    repo: f.repo,
    role: 'public',
    remoteName: github,
    remoteLocation: github,
    input: `(delete) ${zero} refs/tags/old ${f.clean}\n`,
    policy: f.policy,
  });
  assert.equal(result.checked, 0);
  assert.throws(
    () =>
      checkPush({
        repo: f.repo,
        role: 'public',
        remoteName: github,
        remoteLocation: github,
        input: 'malformed\n',
        policy: f.policy,
      }),
    /Invalid pre-push/,
  );
});

test('installation is idempotent and preserves local files and staging', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'user.txt'), 'staged user change\n');
  git(f.repo, ['add', 'user.txt']);
  writeFileSync(join(f.repo, 'user.txt'), 'unstaged user change\n');
  const status = git(f.repo, ['status', '--porcelain=v1', '-uall']);
  const index = git(f.repo, ['diff', '--cached', '--binary']);
  const first = f.install();
  const wrapper = readFileSync(first.hook, 'utf8');
  assert.deepEqual(f.install(), first);
  assert.equal(readFileSync(first.hook, 'utf8'), wrapper);
  assert.equal(git(f.repo, ['status', '--porcelain=v1', '-uall']), status);
  assert.equal(git(f.repo, ['diff', '--cached', '--binary']), index);
  assert.equal(readFileSync(join(f.repo, 'user.txt'), 'utf8'), 'unstaged user change\n');
});

test('existing user hooks, symlinks and custom hooksPath are preserved', t => {
  const f = fixture(t);
  const hook = join(f.repo, '.git/hooks/pre-push');
  writeFileSync(hook, '#!/bin/sh\necho user hook\n');
  chmodSync(hook, 0o755);
  assert.throws(() => f.install(), /existing pre-push hook/);
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\necho user hook\n');
  rmSync(hook);
  symlinkSync('missing-user-hook', hook);
  assert.throws(() => f.install(), /symlink was preserved/);
  rmSync(hook);
  git(f.repo, ['config', 'core.hooksPath', join(f.root, 'user-hooks')]);
  assert.throws(() => f.install(), /Custom hooksPath/);
});

test('customized managed wrappers remain intact and snapshot upgrades keep the wrapper', t => {
  const f = fixture(t);
  const first = f.install();
  const wrapper = readFileSync(first.hook, 'utf8');
  const customized = wrapper.replace('exec ', 'echo user check\nexec ');
  writeFileSync(first.hook, customized);
  assert.throws(() => f.install(), /existing pre-push hook/);
  assert.equal(readFileSync(first.hook, 'utf8'), customized);
  writeFileSync(first.hook, wrapper);
  writeFileSync(f.policyPath, `${JSON.stringify(f.policy)}\n`);
  const second = f.install();
  assert.notEqual(second.digest, first.digest);
  assert.equal(readFileSync(first.hook, 'utf8'), wrapper);
  assert.equal(f.push(github, `${f.clean}:refs/heads/feature/upgraded`).status, 0);
});

test('concurrent user hook creation wins over first installation', t => {
  const f = fixture(t);
  const installer = new URL('../../scripts/liekan-install-push-guard.mjs', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=commonjs',
      '-e',
      `
    const fs = require('node:fs');
    const original = fs.linkSync;
    fs.linkSync = (source, destination) => {
      fs.writeFileSync(destination, '#!/bin/sh\\necho concurrent user hook\\n');
      return original(source, destination);
    };
    require('node:module').syncBuiltinESMExports();
    import(process.argv[1]).then(({ installPushGuard }) => {
      try { installPushGuard({ repo: process.argv[2], policyPath: process.argv[3] }); }
      catch (error) { if (error.code === 'EEXIST') return; throw error; }
      throw new Error('Concurrent hook was overwritten');
    });
  `,
      installer,
      f.repo,
      f.policyPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    readFileSync(join(f.repo, '.git/hooks/pre-push'), 'utf8'),
    '#!/bin/sh\necho concurrent user hook\n',
  );
});

test('shared hooks and guard directory symlinks are preserved', t => {
  const f = fixture(t);
  const hooks = join(f.repo, '.git/hooks');
  const external = join(f.root, 'shared-hooks');
  mkdirSync(external);
  rmSync(hooks, { recursive: true });
  symlinkSync(external, hooks);
  assert.throws(() => f.install(), /not a real directory/);
  assert.equal(existsSync(join(external, 'pre-push')), false);
  rmSync(hooks);
  mkdirSync(hooks);
  symlinkSync(external, join(f.repo, '.git/liekan-public-guard'));
  assert.throws(() => f.install(), /not a real directory/);
  assert.equal(existsSync(join(external, 'current')), false);
});

test('a custom hooksPath in any linked worktree prevents incomplete installation', t => {
  const f = fixture(t, 'development');
  const worktree = join(f.root, 'custom-worktree');
  const custom = join(f.root, 'user-hooks');
  git(f.repo, ['config', 'extensions.worktreeConfig', 'true']);
  git(f.repo, ['worktree', 'add', '-b', 'feature/custom-hooks', worktree]);
  git(worktree, ['config', '--worktree', 'core.hooksPath', custom]);
  assert.throws(() => f.install(), /Custom hooksPath.*linked worktree/);
  assert.equal(git(worktree, ['config', '--get', 'core.hooksPath']), custom);
  assert.equal(existsSync(join(f.repo, '.git/hooks/pre-push')), false);
});

test('managed hooks without executable permission cannot report successful installation', t => {
  const f = fixture(t);
  const first = f.install();
  chmodSync(first.hook, 0o644);
  assert.throws(() => f.install(), /not executable/);
});

test('a snapshot upgrade during module loading cannot skip the installed guard', t => {
  const f = fixture(t);
  const installed = f.install();
  const directory = join(f.repo, '.git/liekan-public-guard');
  const next = 'f'.repeat(64);
  cpSync(installed.snapshot, join(directory, next), { recursive: true });
  const preload = join(f.root, 'switch-snapshot.mjs');
  writeFileSync(
    preload,
    `
    import { registerHooks } from 'node:module';
    import { rmSync, symlinkSync } from 'node:fs';
    registerHooks({ load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url.endsWith('/scripts/liekan-pre-push.mjs')) {
        rmSync(${JSON.stringify(join(directory, 'current'))});
        symlinkSync(${JSON.stringify(next)}, ${JSON.stringify(join(directory, 'current'))});
        console.error('fixture-switched-snapshot');
      }
      return result;
    }});
  `,
  );
  const result = spawnSync(installed.hook, [github, github], {
    cwd: f.repo,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
    input: `refs/heads/feature/dirty ${f.dirty} refs/heads/feature/dirty ${zero}\n`,
    encoding: 'utf8',
  });
  assert.match(result.stderr, /fixture-switched-snapshot/);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected public history root/);
});

test('effective Git SSH configuration and command precedence identify routed aliases', t => {
  const f = fixture(t, 'development');
  const config = join(f.root, 'custom ssh config');
  writeFileSync(config, 'Host geoinflow-routed\n  HostName github.com\n');
  git(f.repo, ['config', 'core.sshCommand', `ssh -F '${config}'`]);
  const address = 'git@geoinflow-routed:yaojingang/GEOInflow.git';
  assert.equal(isGitHubPush({ repo: f.repo, remoteName: address, remoteLocation: address }), true);
  const installed = f.install();
  for (const protocol of ['ssh', 'git+ssh', 'ssh+git']) {
    const routed = `${protocol}://git@geoinflow-routed/yaojingang/GEOInflow.git`;
    git(f.repo, ['config', '--add', `url.${f.server}.insteadOf`, routed]);
    const pushed = f.push(routed, `${f.dirty}:refs/heads/feature/transport`);
    assert.notEqual(pushed.status, 0);
    assert.match(pushed.stderr, /independent public checkout/);
    assert.equal(f.remoteRef('refs/heads/feature/transport'), null);
  }
  git(f.repo, ['config', 'core.sshCommand', 'ssh']);
  const inline = spawnSync(
    'git',
    [
      '-C',
      f.repo,
      '-c',
      `core.sshCommand=ssh -F '${config}'`,
      'push',
      'ssh://git@geoinflow-routed/yaojingang/GEOInflow.git',
      `${f.dirty}:refs/heads/feature/inline`,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(inline.status, 0);
  assert.match(inline.stderr, /independent public checkout/);
  assert.equal(f.remoteRef('refs/heads/feature/inline'), null);
  const counted = spawnSync(installed.hook, ['route', address], {
    cwd: f.repo,
    input: `refs/heads/main ${f.clean} refs/heads/feature/routed ${zero}\n`,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.sshCommand',
      GIT_CONFIG_VALUE_0: `ssh -F '${config}'`,
    },
    encoding: 'utf8',
  });
  assert.notEqual(counted.status, 0);
  assert.match(counted.stderr, /independent public checkout/);
  git(f.repo, ['config', 'core.sshCommand', 'unsupported-ssh-wrapper']);
  const result = spawnSync(installed.hook, ['route', address], {
    cwd: f.repo,
    input: `refs/heads/main ${f.clean} refs/heads/feature/routed ${zero}\n`,
    env: { ...process.env, GIT_SSH_COMMAND: `ssh -F '${config}'` },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /independent public checkout/);
  assert.throws(
    () => isGitHubPush({ repo: f.repo, remoteName: address, remoteLocation: address }),
    /Unsupported custom SSH command/,
  );
  const sentinel = join(f.root, 'must-not-exist');
  git(f.repo, ['config', 'core.sshCommand', `ssh; touch '${sentinel}'`]);
  assert.throws(
    () => isGitHubPush({ repo: f.repo, remoteName: address, remoteLocation: address }),
    /Unsupported custom SSH command/,
  );
  assert.equal(existsSync(sentinel), false);
  git(f.repo, [
    'config',
    'core.sshCommand',
    'ssh -o HostName=not-github.invalid\nssh -o HostName=github.com',
  ]);
  assert.throws(
    () => isGitHubPush({ repo: f.repo, remoteName: address, remoteLocation: address }),
    /Unsupported custom SSH command/,
  );
});

test('clean Gitee URLs, alternate remotes, rewrites and SSH aliases reject development ancestry', t => {
  const f = fixture(t, 'development');
  f.install();
  for (const address of [
    gitee,
    'git@gitee.com:liekan/liekan-statistics.git',
    'ssh://git@gitee.com/liekan/liekan-statistics.git',
  ]) {
    git(f.repo, ['config', '--add', `url.${f.server}.insteadOf`, address]);
    const bad = f.push(address, `${f.dirty}:refs/heads/feature/mixed`);
    assert.notEqual(bad.status, 0, address);
    assert.match(bad.stderr, /independent public checkout/);
  }
  git(f.repo, ['remote', 'add', 'another', gitee]);
  assert.notEqual(f.push('another', `${f.dirty}:refs/heads/feature/another`).status, 0);
  const config = join(f.root, 'gitee ssh config');
  writeFileSync(config, 'Host geoinflow-gitee\n  HostName gitee.com\n');
  git(f.repo, ['config', 'core.sshCommand', `ssh -F '${config}'`]);
  const alias = 'ssh://git@geoinflow-gitee/liekan/liekan-statistics.git';
  git(f.repo, ['config', '--add', `url.${f.server}.insteadOf`, alias]);
  assert.notEqual(f.push(alias, `${f.clean}:refs/heads/feature/alias`).status, 0);
  assert.equal(f.push('origin', `${f.dirty}:refs/heads/feature/archive`).status, 0);
  assert.equal(f.remoteRef('refs/heads/feature/mixed'), null);
  assert.equal(f.remoteRef('refs/heads/feature/archive'), f.dirty);
});

test('public Gitee rejects mixed ancestry and main follows protected GitHub main', t => {
  const f = fixture(t);
  f.install();
  git(f.repo, ['remote', 'add', 'gitee', gitee]);
  git(f.repo, ['config', '--add', `url.${f.server}.insteadOf`, gitee]);
  assert.equal(f.push('origin', `${f.clean}:refs/heads/main`).status, 0);
  assert.notEqual(f.push('gitee', `${f.dirty}:refs/heads/feature/mixed`).status, 0);
  assert.equal(f.push('gitee', `${f.clean}:refs/heads/feature/clean`).status, 0);
  const later = git(
    f.repo,
    ['commit-tree', git(f.repo, ['rev-parse', 'HEAD^{tree}']), '-p', f.clean],
    { input: 'later candidate\n' },
  );
  const badMain = f.push('gitee', `${later}:refs/heads/main`);
  assert.notEqual(badMain.status, 0);
  assert.match(badMain.stderr, /must match the protected GitHub main/);
  assert.equal(f.push('gitee', `${f.clean}:refs/heads/main`).status, 0);
  assert.notEqual(f.push('gitee', ':refs/heads/main').status, 0);
  assert.equal(f.remoteRef('refs/heads/main'), f.clean);
});
