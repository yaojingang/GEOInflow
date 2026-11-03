import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { checkPublicHistory, git, readPolicy, repositoryKey } from './liekan-public-history.mjs';

export function gitConfig(repo, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('GIT_CONFIG_')),
  );
  return git(repo, ['config', ...args], { env });
}

function sshCommand(repo) {
  let command = process.env.GIT_SSH_COMMAND;
  if (!command) {
    try {
      command = gitConfig(repo, ['--get', 'core.sshCommand']);
    } catch (error) {
      if (error.status !== 1) throw error;
    }
  }
  command ||= process.env.GIT_SSH || 'ssh';
  if (/[\r\n]/.test(command))
    throw new Error('Unsupported custom SSH command; review push routing first');
  const words = [];
  let end = 0;
  // Accept literal shell words and quoting; never evaluate shell operators or expansions.
  for (const match of command.matchAll(
    /(?:[^\s'"\\$`;&|<>()*?[\]{}~]+|'[^']*'|"[^"\\$`]*"|\\[^\r\n])+/g,
  )) {
    if (command.slice(end, match.index).trim())
      throw new Error('Unsupported custom SSH command; review push routing first');
    words.push(
      match[0].replace(
        /'([^']*)'|"([^"\\$`]*)"|\\(.)/g,
        (_, single, double, escaped) => single ?? double ?? escaped,
      ),
    );
    end = match.index + match[0].length;
  }
  if (command.slice(end).trim() || !/^(?:ssh|\/[^\s]*\/ssh)$/.test(words[0] || ''))
    throw new Error('Unsupported custom SSH command; review push routing first');
  return words;
}

function sshHostname(repo, host, { user, port } = {}) {
  const [executable, ...configured] = sshCommand(repo);
  const args = ['-G', '-o', 'BatchMode=yes', ...configured];
  if (user) args.push('-l', user);
  if (port) args.push('-p', port);
  const result = spawnSync(executable, [...args, '--', host], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Cannot resolve the SSH push destination safely');
  const value = result.stdout.match(/^hostname\s+(\S+)$/m)?.[1];
  if (!value) throw new Error('SSH push destination has no resolved hostname');
  return value.toLowerCase();
}

export function destinationHost(address) {
  if (/^[A-Za-z]:[\\/]/.test(address)) return null;
  if (address.includes('://')) {
    try {
      const url = new URL(address);
      return {
        host: url.hostname.toLowerCase(),
        path: decodeURIComponent(url.pathname)
          .replace(/^\/+|\/+$/g, '')
          .replace(/\.git$/, ''),
        ssh: ['ssh:', 'git+ssh:', 'ssh+git:'].includes(url.protocol),
        user: decodeURIComponent(url.username),
        port: url.port,
      };
    } catch {
      throw new Error('Invalid push destination address');
    }
  }
  const scp = address.match(/^(?:([^/@\s:]+)@)?([^/:\s]+):([^\s]+)/);
  return scp
    ? {
        host: scp[2].toLowerCase(),
        user: scp[1],
        ssh: true,
        path: decodeURIComponent(scp[3])
          .replace(/^\/+|\/+$/g, '')
          .replace(/\.git$/, ''),
      }
    : null;
}

function pushAddresses({ repo, remoteName, remoteLocation }) {
  const addresses = [remoteName, remoteLocation];
  if (/^[\w.-]+$/.test(remoteName)) {
    for (const key of ['pushurl', 'url']) {
      try {
        addresses.push(
          ...gitConfig(repo, ['--get-all', `remote.${remoteName}.${key}`]).split('\n'),
        );
      } catch (error) {
        if (error.status !== 1) throw error;
      }
    }
  }
  return addresses.map(destinationHost).filter(Boolean);
}

export function isGitHubPush(options) {
  const parsed = pushAddresses(options);
  const resolveSshHost =
    options.resolveSshHost || ((host, address) => sshHostname(options.repo, host, address));
  const github = host => {
    const normalized = host.toLowerCase().replace(/\.$/, '');
    return normalized === 'github.com' || normalized.endsWith('.github.com');
  };
  if (parsed.some(address => github(address.host))) return true;
  for (const address of parsed) {
    if (address.ssh && github(resolveSshHost(address.host, address))) return true;
  }
  return false;
}

export function projectPushDestination(options) {
  const policy = options.policy || readPolicy();
  const parsed = pushAddresses(options);
  const resolveHost =
    options.resolveSshHost || ((host, address) => sshHostname(options.repo, host, address));
  const development = repositoryKey(policy.developmentRepository || '');
  let github = false;
  let gitee = false;
  for (const address of parsed) {
    const hosts = [address.host];
    // Inspect literal hosts first; a rewrite must not remove an existing safeguard.
    if (address.ssh) hosts.push(resolveHost(address.host, address));
    for (const rawHost of hosts) {
      const host = rawHost.toLowerCase().replace(/\.$/, '');
      if (host === 'github.com' || host.endsWith('.github.com')) github = true;
      if (
        (host === 'gitee.com' || host.endsWith('.gitee.com')) &&
        `${host}/${address.path}` !== development
      )
        gitee = true;
    }
  }
  return { github, gitee, protected: github || gitee };
}

export function checkPush({
  repo = process.cwd(),
  role,
  remoteName,
  remoteLocation,
  input,
  policy,
  resolveSshHost,
}) {
  if (!['development', 'public'].includes(role))
    throw new Error('Invalid installed push-guard role');
  if (!remoteName || !remoteLocation) throw new Error('Missing Git push destination');
  policy ||= readPolicy();
  const destination = projectPushDestination({
    repo,
    remoteName,
    remoteLocation,
    resolveSshHost,
    policy,
  });
  if (!destination.protected) return { checked: 0, github: false };
  const lines = input.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return { checked: 0, github: true };
  if (role === 'development')
    throw new Error(
      'GitHub and clean Gitee pushes require the independent public checkout; full history belongs in the private development repository',
    );
  const commits = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length !== 4 ||
      !/^[a-f0-9]{40,64}$/.test(fields[1]) ||
      !/^[a-f0-9]{40,64}$/.test(fields[3])
    )
      throw new Error('Invalid pre-push reference record');
    if (destination.gitee && fields[2] === 'refs/heads/main') {
      const expected = git(repo, ['ls-remote', policy.repository, 'refs/heads/main']).split(
        /\s+/,
      )[0];
      if (!/^[a-f0-9]{40,64}$/.test(expected) || fields[1] !== expected)
        throw new Error('Gitee main must match the protected GitHub main exactly');
    }
    if (!/^0+$/.test(fields[1])) commits.push(fields[1]);
  }
  if (commits.length)
    checkPublicHistory({ repo, refs: [...new Set(commits)], policy: policy || readPolicy() });
  return { checked: commits.length, github: true };
}

if (typeof import.meta.main !== 'boolean')
  throw new Error('Run the GEOInflow push guard with the Node.js version pinned in .nvmrc');

if (import.meta.main) {
  try {
    if (process.argv[2] === '--help') {
      console.log(
        'Usage: installed pre-push --role development|public REMOTE LOCATION < reference-records',
      );
    } else {
      if (process.argv[2] !== '--role' || process.argv.length !== 6)
        throw new Error('Invoke this guard through the installed Git pre-push hook');
      checkPush({
        role: process.argv[3],
        remoteName: process.argv[4],
        remoteLocation: process.argv[5],
        input: readFileSync(0, 'utf8'),
      });
    }
  } catch (error) {
    console.error(`GEOInflow pre-push rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
