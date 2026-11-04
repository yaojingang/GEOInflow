import { createHash } from 'node:crypto';

export const ROUTING_VERSION = 1;
export type RouteIdentity = { websiteId: string; sessionId: string; clientEventId?: string | null };
export function canonicalUUID(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
  )
    throw new Error('Invalid warehouse UUID');
  return value.toLowerCase();
}
export function routingKey(value: RouteIdentity): string {
  return JSON.stringify([
    canonicalUUID(value.websiteId),
    value.clientEventId ? 'receipt' : 'session',
    canonicalUUID(value.clientEventId ?? value.sessionId),
  ]);
}
export function route(value: RouteIdentity, partitions: number): number {
  if (!Number.isInteger(partitions) || partitions < 1 || partitions > 4096)
    throw new Error('Invalid warehouse partition count');
  return createHash('sha256').update(routingKey(value)).digest().readUInt32BE(0) % partitions;
}

export type InputEnvelope = RouteIdentity & {
  version: 1;
  routingVersion: 1;
  topicId: string;
  inputId: string;
  eventId: string;
  visitId: string;
  epoch: string;
  policyRevision: string;
  kind:
    | 'browser'
    | 'identify'
    | 'log'
    | 'replay'
    | 'heatmap'
    | 'link'
    | 'pixel'
    | 'ingress'
    | 'task';
  fingerprint: string;
  collectionSource: string;
  collectionScope: string;
  receivedAt: string;
  data: Record<string, unknown>;
};

export function validateEnvelope(input: unknown): InputEnvelope {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid warehouse envelope');
  const e = input as InputEnvelope;
  routingKey(e);
  for (const key of ['inputId', 'eventId', 'visitId'] as const)
    if (canonicalUUID(e[key]) !== e[key]) throw new Error('Noncanonical warehouse UUID');
  if (
    canonicalUUID(e.websiteId) !== e.websiteId ||
    canonicalUUID(e.sessionId) !== e.sessionId ||
    (e.clientEventId && canonicalUUID(e.clientEventId) !== e.clientEventId)
  )
    throw new Error('Noncanonical warehouse route');
  if (e.version !== 1 || e.routingVersion !== ROUTING_VERSION || !/^[0-9a-f]{32}$/.test(e.topicId))
    throw new Error('Unsupported warehouse envelope version');
  if (
    ![
      'browser',
      'identify',
      'log',
      'replay',
      'heatmap',
      'link',
      'pixel',
      'ingress',
      'task',
    ].includes(e.kind) ||
    !/^[0-9a-f]{64}$/.test(e.fingerprint)
  )
    throw new Error('Invalid warehouse event kind or fingerprint');
  if (!/^\d+$/.test(e.epoch) || !/^\d+$/.test(e.policyRevision))
    throw new Error('Invalid warehouse event boundary');
  if (
    typeof e.collectionSource !== 'string' ||
    typeof e.collectionScope !== 'string' ||
    !Number.isFinite(Date.parse(e.receivedAt)) ||
    !e.data ||
    typeof e.data !== 'object' ||
    Array.isArray(e.data)
  )
    throw new Error('Incomplete warehouse envelope');
  return e;
}
