import { classifyEntrySourceForDisplay } from '../contracts/sources';
import { WarehouseEvidenceSpool, type EvidenceProducer } from './warehouse-evidence-spool';

type SourceIdentity = { id: string; referrer: string | null };
type GroupIdentity = {
  id: string;
  name: string;
  sourceLabel?: 'direct';
  ai: boolean;
  sequence: number;
};
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareSource = (a: GroupIdentity, b: GroupIdentity) =>
  lexical(a.name, b.name) || lexical(a.sourceLabel ?? '', b.sourceLabel ?? '');

/** Count identities outside JS memory. Only the existing complete source groups
 * are retained in the response; ties keep their original first-seen order. */
export async function warehouseRealtimeSources(
  produce: EvidenceProducer<SourceIdentity>,
  signal?: AbortSignal,
) {
  const spool = await WarehouseEvidenceSpool.create(signal);
  try {
    let sequence = 0;
    const identities = await spool.sort<GroupIdentity>(
      async emit => {
        await produce(async row => {
          const label = classifyEntrySourceForDisplay({ referrer: row.referrer });
          await emit({
            id: row.id,
            name: label.source,
            ...(label.sourceLabel ? { sourceLabel: label.sourceLabel } : {}),
            ai: label.channel === 'AI 搜索引荐',
            sequence: sequence++,
          });
        });
      },
      (a, b) => compareSource(a, b) || lexical(a.id, b.id),
    );
    const aiIdentities = await spool.sort<{ id: string }>(
      async emit => {
        for await (const row of identities.iterate()) if (row.ai) await emit({ id: row.id });
      },
      (a, b) => lexical(a.id, b.id),
    );
    let ai = 0,
      lastAi: string | undefined;
    for await (const row of aiIdentities.iterate()) {
      if (row.id !== lastAi) ai++;
      lastAi = row.id;
    }
    await aiIdentities.remove();
    const sources: { name: string; sourceLabel?: 'direct'; value: number; sequence: number }[] = [];
    let previous: GroupIdentity | undefined;
    let group: (typeof sources)[number] | undefined;
    for await (const row of identities.iterate()) {
      if (!previous || compareSource(previous, row)) {
        if (group) sources.push(group);
        group = {
          name: row.name,
          ...(row.sourceLabel ? { sourceLabel: row.sourceLabel } : {}),
          value: 0,
          sequence: row.sequence,
        };
      }
      if (!previous || compareSource(previous, row) || previous.id !== row.id) group.value++;
      group.sequence = Math.min(group.sequence, row.sequence);
      previous = row;
    }
    if (group) sources.push(group);
    return {
      ai,
      sources: sources
        .sort((a, b) => b.value - a.value || a.sequence - b.sequence)
        .map(({ sequence: _sequence, ...row }) => row),
    };
  } finally {
    await spool.dispose();
  }
}
