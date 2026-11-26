import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { processSingleton } from './process-singleton';
import { getBundledPublishedCatalog } from '../crawlers/catalog-seed';
import { freezeCatalog } from '../crawlers/catalog-validation';
import { installPublishedCatalogResolver } from '../crawlers/published';
import { LiekanError } from './errors';
import type { PublishedCatalog } from '../contracts/crawler-registry';

const CURRENT_AUTHORITY_MS = 60000;
type CurrentPointer = { version: string; revision?: string };
type CollectionAuthority = { deadline: number; epoch: number };

const state = processSingleton('crawler-registry-context-v3', () => ({
  contexts: new AsyncLocalStorage<PublishedCatalog>(),
  last: undefined as PublishedCatalog | undefined,
  versions: new Map<string, PublishedCatalog>(),
  currentPointer: undefined as CurrentPointer | undefined,
  revocationEpoch: 0,
  authorityEpoch: 0,
  collectionAuthorities: new WeakMap<PublishedCatalog, CollectionAuthority>(),
  collectionContexts: new AsyncLocalStorage<CollectionAuthority | undefined>(),
}));
installPublishedCatalogResolver(() => state.contexts.getStore());
let registryModule: Promise<typeof import('./crawler-registry')> | undefined;
const registryBackend = () => (registryModule ??= import('./crawler-registry'));
export async function initializeCrawlerRegistry() {
  return (await registryBackend()).initializeCrawlerRegistry();
}

function pointerMatches(catalog: PublishedCatalog) {
  return (
    state.currentPointer?.version === catalog.version &&
    (!state.currentPointer.revision || state.currentPointer.revision === catalog.revision)
  );
}

/** Intake authority expires independently of immutable replay and crawler-control snapshots. */
export function collectionRegistryIsCurrent(): boolean {
  const catalog = state.contexts.getStore();
  const authority = state.collectionContexts.getStore();
  return (
    !!catalog &&
    !!authority &&
    authority.epoch === state.authorityEpoch &&
    Date.now() < authority.deadline &&
    pointerMatches(catalog)
  );
}

/** A failed read preserves immutable content; current intake authority has a separate deadline. */
export async function loadPublishedRegistry(version?: string): Promise<PublishedCatalog> {
  if (version && !z.uuid().safeParse(version).success) throw new LiekanError('目录版本无效', 400);
  if (version && state.versions.has(version)) return state.versions.get(version);
  try {
    const { readCrawlerRegistryPointer, readPublishedRegistry } = await registryBackend();
    let pointer: { version: string; revision?: string };
    let readEpoch = state.revocationEpoch;
    try {
      pointer = version ? { version } : await readCrawlerRegistryPointer();
    } catch (error) {
      if (version || !(error instanceof LiekanError) || error.status !== 404) throw error;
      state.revocationEpoch++;
      state.authorityEpoch++;
      state.currentPointer = undefined;
      await initializeCrawlerRegistry();
      readEpoch = state.revocationEpoch;
      pointer = await readCrawlerRegistryPointer();
    }
    const pointerReadAt = Date.now();
    if (
      !version &&
      readEpoch === state.revocationEpoch &&
      (!state.currentPointer?.revision ||
        !pointer.revision ||
        BigInt(pointer.revision) >= BigInt(state.currentPointer.revision))
    ) {
      if (
        state.currentPointer?.version !== pointer.version ||
        state.currentPointer?.revision !== pointer.revision
      )
        state.authorityEpoch++;
      state.currentPointer = pointer;
    }
    const catalog =
      state.versions.get(pointer.version) ?? (await readPublishedRegistry(pointer.version));
    if (pointer.revision && pointer.revision !== catalog.revision)
      throw new Error('Crawler pointer revision mismatch');
    if (!version && readEpoch === state.revocationEpoch && pointerMatches(catalog)) {
      state.last = catalog;
      state.collectionAuthorities.set(catalog, {
        deadline: pointerReadAt + CURRENT_AUTHORITY_MS,
        epoch: state.authorityEpoch,
      });
    }
    state.versions.delete(catalog.version);
    state.versions.set(catalog.version, catalog);
    if (state.versions.size > 64) state.versions.delete(state.versions.keys().next().value);
    return catalog;
  } catch (error) {
    if (error instanceof LiekanError && [400, 404].includes(error.status)) throw error;
    const seed = getBundledPublishedCatalog();
    const cached = version
      ? (state.versions.get(version) ?? (seed.version === version ? seed : undefined))
      : (state.last ?? seed);
    if (!cached) throw new LiekanError('指定目录版本暂不可用', 503);
    const fallback = freezeCatalog({ ...cached, state: 'fallback' as const });
    const authority = state.collectionAuthorities.get(cached);
    if (!version && authority?.epoch === state.authorityEpoch && pointerMatches(cached))
      state.collectionAuthorities.set(fallback, authority);
    return fallback;
  }
}
/** Nested work inherits one batch snapshot unless it explicitly requests another immutable version. */
export async function withPublishedRegistry<T>(
  work: (catalog: PublishedCatalog) => T | Promise<T>,
  version?: string,
): Promise<T> {
  const existing = state.contexts.getStore();
  if (existing && (!version || existing.version === version))
    return version ? state.collectionContexts.run(undefined, () => work(existing)) : work(existing);
  const catalog = await loadPublishedRegistry(version);
  return state.contexts.run(catalog, () =>
    state.collectionContexts.run(
      version ? undefined : state.collectionAuthorities.get(catalog),
      () => work(catalog),
    ),
  );
}
