import { browserPopulationSchema } from './browser-population';
import { z } from 'zod';
const numeric = z.union([z.number(), z.string()]);
const time = z.string().nullable();
const series = z.array(z.object({ x: z.string(), y: z.number() }));
export const goalAnalyticsResponse = z.object({
  population: browserPopulationSchema.optional(),
  conversions: z.number(),
  num: z.number().nullable(),
  total: z.number().nullable(),
  series,
});
export const featureSession = z
  .object({
    id: z.uuid(),
    firstAt: time,
    lastAt: time,
    views: z.number(),
    seconds: z.number().nullable(),
    referrerDomain: z.string().nullable(),
    urlPath: z.string().nullable(),
    country: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable().optional(),
    browser: z.string().nullable(),
    device: z.string().nullable(),
  })
  .passthrough();
export const journeyResponse = z.object({
  population: browserPopulationSchema.optional(),
  rows: z.array(
    z.object({
      nodes: z.array(z.string()),
      visitors: z.number().nullable(),
      visits: z.number().nullable(),
      seconds: z.number().nullable(),
      source: z.string().nullable(),
    }),
  ),
  visitors: z.number().nullable(),
  sessions: z.array(featureSession).optional(),
  count: z.number().nullable().optional(),
  page: z.number(),
  pageSize: z.number(),
  limited: z.boolean(),
});
const pagedSessions = z.object({
  readBoundary: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  population: browserPopulationSchema.optional(),
  rows: z.array(featureSession),
  count: z.number().nullable(),
  page: z.number(),
  pageSize: z.number(),
});
const totalsEvents = z.object({
  total: z.number(),
  visitors: z.number().nullable(),
  types: z.number(),
  withProperties: z.number(),
  lastAt: time,
});
const eventResponse = z.object({
  population: browserPopulationSchema.optional(),
  totals: totalsEvents,
  rows: z.array(
    z.object({
      name: z.string(),
      triggers: z.number(),
      visitors: z.number().nullable(),
      lastAt: time,
      properties: z.number(),
    }),
  ),
  properties: z.array(z.object({ name: z.string(), dataType: z.number(), total: z.number() })),
  values: z.array(
    z.object({ value: z.string().nullable(), dataType: z.number(), total: z.number() }),
  ),
  page: z.number(),
  pageSize: z.number(),
  count: z.number(),
  limited: z.boolean(),
});
const sources = z.object({
  population: browserPopulationSchema.optional(),
  rows: z.array(
    z.object({
      referrer: z.string().nullable(),
      visitors: z.number().nullable(),
      views: z.number(),
    }),
  ),
});
const utm = z.object({
  population: browserPopulationSchema.optional(),
  views: z.number(),
  visitors: z.number().nullable(),
  events: z.number(),
  rows: z.array(z.object({ utm: z.string(), views: z.number() })).optional(),
  dimensionTotal: z.number().optional(),
  limited: z.boolean().optional(),
});
const properties = z.object({
  population: browserPopulationSchema.optional(),
  rows: z.array(
    z.object({
      name: z.string(),
      value: z.string().nullable(),
      dataType: z.number(),
      sessions: z.number().nullable(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  more: z.boolean(),
});
const session = z.object({
  population: browserPopulationSchema.optional(),
  rows: z.array(
    z.object({
      eventId: z.uuid(),
      sessionId: z.uuid(),
      visitId: z.uuid(),
      createdAt: time,
      urlPath: z.string(),
      urlQuery: z.string().nullable(),
      referrerDomain: z.string().nullable(),
      eventType: z.number(),
      eventName: z.string().nullable(),
      hostname: z.string().nullable(),
    }),
  ),
  totals: z.object({
    views: z.number(),
    events: z.number(),
    seconds: z.number().nullable(),
    count: z.number().nullable(),
    firstAt: time,
    lastAt: time,
    entryPath: z.string().nullable(),
    exitPath: z.string().nullable(),
    referrerDomain: z.string().nullable(),
  }),
  page: z.number(),
  pageSize: z.number(),
  more: z.boolean(),
});
const realtime = z.object({
  population: browserPopulationSchema.optional(),
  totals: z.object({
    active: z.number().nullable(),
    views: z.number(),
    events: z.number(),
    ai: z.number().nullable(),
  }),
  pages: z.array(z.object({ name: z.string(), value: z.number().nullable() })),
  sources: z.array(
    z.object({
      name: z.string(),
      value: z.number().nullable(),
      sourceLabel: z.literal('direct').optional(),
    }),
  ),
});
const performance = z
  .object(
    Object.fromEntries(
      ['lcp', 'inp', 'cls', 'fcp', 'ttfb'].flatMap(metric => [
        [`${metric}Count`, z.number()],
        ...['P50', 'P75', 'P95'].map(p => [metric + p, z.number().nullable()]),
      ]),
    ),
  )
  .extend({ population: browserPopulationSchema.optional() });
const revenue = z.object({
  population: browserPopulationSchema.optional(),
  rows: z.array(
    z.object({
      id: z.uuid(),
      sessionId: z.uuid(),
      event: z.string().nullable(),
      amount: numeric.nullable(),
      currency: z.string(),
      createdAt: time,
    }),
  ),
  count: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
const attribution = z.object({
  population: browserPopulationSchema.optional(),
  total: z.object({ visitors: z.number().nullable(), attributed: z.number().nullable() }),
  referrer: z.array(z.object({ name: z.string(), value: z.number().nullable() })),
  limited: z.boolean(),
});
const scroll = z.object({
  population: browserPopulationSchema.optional(),
  total: z.number().nullable(),
  reach25: z.number().nullable(),
  reach50: z.number().nullable(),
  reach75: z.number().nullable(),
  reach100: z.number().nullable(),
});
const replays = z.object({
  population: browserPopulationSchema.optional(),
  rows: z.array(
    z.object({
      id: z.uuid(),
      visitId: z.uuid(),
      sessionId: z.uuid(),
      startedAt: time,
      endedAt: time,
      duration: z.number(),
      eventCount: z.number(),
      chunkCount: z.number(),
      pageviews: z.number(),
      referrerDomain: z.string().nullable(),
      device: z.string().nullable(),
      browser: z.string().nullable(),
      name: z.string().nullable(),
    }),
  ),
  count: z.number().nullable(),
  page: z.number(),
  pageSize: z.number(),
});
export const featureAnalyticsResponse = z.union([
  eventResponse,
  utm,
  sources,
  pagedSessions,
  session,
  properties,
  realtime,
  performance,
  revenue,
  attribution,
  scroll,
  replays,
]);
