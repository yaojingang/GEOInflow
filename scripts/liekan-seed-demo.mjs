import 'dotenv/config';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { DemoSeedError, seedOfficialDemo } from './liekan-demo.mjs';

const automatic = process.argv.includes('--automatic');
let client;
try {
  if (automatic && process.env.LIEKAN_SEED_DEMO === 'false') {
    console.log(JSON.stringify({ status: 'disabled', inserted: false }));
    process.exit(0);
  }
  if (
    automatic &&
    (process.env.DATABASE_TYPE === 'clickhouse' ||
      process.env.CLICKHOUSE_URL ||
      process.env.CLOUD_MODE)
  ) {
    console.log(JSON.stringify({ status: 'unsupported-storage', inserted: false }));
    process.exit(0);
  }
  if (!process.env.DATABASE_URL) throw new DemoSeedError('缺少 DATABASE_URL');
  if (!process.env.APP_SECRET) throw new DemoSeedError('缺少 APP_SECRET');
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const hasWarehouse = (
    await client.query("SELECT to_regclass('public.liekan_warehouse_installation') AS name")
  ).rows[0].name;
  const installation = hasWarehouse
    ? (await client.query('SELECT authority FROM liekan_warehouse_installation WHERE id=1')).rows[0]
    : null;
  if (installation) {
    await client.end();
    client = null;
    if (automatic && installation.authority !== 'clickhouse') {
      console.log(JSON.stringify({ status: 'warehouse-transition', inserted: false }));
    } else {
      await new Promise((done, reject) => {
        const child = spawn(
          process.execPath,
          ['dist/liekan-warehouse-command.mjs', 'seed-demo', ...(automatic ? ['--automatic'] : [])],
          { stdio: 'inherit', env: process.env },
        );
        child.once('error', reject);
        child.once('exit', code =>
          code === 0
            ? done()
            : reject(new DemoSeedError('ClickHouse 示例导入未完成，可使用同一命令继续。')),
        );
      });
    }
  } else {
    const result = await seedOfficialDemo(client, {
      secret: process.env.APP_SECRET,
      schema,
      automatic,
    });
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(
    error instanceof DemoSeedError
      ? error.message
      : `默认示例初始化失败（${error.code || 'runtime'}），请检查数据库连接及迁移。`,
  );
  process.exitCode = 1;
} finally {
  await client?.end();
}
