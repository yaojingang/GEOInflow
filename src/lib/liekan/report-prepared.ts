import type { LiekanReport } from './contracts/report';
import type { getHumanFacts } from './upstream/analytics';
import type { getLogFacts } from './upstream/logs';
import type { reportLogRange } from './report-log-tables';

/** Internal page-only projection. Global aggregates and selected detail rows
 * are computed at one read boundary; legacy/full export inputs stay complete. */
export type PreparedReport = {
  /** The canonical Today preset supplies this card at read time. */
  sharedTodayRequests?: boolean;
  range?: ReturnType<typeof reportLogRange>;
  catalogCount?: number;
  human?: Awaited<ReturnType<typeof getHumanFacts>>;
  logs?: Awaited<ReturnType<typeof getLogFacts>>;
  decorate?(report: LiekanReport): void;
  dispose?(): Promise<void>;
  publishRankings?(report: LiekanReport): Promise<void>;
};
