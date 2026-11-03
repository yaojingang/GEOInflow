import { AsyncLocalStorage } from 'node:async_hooks';
import { processSingleton } from './process-singleton';
export interface AnalysisPermit {
  token: string;
  epoch: string;
  lane?: 'dashboard';
  slot?: number;
}
export const analysisPermitTable = (permit: AnalysisPermit) =>
  permit.slot !== undefined
    ? 'liekan_analysis_read_lease'
    : permit.lane === 'dashboard'
      ? 'liekan_analysis_dashboard_lease'
      : 'liekan_analysis_background_lease';
const context = processSingleton(
  'analysis-background-permit',
  () => new AsyncLocalStorage<AnalysisPermit>(),
);
export const currentAnalysisPermit = () => context.getStore();
export const withinAnalysisPermit = <T>(lease: AnalysisPermit, work: () => Promise<T>) =>
  context.run(lease, work);

export const analysisPermitPredicate = (permit: AnalysisPermit) =>
  `${permit.slot === undefined ? 'id' : 'slot=$3::smallint'} AND token=$1::uuid AND epoch=$2::bigint`;
export const analysisPermitValues = (permit: AnalysisPermit): unknown[] => [
  permit.token,
  permit.epoch,
  ...(permit.slot === undefined ? [] : [permit.slot]),
];
