import { createHash, randomBytes } from 'node:crypto';
import { getClickHouseCountrySQL } from '@/lib/country';
import { getQueryFilters } from '@/lib/request';
import { getWebsiteStats } from '@/queries/sql';
import { getWebsiteSegment } from '@/queries/prisma';
import { identityUsable, unavailableFields } from '../contracts/browser-population';
import type { ExportRequest } from '../contracts/exports';
import { liekanProduct } from '../contracts/product';
import { warehouseReader } from '../warehouse/reader-runtime';
import { readBrowserPopulation } from './browser-population';
import { getPublishedCatalog } from '../crawlers/published';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import { LiekanError } from './errors';
import { nativeRelations } from './warehouse-native-relations';
import { warehouseFeatureSelection } from './warehouse-feature-analytics';
import { warehouseReportStream, withinWarehouseReport } from './warehouse-report-snapshot';
import { warehouseExportResponse } from './warehouse-export-artifact';
import { warehouseTime } from '../warehouse/fact-input';

type Standard = Exclude<ExportRequest, { kind: string }>;
export function warehouseFeatureExport(
  website: { id: string; name: string; domain: string },
  p: Standard,
  signal: AbortSignal,
) {
  return warehouseExportResponse(website.id, signal, p.locale, artifact =>
    withinWarehouseReport(async () => {
      new Intl.DateTimeFormat('zh-CN', { timeZone: p.timezone }).format();
      for (const key of ['segment', 'cohort'])
        if (p.filters[key] && !(await getWebsiteSegment(website.id, p.filters[key])))
          throw new LiekanError('人群条件不属于所选站点', 404);
      const filters = await getQueryFilters(
        { ...p.filters, startAt: p.startAt, endAt: p.endAt, timezone: p.timezone },
        website.id,
      );
      const { cte, params } = warehouseFeatureSelection(website.id, filters);
      const sqlPrefix = `WITH ${nativeRelations().join(',')},${cte.slice(5)}`;
      const args = Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, v instanceof Date ? warehouseTime(v) : v]),
      );
      const population = await readBrowserPopulation(
        website.id,
        new Date(p.startAt),
        new Date(p.endAt),
        p.timezone,
      );
      const sections = p.format === 'zip' ? [...new Set(p.sections)] : ['summary'];
      const integers = new Set(['visitors', 'views', 'triggers', 'events', 'visits']);
      const csv = async (
        name: string,
        fields: string[],
        sql: string,
        mapper: (r: any) => any = r => r,
      ) =>
        artifact.csv(name, fields, consume =>
          warehouseReportStream(
            website.id,
            `${sqlPrefix} ${sql}`,
            args,
            async rows => {
              await consume(
                rows.map(row => {
                  let value = Object.fromEntries(
                    Object.entries(row).map(([k, v]) => [
                      k,
                      v !== null && integers.has(k) ? Number(v) : v,
                    ]),
                  );
                  if (!identityUsable(population))
                    value = unavailableFields(value, ['visitors', 'visits', 'seconds']);
                  for (const key of ['firstAt', 'lastAt'])
                    if (typeof value[key] === 'string')
                      value[key] = new Date(value[key].replace(' ', 'T') + 'Z').toISOString();
                  return mapper(value);
                }),
              );
            },
            artifact.signal,
          true,
          ),
        );
      let summary: unknown;
      if (sections.includes('summary')) {
        summary = JSON.parse(
          JSON.stringify(await getWebsiteStats(website.id, filters), (_k, v) =>
            typeof v === 'bigint' ? Number(v) : v,
          ),
        );
        await artifact.csv('summary.csv', Object.keys(summary), consume =>
          consume([summary as Record<string, unknown>]),
        );
      }
      if (sections.includes('dimensions'))
        for (const [name, column] of [
          ['pages', 'url_path'],
          ['sources', 'referrer_domain'],
          ['browsers', 'liekan_browser'],
          ['devices', 'liekan_device'],
          ['countries', getClickHouseCountrySQL('liekan_country')],
        ])
          await csv(
            `${name}.csv`,
            ['name', 'visitors', 'views'],
            `SELECT ${column} AS name,uniqExact(session_id) AS visitors,count() AS views FROM selected WHERE event_type=1 GROUP BY name ORDER BY ${['pages', 'sources'].includes(name) ? 'views' : 'visitors'} DESC,name`,
          );
      if (sections.includes('events')) {
        await csv(
          'events.csv',
          ['name', 'triggers', 'visitors'],
          'SELECT event_name AS name,count() AS triggers,uniqExact(session_id) AS visitors FROM selected WHERE event_type=2 GROUP BY name ORDER BY triggers DESC,name',
        );
        await csv(
          'event-properties.csv',
          ['event', 'property', 'type', 'value', 'triggers'],
          `SELECT s.event_name AS event,d.data_key AS property,d.data_type AS type,coalesce(d.string_value,toString(d.number_value),toString(d.date_value)) AS value,uniqExact(s.event_id) AS triggers
        FROM event_data d INNER JOIN selected s ON s.event_id=d.website_event_id WHERE s.event_type=2 GROUP BY event,property,type,value ORDER BY event,property,type,value`,
        );
      }
      if (sections.includes('sessions') && identityUsable(population)) {
        const salt = randomBytes(32);
        await csv(
          'sessions.csv',
          ['id', 'firstAt', 'lastAt', 'views', 'events', 'visits', 'browser', 'device', 'country'],
          `SELECT session_id AS id,min(created_at) AS firstAt,max(created_at) AS lastAt,countIf(event_type=1) AS views,countIf(event_type=2) AS events,uniqExact(visit_id) AS visits,
        argMax(tuple(liekan_browser),tuple(created_at,event_id)).1 AS browser,argMax(tuple(liekan_device),tuple(created_at,event_id)).1 AS device,
        ${getClickHouseCountrySQL('argMax(tuple(liekan_country),tuple(created_at,event_id)).1')} AS country FROM selected GROUP BY session_id ORDER BY lastAt,session_id`,
          row => ({
            ...row,
            id: `visitor-${createHash('sha256').update(salt).update(row.id).digest('hex').slice(0, 12)}`,
          }),
        );
      }
      if (sections.includes('config')) {
        await warehouseReader().db.transaction(async tx => {
          await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          for (const [table, id, name] of [
            ['report', 'report_id', 'saved-reports.json'],
            ['segment', 'segment_id', 'saved-audiences.json'],
          ])
            await artifact.json(name, async consume => {
              let after: string | null = null;
              for (;;) {
                const { rows } = await tx.query(
                  `SELECT ${id} AS cursor,name,type,parameters FROM ${table} WHERE website_id=$1 AND ($2::uuid IS NULL OR ${id}>$2::uuid) ORDER BY ${id} LIMIT 500`,
                  [website.id, after],
                );
                if (!rows.length) break;
                after = String(rows.at(-1).cursor);
                await consume(rows.map(({ cursor, ...row }) => row));
              }
            });
        });
        await artifact.json('configuration.json', consume =>
          consume([{ website: { name: website.name, domain: website.domain } }]),
        );
      }
      const manifest = {
        catalogVersion: getPublishedCatalog()?.version ?? null,
        populationVersion: TRAFFIC_POLICY_VERSION,
        snapshotVersion: 'browser-population-v1',
        population,
        product: p.format === 'json' ? 'Liekan 猎看统计' : liekanProduct.name,
        createdAt: new Date().toISOString(),
        website: { name: website.name, domain: website.domain },
        range: { startAt: p.startAt, endAt: p.endAt, timezone: p.timezone },
        filterFields: Object.keys(p.filters),
        sections,
        unavailableSections:
          !identityUsable(population) && sections.includes('sessions') ? ['sessions'] : [],
        format: p.format,
        consistency: 'published-generation',
        privacy:
          p.locale === 'en-US'
            ? 'Session identifiers are anonymized within this file. Raw IP addresses, account credentials, keys and backup codes are excluded.'
            : '会话标识在本文件内脱敏；不包含原始 IP、账户凭据、密钥或备份代码',
        files: artifact.files,
      };
      return artifact.complete(p.format, manifest, summary);
    }),
  );
}
