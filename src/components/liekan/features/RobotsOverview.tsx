'use client';
import { useEffect, useRef, useState } from 'react';
import type { CrawlerAnalysisResponse } from '@/lib/liekan/contracts/crawler-analysis';
import type { RobotsManagement } from '@/lib/liekan/contracts/robots-management';
import {
  robotsOverview,
  robotsOverviewRange,
  robotsPublicUrl,
  type RobotsOverviewRange,
} from '@/lib/liekan/contracts/robots-overview';
import { featureRequest } from '@/lib/liekan/upstream/features-client';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { Button, Definition, Notice } from './ui';

export function RobotsOverview({
  websiteId,
  data,
  range,
  onManage,
  onRead,
  busy = false,
}: {
  websiteId: string;
  data: RobotsManagement;
  range?: RobotsOverviewRange;
  onManage: () => void;
  onRead: () => void;
  busy?: boolean;
}) {
  const i18n = useLiekanI18n();
  const [analysis, setAnalysis] = useState<CrawlerAnalysisResponse | null>(null),
    [loading, setLoading] = useState(true),
    [failed, setFailed] = useState(false),
    [version, setVersion] = useState(0);
  const requested = useRef(robotsOverviewRange(range));
  useEffect(() => {
    const abort = new AbortController();
    let alive = true;
    setLoading(true);
    setFailed(false);
    setAnalysis(null);
    featureRequest<CrawlerAnalysisResponse>(
      'GET',
      `/liekan/websites/${websiteId}/crawler-analysis`,
      requested.current,
      abort.signal,
    )
      .then(result => {
        if (alive) setAnalysis(result);
      })
      .catch(() => {
        if (alive) setFailed(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      abort.abort();
    };
  }, [websiteId, version]);
  const summary = robotsOverview(data, analysis),
    period = analysis?.range || requested.current;
  const date = (value: string | number | null) =>
    value === null
      ? i18n.text('尚未检查')
      : new Date(value).toLocaleString(i18n.locale, { timeZone: period.timezone });
  const value = (number: number | null) =>
    number === null ? i18n.text('暂无数据') : number.toLocaleString(i18n.locale);
  const address = robotsPublicUrl(data.hostname);
  return (
    <section className="form-stack" aria-label={i18n.text('robots.txt 概览与建议')}>
      <h3>{i18n.text('当前 robots.txt 概览')}</h3>
      <Definition
        items={[
          [
            i18n.text('公开访问地址'),
            <a
              key="public-address"
              href={address}
              target="_blank"
              rel="noopener noreferrer"
              style={{ overflowWrap: 'anywhere' }}
            >
              {address}
            </a>,
          ],
          [
            i18n.text('服务器文件路径'),
            (data.agent.connected && data.agent.contextValid && data.agent.path) ||
              i18n.text('完成服务器授权后显示实际路径'),
          ],
          [
            i18n.text('线上文件状态'),
            i18n.system(
              {
                not_checked: '尚未读取当前网站文件',
                missing: '文件不存在（404）',
                available: '已读取线上快照',
                unsupported: '文件内容需人工核对',
              }[summary.fileState],
            ),
          ],
          [
            i18n.text('最近成功检查'),
            date(data.observedHostname === data.hostname ? data.checkedAt : null),
          ],
          [
            i18n.text('规则摘要'),
            summary.groups === null
              ? i18n.text('读取线上文件后显示规则摘要')
              : i18n.text('{v0} 个蜘蛛分组 · {v1} 条 Allow · {v2} 条 Disallow', [
                  value(summary.groups),
                  value(summary.allowRules),
                  value(summary.disallowRules),
                ]),
          ],
          [
            i18n.text('定时监控'),
            i18n.text(data.monitor ? '已启用，每 {v0} 分钟检查' : '尚未启用', [data.interval]),
          ],
        ]}
      />
      {data.changePending && (
        <Notice tone="amber">{i18n.text('监控发现文件变更，请在管理页核对快照。')}</Notice>
      )}
      <div className="form-actions">
        <Button disabled={busy || !data.permissions.canDraft} onClick={onRead}>
          {i18n.text('读取线上 robots.txt')}
        </Button>
        <Button onClick={onManage}>{i18n.text('管理当前 robots.txt')}</Button>
      </div>
      {summary.fileState === 'available' && (
        <details>
          <summary>{i18n.text('查看实际文件快照')}</summary>
          <pre
            className="code-block"
            style={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              maxHeight: 240,
              overflow: 'auto',
            }}
          >
            {data.observedContent}
          </pre>
        </details>
      )}
      <h3>{i18n.text('结合网站数据的建议')}</h3>
      <p className="muted">
        {i18n.text('统计范围：{v0} 至 {v1}', [date(period.startAt), date(period.endAt)])}
      </p>
      {range && range.startAt < requested.current.startAt && (
        <p className="muted">
          {i18n.text('建议最多对照最近 90 天的数据，以上显示本次实际统计范围。')}
        </p>
      )}
      {analysis && (
        <Definition
          items={[
            [i18n.text('已记录蜘蛛请求'), value(summary.requests)],
            [i18n.text('403 / 429 响应'), value(summary.denied)],
            [
              i18n.text('日志覆盖质量'),
              i18n.system(
                {
                  complete: '覆盖已确认',
                  partial: '存在已知缺口',
                  unknown: '连续性未知',
                  missing: '缺少日志输入',
                  unsupported: '当前来源不支持',
                }[analysis.quality.state],
              ),
            ],
            [i18n.text('统计读取时间'), date(analysis.generatedAt)],
          ]}
        />
      )}
      {loading && <p role="status">{i18n.text('正在读取当前网站统计建议…')}</p>}
      {failed && <Notice tone="amber">{i18n.text('统计建议暂不可用，文件管理仍可使用。')}</Notice>}
      <div className="form-actions">
        <Button disabled={loading} onClick={() => setVersion(v => v + 1)}>
          {i18n.text('重新读取统计建议')}
        </Button>
      </div>
      <ul style={{ paddingLeft: 20, display: 'grid', gap: 12 }}>
        {summary.advice.map(item => (
          <li key={item.id}>
            <strong>{i18n.system(item.title)}</strong>
            <p>{i18n.text(item.detail, item.values)}</p>
          </li>
        ))}
      </ul>
      {!!summary.samples.length && (
        <details>
          <summary>{i18n.text('查看规则与日志抽样依据')}</summary>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  {['蜘蛛', '路径', '当前规则', '请求数', '403 / 429'].map(label => (
                    <th key={label}>{i18n.system(label)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.samples.map((row, index) => (
                  <tr key={`${row.bot}:${row.path}:${index}`}>
                    <td>{row.bot}</td>
                    <td style={{ overflowWrap: 'anywhere' }}>{row.path}</td>
                    <td>{i18n.text(row.allowed ? '允许' : '禁止')}</td>
                    <td>{row.requests}</td>
                    <td>{row.denied}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <p className="muted">
        {i18n.text(
          '建议依据当前文件快照与所选期间日志对照生成。历史请求可能早于规则发布；调整后仍需验证公开响应和实际抓取。',
        )}
      </p>
    </section>
  );
}
