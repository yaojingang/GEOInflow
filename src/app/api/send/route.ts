import {
  collectionAdmission,
  normalizeCollectionOrigin,
} from '@/lib/liekan/upstream/collection-admission';
import { withPublishedRegistry } from '@/lib/liekan/upstream/crawler-registry-context';
import { observeCollection } from '@/lib/liekan/upstream/collection-observation';
import { recordGeographyIngress } from '@/lib/liekan/upstream/geography-ingress';
import { startOfHour } from 'date-fns';
import { isbot } from 'isbot';
import { z } from 'zod';
import clickhouse from '@/lib/clickhouse';
import { CACHE_TOKEN_TYPE, COLLECTION_TYPE, EVENT_TYPE, FIELD_LENGTH } from '@/lib/constants';
import { getSalt, hash, secret, uuid } from '@/lib/crypto';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { isAuthenticatedCollection } from '@/lib/liekan/upstream/collection-auth';
import { classifyCollection } from '@/lib/liekan/upstream/collection-quality';
import { collectionIdentity } from '@/lib/liekan/upstream/collection-identity';
import { collectionFingerprint } from '@/lib/liekan/upstream/collection-fingerprint';
import { collectionSnapshots } from '@/lib/liekan/upstream/collection-snapshots';
import {
  CollectionConflictError,
  withCollectionWrite,
  recordCollectionIdentity,
} from '@/lib/liekan/upstream/collection-write';
import { truncateString } from '@/lib/format';
import { createToken, parseToken } from '@/lib/jwt';
import { fetchWebsite } from '@/lib/load';
import { getLink, getPixel } from '@/queries/prisma';
import { parseRequest } from '@/lib/request';
import { badRequest, forbidden, json, serverError } from '@/lib/response';
import { anyObjectParam, urlOrPathParam } from '@/lib/schema';
import { safeDecodeURI, safeDecodeURIComponent } from '@/lib/url';
import { sanitizeCollectionUrl } from '@/tracker/privacy';
import {
  createSession,
  saveEvent,
  saveSessionData,
  saveSessionLink,
  updateSession,
} from '@/queries/sql';

interface Cache {
  websiteId: string;
  sessionId: string;
  visitId: string;
  iat: number;
  sessionLinkId?: string;
  collectionScope?: string;
  resourceType?: string;
}

// Reject strings whose first character is a spreadsheet formula trigger to
// prevent CSV formula injection in analytics exports (defense-in-depth).
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
const safeStringParam = () =>
  z.string().refine(val => !FORMULA_TRIGGER_RE.test(val), {
    message: 'Value must not start with =, +, -, @, tab, or carriage return',
  });

const schema = z.object({
  type: z.enum(['event', 'identify', 'performance']),
  payload: z
    .object({
      website: z.uuid().optional(),
      link: z.uuid().optional(),
      pixel: z.uuid().optional(),
      eventId: z.uuid().optional(),
      webdriver: z.boolean().optional(),
      data: anyObjectParam.optional(),
      hostname: z.string().optional(),
      language: z.string().optional(),
      referrer: urlOrPathParam.optional(),
      screen: z.string().optional(),
      title: z.string().optional(),
      url: urlOrPathParam.optional(),
      name: safeStringParam().optional(),
      tag: safeStringParam().optional(),
      ip: z.string().optional(),
      userAgent: z.string().optional(),
      timestamp: z.coerce.number().int().optional(),
      id: z.string().optional(),
      browser: z.string().optional(),
      os: z.string().optional(),
      device: z.string().optional(),
      lcp: z.number().nonnegative().max(60000).optional(),
      inp: z.number().nonnegative().max(60000).optional(),
      cls: z.number().nonnegative().max(100).optional(),
      fcp: z.number().nonnegative().max(60000).optional(),
      ttfb: z.number().nonnegative().max(60000).optional(),
    })
    .refine(
      data => {
        const keys = [data.website, data.link, data.pixel];
        const count = keys.filter(Boolean).length;
        return count === 1;
      },
      {
        message: 'Exactly one of website, link, or pixel must be provided',
        path: ['website'],
      },
    ),
});

export async function POST(request: Request) {
  return process.env.CLICKHOUSE_URL
    ? collect(request)
    : withPublishedRegistry(() => collect(request));
}
async function collect(request: Request) {
  const receivedAt = new Date();
  try {
    const { body, error } = await parseRequest(request, schema, { skipAuth: true });

    if (error) {
      return error();
    }

    const { type, payload } = body;

    const {
      website: websiteId,
      pixel: pixelId,
      link: linkId,
      hostname,
      screen,
      language,
      url,
      referrer,
      name,
      data,
      title,
      tag,
      timestamp,
      id,
      lcp,
      inp,
      cls,
      fcp,
      ttfb,
    } = payload;

    const sourceId = websiteId || pixelId || linkId;
    const resourceType = websiteId ? 'website' : linkId ? 'link' : 'pixel';
    const resource = websiteId
      ? await fetchWebsite(websiteId)
      : linkId
        ? await getLink(linkId)
        : await getPixel(pixelId);
    if (!resource || resource.deletedAt || (!websiteId && type !== COLLECTION_TYPE.event))
      return badRequest({ message: 'Collection resource not found or type mismatch.' });

    // Cache check
    let cache: Cache | null = null;

    if (websiteId) {
      const cacheHeader = request.headers.get('x-umami-cache');

      if (cacheHeader) {
        const result = await parseToken(cacheHeader, secret());

        if (
          result?.type === CACHE_TOKEN_TYPE &&
          result.websiteId?.toLowerCase() === websiteId.toLowerCase() &&
          (!result.resourceType || result.resourceType === resourceType)
        ) {
          cache = result;
        }
      }
    }

    // Client info
    const {
      ip,
      userAgent,
      device,
      browser,
      os,
      country,
      region,
      city,
      geographyEvidence,
      ipEvidence,
    } = await getClientInfo(request, payload, isAuthenticatedCollection(request));

    const qualityEnabled = Boolean(websiteId && !clickhouse.enabled);
    // Liekan keeps evidence with raw website events; the shared read policy filters automation.
    const botCheckDisabled = ['1', 'true'].includes(process.env.DISABLE_BOT_CHECK?.toLowerCase());
    if (!qualityEnabled && !botCheckDisabled && isbot(userAgent)) {
      return json({ beep: 'boop' });
    }

    if (qualityEnabled && ipEvidence?.invalidInput)
      await recordGeographyIngress(websiteId, 'invalid_ip');

    // IP block
    if (hasBlockedIp(ip)) {
      if (qualityEnabled) await recordGeographyIngress(websiteId, 'blocked_ip');
      return forbidden();
    }

    const createdAt = timestamp != null ? new Date(timestamp * 1000) : receivedAt;
    if (!Number.isFinite(createdAt.getTime()))
      return badRequest({ message: 'Invalid event time.' });
    const now = Math.floor(Date.now() / 1000);
    const distinctId = truncateString(id, FIELD_LENGTH.distinctId);

    const saltRotation = process.env.SALT_ROTATION || 'month';
    const sessionSalt = getSalt(saltRotation, createdAt);
    const visitSalt = hash(startOfHour(createdAt).toUTCString());
    const quality = qualityEnabled
      ? classifyCollection({
          request,
          payload,
          authenticated: isAuthenticatedCollection(request),
          ip,
          userAgent,
          snapshots: await collectionSnapshots(),
          receivedAt,
        })
      : undefined;
    const admission =
      quality?.source === 'browser' ? await collectionAdmission(websiteId) : undefined;
    const identity = quality
      ? collectionIdentity({
          websiteId,
          quality,
          admission,
          ip,
          ipEvidence,
          userAgent,
          salt: sessionSalt,
          distinctId,
          browser,
          os,
          device,
          screen,
          language,
          originHostname: normalizeCollectionOrigin(request.headers.get('origin')),
        })
      : undefined;
    if (
      identity &&
      cache &&
      cache.collectionScope !== identity.scope &&
      !(cache.collectionScope == null && identity.scope === 'browser')
    )
      cache = null;
    let sessionLinkId = cache?.sessionLinkId;

    // Identified users need a separate deterministic session from anonymous users
    // who happen to share the same IP address and user agent.
    let sessionId =
      identity?.sessionId || uuid(sourceId, ip, userAgent, sessionSalt, distinctId ?? '');
    const sessionDrift = !!websiteId && !!cache?.sessionId && cache.sessionId !== sessionId;

    // Visit info
    let visitId = cache?.visitId || uuid(sessionId, visitSalt);
    let iat = cache?.iat || now;

    // A drifted cache session should start a fresh visit on the recomputed session.
    if (sessionDrift) {
      visitId = uuid(sessionId, visitSalt);
      iat = now;
    }

    // Expire visit after 30 minutes
    if (!timestamp && now - iat > 1800) {
      visitId = uuid(sessionId, visitSalt);
      iat = now;
    }

    const collect = async () => {
      if (!clickhouse.enabled) {
        await createSession({
          id: sessionId,
          websiteId: sourceId,
          browser,
          os,
          device,
          screen,
          language,
          country,
          region,
          city,
          distinctId,
          createdAt,
        });
      }
      if (identity) await recordCollectionIdentity(websiteId, identity);
      if (type === COLLECTION_TYPE.event) {
        const base = hostname ? `https://${hostname}` : 'https://localhost';
        const currentUrl = new URL(sanitizeCollectionUrl(url, base));

        let urlPath =
          currentUrl.pathname === '/undefined' ? '' : currentUrl.pathname + currentUrl.hash;
        const urlQuery = currentUrl.search.substring(1);
        const urlDomain = currentUrl.hostname.replace(/^www\./, '');

        let referrerPath: string;
        let referrerQuery: string;
        let referrerDomain: string;

        // UTM Params
        const utmSource = currentUrl.searchParams.get('utm_source');
        const utmMedium = currentUrl.searchParams.get('utm_medium');
        const utmCampaign = currentUrl.searchParams.get('utm_campaign');
        const utmContent = currentUrl.searchParams.get('utm_content');
        const utmTerm = currentUrl.searchParams.get('utm_term');

        // Click IDs
        const gclid = currentUrl.searchParams.get('gclid');
        const fbclid = currentUrl.searchParams.get('fbclid');
        const msclkid = currentUrl.searchParams.get('msclkid');
        const ttclid = currentUrl.searchParams.get('ttclid');
        const lifatid = currentUrl.searchParams.get('li_fat_id');
        const twclid = currentUrl.searchParams.get('twclid');

        if (process.env.REMOVE_TRAILING_SLASH) {
          // Never strip the root slash, otherwise the home page is saved with an empty path
          urlPath = urlPath.replace(/(?!^)\/(?=(#.*)?$)/, '');
        }

        if (referrer) {
          // Canonicalize the event domain (lowercase, punycode, no port) so it
          // compares correctly against the parsed referrer hostname
          let eventDomain = urlDomain;
          if (hostname) {
            try {
              eventDomain = new URL(`https://${hostname}`).hostname.replace(/^www\./, '');
            } catch {
              eventDomain = hostname.replace(/^www\./, '');
            }
          }
          // Resolve path-only referrers against the event's domain, not the localhost fallback
          const referrerUrl = new URL(
            sanitizeCollectionUrl(referrer, eventDomain ? `https://${eventDomain}` : base),
          );

          referrerPath = referrerUrl.pathname;
          referrerQuery = referrerUrl.search.substring(1);
          referrerDomain = referrerUrl.hostname.replace(/^www\./, '');

          // Never save the referrer domain for self-referrals
          if (referrerDomain === eventDomain) {
            referrerDomain = undefined;
          }
        }

        const eventType = linkId
          ? EVENT_TYPE.linkEvent
          : pixelId
            ? EVENT_TYPE.pixelEvent
            : name
              ? EVENT_TYPE.customEvent
              : EVENT_TYPE.pageView;

        await saveEvent({
          websiteId: sourceId,
          sessionId,
          visitId,
          eventType,
          createdAt,

          // Page
          pageTitle: safeDecodeURIComponent(title),
          hostname: hostname || urlDomain,
          urlPath: safeDecodeURI(urlPath),
          urlQuery,
          referrerPath: safeDecodeURI(referrerPath),
          referrerQuery,
          referrerDomain,

          // Session
          distinctId,
          browser,
          os,
          device,
          screen,
          language,
          country,
          region,
          city,

          // Events
          eventName: name,
          eventData: data,
          tag,

          // UTM
          utmSource,
          utmMedium,
          utmCampaign,
          utmContent,
          utmTerm,

          // Click IDs
          gclid,
          fbclid,
          msclkid,
          ttclid,
          lifatid,
          twclid,
        });
      } else if (type === COLLECTION_TYPE.identify) {
        if (websiteId && distinctId) {
          const newLinkId = hash(sessionId, distinctId);

          if (sessionLinkId !== newLinkId) {
            const identify = async () => {
              await Promise.all([
                saveSessionLink({
                  websiteId,
                  sessionId,
                  distinctId,
                  createdAt,
                }),
                updateSession({
                  websiteId,
                  sessionId,
                  distinctId,
                }),
              ]);
              sessionLinkId = newLinkId;
            };
            if (qualityEnabled) await identify();
            else await identify().catch(() => {});
          }
        }

        if (data) {
          await saveSessionData({
            websiteId,
            sessionId,
            sessionData: data,
            distinctId,
            createdAt,
          });
        }
      } else if (type === COLLECTION_TYPE.performance) {
        const base = hostname ? `https://${hostname}` : 'https://localhost';
        const currentUrl = new URL(url, base);
        const urlPath = currentUrl.pathname === '/undefined' ? '' : currentUrl.pathname;

        await saveEvent({
          websiteId: sourceId,
          sessionId,
          visitId,
          urlPath,
          pageTitle: safeDecodeURIComponent(title),
          eventType: EVENT_TYPE.performance,
          browser,
          os,
          device,
          screen,
          language,
          country,
          region,
          city,
          lcp,
          inp,
          cls,
          fcp,
          ttfb,
          createdAt,
        });
      }
    };
    if (qualityEnabled) {
      const result = await withCollectionWrite(
        {
          websiteId,
          eventId: type === COLLECTION_TYPE.identify ? undefined : payload.eventId,
          fingerprint: collectionFingerprint(type, payload),
          quality,
          identity,
          expectedPolicyRevision: admission?.revision,
          identify: type === COLLECTION_TYPE.identify,
          geography: geographyEvidence,
          observation: isAuthenticatedCollection(request)
            ? undefined
            : observeCollection(request, receivedAt),
        },
        collect,
      );
      if (result.status === 'duplicate') {
        sessionId = result.sessionId;
        visitId = result.visitId;
        iat = now;
        if (cache?.sessionId !== sessionId || cache?.visitId !== visitId) sessionLinkId = undefined;
      }
    } else {
      await collect();
    }

    const token = createToken(
      {
        websiteId,
        sessionId,
        visitId,
        iat,
        sessionLinkId,
        collectionScope: identity?.scope,
        resourceType,
        type: CACHE_TOKEN_TYPE,
      },
      secret(),
    );

    return json({ cache: token, sessionId, visitId });
  } catch (e) {
    if (e instanceof CollectionConflictError)
      return Response.json(
        {
          error: {
            message: 'Event ID already used for different content',
            code: 'event-id-conflict',
            status: 409,
          },
        },
        { status: 409 },
      );
    return serverError(e);
  }
}
