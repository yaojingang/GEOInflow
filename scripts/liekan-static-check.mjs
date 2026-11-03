import { sqlStatements } from './liekan-sql-statements.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertProductImports } from './liekan-boundaries.mjs';
import { assertDialogContract } from './liekan-dialog-contract.mjs';
import { assertManualReadPolicy } from './liekan-manual-read-contract.mjs';

execFileSync(process.execPath, ['scripts/liekan-geography-catalog.mjs'], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/liekan-i18n-check.mjs'], { stdio: 'inherit' });
assertDialogContract();
assertManualReadPolicy();
const geographyUI = JSON.parse(readFileSync('config/liekan/geography-ui.json', 'utf8'));
if (
  geographyUI.cityRule !== 'merge-filter-search-sort-page-limit' ||
  geographyUI.denominator !== 'all-eligible-visits' ||
  geographyUI.shareLimit !== 12 ||
  geographyUI.provinceLimit !== 10
)
  throw new Error('Approved geography display rules changed');
const geographyContract = readFileSync('src/lib/liekan/contracts/geography.ts', 'utf8');
for (const key of ['subtitle', 'empty', 'unidentified', 'searchEmpty', 'legacy'])
  if (!geographyContract.includes(geographyUI[key]))
    throw new Error(`Geography copy contract missing: ${key}`);

const teamUserUI = JSON.parse(readFileSync('config/liekan/team-user-ui.json', 'utf8'));
if (
  teamUserUI.systemRole !== 'user' ||
  teamUserUI.defaultTeamRole !== 'team-view-only' ||
  teamUserUI.dialogSize !== 'standard'
)
  throw new Error('Approved team user role and dialog rules changed');
const teamUserDialog = readFileSync(
  'src/components/liekan/features/TeamUserCreateDialog.tsx',
  'utf8',
);
for (const text of [teamUserUI.dialogTitle, teamUserUI.submitLabel])
  if (!teamUserDialog.includes(text)) throw new Error(`Team user dialog contract missing: ${text}`);

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync('design/reference/geo-stats-v3/manifest.json', 'utf8'));
const baseline = JSON.parse(readFileSync('config/liekan/upstream.json', 'utf8'));
const manifestDigest = hash(
  JSON.stringify(
    Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b))),
  ),
);
if (manifestDigest !== baseline.uiManifestSha256)
  throw new Error('Approved UI reference collection fingerprint changed');
for (const [file, digest] of Object.entries(manifest))
  if (hash(readFileSync(`design/reference/geo-stats-v3/${file}`)) !== digest)
    throw new Error(`UI reference drift: ${file}`);
const featureUI = JSON.parse(readFileSync('config/liekan/feature-ui.json', 'utf8'));
if (hash(JSON.stringify(featureUI.files)) !== baseline.featureUiManifestSha256)
  throw new Error('Approved supplemental UI fingerprint changed');
for (const [file, digest] of Object.entries(featureUI.files))
  if (hash(readFileSync(`${featureUI.directory}/${file}`)) !== digest)
    throw new Error(`Supplemental UI drift: ${file}`);
const keywordUI = JSON.parse(readFileSync('config/liekan/keyword-ui.json', 'utf8'));
if (hash(JSON.stringify(keywordUI.files)) !== baseline.keywordUiManifestSha256)
  throw new Error('Approved keyword UI fingerprint changed');
for (const [file, digest] of Object.entries(keywordUI.files))
  if (hash(readFileSync(`${keywordUI.directory}/${file}`)) !== digest)
    throw new Error(`Keyword UI reference drift: ${file}`);
const searchEngineUI = JSON.parse(readFileSync('config/liekan/search-engine-ui.json', 'utf8'));
if (hash(JSON.stringify(searchEngineUI.files)) !== baseline.searchEngineUiManifestSha256)
  throw new Error('Search engine UI fingerprint changed');
for (const [file, digest] of Object.entries(searchEngineUI.files))
  if (hash(readFileSync(`${searchEngineUI.directory}/${file}`)) !== digest)
    throw new Error(`Search engine UI reference drift: ${file}`);
const aiUI = JSON.parse(readFileSync('config/liekan/ai-ui.json', 'utf8'));
if (hash(JSON.stringify(aiUI.sha256)) !== baseline.aiUiManifestSha256)
  throw new Error('Approved AI UI fingerprint changed');
for (const [file, digest] of Object.entries(aiUI.sha256))
  if (hash(readFileSync(`${aiUI.referenceRoot}/${file}`)) !== digest)
    throw new Error(`AI UI reference drift: ${file}`);
if (!aiUI.chatHome?.sha256 || !Object.keys(aiUI.chatHome.sha256).length)
  throw new Error('Approved AI homepage reference manifest is required');
if (hash(JSON.stringify(aiUI.chatHome.sha256)) !== baseline.aiChatHomeUiManifestSha256)
  throw new Error('Approved AI homepage reference fingerprint changed');
for (const [file, digest] of Object.entries(aiUI.chatHome.sha256))
  if (hash(readFileSync(`${aiUI.chatHome.referenceRoot}/${file}`)) !== digest)
    throw new Error(`AI homepage reference drift: ${file}`);
const qualityUI = JSON.parse(readFileSync('config/liekan/traffic-quality-ui.json', 'utf8'));
if (hash(JSON.stringify(qualityUI.files)) !== baseline.trafficQualityUiManifestSha256)
  throw new Error('Traffic quality UI fingerprint changed');
for (const [file, digest] of Object.entries(qualityUI.files))
  if (hash(readFileSync(`${qualityUI.directory}/${file}`)) !== digest)
    throw new Error(`Traffic quality UI reference drift: ${file}`);
const evidenceUI = JSON.parse(readFileSync('config/liekan/traffic-evidence-ui.json', 'utf8'));
for (const [file, digest] of Object.entries(evidenceUI.files))
  if (hash(readFileSync(`${evidenceUI.directory}/${file}`)) !== digest)
    throw new Error(`Traffic evidence UI reference drift: ${file}`);
const geoWeightUI = JSON.parse(readFileSync('config/liekan/geo-weight-ui.json', 'utf8'));
for (const [file, digest] of Object.entries(geoWeightUI.files))
  if (hash(readFileSync(`${geoWeightUI.directory}/${file}`)) !== digest)
    throw new Error(`GEO weight UI reference drift: ${file}`);
const migrationLock = JSON.parse(readFileSync('config/liekan/migrations.json', 'utf8'));
if (baseline.liekanMigration !== Object.keys(migrationLock).length)
  throw new Error('Release migration count and immutable register differ');
if (
  JSON.stringify(
    readdirSync('db/liekan/migrations')
      .filter(f => f.endsWith('.sql'))
      .sort(),
  ) !== JSON.stringify(Object.keys(migrationLock).sort())
)
  throw new Error('Migration directory and immutable register differ');
for (const [file, digest] of Object.entries(migrationLock))
  if (hash(readFileSync(`db/liekan/migrations/${file}`)) !== digest)
    throw new Error(`Immutable migration drift: ${file}`);
// Parse every registered migration using the same quote-aware splitter as installation.
for (const file of Object.keys(migrationLock)) {
  if (!sqlStatements(readFileSync(`db/liekan/migrations/${file}`, 'utf8')).length)
    throw new Error(`Empty migration: ${file}`);
}
const visit = path =>
  readdirSync(path, { withFileTypes: true }).flatMap(file =>
    file.isDirectory() ? visit(join(path, file.name)) : [join(path, file.name)],
  );
for (const file of [
  ...visit('src/components/liekan'),
  ...visit('src/lib/liekan').filter(path => !path.includes('/upstream/')),
  ...visit('src/app/(main)/websites/[websiteId]/geo'),
].filter(path => /\.tsx?$/.test(path))) {
  const source = readFileSync(file, 'utf8');
  assertProductImports(file, source);
}
const overrides = JSON.parse(readFileSync('config/liekan/core-overrides.json', 'utf8'));
if (overrides.baseline !== baseline.commit)
  throw new Error('Core override baseline differs from the selected upstream commit');
for (const entry of overrides.files) {
  for (const field of ['path', 'purpose', 'owner', 'constraint', 'removalCondition'])
    if (typeof entry[field] !== 'string' || !entry[field].trim())
      throw new Error(`Incomplete core override ${entry.path}: ${field}`);
  if (!Array.isArray(entry.tests) || !entry.tests.length)
    throw new Error(`Core override lacks regression checks: ${entry.path}`);
}
const changed = execFileSync('git', ['diff', '--name-only', baseline.commit], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);
changed.push(
  ...execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean),
);
const own = path =>
  /^(src\/lib\/liekan\/|src\/liekan-agent\/|src\/liekan-worker\/|src\/components\/liekan\/|src\/styles\/liekan\/|src\/app\/api\/liekan\/|src\/app\/\(main\)\/websites\/\[websiteId\]\/geo\/|scripts\/liekan-|liekan-agent-deploy\/|db\/liekan\/|config\/liekan\/|design\/|docs\/|public\/liekan\/|tests\/liekan\/|tests\/api\/liekan\.spec\.ts$)/.test(
    path,
  );
for (const path of changed)
  if (!own(path) && !overrides.files.some(file => file.path === path))
    throw new Error(`Unregistered core override: ${path}`);
if (readFileSync('package.json', 'utf8').includes('"ua-parser-js"'))
  throw new Error('Direct ua-parser-js dependency returned');
if (!readFileSync('LICENSE', 'utf8').includes('Umami Software, Inc.'))
  throw new Error('Original copyright missing');
console.log(
  'UI reference, migration fingerprints, product imports and core override register passed.',
);
