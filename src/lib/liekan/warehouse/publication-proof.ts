import type { ClickHouseClient } from '@clickhouse/client';
import type { Attempt } from './control';
import type { ManifestEntry } from './publication';

export type ProofMode = 'write' | 'verify' | 'recover';

// These three projections share the same key/value table. The expected entries
// come from the sealed source. A failed read cannot authorize a repair.
export async function persistPublicationProof(
  ch: ClickHouseClient,
  attempt: Attempt,
  candidate: ManifestEntry,
  proofs: Map<string, string>,
  options: {
    kind: string;
    revision: string;
    createdAt: string;
    mismatch: string;
    mode: ProofMode;
    verifyAfterWrite: boolean;
  },
) {
  const { kind, revision, mode } = options;
  const insert = (entries: Map<string, string>) =>
    ch.insert({
      table: 'warehouse_control_projection',
      ...(kind === 'log-import-scope-v1' && { clickhouse_settings: { async_insert: 0 } }),
      format: 'JSONEachRow',
      values: [...entries].map(([key, value]) => ({
        website_id: attempt.website_id,
        epoch: attempt.epoch,
        kind,
        revision,
        key,
        value,
        created_at: options.createdAt,
      })),
    });

  const readMissing = async () => {
    const result = await ch.query({
      query: `SELECT DISTINCT key,value FROM warehouse_control_projection
        WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND kind={kind:String}
        AND revision={revision:UInt64} AND JSONExtractString(value,'candidateId')={candidate:String}
        LIMIT {limit:UInt32}`,
      query_params: {
        site: attempt.website_id,
        epoch: attempt.epoch,
        kind,
        revision,
        candidate: candidate.candidateId,
        limit: proofs.size + 1,
      },
      format: 'JSONEachRow',
    });
    const missing = new Map(proofs);
    for (const { key, value } of await result.json<{ key: string; value: string }>()) {
      if (missing.get(key) !== value || !missing.delete(key)) throw new Error(options.mismatch);
    }
    return missing;
  };

  if (mode === 'write') {
    await insert(proofs);
    if (!options.verifyAfterWrite) return;
  }
  const missing = await readMissing();
  if (!missing.size) return;
  if (mode !== 'recover') throw new Error(options.mismatch);
  await insert(missing);
  if ((await readMissing()).size) throw new Error(options.mismatch);
}
