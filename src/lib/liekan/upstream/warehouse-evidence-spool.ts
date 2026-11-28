import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { warehouseExportRoot } from '../warehouse/export-files';
import { currentCacheContext } from './cache-context';
import { LiekanError } from './errors';

export type EvidenceProducer<T> = (emit: (row: T) => Promise<void>) => Promise<void>;
const runBytes = 4 * 1024 * 1024;
const runRows = 2048;
const fanIn = 16;

/** Request-owned external sort. Limits apply to working buffers, never the
 * complete result. UUID directories share the existing crashed-export sweep. */
export class WarehouseEvidenceSpool {
  readonly directory = join(warehouseExportRoot(), randomUUID());
  private serial = 0;
  private disposed = false;
  private constructor(readonly signal?: AbortSignal) {}
  static async create(signal?: AbortSignal) {
    const spool = new WarehouseEvidenceSpool(signal);
    try {
      await mkdir(warehouseExportRoot(), { recursive: true, mode: 0o700 });
      await mkdir(spool.directory, { mode: 0o700 });
      await spool.check();
      return spool;
    } catch (error) {
      await spool.dispose();
      throw error;
    }
  }
  async check(signal = this.signal) {
    if (this.disposed) throw new Error('warehouse-evidence-spool-closed');
    if (signal?.aborted || this.signal?.aborted) throw new LiekanError('统计读取已取消', 499);
    const reauthorize = currentCacheContext()?.reauthorize;
    if (reauthorize && !(await reauthorize())) throw new LiekanError('站点访问权限已变更', 403);
    const reserve = Number(process.env.LIEKAN_EXPORT_MIN_FREE_BYTES ?? 268435456);
    if (!Number.isSafeInteger(reserve) || reserve < 0)
      throw new Error('warehouse-export-disk-reserve-invalid');
    const disk = await statfs(this.directory);
    if (disk.bavail * disk.bsize < reserve)
      throw new LiekanError('统计临时磁盘空间不足，请扩容或清理过期文件后重试', 503);
  }
  async write<T>(produce: EvidenceProducer<T>): Promise<SpoolRows<T>> {
    await this.check();
    const path = join(this.directory, `${this.serial++}.jsonl`);
    const file = await open(path, 'wx', 0o600);
    const digest = createHash('sha256');
    let buffer = '',
      bufferBytes = 0,
      count = 0;
    try {
      const flush = async () => {
        if (!buffer) return;
        await this.check();
        await file.writeFile(buffer);
        buffer = '';
        bufferBytes = 0;
      };
      await produce(async row => {
        const line = JSON.stringify(row) + '\n';
        digest.update(line);
        buffer += line;
        bufferBytes += Buffer.byteLength(line);
        count++;
        if (!Number.isSafeInteger(count)) throw new Error('warehouse-evidence-total-out-of-range');
        if (bufferBytes >= 65536) await flush();
      });
      await flush();
      return new SpoolRows(this, path, count, digest.digest('hex'));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    } finally {
      await file.close();
    }
  }
  async sort<T>(produce: EvidenceProducer<T>, compare: (a: T, b: T) => number) {
    const levels: SpoolRows<T>[][] = [];
    const append = async (run: SpoolRows<T>, level = 0): Promise<void> => {
      levels[level] ??= [];
      const entries = levels[level];
      entries.push(run);
      if (entries.length === fanIn) {
        const merged = await this.merge(entries, compare);
        entries.length = 0;
        await append(merged, level + 1);
      }
    };
    let buffer: T[] = [],
      bytes = 0;
    const flush = async () => {
      if (!buffer.length) return;
      buffer.sort(compare);
      const sorted = buffer;
      buffer = [];
      bytes = 0;
      await append(
        await this.write(async emit => {
          for (const row of sorted) await emit(row);
        }),
      );
    };
    await produce(async row => {
      bytes += Buffer.byteLength(JSON.stringify(row));
      buffer.push(row);
      if (bytes >= runBytes || buffer.length >= runRows) await flush();
    });
    await flush();
    // Carried runs contain older input than every remaining lower-level run.
    // Keep that order so equal comparator keys retain JS stable-sort semantics.
    let runs = [...levels].reverse().flat();
    if (!runs.length) return this.write<T>(async () => {});
    while (runs.length > 1) {
      const next: SpoolRows<T>[] = [];
      for (let i = 0; i < runs.length; i += fanIn)
        next.push(await this.merge(runs.slice(i, i + fanIn), compare));
      runs = next;
    }
    return runs[0];
  }
  private async merge<T>(runs: SpoolRows<T>[], compare: (a: T, b: T) => number) {
    const iterators = runs.map(run => run.iterate());
    try {
      const heads = await Promise.all(iterators.map(iterator => iterator.next()));
      const result = await this.write<T>(async emit => {
        for (;;) {
          let selected = -1;
          for (let i = 0; i < heads.length; i++)
            if (
              !heads[i].done &&
              (selected < 0 || compare(heads[i].value, heads[selected].value) < 0)
            )
              selected = i;
          if (selected < 0) break;
          await emit(heads[selected].value);
          heads[selected] = await iterators[selected].next();
        }
      });
      await Promise.all(runs.map(run => run.remove()));
      return result;
    } finally {
      await Promise.all(iterators.map(iterator => iterator.return(undefined)));
    }
  }
  async dispose() {
    this.disposed = true;
    await rm(this.directory, { recursive: true, force: true });
  }
}

export class SpoolRows<T> {
  constructor(
    readonly owner: WarehouseEvidenceSpool,
    readonly path: string,
    readonly total: number,
    private readonly hash: string,
  ) {}
  async *iterate(signal?: AbortSignal): AsyncGenerator<T> {
    await this.owner.check(signal);
    const source = createReadStream(this.path, { highWaterMark: 16384 });
    const lines = createInterface({ input: source, crlfDelay: Infinity });
    let failure: Error | undefined;
    // readline's async iterator does not forward input stream errors. Surface a
    // missing/failed spool as a failed request rather than truncated success.
    source.on('error', error => {
      failure = error;
      lines.close();
    });
    let count = 0;
    try {
      for await (const line of lines) {
        if (++count % 256 === 0) await this.owner.check(signal);
        yield JSON.parse(line) as T;
      }
      if (failure) throw failure;
    } finally {
      lines.close();
      source.destroy();
    }
  }
  async count() {
    return this.total;
  }
  async fingerprint(signal?: AbortSignal) {
    await this.owner.check(signal);
    return this.hash;
  }
  async page(offset: number, limit: number) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new Error('warehouse-evidence-page-out-of-range');
    const rows: T[] = [];
    let index = 0;
    for await (const row of this.iterate()) {
      if (index++ < offset) continue;
      rows.push(row);
      if (rows.length === limit) break;
    }
    return rows;
  }
  async stream(consume: (rows: T[]) => Promise<void>, signal?: AbortSignal) {
    let batch: T[] = [],
      bytes = 0;
    for await (const row of this.iterate(signal)) {
      batch.push(row);
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (batch.length >= 256 || bytes >= 65536) {
        await consume(batch);
        batch = [];
        bytes = 0;
      }
    }
    if (batch.length) await consume(batch);
  }
  async remove() {
    await rm(this.path, { force: true });
  }
}
