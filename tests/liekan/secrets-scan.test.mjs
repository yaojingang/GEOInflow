import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

test('secret scan exceptions match known metadata while new secrets remain detectable in every path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'liekan-secret-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const config = resolve('.gitleaks.toml');
  const files = [
    'config/liekan/ai-ui.json',
    'config/liekan/feature-ui.json',
    'config/liekan/migrations.json',
    'src/lib/liekan/i18n/messages/en-US.json',
    'src/lib/liekan/i18n/help-messages/en-US.json',
    'src/components/liekan/features/WorkspacePages.tsx',
    'docker-compose.test.yml',
    'tests/liekan/deployment.test.mjs',
    'src/lib/mcp/auth.test.ts',
  ];
  for (const file of files) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    await copyFile(file, join(source, file));
  }
  await writeFile(
    join(source, 'src/lib/mcp/auth.test.ts'),
    `const api_key = ${JSON.stringify(
      ['eyJhbGciOiJIUzI1NiJ9', 'eyJ0eXBlIjoib2F1dGhfYWNjZXNzIn0', 'signature'].join('.'),
    )};\n`,
  );
  const scan = name =>
    spawnSync(
      process.env.GITLEAKS_BINARY || 'gitleaks',
      [
        'dir',
        '.',
        '--config',
        config,
        '--redact=100',
        '--no-banner',
        '--no-color',
        '--log-level=error',
        '--report-format=json',
        '--report-path',
        join(root, `${name}.json`),
      ],
      { cwd: source, encoding: 'utf8', timeout: 30_000 },
    );
  const metadata = scan('metadata');
  assert.equal(metadata.status, 0, metadata.error?.message || metadata.stderr);

  // Stable probes keep upstream heuristic allowlists from making this check random.
  const unexpectedSecret = createHash('sha256')
    .update('liekan-gitleaks-positive-base64url-v1')
    .digest('base64url');
  for (const file of [...files, 'unexpected-source.ts']) {
    await writeFile(join(source, file), `const api_key = "${unexpectedSecret}";\n`);
  }
  const positive = scan('positive');
  assert.equal(positive.status, 1, positive.error?.message || positive.stderr);
  const findings = JSON.parse(await readFile(join(root, 'positive.json'), 'utf8'));
  const detected = new Set(findings.map(finding => finding.File));
  for (const file of [...files, 'unexpected-source.ts']) assert.ok(detected.has(file), file);

  const unexpectedHexSecret = createHash('sha256')
    .update('liekan-gitleaks-positive-hex-v1')
    .digest('hex');
  for (const file of [...files, 'unexpected-source.ts']) {
    await writeFile(join(source, file), `const api_key = "${unexpectedHexSecret}";\n`);
  }
  const hex = scan('hex');
  assert.equal(hex.status, 1, hex.error?.message || hex.stderr);
  const hexFindings = JSON.parse(await readFile(join(root, 'hex.json'), 'utf8'));
  const hexDetected = new Set(hexFindings.map(finding => finding.File));
  for (const file of [...files, 'unexpected-source.ts']) assert.ok(hexDetected.has(file), file);

  for (const file of files) await rm(join(source, file));
  await writeFile(
    join(source, 'unexpected-source.ts'),
    `const api_key = ${JSON.stringify(['cell', 'twofactorbadge', '27'].join('-'))};\n`,
  );
  const wrongPath = scan('wrong-path');
  assert.equal(wrongPath.status, 1, wrongPath.error?.message || wrongPath.stderr);
  const outside = JSON.parse(await readFile(join(root, 'wrong-path.json'), 'utf8'));
  assert.ok(outside.some(finding => finding.File === 'unexpected-source.ts'));
});
