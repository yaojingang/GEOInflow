'use client';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';

import { useEffect, useRef, useState } from 'react';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import {
  EXPORT_MAX_BYTES,
  exportSections,
  type ExportFrame,
  type ExportRequest,
} from '@/lib/liekan/contracts/exports';
import { streamFeatureExport } from '@/lib/liekan/upstream/features-client';
import { numberLabel } from '@/lib/liekan/contracts/features';
import { websiteMatchesHandle } from '@/lib/liekan/website-handle';
import { useFeature } from './context';
import {
  Badge,
  Body,
  Button,
  Check,
  Code,
  Definition,
  LiekanDialog,
  Field,
  Form,
  Icon,
  Notice,
  Panel,
  Select,
} from './ui';

export function Exports() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  // 选项值用站点 UUID，而 c.siteId 携带 URL 里的短编号或 UUID；
  // 先换算成对应站点的 id，短编号入口才能命中默认选项。
  const currentSite = c.sites.find(site => websiteMatchesHandle(site, c.siteId));
  const [format, setFormat] = useState<ExportRequest['format']>('zip');
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState({ stage: '正在查询所选数据', percent: 0 });
  const [error, setError] = useState('');
  const [file, setFile] = useState<{ url: string; name: string; manifest: any } | null>(null);
  const [manifestOpen, setManifestOpen] = useState(false);
  const controller = useRef<AbortController | null>(null),
    generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  useEffect(
    () => () => {
      if (file) URL.revokeObjectURL(file.url);
    },
    [file],
  );
  const cancel = () => {
    generation.current++;
    controller.current?.abort();
    setStatus('idle');
    setError('导出已取消，可以重新选择范围。');
  };
  return (
    <div className="wide-narrow">
      <Panel
        title={i18n.text('创建导出任务')}
        subtitle={i18n.text('选择真实数据范围，文件生成与下载在本次请求内完成。')}
      >
        <Body>
          <Form
            busy={status === 'working'}
            error={i18n.system(error)}
            submitLabel={i18n.text('生成导出文件')}
            onSubmit={async (values: any) => {
              const startAt = +fromZonedTime(`${values.start}T00:00:00.000`, c.range.timezone),
                endAt = +fromZonedTime(`${values.end}T23:59:59.999`, c.range.timezone);
              if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt)
                throw new Error('日期范围无效');
              const sections =
                format === 'zip'
                  ? exportSections.filter(section => values[section] === 'on')
                  : ['summary' as const];
              if (!sections.length) throw new Error('至少选择一项数据范围');
              controller.current?.abort();
              controller.current = new AbortController();
              const run = ++generation.current;
              setFile(null);
              setError('');
              setStatus('working');
              setProgress({ stage: '正在查询并校验数据量', percent: 0 });
              const chunks: Uint8Array[] = [];
              let meta: Extract<ExportFrame, { type: 'file' }> | null = null,
                received = 0,
                complete = false;
              try {
                await streamFeatureExport(
                  values.website,
                  {
                    startAt,
                    endAt,
                    timezone: c.range.timezone,
                    format,
                    sections,
                    filters: c.filters,
                    locale: i18n.locale,
                  },
                  controller.current.signal,
                  frame => {
                    if (run !== generation.current) return;
                    if (frame.type === 'progress')
                      setProgress({ stage: frame.stage, percent: frame.percent });
                    if (frame.type === 'file') {
                      if (!frame.downloadUrl && frame.size > EXPORT_MAX_BYTES)
                        throw new Error('下载文件超过 50 MiB');
                      meta = frame;
                    }
                    if (frame.type === 'chunk') {
                      const bytes = Uint8Array.from(atob(frame.data), char => char.charCodeAt(0));
                      received += bytes.length;
                      if (received > EXPORT_MAX_BYTES) throw new Error('下载文件超过 50 MiB');
                      chunks.push(bytes);
                    }
                    if (frame.type === 'complete') complete = true;
                  },
                );
                if (run !== generation.current) return;
                const result = meta as Extract<ExportFrame, { type: 'file' }> | null;
                if (!complete || !result || (!result.downloadUrl && result.size !== received))
                  throw new Error('文件传输未完成，请重新生成');
                const blob = result.downloadUrl
                  ? null
                  : new Blob(chunks as BlobPart[], { type: result.mime });
                setFile({
                  url: result.downloadUrl || URL.createObjectURL(blob),
                  name: result.name,
                  manifest: result.manifest,
                });
                setStatus('done');
              } catch (e: any) {
                if (run !== generation.current) return;
                setError(e.name === 'AbortError' ? '导出已取消' : e.message || '导出失败');
                setStatus('idle');
              }
            }}
          >
            <Select
              label={i18n.text('导出网站')}
              name="website"
              defaultValue={currentSite?.id || c.siteId}
              options={c.sites.map(site => [site.id, site.name])}
              required
            />
            <div className="form-grid">
              <Field
                label={i18n.text('开始日期')}
                name="start"
                type="date"
                required
                defaultValue={formatInTimeZone(c.range.startAt, c.range.timezone, 'yyyy-MM-dd')}
              />
              <Field
                label={i18n.text('结束日期')}
                name="end"
                type="date"
                required
                defaultValue={formatInTimeZone(c.range.endAt, c.range.timezone, 'yyyy-MM-dd')}
              />
            </div>
            <h3>{i18n.text('数据范围')}</h3>
            <div className="two">
              {exportSections.map((section, i) => (
                <Check
                  key={section}
                  name={section}
                  defaultChecked={section !== 'sessions'}
                  disabled={format !== 'zip'}
                >
                  {
                    [
                      i18n.text('汇总指标'),
                      i18n.text('页面与来源'),
                      i18n.text('事件与属性'),
                      i18n.text('访问记录（脱敏）'),
                      i18n.text('已保存配置'),
                    ][i]
                  }
                </Check>
              ))}
            </div>
            <Select
              label={i18n.text('文件格式')}
              name="format"
              value={format}
              onChange={e => setFormat(e.target.value as ExportRequest['format'])}
              options={[
                ['zip', i18n.text('ZIP：CSV 与字段清单')],
                ['csv', i18n.text('CSV：汇总指标')],
                ['json', i18n.text('JSON：汇总与字段清单')],
              ]}
            />
            <Notice tone="amber">
              {i18n.text(
                'CSV 与 JSON 使用汇总范围；ZIP 按勾选项导出。文件生成后开始下载，不包含原始 IP 或账户凭据。',
              )}
            </Notice>
          </Form>
        </Body>
      </Panel>
      <Panel title={i18n.text('导出任务')} subtitle={i18n.text('显示当前请求的生成与传输状态。')}>
        <Body>
          {status === 'idle' ? (
            <div className="state-box" style={{ border: 0, padding: '24px 0' }}>
              <h3>{i18n.text('还没有导出任务')}</h3>
              <p>{i18n.text('左侧选择范围并生成文件。')}</p>
            </div>
          ) : status === 'working' ? (
            <div className="stack">
              <div className="row between">
                <strong>{i18n.system(progress.stage)}</strong>
                <span className="num">{progress.percent}%</span>
              </div>
              <div className="progress">
                <i style={{ width: `${progress.percent}%` }} />
              </div>
              <p className="muted">{i18n.text('校验范围 → 整理字段 → 生成文件 → 传输下载')}</p>
              <Button onClick={cancel}>{i18n.text('取消导出')}</Button>
            </div>
          ) : (
            file && (
              <div className="stack">
                <Badge tone="green">{i18n.text('文件已就绪')}</Badge>
                <Definition
                  items={[
                    [i18n.text('网站'), file.manifest.website.name],
                    [
                      i18n.text('范围'),
                      i18n.text('{v0} 至 {v1}', [
                        formatInTimeZone(
                          file.manifest.range.startAt,
                          c.range.timezone,
                          'yyyy-MM-dd',
                        ),
                        formatInTimeZone(file.manifest.range.endAt, c.range.timezone, 'yyyy-MM-dd'),
                      ]),
                    ],
                    [i18n.text('格式'), file.manifest.format.toUpperCase()],
                    [i18n.text('敏感字段'), i18n.text('不包含原始 IP 或账户凭据')],
                    [i18n.text('数据性质'), i18n.text('当前网站的真实统计数据')],
                  ]}
                />
                <a className="btn primary" href={file.url} download={file.name}>
                  <Icon name="download" />
                  {i18n.text('下载导出文件')}
                </a>
                <Button onClick={() => setManifestOpen(true)}>{i18n.text('查看字段清单')}</Button>
              </div>
            )
          )}
        </Body>
      </Panel>
      {manifestOpen && file && (
        <LiekanDialog
          size="wide"
          title={i18n.text('导出字段清单')}
          onClose={() => setManifestOpen(false)}
        >
          <div className="stack">
            <Definition
              items={[
                [
                  i18n.text('网站'),
                  file.manifest.website.name + ' · ' + file.manifest.website.domain,
                ],
                [
                  i18n.text('统计期间'),
                  i18n.text('{v0} 至 {v1}', [
                    formatInTimeZone(
                      file.manifest.range.startAt,
                      file.manifest.range.timezone,
                      'yyyy-MM-dd',
                    ),
                    formatInTimeZone(
                      file.manifest.range.endAt,
                      file.manifest.range.timezone,
                      'yyyy-MM-dd',
                    ),
                  ]),
                ],
                [i18n.text('时区'), file.manifest.range.timezone],
                [i18n.text('文件格式'), file.manifest.format.toUpperCase()],
                [
                  i18n.text('导出上限'),
                  i18n.text('{v0} 行 · {v1} MiB', [
                    numberLabel(file.manifest.limits.rows),
                    file.manifest.limits.bytes / 1024 / 1024,
                  ]),
                ],
              ]}
            />
            <Notice>{i18n.system(file.manifest.privacy)}</Notice>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{i18n.text('文件')}</th>
                    <th>{i18n.text('行数')}</th>
                    <th>{i18n.text('字段')}</th>
                  </tr>
                </thead>
                <tbody>
                  {file.manifest.files.map(entry => (
                    <tr key={entry.name}>
                      <td>{entry.name}</td>
                      <td>{numberLabel(entry.rows)}</td>
                      <td>
                        {(entry.displayFields || entry.fields).join(
                          i18n.locale === 'en-US' ? ', ' : '、',
                        ) || i18n.text('无字段')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details>
              <summary>{i18n.text('查看原始 JSON 清单')}</summary>
              <Code>{JSON.stringify(file.manifest, null, 2)}</Code>
            </details>
          </div>
        </LiekanDialog>
      )}
    </div>
  );
}
