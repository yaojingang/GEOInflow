import type { RequestIdentityEvidence } from '../crawlers/request-verification';
import { getPublishedCatalog } from '../crawlers/published';
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { z } from 'zod';
import { type LogRecord, parseLogInput } from '../ingest';
import type { VerificationSnapshots } from '../rules/verify';
import { type BotRule, getBotRules } from '../rules/bots';
import type { CrawlerRuleConfiguration } from '../rules/configuration';
import { LiekanError } from '../upstream/errors';
import {
  cloudflareCrawlerEvidence,
  crawlerClassificationVersion,
  crawlerIdentityId,
  type CrawlerLogEvidence,
} from './crawler-evidence';

export const PROTOCOL_VERSION = 1;
export const MAX_RECORDS = 1000;
export const MAX_LINE_BYTES = 64 * 1024;
export const serverEventSchema = z.strictObject({
  generation: z.uuid().transform(value => value.toLowerCase()),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  line: z.string().max(MAX_LINE_BYTES),
});
export const uploadSchema = z.strictObject({
  version: z.literal(1),
  batchId: z.uuid().transform(value => value.toLowerCase()),
  epoch: z.number().int().positive(),
  events: z.array(serverEventSchema).max(MAX_RECORDS).min(1),
});
export const hostname = (domain: string) =>
  new URL(domain.includes('://') ? domain : `https://${domain}`).hostname.toLowerCase();
export interface AutomaticRecord extends LogRecord {
  identityEvidence?: RequestIdentityEvidence;
  eventDigest: string;
  verificationVersion?: string | null;
  classificationVersion?: string;
  catalogVersion?: string | null;
  crawlerId?: string | null;
  crawlerEvidence?: CrawlerLogEvidence | null;
}
export function stableUuid(text: string) {
  const bytes = createHash('sha256').update(text).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function normalizeAutomatic(
  kind: 'server' | 'cloudflare',
  sourceId: string,
  events: unknown[],
  domain: string,
  secret: string,
  rules: BotRule[] = getBotRules(),
  snapshots?: VerificationSnapshots,
  observe?: (ip: string, record: AutomaticRecord) => void,
  configuration?: CrawlerRuleConfiguration,
) {
  if (!events.length || events.length > MAX_RECORDS)
    throw new LiekanError('每批需要 1–1000 条日志');
  const records: AutomaticRecord[] = [];
  const classificationVersion = crawlerClassificationVersion(rules, configuration);
  const errors: { line: number; reason: string }[] = [];
  for (let index = 0; index < events.length; index++) {
    try {
      const raw = events[index];
      let input: Parameters<typeof parseLogInput>[0];
      let identity: unknown[];
      if (kind === 'server') {
        const event = serverEventSchema.parse(raw);
        if (Buffer.byteLength(event.line) > MAX_LINE_BYTES) throw new Error();
        input = { format: 'combined', content: event.line };
        identity = [sourceId, event.generation, event.offset];
      } else {
        const e = raw as Record<string, unknown>;
        if (
          !e ||
          hostname(String(e.ClientRequestHost)) !== hostname(domain) ||
          e.ClientRequestSource !== 'eyeball'
        )
          throw new Error();
        for (const field of [
          'ClientIP',
          'ClientRequestMethod',
          'ClientRequestURI',
          'ClientRequestUserAgent',
          'EdgeStartTimestamp',
          'RayID',
        ]) {
          if (typeof e[field] !== 'string' || !(e[field] as string).length) throw new Error();
        }
        input = {
          format: 'json',
          records: [
            {
              ip: e.ClientIP,
              method: e.ClientRequestMethod,
              path: e.ClientRequestURI,
              userAgent: e.ClientRequestUserAgent,
              time: e.EdgeStartTimestamp,
              status: e.EdgeResponseStatus,
              bytes: e.EdgeResponseBodyBytes,
            },
          ],
        };
        if (!Number.isSafeInteger(e.EdgeResponseBodyBytes) || Number(e.EdgeResponseBodyBytes) < 0)
          throw new Error();
        identity = [
          sourceId,
          e.RayID,
          e.EdgeStartTimestamp,
          e.ClientRequestSource,
          e.ClientRequestHost,
          e.ClientRequestMethod,
          e.ClientRequestURI,
          e.ClientIP,
          e.ClientRequestUserAgent,
          e.EdgeResponseStatus,
          e.EdgeResponseBodyBytes,
        ];
      }
      let validatedIp: string;
      const parsed = parseLogInput(input, domain, secret, rules, snapshots, ip => {
        validatedIp = ip;
      });
      if (parsed.records.length !== 1) throw new Error();
      const content = kind === 'server' ? serverEventSchema.parse(raw).line : identity;
      const eventDigest = createHmac('sha256', secret)
        .update(JSON.stringify(content))
        .digest('hex');
      const id = createHmac('sha256', secret).update(JSON.stringify(identity)).digest('hex');
      records.push({
        ...parsed.records[0],
        id,
        measurement: {
          ...parsed.records[0].measurement,
          host:
            kind === 'cloudflare'
              ? hostname(String((raw as Record<string, unknown>).ClientRequestHost))
              : hostname(domain),
          hostBasis: kind === 'cloudflare' ? 'request_host' : 'configured_host',
          bytesUnit: kind === 'cloudflare' ? 'edge_body' : 'combined_response',
        },
        eventDigest,
        classificationVersion,
        catalogVersion: getPublishedCatalog()?.version ?? null,
        crawlerId: crawlerIdentityId(parsed.records[0].userAgent, rules),
        crawlerEvidence:
          kind === 'cloudflare' ? cloudflareCrawlerEvidence(raw as Record<string, unknown>) : null,
      });
      observe?.(validatedIp, records[records.length - 1]);
    } catch {
      errors.push({ line: index + 1, reason: '字段、时间、IP、请求来源或域名无效' });
    }
  }
  const identities = new Map<string, string>();
  for (const row of records) {
    const previous = identities.get(row.id);
    if (previous && previous !== row.eventDigest)
      throw new LiekanError('同一事件标识的内容已改变', 409);
    identities.set(row.id, row.eventDigest);
  }
  return {
    records,
    received: events.length,
    rejected: errors.length,
    errors: errors.slice(0, 100),
  };
}
export async function decodeUpload(request: Request, kind: 'server' | 'cloudflare') {
  if (!request.body) throw new LiekanError('请求内容为空');
  const encoding = request.headers.get('content-encoding')?.toLowerCase();
  if (encoding && encoding !== 'gzip' && encoding !== 'identity')
    throw new LiekanError('压缩格式无效');
  let compressed = 0;
  const reader = request.body.getReader();
  const raw = Readable.from(
    (async function* () {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          compressed += value.byteLength;
          if (compressed > 5 * 1024 * 1024) throw new LiekanError('请求内容超出上限', 413);
          yield Buffer.from(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    })(),
  );
  const stream = encoding === 'gzip' ? raw.pipe(createGunzip()) : raw;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    // Forward source failures into the decompressor and bound its output.
    raw.on('error', error => stream.destroy(error));
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) throw new LiekanError('解压内容超出上限', 413);
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (kind === 'server') {
      const data = uploadSchema.parse(JSON.parse(text));
      return {
        test: false,
        events: data.events,
        epoch: data.epoch,
        batchId: data.batchId,
        digest: createHash('sha256').update(text).digest('hex'),
      };
    }
    const lines = text.trim().split(/\r?\n/);
    if (lines.length > MAX_RECORDS || lines.some(line => Buffer.byteLength(line) > MAX_LINE_BYTES))
      throw new LiekanError('日志行数或长度超出上限', 413);
    const events = lines.map(line => JSON.parse(line));
    if (
      events.length === 1 &&
      ['{"content":"test"}', '{"content":"tests"}'].includes(JSON.stringify(events[0]))
    )
      return { test: true, events: [], epoch: 0, batchId: '', digest: '' };
    if (events.some(e => !e || typeof e !== 'object' || 'content' in e))
      throw new LiekanError('日志格式无效');
    const digest = createHash('sha256').update(text).digest('hex');
    const epoch = Number(request.headers.get('x-liekan-epoch'));
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new LiekanError('采集代次无效', 409);
    return { test: false, events, epoch, batchId: stableUuid(digest), digest };
  } catch (error) {
    if (error instanceof LiekanError) throw error;
    throw new LiekanError('日志格式或压缩内容无效');
  } finally {
    await reader.cancel().catch(() => {});
    raw.destroy();
    stream.destroy();
  }
}
