import { createHash } from 'node:crypto';
import { browserName } from 'detect-browser';
import ipaddr from 'ipaddr.js';
import { isbot } from 'isbot';
import { configuredIp, normalizeIp } from '@/lib/ip';
import { getPublishedCatalog } from '../crawlers/published';
import { getBrowserRangeSources } from '../crawlers/range-sources';
import { classifyBot, getBotRules } from '../rules/bots';
import { rangeContainsAddress, type VerificationSnapshots } from '../rules/verify';
import { hasUrlAuthority, normalizeCollectionHostname } from '../traffic-quality/hostname';
import { collectionRegistryIsCurrent } from './crawler-registry-context';

export const COLLECTION_RULE_VERSION = 'traffic-quality-v4';
export type CollectionClassification = 'browser' | 'automated' | 'suspected' | 'unknown';
export type CollectionSource = 'browser' | 'authenticated_server' | 'legacy_override';
export type CollectionRangeStatus = 'fresh' | 'stale' | 'missing' | 'untrusted' | 'invalid';
export interface CollectionQuality {
  classification: CollectionClassification;
  source: CollectionSource;
  reasons: string[];
  ruleVersion: string;
  catalogVersion?: string;
  rangeVersion: string | null;
  rangeStatus: CollectionRangeStatus;
  hostname: string | null;
}
export interface CollectionInput {
  request: Request;
  payload: Record<string, any>;
  authenticated: boolean;
  ip: string;
  userAgent: string;
  snapshots: VerificationSnapshots;
  /** Collector receipt time, independent of a caller-supplied historical timestamp. */
  receivedAt?: Date;
  now?: Date;
}

const RANGE_MAX_AGE = 7 * 86400000;
const OVERRIDE_FIELDS = ['ip', 'userAgent', 'browser', 'os', 'device', 'timestamp'] as const;

export function collectionSource(
  payload: Record<string, any>,
  authenticated: boolean,
): CollectionSource {
  if (authenticated) return 'authenticated_server';
  return OVERRIDE_FIELDS.some(field => payload?.[field] != null) ? 'legacy_override' : 'browser';
}

function registeredCrawler(ua: string) {
  if (!collectionRegistryIsCurrent()) return false;
  const match = classifyBot(ua, getBotRules());
  // Conflicting registered identities still establish automation, without attributing a vendor.
  return !!match.crawlerId || !!match.candidateIds?.length;
}

export { normalizeCollectionHostname } from '../traffic-quality/hostname';

function address(value: unknown) {
  const clean = typeof value === 'string' ? normalizeIp(value) : undefined;
  return clean ? ipaddr.parse(clean) : null;
}

function trustedAddress(input: CollectionInput) {
  const clientAddress = address(input.ip);
  if (!clientAddress) return null;
  if (input.authenticated) return clientAddress;
  const candidate = configuredIp(input.request.headers);
  if (candidate?.ip === clientAddress.toString()) return clientAddress;
  return null;
}

type RangeEvidence = {
  status: CollectionRangeStatus;
  version: string | null;
  freshMatches: number;
};

function rangeEvidence(input: CollectionInput): RangeEvidence {
  const entries = Object.entries(input.snapshots || {});
  const empty = (status: CollectionRangeStatus): RangeEvidence => ({
    status,
    version: null,
    freshMatches: 0,
  });
  if (!entries.length) return empty('missing');
  const clientAddress = trustedAddress(input);
  if (!clientAddress)
    return empty(input.authenticated && !address(input.ip) ? 'invalid' : 'untrusted');
  if (!collectionRegistryIsCurrent()) return empty('untrusted');
  const timestamp = +(input.receivedAt ?? input.now ?? new Date());
  if (!Number.isFinite(timestamp)) return empty('invalid');
  // Public overrides describe source provenance; current network evidence uses receipt time.
  const eventTimestamp =
    !input.authenticated || input.payload?.timestamp == null
      ? timestamp
      : typeof input.payload.timestamp === 'number'
        ? input.payload.timestamp * 1000
        : NaN;
  if (!Number.isFinite(eventTimestamp)) return empty('invalid');
  const available: CollectionRangeStatus[] = [];
  const matching: { status: 'fresh' | 'stale'; version: string }[] = [];
  const sources = getBrowserRangeSources();
  for (const [bot, snapshot] of entries) {
    const official = sources.find(source => source.names.includes(bot));
    if (!official) {
      available.push('untrusted');
      continue;
    }
    try {
      if (
        !snapshot ||
        typeof snapshot !== 'object' ||
        !Array.isArray(snapshot.prefixes) ||
        !snapshot.prefixes.length ||
        snapshot.prefixes.length > 5000 ||
        typeof snapshot.retrievedAt !== 'string'
      )
        throw new Error('Invalid range snapshot');
      if (snapshot.source !== official.url) {
        available.push('untrusted');
        continue;
      }
      const retrievedAt = +new Date(snapshot.retrievedAt);
      if (!Number.isFinite(retrievedAt) || retrievedAt > timestamp)
        throw new Error('Invalid range time');
      const status =
        timestamp - retrievedAt <= RANGE_MAX_AGE &&
        Math.abs(eventTimestamp - retrievedAt) <= RANGE_MAX_AGE
          ? 'fresh'
          : 'stale';
      available.push(status);
      if (rangeContainsAddress(snapshot.prefixes, clientAddress)) {
        const version =
          typeof snapshot.version === 'string' && snapshot.version
            ? snapshot.version
            : createHash('sha256')
                .update(JSON.stringify([...snapshot.prefixes].sort()))
                .digest('hex');
        matching.push({ status, version });
      }
    } catch {
      available.push('invalid');
    }
  }
  if (!available.length) return empty('missing');
  const fresh = matching.filter(match => match.status === 'fresh');
  const used = fresh.length ? fresh : matching;
  const status = used.length
    ? fresh.length
      ? 'fresh'
      : 'stale'
    : available.includes('invalid')
      ? 'invalid'
      : available.includes('untrusted')
        ? 'untrusted'
        : available.includes('fresh')
          ? 'fresh'
          : 'stale';
  return {
    status,
    version: used.length
      ? createHash('sha256')
          .update(JSON.stringify(used.map(match => match.version).sort()))
          .digest('hex')
      : null,
    freshMatches: fresh.length,
  };
}

export function classifyCollection(input: CollectionInput): CollectionQuality {
  const source = collectionSource(input.payload, input.authenticated);
  const ranges = rangeEvidence(input);
  const ua = typeof input.userAgent === 'string' ? input.userAgent : '';
  const uaBot = isbot(ua);
  const crawlerUa = registeredCrawler(ua);
  // An authorized server reports the visitor UA separately from its HTTP client.
  // Public payload overrides cannot erase automation evidence in the request UA.
  const requestUaBot = !input.authenticated && isbot(input.request.headers.get('user-agent') || '');
  const requestCrawlerUa =
    !input.authenticated && registeredCrawler(input.request.headers.get('user-agent') || '');
  // A positive client declaration can exclude automation. Absence/false proves no human identity.
  const webdriver = input.payload?.webdriver === true;
  let classification: CollectionClassification;
  let reasons: string[];
  if (ranges.freshMatches) {
    classification = 'automated';
    reasons = [ranges.freshMatches > 1 ? 'official_range_ambiguous' : 'official_range_match'];
  } else if (uaBot) {
    classification = 'automated';
    reasons = ['ua_bot'];
  } else if (requestUaBot) {
    classification = 'automated';
    reasons = ['request_ua_bot'];
  } else if (crawlerUa || requestCrawlerUa) {
    classification = 'automated';
    reasons = [crawlerUa ? 'crawler_ua_token' : 'request_crawler_ua_token'];
  } else if (webdriver) {
    classification = 'automated';
    reasons = ['browser_webdriver'];
  } else if (source === 'legacy_override') {
    classification = 'suspected';
    reasons = ['legacy_payload_override'];
  } else if (browserName(ua)) {
    classification = 'browser';
    reasons = ['browser_compatible'];
  } else {
    classification = 'unknown';
    reasons = ['ua_unrecognized'];
  }
  return {
    classification,
    source,
    reasons,
    ruleVersion: COLLECTION_RULE_VERSION,
    catalogVersion: getPublishedCatalog()?.version,
    rangeVersion: ranges.version,
    rangeStatus: ranges.status,
    hostname:
      (hasUrlAuthority(input.payload?.url)
        ? normalizeCollectionHostname(input.payload.url)
        : null) || normalizeCollectionHostname(input.payload?.hostname),
  };
}
