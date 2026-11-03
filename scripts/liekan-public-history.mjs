import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultPolicyPath = fileURLToPath(
  new URL('../config/liekan/public-history.json', import.meta.url),
);

export function git(repo, args, options = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
    env: { ...env, GIT_NO_REPLACE_OBJECTS: '1', ...options.env },
  }).trim();
}

export function readPolicy(path = defaultPolicyPath) {
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  if (
    policy.version !== 1 ||
    !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(policy.repository) ||
    (policy.mirrorRepository !== undefined &&
      !/^https:\/\/gitee\.com\/[\w.-]+\/[\w.-]+\.git$/.test(policy.mirrorRepository)) ||
    (policy.developmentRepository !== undefined &&
      (!/^https:\/\/gitee\.com\/[\w.-]+\/[\w.-]+\.git$/.test(policy.developmentRepository) ||
        policy.developmentRepository === policy.mirrorRepository)) ||
    !/^[a-f0-9]{40}$/.test(policy.baseline) ||
    !Array.isArray(policy.allowedRoots) ||
    policy.allowedRoots.length === 0 ||
    policy.allowedRoots.some(root => !/^[a-f0-9]{40}$/.test(root))
  )
    throw new Error('Invalid public history policy');
  return policy;
}

export function repositoryKey(address) {
  const normalized = address.replace(/^git@([^:]+):/, 'https://$1/');
  try {
    const url = new URL(normalized);
    if (!['https:', 'ssh:', 'git+ssh:', 'ssh+git:'].includes(url.protocol)) return null;
    return `${url.hostname.toLowerCase().replace(/\.$/, '')}/${decodeURIComponent(url.pathname)
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/, '')}`;
  } catch {
    return null;
  }
}

export function checkPublicationRemotes(repo, policy, { requireMirror = false } = {}) {
  const remotes = git(repo, ['remote']).split('\n');
  const expected = { origin: policy.repository };
  if (policy.mirrorRepository) expected.gitee = policy.mirrorRepository;
  if (
    !remotes.includes('origin') ||
    remotes.some(remote => !Object.hasOwn(expected, remote)) ||
    (requireMirror && !remotes.includes('gitee'))
  )
    throw new Error('Public checkout must have only its GitHub origin and approved Gitee mirror');
  for (const remote of remotes) {
    for (const kind of [[], ['--push']]) {
      const urls = git(repo, ['remote', 'get-url', ...kind, '--all', remote]).split('\n');
      if (urls.length !== 1 || repositoryKey(urls[0]) !== repositoryKey(expected[remote]))
        throw new Error(
          `Public ${remote} does not match the approved ${remote === 'origin' ? 'GitHub' : 'Gitee'} repository`,
        );
    }
  }
  return remotes;
}

export function checkPublicHistory({
  repo = process.cwd(),
  refs = ['HEAD'],
  policy = readPolicy(),
} = {}) {
  if (!refs.length || refs.some(ref => !ref || ref.startsWith('-')))
    throw new Error('Provide explicit commit references');
  const commits = refs.map(ref => git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]));
  const grafts = git(repo, ['rev-parse', '--git-path', 'info/grafts']);
  if (existsSync(resolve(repo, grafts)))
    throw new Error('Legacy grafts cannot verify public history');
  const shallowPath = git(repo, ['rev-parse', '--git-path', 'shallow']);
  if (existsSync(resolve(repo, shallowPath))) {
    const shallow = new Set(readFileSync(resolve(repo, shallowPath), 'utf8').trim().split('\n'));
    const reachable = git(repo, ['rev-list', ...commits]).split('\n');
    if (reachable.some(sha => shallow.has(sha)))
      throw new Error('Public history is shallow; fetch the full branch history');
  }
  const roots = [...new Set(git(repo, ['rev-list', '--max-parents=0', ...commits]).split('\n'))];
  const unknown = roots.filter(root => !policy.allowedRoots.includes(root));
  if (unknown.length) throw new Error(`Unexpected public history root: ${unknown.join(', ')}`);
  return { valid: true, commits, roots };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let repo = process.cwd();
    let policyPath = defaultPolicyPath;
    const refs = [];
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--help') {
        console.log(
          'Usage: node scripts/liekan-public-history.mjs [--repo DIR] [--policy FILE] [REF ...]',
        );
        process.exit(0);
      }
      if (args[i] === '--repo' || args[i] === '--policy') {
        const key = args[i];
        const value = args[++i];
        if (!value || value.startsWith('-')) throw new Error(`Missing value for ${key}`);
        if (key === '--repo') repo = resolve(value);
        else policyPath = resolve(value);
      } else if (args[i].startsWith('-')) throw new Error(`Unknown option: ${args[i]}`);
      else refs.push(args[i]);
    }
    console.log(
      JSON.stringify(
        checkPublicHistory({
          repo,
          refs: refs.length ? refs : ['HEAD'],
          policy: readPolicy(policyPath),
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
