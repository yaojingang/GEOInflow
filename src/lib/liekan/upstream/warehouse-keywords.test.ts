// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Papa from 'papaparse';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  addKeywordCandidate,
  type KeywordCandidate,
  type KeywordRow,
  keywordConditionsSchema,
  selectKeywords,
} from '../contracts/keywords';
import { buildWarehouseKeywordSelection } from './warehouse-keywords';

vi.mock('./warehouse-browser-queries', () => ({}));
vi.mock('./warehouse-report-snapshot', () => ({}));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'warehouse-keywords-test-'));
  vi.stubEnv('LIEKAN_EXPORT_DIRECTORY', directory);
  vi.stubEnv('LIEKAN_EXPORT_MIN_FREE_BYTES', '0');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const candidate = (query = '?q=word', extra = {}): KeywordCandidate => ({
  referrer: 'www.google.com',
  referrerPath: '/search',
  referrerQuery: query,
  sessions: 3,
  bounces: 1,
  conversions: 2,
  ...extra,
});
const candidates = [
  candidate(),
  candidate('?q=%77ord'),
  candidate('?q=person%40example.test'),
  candidate('?q=%E6'),
  candidate('', { referrer: 'www.baidu.com', referrerPath: '/link' }),
  candidate('', { referrer: 'www.baidu.com', referrerPath: '/unsupported' }),
  candidate('', { referrer: 'www.baidu.com', referrerPath: '/s' }),
  candidate('', { utmTerm: 'literal%2B+' }),
  candidate('', { utmTerm: 'token=secret' }),
  candidate('?q=ignored', { referrer: 'chatgpt.com' }),
  candidate('?q=zero', { sessions: 0, bounces: 0, conversions: 0 }),
];
it('keeps exact identity, redaction, redirect merges, rates, filters, null ordering and snapshot', async () => {
  const groups = new Map<string, KeywordRow>();
  for (const row of candidates) addKeywordCandidate(groups, row);
  const original = [...groups.values()];
  for (const modern of [true, false])
    for (const hasGoals of [true, false]) {
      for (const overrides of [
        {},
        { engine: '百度', status: 'unsupported' },
        { search: '来源不支持' },
        { evidence: 'utm' },
        { sort: 'conversionRate', direction: 'asc' },
        { sort: 'keyword', direction: 'asc' },
        { sort: 'share' },
        ...[
          'sessions',
          'keyword',
          'engine',
          'evidence',
          'status',
          'share',
          'bounceRate',
          'conversionRate',
        ].flatMap(sort => ['asc', 'desc'].map(direction => ({ sort, direction }))),
      ]) {
        const conditions = keywordConditionsSchema.parse(overrides);
        const expected = selectKeywords(original, conditions, hasGoals, modern);
        const actual = await buildWarehouseKeywordSelection(
          async emit => {
            for (const row of candidates) await emit(row);
          },
          { ...conditions, keywordStatusVersion: modern ? '2' : undefined },
          hasGoals,
        );
        try {
          const rows: KeywordRow[] = [];
          await actual.rows.stream(async batch => {
            rows.push(...batch);
          });
          expect(rows).toEqual(expected.rows);
          expect({
            total: actual.total,
            referrer: actual.referrer,
            utm: actual.utm,
            availability: actual.availability,
          }).toEqual({
            total: expected.total,
            referrer: expected.referrer,
            utm: expected.utm,
            availability: expected.availability,
          });
          const hash = createHash('sha256')
            .update(
              JSON.stringify([
                1,
                hasGoals,
                original
                  .map(row => [row.id, row.sessions, row.bounces, row.conversions])
                  .sort((a, b) =>
                    String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0,
                  ),
              ]),
            )
            .digest('hex')
            .slice(0, 32);
          expect(actual.snapshot).toBe(
            `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`,
          );
          expect(actual.engines).toEqual([...new Set(original.map(row => row.engine))].sort());
        } finally {
          await actual.dispose();
        }
      }
    }
  expect(await readdir(directory)).toEqual([]);
});

it('pages and completely streams more than 100k groups and 50 MiB without retaining the result', async () => {
  const count = 100013;
  const term = (n: number) => '词'.repeat(220) + String(n).padStart(6, '0');
  const actual = await buildWarehouseKeywordSelection(
    async emit => {
      for (let i = count - 1; i >= 0; i--) await emit(candidate(`?q=${term(i)}`));
    },
    { keywordStatusVersion: '2', sort: 'keyword', direction: 'asc' },
    true,
  );
  try {
    expect(await actual.rows.count()).toBe(count);
    expect(actual.total).toBe(count * 3);
    expect((await actual.rows.page(0, 20)).map(row => row.keyword)).toEqual(
      Array.from({ length: 20 }, (_, i) => term(i)),
    );
    expect((await actual.rows.page(100000, 20)).at(-1)?.keyword).toBe(term(count - 1));
    let received = 0,
      bytes = 0,
      largestBatch = 0;
    await actual.rows.stream(async batch => {
      largestBatch = Math.max(largestBatch, batch.length);
      for (const row of batch) {
        expect(row.keyword).toBe(term(received++));
        expect(row.conversionRate).toBe(66.67);
      }
      bytes += Buffer.byteLength(
        Papa.unparse(
          batch.map(row => [
            row.keyword,
            row.engine,
            row.evidence,
            row.sessions,
            row.share,
            row.bounceRate,
            row.conversionRate,
          ]),
        ) + '\r\n',
      );
    });
    expect(received).toBe(count);
    expect(bytes).toBeGreaterThan(50 * 1024 * 1024);
    expect(largestBatch).toBeLessThanOrEqual(256);
  } finally {
    await actual.dispose();
  }
  expect(await readdir(directory)).toEqual([]);
}, 180000);

it('removes partial spools when collection fails or is cancelled', async () => {
  await expect(
    buildWarehouseKeywordSelection(
      async emit => {
        for (let i = 0; i < 2200; i++) await emit(candidate(`?q=word${i}`));
        throw new Error('source-failed');
      },
      {},
      false,
    ),
  ).rejects.toThrow('source-failed');
  expect(await readdir(directory)).toEqual([]);
  const controller = new AbortController();
  await expect(
    buildWarehouseKeywordSelection(
      async emit => {
        await emit(candidate());
        controller.abort();
      },
      {},
      false,
      controller.signal,
    ),
  ).rejects.toMatchObject({ status: 499 });
  expect(await readdir(directory)).toEqual([]);
});
