import { execFileSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import JSZip from 'jszip';

const version = '22.23.4';
const runtimes = {
  x64: 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',
  arm64: 'f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9',
};
// Keep the working paths relative to the repository root: tar (GNU and bsdtar)
// reads an absolute Windows path such as F:\... as a remote host specification.
const cache = 'outputs/agent-build-cache',
  output = 'public/liekan-agent';
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
let keyPath = process.env.LIEKAN_AGENT_SIGNING_KEY_FILE;
if (process.argv.includes('--development-key')) {
  keyPath = resolve('.local/agent-development-signing.pem');
  await mkdir(resolve('.local'), { recursive: true });
  try {
    await access(keyPath);
  } catch {
    await writeFile(
      keyPath,
      generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    );
  }
}
if (!keyPath)
  throw new Error(
    'Configure LIEKAN_AGENT_SIGNING_KEY_FILE; local verification may use --development-key',
  );
const privateKey = createPrivateKey(await readFile(keyPath));
if (privateKey.asymmetricKeyType !== 'ed25519')
  throw new Error('An Ed25519 signing key is required');
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
await build({
  entryPoints: ['src/liekan-agent/main.ts'],
  outfile: join(cache, 'agent.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
});
const dockerContext = join(cache, 'docker');
await mkdir(dockerContext, { recursive: true });
await build({
  entryPoints: ['src/liekan-agent/container.ts'],
  outfile: join(dockerContext, 'container.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
});
await copyFile(join(cache, 'agent.mjs'), join(dockerContext, 'agent.mjs'));
await copyFile('LICENSE', join(dockerContext, 'LICENSE'));
for (const file of ['Dockerfile', 'docker-compose.yml'])
  await copyFile(`scripts/liekan-agent/${file}`, join(dockerContext, file));
const dockerFiles = ['Dockerfile', 'docker-compose.yml', 'agent.mjs', 'container.mjs', 'LICENSE'];
// GNU tar on Windows treats backslash separators as escape characters.
const posix = path => path.replaceAll('\\', '/');
execFileSync('tar', [
  '-czf',
  posix(join(output, 'agent-docker.tar.gz')),
  '-C',
  posix(dockerContext),
  ...dockerFiles,
]);
const dockerChecksum = createHash('sha256')
  .update(await readFile(join(output, 'agent-docker.tar.gz')))
  .digest('hex');
const dockerInstaller = (await readFile('scripts/liekan-agent/install-docker.template.sh', 'utf8'))
  .replaceAll('__DOCKER_SHA256__', dockerChecksum)
  .replaceAll('__DOCKER_TAG__', dockerChecksum.slice(0, 12));
await writeFile(join(output, 'install-docker.sh'), dockerInstaller);
const dockerZip = new JSZip();
for (const file of dockerFiles) dockerZip.file(file, await readFile(join(dockerContext, file)));
dockerZip.file('install.sh', dockerInstaller, { unixPermissions: 0o755 });
await writeFile(
  join(output, 'agent-docker.zip'),
  await dockerZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' }),
);
const manifest = {
  version: '1.0.0',
  protocol: 1,
  runtime: version,
  installerSha256: '',
  platforms: {},
  docker: {
    file: 'agent-docker.tar.gz',
    sha256: dockerChecksum,
    zipFile: 'agent-docker.zip',
    zipSha256: createHash('sha256')
      .update(await readFile(join(output, 'agent-docker.zip')))
      .digest('hex'),
    installerSha256: createHash('sha256').update(dockerInstaller).digest('hex'),
  },
};
// Refresh the standalone manual deployment folder; its static templates live in the repo.
const deploy = resolve('liekan-agent-deploy');
await copyFile(join(cache, 'agent.mjs'), join(deploy, 'agent.mjs'));
await copyFile(join(dockerContext, 'container.mjs'), join(deploy, 'container.mjs'));
const deployFiles = [
  'Dockerfile',
  'docker-compose.yml',
  '.env.example',
  'README.md',
  'README.en.md',
  'LICENSE',
  'agent.mjs',
  'container.mjs',
];
for (const file of deployFiles) await access(join(deploy, file));
const rootLicense = await readFile('LICENSE');
if (!(await readFile(join(deploy, 'LICENSE'))).equals(rootLicense))
  throw new Error('liekan-agent-deploy/LICENSE differs from the project LICENSE');
for (const [arch, expected] of Object.entries(runtimes)) {
  const name = `node-v${version}-linux-${arch}.tar.gz`,
    runtime = join(cache, name);
  try {
    await access(runtime);
  } catch {
    execFileSync(
      'curl',
      [
        '-fsS',
        // Schannel cannot finish its revocation probe on restricted networks;
        // the downloaded runtime is still pinned by its SHA-256 below.
        ...(process.platform === 'win32' ? ['--ssl-no-revoke'] : []),
        '--retry',
        '4',
        '--retry-delay',
        '2',
        '--retry-all-errors',
        '--proto',
        '=https',
        '--tlsv1.2',
        '--max-time',
        '300',
        `https://nodejs.org/download/release/v${version}/${name}`,
        '-o',
        posix(runtime),
      ],
      { stdio: 'inherit' },
    );
  }
  if (
    createHash('sha256')
      .update(await readFile(runtime))
      .digest('hex') !== expected
  )
    throw new Error('Official Node runtime checksum mismatch');
  const dir = join(cache, arch);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  execFileSync('tar', [
    '-xzf',
    posix(runtime),
    '-C',
    posix(dir),
    '--strip-components=1',
    `node-v${version}-linux-${arch}/bin/node`,
    `node-v${version}-linux-${arch}/LICENSE`,
  ]);
  await copyFile(join(cache, 'agent.mjs'), join(dir, 'agent.mjs'));
  await copyFile('LICENSE', join(dir, 'LIEKAN-LICENSE'));
  const file = `agent-linux-${arch}.tar.gz`;
  execFileSync('tar', [
    '-czf',
    posix(join(output, file)),
    '-C',
    posix(dir),
    'bin/node',
    'agent.mjs',
    'LICENSE',
    'LIEKAN-LICENSE',
  ]);
  manifest.platforms[arch] = {
    file,
    sha256: createHash('sha256')
      .update(await readFile(join(output, file)))
      .digest('hex'),
  };
}
const installer = (await readFile('scripts/liekan-agent/install.template.sh', 'utf8')).replace(
  '__PUBLIC_KEY__',
  String(publicKey).trim(),
);
manifest.installerSha256 = createHash('sha256').update(installer).digest('hex');
const bytes = Buffer.from(JSON.stringify(manifest));
await writeFile(join(output, 'manifest.json'), bytes);
await writeFile(join(output, 'manifest.sig'), sign(null, bytes, privateKey));
await writeFile(join(output, 'manifest.pub'), publicKey);
await writeFile(join(output, 'install.sh'), installer);
console.log('Signed collector artifacts built for Docker and Linux x64/arm64.');
console.log('Manual deployment folder liekan-agent-deploy/ SHA-256:');
for (const file of deployFiles)
  console.log(
    `  ${createHash('sha256')
      .update(await readFile(join(deploy, file)))
      .digest('hex')}  ${file}`,
  );
