#!/usr/bin/env node
import 'dotenv/config';
import {
  closeWarehouseV2Runtime,
  ensureV2Schema,
  importPgToWarehouseV2,
  purgeV2SiteEpoch,
  rebuildV2LogHourAggregates,
  seedV2OfficialDemo,
  warehouseV2Runtime,
} from '../src/lib/liekan/warehouse-v2/index';

const [command, ...args] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main() {
  const rt = warehouseV2Runtime();
  try {
    if (command === 'init') {
      await ensureV2Schema(rt.ch);
      console.log(JSON.stringify({ ok: true, command: 'init' }));
      return;
    }
    if (command === 'import-pg') {
      const websiteId = flag('--website-id');
      const batchSize = flag('--batch-size') ? Number(flag('--batch-size')) : 5000;
      const stats = await importPgToWarehouseV2(rt.pg, rt.ch, {
        websiteId,
        batchSize,
        onProgress: (stage, count) => {
          if (count % 50000 === 0) console.error(`[import-pg] ${stage}: ${count}`);
        },
      });
      console.log(JSON.stringify({ ok: true, command: 'import-pg', stats }));
      return;
    }
    if (command === 'purge-site') {
      const websiteId = flag('--website-id');
      const beforeEpoch = flag('--before-epoch');
      if (!websiteId || !beforeEpoch) {
        throw new Error('Usage: purge-site --website-id UUID --before-epoch N');
      }
      await purgeV2SiteEpoch(rt.ch, websiteId, beforeEpoch);
      console.log(JSON.stringify({ ok: true, command: 'purge-site', websiteId, beforeEpoch }));
      return;
    }
    if (command === 'rebuild-hour') {
      const websiteId = flag('--website-id');
      const epoch = flag('--epoch') ?? '1';
      const hour = flag('--hour');
      if (!websiteId || !hour) {
        throw new Error('Usage: rebuild-hour --website-id UUID --epoch N --hour ISO_UTC');
      }
      await rebuildV2LogHourAggregates(rt.ch, websiteId, epoch, hour);
      console.log(JSON.stringify({ ok: true, command: 'rebuild-hour', websiteId, epoch, hour }));
      return;
    }
    if (command === 'seed-demo') {
      const automatic = args.includes('--automatic');
      const secret = process.env.APP_SECRET || '';
      const schema = new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || 'public';
      const result = await seedV2OfficialDemo(rt.pg, rt.ch, { secret, schema, automatic });
      console.log(JSON.stringify({ ok: true, command: 'seed-demo', ...result }));
      return;
    }
    console.error(
      'Commands: init | seed-demo [--automatic] | import-pg [--website-id UUID] | purge-site | rebuild-hour',
    );
    process.exitCode = 1;
  } finally {
    await closeWarehouseV2Runtime();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
