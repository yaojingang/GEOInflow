import { warehouseTransient } from '../warehouse/control-db';
import { AnalyticsRestart } from './analytics-budget';
import { readReportingMetadata } from '../warehouse/reporting-context';
import { warehouseReader } from '../warehouse/reader-runtime';
import { getBearerToken } from '@/lib/auth';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import Papa from 'papaparse';
import { safeCsvCell, sanitizeExportValue, type ExportFrame } from '../contracts/exports';
import { currentCacheContext, exportReadContext } from './cache-context';
import { LiekanError } from './errors';
import { warehouseReportMetadata, warehouseControlFingerprint } from './warehouse-report-snapshot';
import { withinWarehouseAuthority } from '../warehouse/authority-routing';
import { csvFieldLabel, csvDisplayValue } from './feature-exports';
import type { LiekanLocale } from '../i18n/locale';
import { warehouseExportCookie } from './warehouse-export-cookie';

import { warehouseExportRoot as root } from '../warehouse/export-files';
const lifetime = 24 * 60 * 60 * 1000;
export class WarehouseExportArtifact {
  readonly id = randomUUID();
  readonly directory = join(root(), this.id);
  readonly files: { name: string; rows: number; fields: string[] }[] = [];
  constructor(
    readonly site: string,
    readonly owner: string,
    readonly signal: AbortSignal,
    readonly locale?: LiekanLocale,
  ) {}
  async check() {
    if (this.signal.aborted) throw new LiekanError('导出已取消', 499);
    const reauthorize = currentCacheContext()?.reauthorize;
    if (reauthorize && !(await reauthorize())) throw new LiekanError('站点访问权限已变更', 403);
    const disk = await statfs(this.directory);
    const reserve = Number(process.env.LIEKAN_EXPORT_MIN_FREE_BYTES ?? 268435456);
    if (!Number.isSafeInteger(reserve) || reserve < 0)
      throw new Error('warehouse-export-disk-reserve-invalid');
    if (disk.bavail * disk.bsize < reserve)
      throw new LiekanError('导出临时磁盘空间不足，请扩容或清理过期文件后重试', 503);
  }
  async initialize() {
    await mkdir(root(), { recursive: true, mode: 0o700 });
    await mkdir(this.directory, { mode: 0o700 });
    await this.check();
  }
  async csv(
    name: string,
    fields: string[],
    produce: (consume: (rows: Record<string, unknown>[]) => Promise<void>) => Promise<void>,
    preamble = '',
  ) {
    const file = await open(join(this.directory, name), 'wx', 0o600),
      info = { name, rows: 0, fields };
    try {
      await file.writeFile(
        preamble +
          Papa.unparse([fields.map(k => safeCsvCell(csvFieldLabel(name, k, this.locale)))]) +
          '\r\n',
      );
      await produce(async rows => {
        await this.check();
        const safe = rows.map(row => {
          const clean: any = sanitizeExportValue(row);
          if (
            row.property &&
            /password|secret|token|key|email|phone|ip|cookie/i.test(String(row.property))
          )
            clean.value = '[已脱敏]';
          return fields.map(k =>
            safeCsvCell(
              typeof clean[k] === 'object' && clean[k] !== null
                ? JSON.stringify(clean[k])
                : csvDisplayValue(name, k, clean[k], this.locale),
            ),
          );
        });
        if (safe.length) await file.writeFile(Papa.unparse(safe) + '\r\n');
        info.rows += rows.length;
      });
      await file.sync();
      this.files.push(info);
    } finally {
      await file.close();
    }
  }
  async json(
    name: string,
    produce: (consume: (rows: Record<string, unknown>[]) => Promise<void>) => Promise<void>,
  ) {
    const file = await open(join(this.directory, name), 'wx', 0o600),
      info = { name, rows: 0, fields: [] as string[] };
    try {
      await file.writeFile('[');
      await produce(async rows => {
        await this.check();
        for (const row of rows) {
          for (const key of Object.keys(row)) if (!info.fields.includes(key)) info.fields.push(key);
          await file.writeFile((info.rows ? ',' : '') + JSON.stringify(sanitizeExportValue(row)));
          info.rows++;
        }
      });
      await file.writeFile(']');
      await file.sync();
      this.files.push(info);
    } finally {
      await file.close();
    }
  }
  async complete(
    format: 'zip' | 'csv' | 'json',
    manifest: Record<string, unknown>,
    summary?: unknown,
  ) {
    await this.check();
    const metadata = await warehouseReportMetadata(this.site),
      path = join(this.directory, 'download');
    if (format === 'zip') {
      const zip = new ZipFile();
      zip.on('error', error => (zip.outputStream as Readable).destroy(error));
      const writing = pipeline(
        zip.outputStream,
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        { signal: this.signal },
      );
      for (const file of this.files)
        zip.addFile(join(this.directory, file.name), file.name, { compressionLevel: 6 });
      zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
      zip.end();
      await writing;
    } else if (format === 'csv')
      await pipeline(
        createReadStream(join(this.directory, this.files[0].name)),
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        { signal: this.signal },
      );
    else await writeFile(path, JSON.stringify({ summary, manifest }), { flag: 'wx', mode: 0o600 });
    await this.check();
    const size = (await stat(path)).size,
      name = `liekan-export-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
    const mime =
      format === 'zip'
        ? 'application/zip'
        : format === 'csv'
          ? 'text/csv;charset=utf-8'
          : 'application/json';
    await writeFile(
      join(this.directory, 'metadata.json'),
      JSON.stringify({
        site: this.site,
        owner: this.owner,
        name,
        mime,
        size,
        expiresAt: Date.now() + lifetime,
        fingerprint: warehouseControlFingerprint(metadata),
      }),
      { flag: 'wx', mode: 0o600 },
    );
    for (const file of this.files) await rm(join(this.directory, file.name));
    return {
      type: 'file' as const,
      name,
      mime,
      size,
      manifest,
      downloadUrl: `/api/liekan/websites/${this.site}/exports/${this.id}`,
    };
  }
  async remove() {
    await rm(this.directory, { recursive: true, force: true });
  }
}

export async function downloadWarehouseExport(
  site: string,
  owner: string,
  id: string,
  signal: AbortSignal,
  reauthorize?: () => Promise<void>,
) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
    throw new LiekanError('导出文件不存在', 404);
  const folder = join(root(), id),
    metadata = await readFile(join(folder, 'metadata.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
  if (!metadata || metadata.site !== site || metadata.owner !== owner)
    throw new LiekanError('导出文件不存在', 404);
  if (metadata.expiresAt < Date.now()) throw new LiekanError('导出文件已过期，请重新生成', 410);
  if (warehouseControlFingerprint(await warehouseReportMetadata(site)) !== metadata.fingerprint)
    throw new LiekanError('数据规则已变更，请重新生成导出文件', 409);
  const source = createReadStream(join(folder, 'download'), { signal });
  const stream = Readable.from(
    (async function* () {
      let checked = 0;
      try {
        for await (const chunk of source) {
          if (Date.now() - checked >= 1000) {
            await reauthorize?.();
            const current = await readReportingMetadata(warehouseReader().db, site);
            if (warehouseControlFingerprint(current) !== metadata.fingerprint)
              throw new LiekanError('数据规则已变更，请重新生成导出文件', 409);
            checked = Date.now();
          }
          yield chunk;
        }
      } finally {
        source.destroy();
      }
    })(),
  );
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    headers: {
      'Content-Type': metadata.mime,
      'Content-Length': String(metadata.size),
      'Content-Disposition': `attachment; filename="${metadata.name}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function warehouseExportResponse(
  site: string,
  signal: AbortSignal,
  locale: LiekanLocale | undefined,
  build: (artifact: WarehouseExportArtifact) => Promise<Extract<ExportFrame, { type: 'file' }>>,
) {
  const context = currentCacheContext(),
    owner = context?.actor;
  if (!owner || (context?.scope && !(context.scope as { private?: boolean }).private))
    throw new LiekanError('导出需要登录账户', 401);
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const artifact = new WarehouseExportArtifact(site, owner, cancellation.signal, locale);
  let stopped = false;
  const encoder = new TextEncoder();
  const credential = context.request && getBearerToken(context.request);
  if (!credential) throw new LiekanError('导出需要登录账户', 401);
  const cookie = warehouseExportCookie(context.request, credential);
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (frame: ExportFrame) => {
          if (!stopped && !cancellation.signal.aborted)
            controller.enqueue(encoder.encode(JSON.stringify(frame) + '\n'));
        };
        const heartbeat = setInterval(() => {
          if ((controller.desiredSize ?? 0) > 0)
            emit({ type: 'progress', stage: '正在生成导出文件', percent: 0 });
        }, 5000);
        try {
          emit({ type: 'progress', stage: '正在生成导出文件', percent: 0 });
          await artifact.initialize();
          const frame = await exportReadContext(() =>
            withinWarehouseAuthority(() => build(artifact), undefined, true),
          );
          await artifact.check();
          emit(frame);
          emit({ type: 'complete' });
        } catch (error) {
          await artifact.remove();
          if (!cancellation.signal.aborted)
            emit({
              type: 'error',
              status:
                error instanceof LiekanError
                  ? error.status
                  : error instanceof AnalyticsRestart || warehouseTransient(error)
                    ? 503
                    : 500,
              message:
                error instanceof LiekanError
                  ? error.message
                  : error instanceof AnalyticsRestart || warehouseTransient(error)
                    ? '统计数据已更新或暂时繁忙，请重新导出'
                    : '文件生成失败，请重试',
            });
        } finally {
          clearInterval(heartbeat);
          signal.removeEventListener('abort', abort);
          if (!stopped) controller.close();
        }
      },
      cancel() {
        stopped = true;
        cancellation.abort();
      },
    }),
    {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Accel-Buffering': 'no',
        'Set-Cookie': cookie,
      },
    },
  );
}
