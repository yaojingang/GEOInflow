import { browserPopulationSchema } from './browser-population';
import { z } from 'zod';

export const websiteSummaryQuery = z
  .object({
    ids: z
      .string()
      .max(1850)
      .refine(
        value =>
          !value ||
          (value.split(',').length <= 50 &&
            value.split(',').every(id => z.uuid().safeParse(id).success)),
        '网站 ID 无效',
      ),
    startAt: z.coerce.number().int().min(0),
    endAt: z.coerce.number().int().min(0),
    timezone: z.string().max(80).default('Asia/Shanghai'),
  })
  .refine(p => p.endAt >= p.startAt, '日期范围无效');
const totals = z.object({
  population: browserPopulationSchema.optional(),
  pageviews: z.number().nullable(),
  visitors: z.number().nullable(),
  visits: z.number().nullable(),
  bounces: z.number().nullable(),
  totaltime: z.number().nullable(),
  aiVisits: z.number().nullable(),
});
export const websiteSummarySchema = z.array(
  totals.extend({
    id: z.uuid(),
    views: z.number().nullable(),
    received: z.boolean(),
    lastAt: z.string().nullable(),
    comparison: totals,
    snapshot: z
      .object({
        state: z.enum(['ready', 'updating', 'preparing']),
        startAt: z.number(),
        endAt: z.number(),
        dataThrough: z.number().nullable(),
      })
      .optional(),
    collectionKnown: z.boolean().optional(),
  }),
);
export type WebsiteSummary = z.infer<typeof websiteSummarySchema>;
