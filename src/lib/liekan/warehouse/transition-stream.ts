import { createHash, randomUUID } from 'node:crypto';
import { type ControlDatabase, WarehouseConflict } from './control-db';
import { QueueReplayReader } from './replay-reader';
import {
  decodeAuthoritativeResult,
  TransitionCapture,
  type CapturedResult,
} from './transition-capture';
import type { WarehouseQueue } from './transport';

type Frame = {
  format: 'authority-frame-v1';
  sequence: string;
  operationId: string;
  digest: string;
  part: number;
  parts: number;
  chunkDigest: string;
  data: string;
};
export function resultFrames(result: CapturedResult, chunkBytes = 4 * 1024 * 1024) {
  decodeAuthoritativeResult(result);
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1024 || chunkBytes > 4 * 1024 * 1024)
    throw new Error('warehouse-result-chunk-size-invalid');
  const bytes = Buffer.from(result.payload),
    parts = Math.ceil(bytes.length / chunkBytes);
  if (parts < 1 || parts > 1024) throw new Error('warehouse-result-chunk-count-invalid');
  return Array.from({ length: parts }, (_, part) => {
    const chunk = bytes.subarray(part * chunkBytes, (part + 1) * chunkBytes);
    return JSON.stringify({
      format: 'authority-frame-v1',
      sequence: result.sequence,
      operationId: result.operation_id,
      digest: result.digest,
      part,
      parts,
      chunkDigest: createHash('sha256').update(chunk).digest('hex'),
      data: chunk.toString('base64'),
    } satisfies Frame);
  });
}
export function assembleResultFrames(
  expected: Pick<CapturedResult, 'sequence' | 'operation_id' | 'digest'>,
  messages: string[],
) {
  if (!messages.length || messages.length > 1024)
    throw new Error('warehouse-result-frame-count-invalid');
  const chunks: Buffer[] = [];
  for (let i = 0; i < messages.length; i++) {
    const f = JSON.parse(messages[i]) as Frame;
    if (
      f.format !== 'authority-frame-v1' ||
      f.sequence !== expected.sequence ||
      f.operationId !== expected.operation_id ||
      f.digest !== expected.digest ||
      f.parts !== messages.length ||
      f.part !== i ||
      typeof f.data !== 'string'
    )
      throw new Error('warehouse-result-frame-mismatch');
    const chunk = Buffer.from(f.data, 'base64');
    if (
      chunk.toString('base64') !== f.data ||
      createHash('sha256').update(chunk).digest('hex') !== f.chunkDigest
    )
      throw new Error('warehouse-result-frame-corrupt');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== expected.digest)
    throw new Error('warehouse-result-payload-corrupt');
  return bytes.toString('utf8');
}

type Lease = { owner: string; generation: string };
type Delivery = {
  sequence: string;
  operation_id: string;
  digest: string;
  topic_id: string;
  offsets: string[];
  chunks: number;
};
export class TransitionStream {
  private readonly replay: QueueReplayReader;
  private readonly capture: TransitionCapture;
  constructor(
    private readonly db: ControlDatabase,
    private readonly queue: WarehouseQueue,
  ) {
    this.replay = new QueueReplayReader(queue);
    this.capture = new TransitionCapture(db);
  }
  private async claim(): Promise<Lease> {
    await this.queue.assertIdentity();
    const owner = randomUUID();
    const rows = await this.db.read<{ generation: string }>(
      `UPDATE liekan_warehouse_transition
      SET owner_id=$1,generation=generation+1,lease_until=clock_timestamp()+interval '60 seconds'
      WHERE id=1 AND state IN('capturing','frozen','draining') AND topic_id=$2 AND topic_name=$3
      AND (migration_id IS NULL OR EXISTS(SELECT 1 FROM liekan_warehouse_transition_baseline b WHERE b.id=1 AND b.status='ready'))
      AND (owner_id IS NULL OR lease_until<clock_timestamp()) RETURNING generation`,
      [owner, this.queue.installation.topicId, this.queue.installation.topicName],
    );
    if (!rows.length) throw new WarehouseConflict('warehouse-result-publisher-fenced');
    return { owner, generation: rows[0].generation };
  }
  private async renew(lease: Lease) {
    const rows = await this.db.read(
      `UPDATE liekan_warehouse_transition SET lease_until=clock_timestamp()+interval '60 seconds'
      WHERE id=1 AND owner_id=$1 AND generation=$2 AND state<>'closed' AND lease_until>clock_timestamp() RETURNING id`,
      [lease.owner, lease.generation],
    );
    if (!rows.length) throw new WarehouseConflict('warehouse-result-publisher-fenced');
  }
  async publish(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('warehouse-result-publish-limit-invalid');
    const lease = await this.claim();
    let sent = 0;
    try {
      for (; sent < limit; sent++) {
        await this.renew(lease);
        const [state] = await this.db.read<{ sent_sequence: string; state: string }>(
          'SELECT sent_sequence,state FROM liekan_warehouse_transition WHERE id=1',
        );
        const [row] = await this.capture.pending(state.sent_sequence, 1);
        if (!row) break;
        if (BigInt(row.sequence) !== BigInt(state.sent_sequence) + 1n)
          throw new Error('warehouse-result-sequence-gap');
        const frames = resultFrames(row),
          offsets: string[] = [];
        for (const frame of frames) {
          await this.renew(lease);
          offsets.push(await this.queue.enqueueResultFrame(frame));
        }
        await this.db.transaction(async tx => {
          const locked = await tx.query(
            `SELECT id FROM liekan_warehouse_transition WHERE id=1 AND owner_id=$1 AND generation=$2
            AND lease_until>clock_timestamp() AND sent_sequence=$3 AND state<>'closed' FOR UPDATE`,
            [lease.owner, lease.generation, state.sent_sequence],
          );
          if (!locked.rowCount) throw new WarehouseConflict('warehouse-result-publisher-fenced');
          await tx.query(
            `INSERT INTO liekan_warehouse_transition_delivery(sequence,operation_id,digest,topic_id,offsets,chunks)
            VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
            [
              row.sequence,
              row.operation_id,
              row.digest,
              this.queue.installation.topicId,
              JSON.stringify(offsets),
              frames.length,
            ],
          );
          await tx.query(
            'UPDATE liekan_warehouse_transition SET sent_sequence=$1,updated_at=clock_timestamp() WHERE id=1',
            [row.sequence],
          );
        });
      }
      return sent;
    } finally {
      await this.db.read(
        'UPDATE liekan_warehouse_transition SET owner_id=NULL,lease_until=NULL WHERE id=1 AND owner_id=$1 AND generation=$2',
        [lease.owner, lease.generation],
      );
    }
  }
  async read(sequence: string) {
    if (!/^[1-9]\d*$/.test(sequence)) throw new Error('warehouse-result-sequence-invalid');
    await this.queue.assertIdentity();
    const [delivery] = await this.db.read<Delivery>(
      'SELECT * FROM liekan_warehouse_transition_delivery WHERE sequence=$1',
      [sequence],
    );
    if (
      !delivery ||
      delivery.topic_id !== this.queue.installation.topicId ||
      delivery.chunks !== delivery.offsets.length
    )
      throw new Error('warehouse-result-delivery-unavailable');
    const values = new Map<string, string>();
    while (values.size < delivery.offsets.length) {
      const wanted = delivery.offsets.filter(o => !values.has(o)).slice(0, 500);
      const found = await this.replay.fetch(0, wanted);
      if (!found.size) throw new Error('warehouse-result-delivery-incomplete');
      for (const [offset, message] of found) {
        if (!message.value || message.key?.toString() !== sequence)
          throw new Error('warehouse-result-delivery-mismatch');
        values.set(offset, message.value.toString());
      }
    }
    const payload = assembleResultFrames(
      delivery,
      delivery.offsets.map(o => values.get(o)),
    );
    const value = JSON.parse(payload);
    const row: CapturedResult = {
      ...delivery,
      payload,
      authority: value.authority,
      website_id: value.websiteId,
      epoch: value.epoch,
      site_version: value.siteVersion,
      kind: value.kind,
    };
    decodeAuthoritativeResult(row);
    return row;
  }
  async close() {
    await this.replay.close();
  }
}
