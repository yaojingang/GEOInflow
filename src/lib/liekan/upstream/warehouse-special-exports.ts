import Papa from 'papaparse';
import { identityUsable, unavailableFields } from '../contracts/browser-population';
import type { ExportRequest } from '../contracts/exports';
import { safeCsvCell, sanitizeExportValue } from '../contracts/exports';
import { geographyCoverage, geographyTable, geographyVersion } from '../contracts/geography';
import {
  keywordConditionsSchema,
  keywordEvidenceLabels,
  keywordStatusLabels,
  redactKeywordTerm,
} from '../contracts/keywords';
import { getPublishedCatalog } from '../crawlers/published';
import { getHumanFacts } from './analytics';
import { readBrowserPopulation } from './browser-population';
import { LiekanError } from './errors';
import { exportLabel } from './feature-exports';
import { validateKeywordRange } from './keywords';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import { warehouseExportResponse } from './warehouse-export-artifact';
import { withWarehouseKeywords } from './warehouse-keywords';
import { withinWarehouseReport } from './warehouse-report-snapshot';
export function warehouseSpecialExport(
  website: { id: string; name: string; domain: string },
  p: Extract<ExportRequest, { kind: string }>,
  signal: AbortSignal,
) {
  return warehouseExportResponse(website.id, signal, p.locale, artifact =>
    withinWarehouseReport(async () => {
      if (p.endAt > Date.now() + 86400000) throw new LiekanError('日期范围无效');
      new Intl.DateTimeFormat('zh-CN', { timeZone: p.timezone }).format();
      const complete = (
        rows: number,
        fields: string[],
        extra: Record<string, unknown>,
        population: any,
      ) =>
        artifact.complete('csv', {
          catalogVersion: getPublishedCatalog()?.version ?? null,
          populationVersion: TRAFFIC_POLICY_VERSION,
          snapshotVersion: 'browser-population-v1',
          population,
          kind: p.kind,
          createdAt: new Date().toISOString(),
          website: { name: website.name, domain: website.domain },
          range: { startAt: p.startAt, endAt: p.endAt, timezone: p.timezone },
          rows,
          fields,
          consistency: 'published-generation',
          ...extra,
        });
      if (p.kind === 'source-keywords') {
        validateKeywordRange(p);
        return withWarehouseKeywords(
          website.id,
          p,
          async selected => {
            const population = await readBrowserPopulation(
              website.id,
              new Date(p.startAt),
              new Date(p.endAt),
              p.timezone,
            );
            const conditions = keywordConditionsSchema.parse(p);
            const safeConditions = sanitizeExportValue({
              ...conditions,
              search: redactKeywordTerm(conditions.search),
            });
            const createdAt = new Date(selected.readAt).toISOString();
            const preamble =
              '\ufeff' +
              Papa.unparse(
                [
                  ['统计读取时间', createdAt],
                  ['开始时间', new Date(p.startAt).toISOString()],
                  ['结束时间', new Date(p.endAt).toISOString()],
                  ['时区', p.timezone],
                  ['筛选条件', JSON.stringify(safeConditions)],
                  ['一致性', 'published-generation'],
                ].map(([k, v]) => [safeCsvCell(exportLabel(k, p.locale)), safeCsvCell(v)]),
              ) +
              '\r\n\r\n';
            const fields = [
              '关键词/状态',
              '搜索引擎',
              '识别依据',
              '会话数',
              '搜索渠道占比(%)',
              '跳出率(%)',
              '转化率(%)',
            ].map(k => exportLabel(k, p.locale));
            await artifact.csv(
              `${p.kind}.csv`,
              fields,
              consume =>
                selected.rows.stream(async batch => {
                  await consume(
                    batch.map(row =>
                      Object.fromEntries(
                        fields.map((key, i) => [
                          key,
                          [
                            row.keyword || exportLabel(keywordStatusLabels[row.status], p.locale),
                            exportLabel(row.engine, p.locale),
                            exportLabel(keywordEvidenceLabels[row.evidence], p.locale),
                            ...(['sessions', 'share', 'bounceRate', 'conversionRate'] as const).map(
                              k => (identityUsable(population) ? row[k] : null),
                            ),
                          ][i],
                        ]),
                      ),
                    ),
                  );
                }, artifact.signal),
              preamble,
            );
            return complete(
              await selected.rows.count(),
              fields,
              { conditions: safeConditions, createdAt },
              population,
            );
          },
          artifact.signal,
          true,
        );
      }
      let rows: Record<string, unknown>[],
        fields: string[],
        extra: Record<string, unknown>,
        population: any;
      const facts = await getHumanFacts(
        website.id,
        new Date(p.startAt),
        new Date(p.endAt),
        p.timezone,
        ['geo', 'goals'],
      );
      population = facts.totals.population;
      fields = ['城市', '会话', '占比(%)', '平均时长(秒)', '跳出率(%)', '转化率(%)'].map(k =>
        exportLabel(k, p.locale),
      );
      rows = geographyTable(facts.geo, facts.totals.visits, !!facts.goals.length, p, p.locale).map(
        row => {
          const value = identityUsable(population)
            ? row
            : unavailableFields(row, [
                'sessions',
                'share',
                'duration',
                'bounceRate',
                'conversionRate',
              ]);
          return Object.fromEntries(
            fields.map((key, i) => [
              key,
              [
                redactKeywordTerm(value.city),
                value.sessions,
                value.share,
                value.duration,
                value.bounceRate,
                value.conversionRate,
              ][i],
            ]),
          );
        },
      );
      extra = {
        geographyVersion,
        geographyCoverage: identityUsable(population)
          ? geographyCoverage(facts.geo, facts.totals.visits)
          : null,
        selection: sanitizeExportValue({
          search: redactKeywordTerm(p.search),
          geoSort: p.geoSort,
          direction: p.direction,
        }),
      };
      await artifact.csv(
        `${p.kind}.csv`,
        fields,
        async consume => {
          for (let i = 0; i < rows.length; i += 500) await consume(rows.slice(i, i + 500));
        },
        '\ufeff',
      );
      return complete(rows.length, fields, extra, population);
    }),
  );
}
