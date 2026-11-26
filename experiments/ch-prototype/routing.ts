import { createHash } from 'node:crypto';

export const ROUTING_VERSION = 1;
export const PARTITIONS = 2;

/** Normalize UUID spelling without changing opaque fixture identifiers. */
export function routingIdentifier(value: string): string {
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value) ? value.toLowerCase() : value;
}

/** Use receipt identity, or session ordering when the caller supplies no receipt. */
export function routingKey(event: { site: string; uuid?: string; session: string }): string {
  return JSON.stringify([
    routingIdentifier(event.site),
    event.uuid ? 'receipt' : 'session',
    routingIdentifier(event.uuid ?? event.session),
  ]);
}

/** Pin the hash and partition count; changing either requires an explicit migration. */
export function route(event: { site: string; uuid?: string; session: string }): number {
  return createHash('sha256').update(routingKey(event)).digest().readUInt32BE(0) % PARTITIONS;
}
