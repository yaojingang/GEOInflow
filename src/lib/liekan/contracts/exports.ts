import { z } from 'zod';
import { keywordConditionsSchema, keywordStatusVersion } from './keywords';
import { geographySorts } from './geography';
import { liekanLocales } from '../i18n/locale';
const exportLocaleSchema = z.enum(liekanLocales).optional();
export const exportSections = ['summary', 'dimensions', 'events', 'sessions', 'config'] as const;
const standardExportRequestSchema = z
  .object({
    kind: z.never().optional(),
    locale: exportLocaleSchema,
    startAt: z.number().int().nonnegative(),
    endAt: z.number().int().nonnegative(),
    timezone: z.string().max(80).default('Asia/Shanghai'),
    format: z.enum(['zip', 'csv', 'json']),
    sections: z.array(z.enum(exportSections)).min(1).max(5),
    filters: z.record(z.string(), z.string().max(2000)).default({}),
  })
  .refine(p => p.endAt >= p.startAt && p.endAt - p.startAt <= 1096 * 86400000, {
    message: '日期范围上限 3 年',
  });
export const keywordExportRequestSchema = keywordConditionsSchema
  .extend({
    kind: z.literal('source-keywords'),
    locale: exportLocaleSchema,
    keywordStatusVersion: z.literal(keywordStatusVersion).optional(),
    format: z.literal('csv'),
    startAt: z.number().int().nonnegative(),
    endAt: z.number().int().nonnegative(),
    timezone: z.string().max(80).default('Asia/Shanghai'),
  })
  .refine(p => p.endAt >= p.startAt && p.endAt - p.startAt <= 1096 * 86400000, {
    message: '日期范围上限 3 年',
  });
export const exportRequestSchema = z.union([
  z
    .object({
      kind: z.literal('geography'),
      locale: exportLocaleSchema,
      format: z.literal('csv'),
      startAt: z.number().int().nonnegative(),
      endAt: z.number().int().nonnegative(),
      timezone: z.string().max(80).default('Asia/Shanghai'),
      search: z.string().max(200).default(''),
      geoSort: z.enum(geographySorts).default('sessions'),
      direction: z.enum(['asc', 'desc']).default('desc'),
    })
    .strict()
    .refine(p => p.endAt >= p.startAt && p.endAt - p.startAt <= 1096 * 86400000, {
      message: '日期范围上限 3 年',
    }),
  keywordExportRequestSchema,
  standardExportRequestSchema,
]);
export type ExportRequest = z.infer<typeof exportRequestSchema>;
export const EXPORT_MAX_ROWS = 100000;
export const EXPORT_MAX_BYTES = 50 * 1024 * 1024;
export { sanitizeExportValue, safeCsvCell } from './export-privacy';
export type ExportFrame =
  | { type: 'progress'; stage: string; percent: number }
  | {
      type: 'file';
      name: string;
      mime: string;
      size: number;
      manifest: unknown;
      downloadUrl?: string;
    }
  | { type: 'chunk'; data: string }
  | { type: 'complete' }
  | { type: 'error'; status: number; message: string };
