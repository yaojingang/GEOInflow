import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { readDemoManifest, readDemoRecords } from './liekan-demo.mjs';
import { demoKinds, validateDemoRow } from './liekan-demo-format.mjs';
import { bundledDemoCatalog } from './liekan-demo-catalog.mjs';

export async function checkOfficialDemo() {
  const manifest = await readDemoManifest();
  const bundled = await bundledDemoCatalog();
  const catalog = JSON.parse(
    await readFile(new URL('./liekan-demo-data/catalog.json', import.meta.url), 'utf8'),
  );
  if (JSON.stringify(catalog) !== JSON.stringify(bundled))
    throw new Error('Default demo catalog must match the source factory');
  const counts = Object.fromEntries(demoKinds.map(kind => [kind, 0]));
  const days = new Set();
  let pageviews = 0,
    conversions = 0,
    performance = 0,
    metadata = false;
  const forbidden =
    /^(?:password|token|secret|distinct_id|ip|ip_hash|ip_masked|user_agent|user_id|owner_id|created_by|headers|authorization|cookie)$/i;
  const inspect = value => {
    if (value && typeof value === 'object')
      for (const [key, nested] of Object.entries(value)) {
        if (forbidden.test(key)) throw new Error('Private field in official demo');
        inspect(nested);
      }
  };
  for await (const record of readDemoRecords()) {
    if (!Array.isArray(record) || record.length !== 2) throw new Error('Malformed demo record');
    const [kind, row] = record;
    if (kind === 'metadata') {
      if (
        metadata ||
        Object.values(counts).some(Boolean) ||
        row.websiteId !== manifest.websiteId ||
        row.formatVersion !== 2 ||
        row.isDemo !== true
      )
        throw new Error('Invalid demo metadata');
      metadata = true;
      continue;
    }
    if (!metadata) throw new Error('Missing demo metadata');
    validateDemoRow(kind, row, manifest);
    inspect(row);
    counts[kind]++;
    if (kind === 'event') {
      pageviews += Number(row.event_type === 1);
      conversions += Number(row.event_type === 2);
      performance += Number(row.event_type === 5);
      if (row.created_at >= -30 * 86400000)
        days.add(
          Math.floor((Date.parse(manifest.sourceAnchor) + row.created_at + 8 * 3600000) / 86400000),
        );
    }
  }
  if (!metadata || demoKinds.some(kind => counts[kind] !== manifest.counts[kind]))
    throw new Error('Demo record count mismatch');
  if (
    pageviews !== manifest.pageviews ||
    conversions !== manifest.conversionEvents ||
    performance !== manifest.performanceEvents ||
    days.size < 30
  )
    throw new Error('Demo feature/date coverage incomplete');
  for (const kind of [
    'quality',
    'geography',
    'environment',
    'event-data',
    'session-data',
    'revenue',
    'heatmap',
    'replay',
    'saved-replay',
    'evidence',
    'catalog-snapshot',
    'annotation',
  ])
    if (!counts[kind]) throw new Error('Missing official demo feature');
  return {
    counts,
    pageviews,
    conversions,
    performance,
    recentDays: days.size,
    sha256: manifest.sha256,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await checkOfficialDemo()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
