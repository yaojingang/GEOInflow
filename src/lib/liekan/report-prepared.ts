import type { LiekanReport } from './contracts/report';
import type { getHumanFacts } from './upstream/analytics';
import type { getLogFacts } from './upstream/logs';
import type { reportLogRange } from './report-log-tables';

/** Internal page-only projection. Global aggregates and selected detail rows
 * are computed at one read boundary; legacy/full export inputs stay complete. */
export type PreparedReport = {
  range?: ReturnType<typeof reportLogRange>;
  catalogCount?: number;
  human?: Awaited<ReturnType<typeof getHumanFacts>>;
  logs?: Awaited<ReturnType<typeof getLogFacts>>;
  decorate?(report: LiekanReport): void;
  dispose?(): Promise<void>;
};
