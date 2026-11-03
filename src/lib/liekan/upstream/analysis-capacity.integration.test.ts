// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';

const enabled = process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1';
let prisma: typeof import('@/lib/prisma').default;
afterAll(async () => {
  vi.unstubAllEnvs();
  if (prisma) await prisma.client.$disconnect();
});

describe.skipIf(!enabled)('configured storage capacity in an owned PostgreSQL schema', () => {
  it('resumes the same checkpoint and publishes exact coverage after expanding the site budget', async () => {
    const url = new URL(process.env.DATABASE_URL);
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '15462' ||
      url.pathname !== '/liekan_analysis_rollups_test' ||
      !/^analysis_[a-f0-9]+$/.test(url.searchParams.get('schema') || '')
    )
      throw new Error('Owned analysis test database required');
    vi.stubEnv('LIEKAN_ANALYSIS_SITE_LIMIT_MIB', '1024');
    vi.stubEnv('LIEKAN_ANALYSIS_GLOBAL_LIMIT_MIB', '8192');
    vi.resetModules();
    const database = await import('./analysis-rollups-db');
    const original = await import('./analysis-rollups-worker');
    ({ default: prisma } = await import('@/lib/prisma'));
    const exec = (sql: string, ...values: unknown[]) =>
      database.analysisTransaction(tx => tx.$executeRawUnsafe(sql, ...values));
    const query = (sql: string, ...values: unknown[]) =>
      database.analysisTransaction(tx => tx.$queryRawUnsafe<any[]>(sql, ...values));
    const actor = randomUUID(),
      site = randomUUID(),
      imported = randomUUID();
    const start = new Date(Math.floor((Date.now() - 7200000) / 3600000) * 3600000);
    await exec(
      `INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$1,'fixture','user')`,
      actor,
    );
    await exec(
      "INSERT INTO website(website_id,name,domain,user_id) VALUES($1::uuid,'Capacity regression fixture','capacity.example',$2::uuid)",
      site,
      actor,
    );
    await exec(
      'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1,2001,0)',
      imported,
      site,
    );
    await exec(
      `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
      SELECT md5($1::text||g),$1::uuid,$2::uuid,$3::timestamptz+interval '1 minute','/capacity','GET',200,0,'','','GPTBot/fixture','','GPTBot','OpenAI','训练','verified_range',true,'recognized' FROM generate_series(1,2001) g`,
      site,
      imported,
      start,
    );
    await original.reconcileAnalysisRollups();
    const [unit] = await query(
      "SELECT id FROM liekan_analysis_build WHERE website_id=$1::uuid AND actor_id IS NULL AND request_hash='live' ORDER BY range_start DESC LIMIT 1",
      site,
    );
    expect(unit).toBeDefined();
    await original.runOneAnalysisWorkUnit(unit.id);
    const [before] = await query(
      'SELECT checkpoint FROM liekan_analysis_build WHERE id=$1::uuid',
      unit.id,
    );
    expect(before.checkpoint.generation).toBeTruthy();
    await exec(
      'UPDATE liekan_analysis_site SET derived_bytes=$2::bigint WHERE website_id=$1::uuid',
      site,
      String(998 * 1024 ** 2),
    );
    await original.runOneAnalysisWorkUnit(unit.id);
    const [limited] = await query(
      'SELECT status,checkpoint FROM liekan_analysis_build WHERE id=$1::uuid',
      unit.id,
    );
    expect(limited.status).toBe('capacity_limited');
    expect(limited.checkpoint).toEqual(before.checkpoint);
    await exec(
      "UPDATE liekan_analysis_build SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",
      unit.id,
    );

    vi.stubEnv('LIEKAN_ANALYSIS_SITE_LIMIT_MIB', '2048');
    vi.resetModules();
    const expanded = await import('./analysis-rollups-worker');
    const expandedDatabase = await import('./analysis-rollups-db');
    const capacity = await expandedDatabase.analysisTransaction(tx =>
      expandedDatabase.analysisCapacity(tx, site),
    );
    expect(capacity.siteLimit).toBe(2 * 1024 ** 3);
    await expanded.reconcileAnalysisRollups();
    const [resumed] = await query(
      'SELECT status,checkpoint,attempts,error_code FROM liekan_analysis_build WHERE id=$1::uuid',
      unit.id,
    );
    expect(resumed).toMatchObject({ status: 'queued', attempts: 0, error_code: null });
    expect(resumed.checkpoint).toEqual(before.checkpoint);
    for (let n = 0; n < 4; n++) {
      await expanded.runOneAnalysisWorkUnit(unit.id);
      const [row] = await query(
        'SELECT status FROM liekan_analysis_build WHERE id=$1::uuid',
        unit.id,
      );
      if (row.status === 'completed') break;
    }
    expect(
      (await query('SELECT status FROM liekan_analysis_build WHERE id=$1::uuid', unit.id))[0]
        .status,
    ).toBe('completed');
    const [counts] = await query(
      `SELECT (SELECT count(*) FROM liekan_log WHERE website_id=$1::uuid)::int AS raw,
      sum(f.requests)::int AS derived FROM liekan_analysis_manifest m JOIN liekan_analysis_log f ON f.website_id=m.website_id AND f.generation=m.generation
      WHERE m.website_id=$1::uuid AND m.family='log' AND f.grain='hour'`,
      site,
    );
    expect(counts).toEqual({ raw: 2001, derived: 2001 });
    expect(
      (
        await query(
          "SELECT count(*)::int AS n FROM liekan_analysis_build WHERE website_id=$1::uuid AND request_hash='live'",
          site,
        )
      )[0].n,
    ).toBe(1);
  }, 30000);
});
