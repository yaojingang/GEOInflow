import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';

const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120000,
  });
async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(300);
  }
  assert.fail(message);
}
test('Docker installer rejects unsafe paths and serializes its lifecycle', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'liekan-installer-lifecycle-'));
  const website = randomUUID();
  try {
    await writeFile(
      join(temp, 'install.sh'),
      await readFile('public/liekan-agent/install-docker.sh'),
    );
    await writeFile(
      join(temp, 'context.tar.gz'),
      await readFile('public/liekan-agent/agent-docker.tar.gz'),
    );
    await writeFile(
      join(temp, 'docker'),
      `#!/bin/sh
printf '%s\\n' "$*" >> /tmp/docker-calls
case "$1" in
  info) case "$3" in *Architecture*) echo aarch64;; *OSType*) echo linux;; esac;;
  compose) case "$*" in
    'compose version') echo 'Docker Compose version v2.39.0';;
    'compose up --help') echo '--wait-timeout';;
    *'collector preflight') case "$CASE" in signal) kill -TERM "$PPID";; kill) kill -KILL "$PPID";; esac;;
  esac;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(temp, 'curl'),
      `#!/bin/sh
for value do destination="$value"; done
cp /fixture/context.tar.gz "$destination"
`,
      { mode: 0o755 },
    );
    const fixture = `
set -eu
cp /fixture/docker /fixture/curl /usr/local/bin/
mkdir -p /var/log/liekan-test /opt/liekan-agent-docker/${website}
: > /var/log/liekan-test/access.log
: > /tmp/docker-calls
directory=/opt/liekan-agent-docker/${website}
if [ "$CASE" = locked-stop ]; then
  : > "$directory/docker-compose.yml"
  mkdir "$directory/.install-lock"
  exec 8> "$directory/.install.lock"
  flock -n 8
fi
if [ "$CASE" = stale-lock ]; then mkdir "$directory/.install-lock"; fi
log=/var/log/liekan-test/access.log
if [ "$CASE" = unsafe-path ]; then
  target=$(printf '/var/log/liekan-test/actual\\nLIEKAN_PUBLIC_URL=https:/attacker.example\\nLIEKAN_LOG_DIRECTORY=/var/log/liekan-test')
  mkdir -p "$target"
  : > "$target/access.log"
  ln -s "$target" /var/log/liekan-test/linked
  log=/var/log/liekan-test/linked/access.log
fi
if [ "$CASE" = locked-stop ]; then
  set -- --website ${website} --stop
else
  set -- --url https://stats.example.test --website ${website} --log "$log" --code ${'a'.repeat(43)}
fi
set +e
if [ "$CASE" = crash-retry ]; then
  CASE=kill sh /fixture/install.sh "$@" > /tmp/first-output 2>&1
  printf 'first-status=%s\\n' "$?"
  export CASE=normal
fi
sh /fixture/install.sh "$@" > /tmp/install-output 2>&1
status=$?
set -e
printf 'installer-status=%s\\n' "$status"
cat /tmp/docker-calls /tmp/install-output
`;
    const run = scenario =>
      docker(
        'run',
        '--rm',
        '--network',
        'none',
        '-e',
        `CASE=${scenario}`,
        '--mount',
        `type=bind,src=${temp},dst=/fixture,readonly`,
        'node:22.23.4-alpine',
        'sh',
        '-c',
        fixture,
      );
    await t.test('a normal installation pairs and starts', () => {
      const output = run('normal');
      assert.match(output, /installer-status=0\n/);
      assert.match(output, /collector pair/);
      assert.match(output, /compose .* up /);
    });
    await t.test('termination exits before pairing', () => {
      const output = run('signal');
      assert.match(output, /collector preflight/);
      assert.match(output, /installer-status=143\n/);
      assert.doesNotMatch(output, /collector pair|compose .* up /);
    });
    await t.test('stop respects an active installation lock', () => {
      const output = run('locked-stop');
      assert.match(output, /installer-status=1\n/);
      assert.match(output, /已有安装任务正在执行/);
      assert.doesNotMatch(output, /compose .* stop/);
    });
    await t.test('installation can resume after the installer is killed', () => {
      const output = run('crash-retry');
      assert.match(output, /first-status=137\n/);
      assert.match(output, /installer-status=0\n/);
      assert.match(output, /collector pair/);
    });
    await t.test(
      'a directory left by an interrupted legacy installer does not block recovery',
      () => {
        const output = run('stale-lock');
        assert.match(output, /installer-status=0\n/);
        assert.match(output, /collector pair/);
        assert.match(output, /Docker 采集器已启动/);
      },
    );
    await t.test(
      'a parent symlink cannot inject environment entries after canonicalization',
      () => {
        const output = run('unsafe-path');
        assert.match(output, /installer-status=1\n/);
        assert.match(output, /日志路径仅支持/);
        assert.doesNotMatch(output, /build --tag|collector preflight|collector pair/);
      },
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test('direct installer exits on termination before downloading further assets', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'liekan-installer-direct-'));
  const source = randomUUID();
  try {
    await writeFile(join(temp, 'install.sh'), await readFile('public/liekan-agent/install.sh'));
    const output = docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--mount',
      `type=bind,src=${temp},dst=/fixture,readonly`,
      'node:22.23.4-alpine',
      'sh',
      '-c',
      `
set -eu
printf 'ID=debian\\nVERSION_ID=12\\n' > /etc/os-release
mkdir -p /etc/liekan-agent
printf '{}' > /etc/liekan-agent/${source}.json
for command in systemctl openssl getent setpriv runuser useradd usermod; do
  printf '#!/bin/sh\\nexit 0\\n' > /usr/local/bin/"$command"
  chmod 755 /usr/local/bin/"$command"
done
cat > /usr/local/bin/curl <<'CURL'
#!/bin/sh
printf 'fetch\\n' >> /tmp/fetches
kill -TERM "$PPID"
exit 0
CURL
chmod 755 /usr/local/bin/curl
set +e
sh /fixture/install.sh --url https://stats.example.test --upgrade ${source} > /tmp/result 2>&1
status=$?
set -e
printf 'installer-status=%s\\n' "$status"
cat /tmp/fetches
`,
    );
    assert.match(output, /installer-status=143\n/);
    assert.equal(output.split('\n').filter(line => line === 'fetch').length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test('packaged Docker collector validates, pairs, persists, rotates and recovers offline batches', {
  timeout: 240000,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'liekan-agent-docker-'));
  const id = randomUUID();
  const prefix = `liekan-agent-test-${id.slice(0, 8)}`;
  const network = `${prefix}-net`,
    volume = `${prefix}-state`,
    receiver = `${prefix}-receiver`,
    collector = `${prefix}-collector`;
  const image = `${prefix}:test`,
    source = randomUUID();
  const code = randomBytes(32).toString('base64url'),
    token = randomBytes(32).toString('base64url');
  const code2 = randomBytes(32).toString('base64url'),
    token2 = randomBytes(32).toString('base64url'),
    source2 = randomUUID();
  const context = join(temp, 'context'),
    logs = join(temp, 'logs'),
    fixture = join(temp, 'fixture');
  await Promise.all([mkdir(context), mkdir(logs), mkdir(fixture)]);
  const archive = await JSZip.loadAsync(
    await readFile(resolve('public/liekan-agent/agent-docker.zip')),
  );
  for (const file of [
    'Dockerfile',
    'docker-compose.yml',
    'agent.mjs',
    'container.mjs',
    'LICENSE',
    'install.sh',
  ]) {
    assert.ok(archive.file(file), `packaged file ${file}`);
    await writeFile(join(context, file), await archive.file(file).async('nodebuffer'));
  }
  const log = join(logs, 'access.log');
  const line = path =>
    `192.0.2.20 - - [10/Oct/2026:12:00:00 +0000] "GET ${path} HTTP/1.1" 200 64 "-" "GPTBot"\n`;
  await writeFile(log, line('/historical'), { mode: 0o644 });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(fixture, 'key.pem'),
      '-out',
      join(fixture, 'ca.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=stats.example.test',
      '-addext',
      'subjectAltName=DNS:stats.example.test',
    ],
    { stdio: 'ignore' },
  );
  await writeFile(
    join(fixture, 'credentials.json'),
    JSON.stringify({ code, token, source, code2, token2, source2, websiteId: id }),
    {
      mode: 0o600,
    },
  );
  await writeFile(
    join(fixture, 'server.mjs'),
    `
import https from 'node:https'; import fs from 'node:fs';
const { code, token, source, code2, token2, source2, websiteId } = JSON.parse(fs.readFileSync('/fixture/credentials.json'));
let liveToken=token, liveSource=source;
let pairs=0, heartbeats=0; const events=new Map(); const requests=new Set();
function save(){fs.writeFileSync('/fixture/result.json',JSON.stringify({pairs,heartbeats,events:[...events.values()]}));} save();
https.createServer({key:fs.readFileSync('/fixture/key.pem'),cert:fs.readFileSync('/fixture/ca.pem')},async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk); const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
 const reply=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
 if(req.url==='/api/heartbeat')return reply(200,{ok:true});
 if(req.url==='/api/liekan/collectors/pair') {if(body.websiteId!==websiteId)return reply(409,{});if(body.code===code&&!pairs){pairs=1;}else if(body.code===code2&&pairs===1&&fs.existsSync('/fixture/revoked')){pairs=2;liveToken=token2;liveSource=source2;fs.unlinkSync('/fixture/revoked');}else return reply(401,{});save();return reply(200,{version:1,websiteId,sourceId:liveSource,token:liveToken,epoch:1});}
 if(req.headers.authorization!=='Bearer '+liveToken||fs.existsSync('/fixture/revoked'))return reply(401,{});
 if(req.method==='GET'&&req.url.endsWith('/heartbeat'))return reply(200,{version:1,websiteId,state:'active',epoch:1});
 if(fs.existsSync('/fixture/offline'))return reply(503,{});
 if(req.url.endsWith('/heartbeat')){heartbeats++;save();return reply(200,{version:1,epoch:1,state:'active'});}
 if(req.url.endsWith('/batches')){for(const event of body.events)events.set(event.generation+':'+event.offset,event.line);requests.add(body.batchId);save();return reply(200,{requestBatchId:body.batchId,batchId:body.batchId,epoch:1,received:body.events.length,valid:body.events.length,rejected:0});}
 reply(404,{});
}).listen(8443,'0.0.0.0');
`,
  );
  const result = async () => JSON.parse(await readFile(join(fixture, 'result.json'), 'utf8'));
  await writeFile(
    join(context, '.env'),
    [
      `LIEKAN_AGENT_IMAGE=${image}`,
      `LIEKAN_WEBSITE_ID=${id}`,
      'LIEKAN_LOG_GID=0',
      'LIEKAN_PUBLIC_URL=https://stats.example.test:8443',
      'LIEKAN_LOG_FILE=access.log',
      `LIEKAN_LOG_DIRECTORY=${logs}`,
    ].join('\n'),
  );
  await writeFile(
    join(context, 'override.json'),
    JSON.stringify({
      services: {
        collector: {
          container_name: collector,
          environment: { NODE_EXTRA_CA_CERTS: '/trust/ca.pem' },
          networks: ['fixture'],
          volumes: [
            {
              type: 'bind',
              source: join(fixture, 'ca.pem'),
              target: '/trust/ca.pem',
              read_only: true,
            },
          ],
        },
      },
      networks: { fixture: { external: true, name: network } },
      volumes: { state: { external: true, name: volume } },
    }),
  );
  const composeArgs = [
    'compose',
    '--project-name',
    prefix,
    '--project-directory',
    context,
    '--env-file',
    join(context, '.env'),
    '-f',
    join(context, 'docker-compose.yml'),
    '-f',
    join(context, 'override.json'),
  ];
  const compose = (...args) => docker(...composeArgs, ...args);
  try {
    docker('build', '--tag', image, context);
    docker('network', 'create', '--subnet', `10.253.${parseInt(id.slice(0, 2), 16)}.0/28`, network);
    docker('volume', 'create', volume);
    docker(
      'run',
      '-d',
      '--name',
      receiver,
      '--network',
      network,
      '--network-alias',
      'stats.example.test',
      '--mount',
      `type=bind,src=${fixture},dst=/fixture`,
      'node:22.23.4-alpine',
      'node',
      '/fixture/server.mjs',
    );
    await until(async () => {
      try {
        await result();
        return true;
      } catch {
        return false;
      }
    }, 'receiver fixture starts');
    compose('config', '--quiet');
    compose('run', '--rm', '-T', '--no-deps', 'collector', 'preflight');
    const help = docker(
      'run',
      '--rm',
      '--mount',
      `type=bind,src=${context},dst=/context,readonly`,
      'node:22.23.4-alpine',
      'sh',
      '/context/install.sh',
      '--help',
    );
    assert.match(help, /猎看 Docker 采集器/);
    const legacyBin = join(context, 'legacy-bin');
    await mkdir(legacyBin);
    await writeFile(
      join(legacyBin, 'docker'),
      `#!/bin/sh
case "$1" in
  info) case "$3" in *Architecture*) echo aarch64;; *OSType*) echo linux;; esac; exit 0;;
  compose) case "$2" in version) echo 'Docker Compose version v2.0.1'; exit 0;; up) echo '--detach --force-recreate'; exit 0;; esac;;
esac
exit 1
`,
      { mode: 0o755 },
    );
    await writeFile(join(legacyBin, 'curl'), '#!/bin/sh\ntouch /tmp/download-attempt\nexit 1\n', {
      mode: 0o755,
    });
    const legacy = docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--mount',
      `type=bind,src=${context},dst=/context,readonly`,
      'node:22.23.4-alpine',
      'sh',
      '-c',
      `export PATH="/context/legacy-bin:$PATH"; sh /context/install.sh --url https://stats.example.test --website ${id} > /tmp/result 2>&1; result=$?; cat /tmp/result; [ "$result" -eq 1 ] && [ ! -e /opt/liekan-agent-docker ] && [ ! -e /tmp/download-attempt ]`,
    );
    assert.match(legacy, /Docker Compose.*配对码未使用/);
    await writeFile(log, 'unsupported log format\n');
    const invalid = spawnSync(
      'docker',
      [...composeArgs, 'run', '--rm', '-T', '--no-deps', 'collector', 'pair'],
      {
        input: code,
        encoding: 'utf8',
      },
    );
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /日志格式/);
    assert.equal((await result()).pairs, 0, 'preflight failure never consumes a code');
    await writeFile(log, line('/historical'));
    const paired = spawnSync(
      'docker',
      [...composeArgs, 'run', '--rm', '-T', '--no-deps', 'collector', 'pair'],
      {
        input: code,
        encoding: 'utf8',
      },
    );
    assert.equal(paired.status, 0, paired.stderr);
    assert.equal(paired.stdout.includes(code), false);
    assert.equal(paired.stdout.includes(token), false);
    const repeated = spawnSync(
      'docker',
      [...composeArgs, 'run', '--rm', '-T', '--no-deps', 'collector', 'pair'],
      {
        input: '',
        encoding: 'utf8',
      },
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal((await result()).pairs, 1);
    compose('up', '-d', '--wait', '--wait-timeout', '60');
    await until(async () => {
      try {
        docker('exec', collector, 'node', '/app/container.mjs', 'health');
        return true;
      } catch {
        return false;
      }
    }, 'collector becomes ready');
    await until(async () => (await result()).heartbeats > 0, 'collector synchronizes');
    await appendFile(log, line('/first'));
    await until(async () => (await result()).events.length === 1, 'new request received');
    assert.equal(
      (await result()).events.some(row => row.includes('/historical')),
      false,
      'initial cursor starts at EOF',
    );
    docker('restart', collector);
    await until(async () => {
      try {
        docker('exec', collector, 'node', '/app/container.mjs', 'health');
        return true;
      } catch {
        return false;
      }
    }, 'collector restarts with state');
    await appendFile(log, line('/second'));
    await until(async () => (await result()).events.length === 2, 'restart preserves cursor');
    await rename(log, `${log}.1`);
    await writeFile(log, line('/rotated'), { mode: 0o644 });
    await until(
      async () => (await result()).events.length === 3,
      'directory mount follows rename/create rotation',
    );
    await writeFile(join(fixture, 'offline'), 'offline');
    await appendFile(log, line('/offline'));
    await until(
      async () =>
        Number(
          docker(
            'exec',
            collector,
            'node',
            '-e',
            `console.log(require('fs').readdirSync('/var/lib/liekan-agent/${source}/spool').length)`,
          ),
        ) > 0,
      'offline request persists in encrypted spool',
    );
    docker('restart', collector);
    await unlink(join(fixture, 'offline'));
    await until(
      async () => (await result()).events.length === 4,
      'offline batch survives restart and recovers',
      60000,
    );
    const final = await result();
    assert.equal(final.pairs, 1);
    assert.equal(final.events.length, 4);
    const inspected = JSON.parse(docker('inspect', collector))[0];
    assert.equal(inspected.HostConfig.Privileged, false);
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspected.Mounts.find(mount => mount.Destination === '/logs').RW, false);
    assert.equal(
      inspected.Config.Env.some(value => value.includes(token) || value.includes(code)),
      false,
    );
    const output = docker('logs', collector);
    assert.equal(output.includes(token) || output.includes(code), false);
    const originalEnvironment = await readFile(join(context, '.env'), 'utf8');
    const otherLogs = join(temp, 'other-logs');
    await mkdir(otherLogs);
    await writeFile(join(otherLogs, 'access.log'), line('/other-site'));
    await writeFile(join(context, '.env'), originalEnvironment.replace(logs, otherLogs));
    const changedLog = spawnSync(
      'docker',
      [...composeArgs, 'run', '--rm', '-T', '--no-deps', 'collector', 'preflight'],
      { encoding: 'utf8' },
    );
    assert.notEqual(changedLog.status, 0);
    assert.match(changedLog.stderr, /已有采集配置/);
    assert.equal(
      (await result()).pairs,
      1,
      'same-basename host path change cannot silently replace the binding',
    );
    await writeFile(join(context, '.env'), originalEnvironment);
    await writeFile(join(fixture, 'revoked'), 'revoked');
    const invalidReconnect = spawnSync(
      'docker',
      [...composeArgs, 'run', '--rm', '-T', '--no-deps', 'collector', 'pair'],
      { input: code, encoding: 'utf8' },
    );
    assert.notEqual(invalidReconnect.status, 0);
    assert.equal((await result()).pairs, 1);
    const reconnect = spawnSync(
      'docker',
      [...composeArgs, 'run', '--rm', '-T', '--no-deps', 'collector', 'pair'],
      { input: code2, encoding: 'utf8' },
    );
    assert.equal(reconnect.status, 0, reconnect.stderr);
    assert.equal((await result()).pairs, 2);
    compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '60');
    await appendFile(log, line('/reconnected'));
    await until(
      async () => (await result()).events.length === 5,
      'new pairing reconnects after revocation',
    );
    assert.equal(
      Number(
        docker(
          'exec',
          collector,
          'node',
          '-e',
          `console.log(require('fs').existsSync('/var/lib/liekan-agent/${source}/config.json') ? 1 : 0)`,
        ),
      ),
      1,
      'old configuration and cache remain available',
    );
  } finally {
    for (const name of [collector, receiver]) {
      try {
        docker('rm', '-f', name);
      } catch {}
    }
    for (const [kind, name] of [
      ['volume', volume],
      ['network', network],
      ['image', image],
    ]) {
      try {
        docker(kind, 'rm', name);
      } catch {}
    }
    await rm(temp, { recursive: true, force: true });
  }
});
