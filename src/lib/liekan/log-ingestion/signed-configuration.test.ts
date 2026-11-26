// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  catalog: undefined as any,
  configuration: undefined as any,
  source: undefined as any,
  query: vi.fn(),
  execute: vi.fn(),
  locate: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('../crawlers/published', () => ({ getPublishedCatalog: () => h.catalog }));
vi.mock('../upstream/crawler-registry-context', () => ({
  withPublishedRegistry: (work: any) => work(h.catalog),
}));
vi.mock('../upstream/server', async () => ({
  ...(await import('../upstream/errors')),
  query: (...args: unknown[]) => h.query(...args),
  transaction: (work: any) => work({ $queryRawUnsafe: h.query, $executeRawUnsafe: h.execute }),
  sourceWebsite: async () => ({ domain: 'example.com', user_id: null, team_id: null }),
  lockWritableWebsite: vi.fn(),
}));
vi.mock('@/lib/detect', () => ({ getGeographyEvidence: h.locate }));
vi.mock('../upstream/query-cache', () => ({ invalidateWebsiteAnalytics: vi.fn() }));
vi.mock('../upstream/analytics-revision', () => ({ bumpAnalyticsRevision: vi.fn() }));
vi.mock('./queue', () => ({ enqueue: h.enqueue, LOG_QUEUE: 'logs', PROVIDER_QUEUE: 'provider' }));
vi.mock('./ranges', () => ({ verificationSnapshots: async () => ({}) }));
import { getBundledPublishedCatalog } from '../crawlers/catalog-seed';
import { getSettings } from '../store';
import { officialRuleConfiguration } from '../rules/configuration';
import { getBotRules } from '../rules/bots';
import { previewOfficialConversion } from '../rules/editor';
import { crawlerClassificationVersion } from './crawler-evidence';
import { receiveBatch, heartbeat } from './service';
import { tokenHash } from './secrets';

const sourceId = 'e8ae48ba-a17b-4f66-8444-0470de3ca62f';
const websiteId = '86500361-62fc-4147-86eb-b4c281aef60a';
const token = 'f'.repeat(43);
const request = () =>
  new Request('https://example.com/batches', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-liekan-epoch': '1' },
    body: JSON.stringify({
      ClientIP: '192.0.2.9',
      ClientRequestHost: 'example.com',
      ClientRequestMethod: 'GET',
      ClientRequestURI: '/',
      ClientRequestUserAgent: 'Mozilla/5.0',
      EdgeResponseStatus: 200,
      EdgeResponseBodyBytes: 20,
      EdgeStartTimestamp: '2026-10-09T01:00:00Z',
      ClientRequestSource: 'eyeball',
      RayID: 'fixture-ray',
      BotDetectionIDs: [129220581],
    }),
  });
const insert = (table: string) =>
  h.execute.mock.calls.find(([sql]) => sql.includes(`INSERT INTO ${table}(`));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('APP_SECRET', 'signed-configuration-fixture');
  h.catalog = structuredClone(getBundledPublishedCatalog());
  h.configuration = officialRuleConfiguration();
  h.source = {
    id: sourceId,
    website_id: websiteId,
    kind: 'cloudflare',
    domain: 'example.com',
    owner_id: null,
    team_id: null,
    created_by: null,
    state: 'active',
    credential_hash: tokenHash(token),
    credential_version: 1,
    provider_config: 'fixture-encrypted-zone',
    provider_job_id: 'fixture-job',
    health: { fieldCapabilities: { BotDetectionIDs: true } },
  };
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT s.robots'))
      return [{ crawlerRules: structuredClone(h.configuration) }];
    if (sql.includes('w.domain AS website_domain'))
      return [
        {
          ...h.source,
          website_domain: h.source.domain,
          website_user_id: null,
          website_team_id: null,
          website_deleted_at: null,
        },
      ];
    if (sql.includes('FROM liekan_log_source')) return [{ ...h.source }];
    if (sql.includes('FROM liekan_log_state')) return [{ epoch: 1, policy_revision: 1 }];
    if (sql.includes('FROM liekan_log_interval')) return [{ id: sourceId }];
    if (sql.includes(' AS pending,')) return [{ pending: 0, recent: 0 }];
    return [];
  });
  h.execute.mockResolvedValue(1);
  h.locate.mockResolvedValue(undefined);
  h.enqueue.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe('signed identity configuration at authenticated batch receipt', () => {
  it('persists the same full configuration version in settings, normalized events and the archive', async () => {
    const settings = await getSettings(websiteId);
    expect(await receiveBatch(request(), sourceId)).toMatchObject({ valid: 1, rejected: 0 });
    const archive = insert('liekan_crawler_rule_version');
    const payload = JSON.parse(insert('liekan_ingest_batch')[6]);
    expect(archive[2]).toBe(settings.classificationVersion);
    expect(JSON.parse(archive[6])).toEqual(h.configuration);
    expect(payload[0]).toMatchObject({
      crawlerId: 'chatgpt-agent',
      verification: 'verified_edge',
      classificationVersion: settings.classificationVersion,
    });
    expect(payload[0].classificationVersion).toBe(
      crawlerClassificationVersion(settings.rules, h.configuration),
    );
    expect(getBotRules().some(rule => rule.crawlerId === 'chatgpt-agent')).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('192.0.2.9');
  });
  it('keeps every identity disabled after converting a disabled website', async () => {
    h.configuration = previewOfficialConversion({ mode: 'disabled' }).configuration;
    await receiveBatch(request(), sourceId);
    const payload = JSON.parse(insert('liekan_ingest_batch')[6]);
    expect(payload[0]).toMatchObject({
      crawlerId: null,
      verification: 'unverified',
      aiEligible: false,
    });
  });
  it('rejects a batch when only the signed agent setting changes during normalization', async () => {
    const initialRules = (await getSettings(websiteId)).rules;
    h.locate.mockImplementation(async () => {
      h.configuration = { ...officialRuleConfiguration(), disabledIds: ['chatgpt-agent'] };
      return undefined;
    });
    await expect(receiveBatch(request(), sourceId)).rejects.toMatchObject({
      status: 409,
      message: '规则已被更新，请重试当前批次',
    });
    expect(h.locate).toHaveBeenCalledOnce();
    expect((await getSettings(websiteId)).rules).toEqual(initialRules);
    expect(insert('liekan_crawler_rule_version')).toBeUndefined();
    expect(insert('liekan_ingest_batch')).toBeUndefined();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('keeps a browser UA unclassified when the source lacks the authenticated edge binding', async () => {
    h.source.provider_config = null;
    await receiveBatch(request(), sourceId);
    const payload = JSON.parse(insert('liekan_ingest_batch')[6]);
    expect(payload[0]).toMatchObject({
      crawlerId: null,
      verification: 'unverified',
      aiEligible: false,
    });
  });
  it('changes the collector coverage binding when only a signed identity is disabled', async () => {
    const health = { version: '1', bytes: 0, pending: 0, gap: false, errorCode: 'none' };
    const first = await heartbeat(sourceId, token, health);
    h.configuration = { ...officialRuleConfiguration(), disabledIds: ['chatgpt-agent'] };
    const second = await heartbeat(sourceId, token, health);
    expect(second.coverageBinding).toBe(
      `1:${(await getSettings(websiteId)).classificationVersion}`,
    );
    expect(second.coverageBinding).not.toBe(first.coverageBinding);
  });
});
