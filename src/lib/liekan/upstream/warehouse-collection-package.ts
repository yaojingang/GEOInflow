import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import { DATA_TYPE, FIELD_LENGTH } from '@/lib/constants';
import { normalizeCountryCode, normalizeRegionCode } from '@/lib/country';
import { flattenJSON, getStoredStringValue } from '@/lib/data';
import { truncateString } from '@/lib/format';
import type { SaveEventArgs } from '@/queries/sql/events/saveEvent';
import type { SaveSessionDataArgs } from '@/queries/sql/sessions/saveSessionData';
import type { SaveSessionLinkArgs } from '@/queries/sql/sessions/saveSessionLink';
import type { UpdateSessionArgs } from '@/queries/sql/sessions/updateSession';
import { rowDigest } from '../warehouse/codec';
import { factInput } from '../warehouse/fact-input';
import type { FactMutation } from '../warehouse/landing';
import type { CollectionIdentity } from './collection-identity';
import type { CollectionWriteInput } from './collection-write';

export type BrowserPackage = {
  format: 'browser-v1';
  facts: FactMutation[];
  identify: boolean;
  hasQuality: boolean;
  hasGeography: boolean;
  hasIdentity: boolean;
  hasObservation: boolean;
};

// This adapter receives only normalized collector values. Request IP/full UA and
// public provenance overrides never enter the durable package.
export class WarehouseCollectionPackage {
  readonly eventId = randomUUID();
  readonly facts: FactMutation[] = [];
  constructor(
    readonly input: CollectionWriteInput,
    private readonly receivedAt: Date,
    private readonly resourceType: 'website' | 'link' | 'pixel' = 'website',
  ) {}
  private add(family: string, fields: Record<string, unknown>, retainCreatedAt = false) {
    const row = factInput(family, fields);
    this.facts.push({ family, row, ...(retainCreatedAt ? { retainCreatedAt: true } : {}) });
    return row;
  }
  async createSession(data: Prisma.SessionCreateInput) {
    const country = normalizeCountryCode(data.country);
    this.add('session', {
      session_id: data.id,
      website_id: data.websiteId,
      browser: data.browser,
      os: data.os,
      device: data.device,
      screen: data.screen,
      language: data.language,
      country,
      region: normalizeRegionCode(data.region, data.country),
      city: data.city,
      distinct_id: data.distinctId,
      created_at: data.createdAt ?? this.receivedAt,
    });
  }
  async identity(websiteId: string, i: CollectionIdentity) {
    if (websiteId !== this.input.websiteId || i !== this.input.identity)
      throw new Error('Collection identity boundary mismatch');
    this.add('liekan_session_source', {
      website_id: websiteId,
      session_id: i.sessionId,
      source: this.input.quality.source,
      scope: i.scope,
      identity_version: i.version,
      identity_available: i.available,
      created_at: this.receivedAt,
      updated_at: this.receivedAt,
    });
  }
  async saveEvent(args: SaveEventArgs) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args))
      fields[key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)] = value;
    fields.li_fat_id = args.lifatid;
    const event = this.add('website_event', {
      ...fields,
      event_id: this.eventId,
      created_at: args.createdAt ?? this.receivedAt,
    });
    if (args.eventData) {
      for (const property of flattenJSON(args.eventData))
        this.add('event_data', {
          event_data_id: randomUUID(),
          website_event_id: this.eventId,
          website_id: args.websiteId,
          data_key: property.key,
          string_value: getStoredStringValue(property.value, property.dataType),
          number_value: property.dataType === DATA_TYPE.number ? property.value : null,
          date_value: property.dataType === DATA_TYPE.date ? property.value : null,
          data_type: property.dataType,
          created_at: args.createdAt ?? this.receivedAt,
        });
      const { revenue, currency } = args.eventData;
      if (revenue > 0 && currency)
        this.add('revenue', {
          revenue_id: randomUUID(),
          website_id: args.websiteId,
          session_id: args.sessionId,
          event_id: this.eventId,
          event_name: args.eventName,
          currency,
          revenue,
          created_at: args.createdAt ?? this.receivedAt,
        });
    }
    const i = this.input.identity,
      g = this.input.geography,
      q = this.input.quality,
      o = this.input.observation;
    if (i)
      this.add('liekan_event_environment', {
        event_id: this.eventId,
        website_id: args.websiteId,
        scope: i.scope,
        identity_version: i.version,
        identity_available: i.available,
        browser: i.browser,
        os: i.os,
        device: i.device,
        screen: i.screen,
        language: i.language,
        origin_hostname: i.originHostname,
        distinct_id: i.distinctId,
        created_at: this.receivedAt,
      });
    if (g)
      this.add('liekan_event_geography', {
        event_id: this.eventId,
        website_id: args.websiteId,
        country: g.location.country || null,
        region: g.location.region || null,
        city: g.location.city?.slice(0, 80) || null,
        source: g.source,
        trust: g.trust,
        ip_family: g.ipFamily,
        precision: g.precision,
        reason: g.reason,
        rule_version: g.ruleVersion,
        data_version: g.dataVersion,
        city_id: g.cityId,
        accuracy_radius: g.accuracyRadius,
        country_basis: g.countryBasis,
        processed_at: g.processedAt,
        shadow: g.shadow,
      });
    if (q)
      this.add('liekan_event_quality', {
        event_id: this.eventId,
        website_id: args.websiteId,
        classification: q.classification,
        source: q.source,
        reasons: q.reasons,
        rule_version: q.ruleVersion,
        range_version: q.rangeVersion,
        range_status: q.rangeStatus,
        hostname: q.hostname,
        catalog_version: q.catalogVersion,
        repair_scope_id: null,
        created_at: this.receivedAt,
      });
    if (o && q && ['browser', 'legacy_override'].includes(q.source) && args.eventType === 1)
      this.add('liekan_event_observation', {
        event_id: this.eventId,
        website_id: args.websiteId,
        epoch: '1',
        version: o.version,
        event_at: event.created_at,
        received_at: o.receivedAt,
        features: o.features,
      }); // Worker binds the authoritative observation epoch.
    if (this.input.eventId)
      this.add('liekan_collection_receipt', {
        website_id: args.websiteId,
        client_event_id: this.input.eventId,
        payload_hash: this.input.fingerprint,
        event_id: this.eventId,
        collection_source: q?.source ?? this.resourceType,
        collection_scope: i?.scope ?? q?.source ?? this.resourceType,
        created_at: this.receivedAt,
      });
  }
  async saveSessionData(args: SaveSessionDataArgs) {
    const i = this.input.identity;
    for (const p of flattenJSON(args.sessionData)) {
      const row = this.add(
        'session_data',
        {
          session_data_id: randomUUID(),
          website_id: args.websiteId,
          session_id: args.sessionId,
          data_key: p.key,
          string_value: getStoredStringValue(p.value, p.dataType),
          number_value: p.dataType === DATA_TYPE.number ? p.value : null,
          date_value: p.dataType === DATA_TYPE.date ? p.value : null,
          data_type: p.dataType,
          distinct_id: args.distinctId,
          created_at: args.createdAt ?? this.receivedAt,
        },
        !args.createdAt,
      );
      if (i)
        this.add('liekan_session_data_source', {
          website_id: args.websiteId,
          session_id: args.sessionId,
          data_key: row.data_key,
          scope: i.scope,
          hostname: i.hostname,
          origin_hostname: i.originHostname,
          classification: i.classification,
          row_digest: rowDigest('session_data', row),
          updated_at: this.receivedAt,
        });
    }
  }
  async saveSessionLink(args: SaveSessionLinkArgs) {
    this.add('session_link', {
      website_id: args.websiteId,
      session_id: args.sessionId,
      distinct_id: args.distinctId,
      created_at: args.createdAt ?? this.receivedAt,
    });
    const i = this.input.identity;
    if (i)
      this.add('liekan_session_link_source', {
        website_id: args.websiteId,
        session_id: args.sessionId,
        distinct_id: args.distinctId,
        scope: i.scope,
        hostname: i.hostname,
        origin_hostname: i.originHostname,
        classification: i.classification,
        created_at: this.receivedAt,
      });
  }
  async updateSession(args: UpdateSessionArgs) {
    // createSession runs first in the same package; the read relation preserves
    // the first existing nonempty identity across all accepted versions.
    const session = this.facts.find(
      f => f.family === 'session' && f.row.session_id === args.sessionId,
    );
    if (!session) throw new Error('Collection session missing');
    session.row.distinct_id = truncateString(args.distinctId, FIELD_LENGTH.distinctId) ?? null;
  }
  seal(): BrowserPackage {
    return {
      format: 'browser-v1',
      facts: this.facts,
      identify: !!this.input.identify,
      hasQuality: !!this.input.quality,
      hasGeography: !!this.input.geography,
      hasIdentity: !!this.input.identity,
      hasObservation: this.facts.some(f => f.family === 'liekan_event_observation'),
    };
  }
}
