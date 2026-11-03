import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { safeCsvCell, sanitizeExportValue } from '../contracts/exports';
import type { LiekanLocale } from '../i18n/locale';
import {
  authenticateCrawler,
  authorizeCrawler,
  type CrawlerActor,
  crawlerTransaction,
} from '../upstream/crawler-access';
import { LiekanError } from '../upstream/errors';
import {
  type WarehouseEvidenceRows,
  warehouseEvidenceRows,
  warehouseEvidenceSections,
} from '../upstream/warehouse-evidence-table';
import {
  downloadWarehouseExport,
  WarehouseExportArtifact,
} from '../upstream/warehouse-export-artifact';
import { reportEvidenceCsv } from './report-evidence';

const csv = (row: unknown[]) =>
  row
    .map(
      value =>
        '"' + String(safeCsvCell(sanitizeExportValue(value)) ?? '').replaceAll('"', '""') + '"',
    )
    .join(',') + '\r\n';

/** Preserve the existing single CSV response while generation and download use
 * bounded buffers. The private artifact is removed on completion or cancellation. */
export async function warehouseEvidenceCsv(
  result: any,
  metadata: any,
  actor: CrawlerActor,
  websiteId: string,
  kind: string,
  locale: LiekanLocale,
  request: Request,
) {
  const artifact = new WarehouseExportArtifact(websiteId, actor.id, request.signal, locale);
  const authorize = async () => {
    const current = await authenticateCrawler(request);
    if (current.id !== actor.id) throw new LiekanError('当前登录已失效', 401);
    await crawlerTransaction(tx => authorizeCrawler(tx, current, websiteId));
  };
  let checked = 0;
  const check = async () => {
    await artifact.check();
    if (Date.now() - checked >= 1000) {
      await authorize();
      checked = Date.now();
    }
  };
  try {
    await artifact.initialize();
    await authorize();
    const file = await open(join(artifact.directory, 'evidence.csv'), 'wx', 0o600);
    let written = 0;
    try {
      await file.writeFile(
        '\ufeff' +
          csv([
            locale === 'zh-CN' ? '导出说明' : 'Export metadata',
            JSON.stringify(sanitizeExportValue(metadata)),
          ]),
      );
      if (result.table) {
        let header = false;
        const consume = async (rows: any[]) => {
          await check();
          let value = reportEvidenceCsv({ ...result, rows }, locale).replace(/^\ufeff/, '');
          if (header) value = value.slice(value.indexOf('\n') + 1);
          header = true;
          if (value) await file.writeFile(value.replace(/\r?\n?$/, '') + '\r\n');
          written += rows.length;
        };
        const table = result[warehouseEvidenceRows] as WarehouseEvidenceRows | undefined;
        if (table) await table.stream(consume, request.signal);
        else await consume(result.rows);
        if (!header) await consume([]);
      } else {
        for (const [key, value] of Object.entries(result)) {
          if (key === 'meta' || key === 'outsideScope') continue;
          const table =
            key === 'rows'
              ? (result[warehouseEvidenceRows] as WarehouseEvidenceRows | undefined)
              : (result[warehouseEvidenceSections]?.[key] as WarehouseEvidenceRows | undefined);
          if (Array.isArray(value) || table) {
            let fields: string[];
            const consume = async (rows: any[]) => {
              await check();
              if (!rows.length) return;
              rows = JSON.parse(JSON.stringify(rows));
              if (!fields) {
                fields = Object.keys(rows[0]);
                await file.writeFile(csv([key, ...fields]));
              }
              await file.writeFile(
                rows
                  .map(row =>
                    csv([
                      key,
                      ...fields.map(field =>
                        typeof row[field] === 'object' && row[field] !== null
                          ? JSON.stringify(sanitizeExportValue(row[field]))
                          : row[field],
                      ),
                    ]),
                  )
                  .join(''),
              );
              written += rows.length;
            };
            if (table) await table.stream(consume, request.signal);
            else await consume(value as any[]);
          } else await file.writeFile(csv([key, JSON.stringify(sanitizeExportValue(value))]));
        }
      }
      await file.sync();
    } finally {
      await file.close();
    }
    artifact.files.push({ name: 'evidence.csv', rows: written, fields: [] });
    await artifact.complete('csv', metadata);
    await authorize();
    const response = await downloadWarehouseExport(
      websiteId,
      actor.id,
      artifact.id,
      request.signal,
      authorize,
    );
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            await artifact.remove();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
          await reader.cancel().catch(() => {});
          await artifact.remove();
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
        await artifact.remove();
      },
    });
    response.headers.set('Content-Disposition', `attachment; filename="liekan-${kind}.csv"`);
    response.headers.set('X-Liekan-Export-Read-At', metadata.exportReadAt);
    response.headers.set(
      'X-Liekan-Export-Changed',
      metadata.changed === null ? 'unknown' : String(metadata.changed),
    );
    return new Response(body, { headers: response.headers });
  } catch (error) {
    await artifact.remove();
    throw error;
  }
}
