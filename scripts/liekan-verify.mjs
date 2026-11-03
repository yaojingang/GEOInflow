import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

if (Number(process.versions.node.split('.')[0]) !== 22)
  throw new Error('Use the pinned Node.js 22 runtime');
const pnpm = process.env.npm_execpath;
if (!pnpm?.includes('pnpm')) throw new Error('Run through pnpm liekan:verify');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const workingTree = process.argv.includes('--working-tree');
const sourceOnly = workingTree || process.argv.includes('--source-only');
const status = () => execFileSync('git', ['status', '--porcelain', '-uall'], { encoding: 'utf8' });
if (!workingTree && status().trim())
  throw new Error(
    'Release verification requires a clean committed candidate. Use --working-tree for development checks.',
  );
const fingerprint = () => {
  const hash = createHash('sha256').update(
    execFileSync('git', ['diff', '--binary', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 }),
  );
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .sort();
  for (const path of untracked) hash.update(path).update(readFileSync(path));
  return hash.digest('hex');
};
const sourceFingerprint = fingerprint();
const commands = [
  ['install', '--frozen-lockfile'],
  ['exec', 'prisma', 'generate'],
  ['run', 'build:prisma:client'],
  ['run', 'build:ai:maintenance'],
  ['run', 'liekan:build-worker'],
  ['run', 'liekan:check-demo'],
  ['run', 'build:openapi'],
  ['run', 'openapi:check', '--explicit'],
  ['run', 'check:api:client'],
  ['run', 'build:packages'],
  ['exec', 'tsc', '--noEmit', '--pretty', 'false'],
  // Bound CPU contention so real bcrypt checks keep their existing timeout.
  ['run', 'test', '--maxWorkers=2'],
  ['run', 'test:packages'],
  ['run', 'test:deployment'],
  ['run', 'test:log-ingestion'],
  ['exec', 'node', 'scripts/liekan-static-check.mjs'],
  ['run', 'build:tracker'],
  ['run', 'build:recorder'],
  ['run', 'build:app'],
];
const results = [];
mkdirSync('outputs', { recursive: true });
for (const args of commands) {
  const start = Date.now();
  const result = spawnSync(pnpm, args, {
    stdio: 'inherit',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  results.push({
    command: ['pnpm', ...args].join(' '),
    status: result.status,
    seconds: (Date.now() - start) / 1000,
  });
  writeFileSync(
    'outputs/verification.json',
    `${JSON.stringify({ head, sourceFingerprint, mode: workingTree ? 'development' : 'release', passed: false, finalized: false, results }, null, 2)}\n`,
  );
  if (result.status !== 0) process.exit(result.status || 1);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== head)
  throw new Error('HEAD changed during verification');
if (fingerprint() !== sourceFingerprint)
  throw new Error(
    'Source, lockfile or generated files changed during verification. Review and commit regenerated artifacts, then rerun.',
  );
if (!workingTree && status().trim()) throw new Error('Generation left uncommitted changes');
writeFileSync(
  'outputs/verification.json',
  `${JSON.stringify({ head, sourceFingerprint, mode: workingTree ? 'development' : 'release', passed: true, finalized: true, results }, null, 2)}\n`,
);
console.log(`Liekan source checks passed at ${head}.`);
if (sourceOnly) {
  console.log('Source-only run: Docker, API, restore and visual acceptance were not run.');
} else {
  const acceptance = spawnSync(process.execPath, ['scripts/liekan-acceptance.mjs'], {
    stdio: 'inherit',
    env: process.env,
  });
  if (acceptance.status !== 0) process.exit(acceptance.status || 1);
  const trafficQuality = spawnSync(
    process.execPath,
    ['tests/liekan/traffic-quality.integration.mjs'],
    {
      stdio: 'inherit',
      env: process.env,
    },
  );
  if (trafficQuality.status !== 0) process.exit(trafficQuality.status || 1);
  const crawlerEvidence = spawnSync(
    process.execPath,
    ['tests/liekan/crawler-evidence.integration.mjs'],
    { stdio: 'inherit', env: process.env },
  );
  if (crawlerEvidence.status !== 0) process.exit(crawlerEvidence.status || 1);
}
