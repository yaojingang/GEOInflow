// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readBenchmarkDemand } from '../../../../scripts/liekan-dashboard-drain';

const enabled = process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1';
const schema = `analysis_drain_${randomUUID().replaceAll('-', '')}`;
const site = randomUUID();
let client: Client;
beforeAll(async () => {
  if (!enabled) return;
  const url = new URL(process.env.DATABASE_URL);
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '15462' ||
    url.pathname !== '/liekan_analysis_rollups_test'
  )
    throw new Error('Owned dashboard benchmark fixture required');
  url.search = '';
  client = new Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(`CREATE TABLE liekan_analysis_query(id uuid PRIMARY KEY,website_id uuid,status text,target text,parameters jsonb DEFAULT '{}',attempts int DEFAULT 0,next_attempt_at timestamptz DEFAULT now(),retention_until timestamptz DEFAULT now()+interval '1 day');
    CREATE TABLE liekan_analysis_query_consumer(job_id uuid,actor_id uuid);
    CREATE TABLE liekan_dashboard_snapshot(job_id uuid,last_read_at timestamptz);
    CREATE TABLE liekan_analysis_build(id uuid PRIMARY KEY,website_id uuid,status text,family text DEFAULT 'both',attempts int DEFAULT 0,next_attempt_at timestamptz DEFAULT now(),origin_build_id uuid);`);
});
afterAll(async () => {
  if (!client) return;
  await client.query(`DROP SCHEMA ${schema} CASCADE`);
  await client.end();
});

it.skipIf(!enabled)(
  'settles the original cohort while retaining later foreground demand and build descendants',
  async () => {
    const query = randomUUID(),
      build = randomUUID(),
      child = randomUUID();
    await client.query(
      "INSERT INTO liekan_analysis_query(id,website_id,status,target) VALUES($1,$2,'running','feature:page-report')",
      [query, site],
    );
    await client.query(
      "INSERT INTO liekan_analysis_build(id,website_id,status) VALUES($1,$2,'running')",
      [build, site],
    );
    const initial = await readBenchmarkDemand(client, [], [site], true);
    const cohort = { queries: [query], builds: [build] };
    expect(initial.map(row => row.id).sort()).toEqual([query, build].sort());
    expect(await readBenchmarkDemand(client, [], [site], true, cohort)).toHaveLength(2);
    await client.query("UPDATE liekan_analysis_query SET status='ready'");
    await client.query("UPDATE liekan_analysis_build SET status='completed'");
    const maintenance = randomUUID(),
      history = randomUUID();
    await client.query(
      "INSERT INTO liekan_analysis_query(id,website_id,status,target) VALUES($1,$2,'queued','feature:page-report')",
      [maintenance, site],
    );
    await client.query(
      "INSERT INTO liekan_dashboard_snapshot(job_id,last_read_at) VALUES($1,'1970-01-01')",
      [maintenance],
    );
    await client.query(
      "INSERT INTO liekan_analysis_build(id,website_id,status) VALUES($1,$2,'queued')",
      [history, site],
    );
    expect(await readBenchmarkDemand(client, [], [site], true, cohort)).toEqual([]);
    expect(await readBenchmarkDemand(client, [], [site], true)).toHaveLength(2);
    const foreground = randomUUID();
    await client.query(
      "INSERT INTO liekan_analysis_query(id,website_id,status,target) VALUES($1,$2,'queued','feature:page-report')",
      [foreground, site],
    );
    await client.query(
      "INSERT INTO liekan_analysis_build(id,website_id,status,origin_build_id) VALUES($1,$2,'queued',$3)",
      [child, site, build],
    );
    const pending = await readBenchmarkDemand(client, [], [site], true, cohort);
    expect(pending.map(row => row.id).sort()).toEqual([foreground, child].sort());
    await client.query("UPDATE liekan_analysis_query SET status='ready' WHERE id=$1", [foreground]);
    await client.query("UPDATE liekan_analysis_build SET status='completed' WHERE id=$1", [child]);
    expect(await readBenchmarkDemand(client, [], [site], true, cohort)).toEqual([]);
  },
);
