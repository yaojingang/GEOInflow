// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import pg from 'pg';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
it.skipIf(process.env.LIEKAN_REPORT_PLAN_PAGES !== '1')(
  'upgrades an existing control schema once and preserves identities, website and migration records',
  async () => {
    const admin = new pg.Client('postgresql://postgres@127.0.0.1:25489/postgres');
    const name = `report_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = `postgresql://postgres@127.0.0.1:25489/${name}`;
    const db = new pg.Client(url);
    await db.connect();
    try {
      await db.query(
        'CREATE TABLE _prisma_migrations(migration_name text,checksum text,finished_at timestamptz,rolled_back_at timestamptz)',
      );
      for (const file of (await readdir('prisma/migrations')).filter(n => /^\d/.test(n)).sort()) {
        const sql = await readFile(`prisma/migrations/${file}/migration.sql`, 'utf8');
        await db.query(sql);
        await db.query('INSERT INTO _prisma_migrations VALUES($1,$2,now(),null)', [
          file,
          createHash('sha256').update(sql).digest('hex'),
        ]);
      }
      await db.query(
        'CREATE TABLE liekan_migration(name text PRIMARY KEY,checksum varchar(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const file of (await readdir('db/liekan/migrations'))
        .filter(n => /^\d.*\.sql$/.test(n) && !/^09[678]_/.test(n))
        .sort()) {
        const sql = await readFile(`db/liekan/migrations/${file}`, 'utf8');
        await db.query(sql);
        await db.query('INSERT INTO liekan_migration(name,checksum) VALUES($1,$2)', [
          file,
          createHash('sha256').update(sql).digest('hex'),
        ]);
      }
      const site = randomUUID();
      await db.query(
        "INSERT INTO website(website_id,name,domain) VALUES($1,'Upgrade fixture','upgrade.test')",
        [site],
      );
      const before = (await db.query('SELECT * FROM liekan_migration ORDER BY name')).rows;
      const accounts = (await db.query('SELECT * FROM "user" ORDER BY user_id')).rows;
      const websites = (await db.query('SELECT * FROM website ORDER BY website_id')).rows;
      const run = () =>
        exec(process.execPath, ['scripts/liekan-migrate.mjs'], {
          env: { ...process.env, DATABASE_URL: url },
          timeout: 60000,
        });
      const upgraded = (await run()).stdout;
      expect(upgraded).toContain('096_warehouse_report_boundaries.sql');
      expect(upgraded).toContain('098_warehouse_round_metrics.sql');
      const after = (await db.query('SELECT * FROM liekan_migration ORDER BY name')).rows;
      expect(after.filter(r => !/^09[678]_/.test(r.name))).toEqual(before);
      expect(after).toHaveLength(before.length + 3);
      expect((await run()).stdout).not.toContain('migration applied');
      expect((await db.query('SELECT * FROM liekan_migration ORDER BY name')).rows).toEqual(after);
      expect((await db.query('SELECT * FROM "user" ORDER BY user_id')).rows).toEqual(accounts);
      expect((await db.query('SELECT * FROM website ORDER BY website_id')).rows).toEqual(websites);
      expect(
        (await db.query("SELECT to_regclass('liekan_warehouse_report_boundary') AS name")).rows[0]
          .name,
      ).toBe('liekan_warehouse_report_boundary');
      expect(
        (await db.query("SELECT to_regclass('liekan_warehouse_report_round') AS name")).rows[0]
          .name,
      ).toBe('liekan_warehouse_report_round');
    } finally {
      await db.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
  120000,
);
