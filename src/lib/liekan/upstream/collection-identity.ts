import { conflictsWithCollectionHosts, type CollectionAdmission } from './collection-admission';
import { uuid } from '@/lib/crypto';
import type { IpEvidence } from '@/lib/ip';
import type { CollectionQuality } from './collection-quality';
import { CURRENT_BROWSER_IDENTITY_VERSION } from '../contracts/browser-population';

export const COLLECTION_IDENTITY_VERSION = CURRENT_BROWSER_IDENTITY_VERSION;
export type CollectionIdentityScope =
  | 'browser'
  | 'browser_unresolved'
  | 'browser_automated'
  | 'browser_conflicted'
  | 'authenticated_server'
  | 'legacy_override';

export interface CollectionIdentity {
  scope: CollectionIdentityScope;
  available: boolean;
  version: string;
  sessionId: string;
  browser: string | null;
  os: string | null;
  device: string | null;
  screen: string | null;
  language: string | null;
  originHostname: string | null;
  distinctId: string | null;
  hostname: string | null;
  classification: CollectionQuality['classification'];
}

export function collectionIdentity(input: {
  websiteId: string;
  quality: CollectionQuality;
  admission?: CollectionAdmission;
  ip?: string;
  ipEvidence?: IpEvidence;
  userAgent?: string;
  salt: string;
  distinctId?: string;
  browser?: string;
  os?: string;
  device?: string;
  screen?: string;
  language?: string;
  originHostname?: string | null;
}): CollectionIdentity {
  const { quality, ipEvidence, userAgent, websiteId, salt, distinctId } = input;
  const trusted = !!(ipEvidence?.trusted && input.ip && userAgent);
  const scope: CollectionIdentityScope =
    quality.source !== 'browser'
      ? quality.source
      : quality.classification === 'automated'
        ? 'browser_automated'
        : input.admission &&
            (conflictsWithCollectionHosts(
              input.admission,
              quality.hostname,
              input.originHostname ?? null,
            ) ||
              (input.admission.mode === 'strict' && quality.classification === 'suspected'))
          ? 'browser_conflicted'
          : trusted && quality.classification === 'browser'
            ? 'browser'
            : 'browser_unresolved';
  // Unresolved storage keys are never counted as qualified visitor identities.
  const ip = quality.source === 'browser' && !trusted ? '' : input.ip;
  const values = [scope, websiteId, ip ?? '', userAgent ?? '', salt, distinctId ?? ''];
  return {
    scope,
    available: scope === 'browser',
    version: COLLECTION_IDENTITY_VERSION,
    hostname: quality.hostname,
    classification: quality.classification,
    sessionId: uuid('liekan-collection-v4:', JSON.stringify(values)),
    browser: input.browser?.slice(0, 20) || null,
    os: input.os?.slice(0, 20) || null,
    device: input.device?.slice(0, 20) || null,
    screen: input.screen?.slice(0, 11) || null,
    language: input.language?.slice(0, 35) || null,
    originHostname: input.originHostname || null,
    distinctId: distinctId?.slice(0, 50) || null,
  };
}
