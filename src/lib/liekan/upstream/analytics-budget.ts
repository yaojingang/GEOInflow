import { LiekanError } from './errors';
import { isAnalyticsWorker } from './process-role';
import { processSingleton } from './process-singleton';
import { currentAnalysisPermit } from './analysis-permit-context';

export const AnalyticsUnavailable = processSingleton(
  'analytics-unavailable-error',
  () =>
    class AnalyticsUnavailable extends LiekanError {
      constructor(
        message = '统计正在更新，请稍后重试',
        public retryAfter = 5,
        status = 503,
        code = 'liekan-error',
      ) {
        super(message, status, code);
      }
    },
);
export type AnalyticsUnavailable = InstanceType<typeof AnalyticsUnavailable>;
export const AnalyticsRestart = processSingleton(
  'analytics-restart-error',
  () => class AnalyticsRestart extends Error {},
);
export type AnalyticsRestart = InstanceType<typeof AnalyticsRestart>;

/** Every uncached computation uses this gate, including degraded and oversized results. */
export class AnalyticsGate {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(
    private concurrency = 2,
    private queueLimit = 32,
    private waitMs = 5000,
  ) {}

  async run<T>(work: () => Promise<T>, deadline = Infinity): Promise<T> {
    if (Date.now() >= deadline) throw new AnalyticsUnavailable();
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.queueLimit) throw new AnalyticsUnavailable();
      await new Promise<void>((resolve, reject) => {
        const enter = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(
          () => {
            this.waiting = this.waiting.filter(item => item !== enter);
            reject(new AnalyticsUnavailable());
          },
          Math.min(this.waitMs, deadline - Date.now()),
        );
        this.waiting.push(enter);
      });
    } else this.active++;
    try {
      if (Date.now() >= deadline) throw new AnalyticsUnavailable();
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
  get state() {
    return { active: this.active, queued: this.waiting.length };
  }
}

export const analyticsGate = processSingleton(
  'analytics-computation-gate',
  () => new AnalyticsGate(isAnalyticsWorker() ? 1 : 2),
);
const dashboardGate = processSingleton(
  'analytics-dashboard-computation-gate',
  () => new AnalyticsGate(2),
);

/** Match the database permits with bounded process-local computation slots. */
export const analyticsComputationGate = () =>
  currentAnalysisPermit()?.lane === 'dashboard' ? dashboardGate : analyticsGate;
