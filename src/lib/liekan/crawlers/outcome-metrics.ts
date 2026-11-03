import {
  identityComplete,
  identityUsable,
  type BrowserPopulation,
} from '../contracts/browser-population';
import { platformSupportsReferralRatio } from '../contracts/sources';
import { evidenceValue } from '../contracts/crawler-metrics';
import type { EvidenceQuery } from '../contracts/traffic-evidence';
import type { EvidenceInputs } from './evidence-read';

export const OUTCOME_MAPPING_VERSION = 'crawler-outcomes-v1';

export function finalizeOutcomeRow(
  row: any,
  p: EvidenceQuery,
  input: EvidenceInputs,
  context: { goalsConfigured: boolean; connected: boolean; browserPopulation: BrowserPopulation },
) {
  const { browserPopulation } = context;
  const identityReady = identityUsable(browserPopulation);
  const goals = { configured: context.goalsConfigured };
  const presence = { connected: context.connected };
  const supported = platformSupportsReferralRatio(row.platformId);
  const reason = !supported
    ? 'mapping_unsupported'
    : row.ambiguous
      ? 'ambiguous_path'
      : !presence.connected
        ? 'browser_missing'
        : !identityComplete(browserPopulation)
          ? 'browser_identity_unavailable'
          : row.unknownBrowserHost
            ? 'browser_host_unknown'
            : !p.sourceId || input.quality.state !== 'complete'
              ? 'source_coverage'
              : !row.requests
                ? 'measurement_missing'
                : !row.configKnown ||
                    input.measurement.intervals !== 1 ||
                    input.measurement.interval !== input.quality.sourceVersion ||
                    input.measurement.intervalSamples !== input.measurement.requests ||
                    input.measurement.versions !== 1 ||
                    input.measurement.samples !== input.measurement.requests
                  ? 'source_config_unknown'
                  : !row.hostObserved
                    ? 'host_evidence'
                    : !row.unsampled
                      ? 'sampling_unknown'
                      : !row.visits
                        ? 'zero_referrals'
                        : null;
  const browserKnown = presence.connected && !row.unknownBrowserHost;
  return {
    ...row,
    catalogPaths: typeof row.catalogPaths === 'number' ? row.catalogPaths : row.catalogPaths.size,
    unknownBrowserHost: identityReady ? row.unknownBrowserHost : null,
    browserHostKnown: !row.unknownBrowserHost,
    observedVisits: identityReady && presence.connected ? row.visits : null,
    visits: identityReady && browserKnown ? row.visits : null,
    conversions: identityReady && browserKnown ? row.conversions : null,
    goalEvents: identityReady && browserKnown ? row.goalEvents : null,
    conversionRate:
      identityReady && browserKnown && goals.configured && row.visits
        ? row.conversions / row.visits
        : null,
    ratioDenominator: identityReady && browserKnown ? row.visits : null,
    ratio: evidenceValue(
      reason ? null : row.requests / row.visits,
      reason ? 0 : row.requests,
      row.requests,
      reason === 'mapping_unsupported' ? 'unsupported' : reason ? 'not_comparable' : 'available',
      reason,
    ),
  };
}
