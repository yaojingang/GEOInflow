'use client';
import { identityUsable } from '@/lib/liekan/contracts/browser-population';
import { identityUnavailableReason } from '@/lib/liekan/contracts/population-results';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { featureRequest, downloadTrafficEvidence } from '@/lib/liekan/upstream/features-client';
import { withClientFreshness } from '@/lib/liekan/upstream/client-freshness';
import type { CrawlerIdentityScope } from '@/lib/liekan/contracts/crawler-metrics';
import { verificationReasonLabel } from '@/lib/liekan/rules/verification-labels';
import { downloadFile } from '../data';
import { Button, Notice, Panel, Select, Table } from './ui';

const identityLabels = {
  verified_range: '官方范围匹配',
  verified_dns: '官方 DNS 双向核验',
  verified_edge: '可信边缘身份核验',
  range_mismatch: '官方范围未匹配',
  unverified: '未核验',
};
const responses = ['1xx', '2xx', '3xx', '304', 'denied', 'other4xx', '5xx'];
const fieldStateLabels: Record<string, string> = {
  present: '已提供',
  missing: '字段缺失',
  unsupported: '来源不支持',
  invalid: '字段无效',
  unknown: '能力未知',
  not_collected: '未采集观察行',
};
const responseLabel = (value: string) =>
  ({ denied: '拒绝类', other4xx: '其他 4xx' })[value] || value;
const reasons: Record<string, string> = {
  ambiguous_path: '路径存在编码歧义',
  browser_missing: '缺少浏览器输入',
  browser_identity_unavailable: identityUnavailableReason,
  source_coverage: '日志连续性证据不足',
  host_evidence: '缺少逐条请求主机依据',
  sampling_unknown: '采样比例未知',
  measurement_missing: '缺少测量依据',
  catalog_missing: '尚未导入页面目录',
  browser_host_unknown: '浏览器主机依据缺失',
  source_config_unknown: '来源配置依据不足',
  mapping_unsupported: '平台对应关系未确认',
  zero_referrals: '所选范围没有引荐会话',
};
export function TrafficEvidencePanel({
  websiteId,
  hostname,
  range,
  botId,
  path,
  onIdentityScope,
  identityScope = 'all',
  mode = 'evidence',
}: {
  websiteId: string;
  hostname: string;
  range: { startAt: number; endAt: number; timezone: string };
  botId?: string;
  path?: string;
  onIdentityScope?: (scope: CrawlerIdentityScope) => void;
  identityScope?: CrawlerIdentityScope;
  mode?: 'evidence' | 'reconciliation' | 'performance' | 'outcomes' | 'observations';
}) {
  const i18n = useLiekanI18n();
  const [catalogReadId] = useState(() => crypto.randomUUID());
  const [sourceId, setSourceId] = useState(''),
    [sources, setSources] = useState<any[]>([]),
    [response, setResponse] = useState<{ key: string; data: any } | null>(null);
  const [page, setPage] = useState(1),
    [reasonsPage, setReasonsPage] = useState(1),
    [fieldCoveragePage, setFieldCoveragePage] = useState(1),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [exportMessage, setExportMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const snapshot = useRef<string>(undefined);
  const [subset, setSubset] = useState('raw');
  const [observationWindow, setObservationWindow] = useState<{
    startAt: number;
    endAt: number;
  } | null>(null);
  const [drilldown, setDrilldown] = useState<{
    scope: CrawlerIdentityScope;
    filters: {
      responseGroup?: string;
      verificationGroup?: string;
      recognitionGroup?: string;
      population?: string;
    };
  } | null>(null);
  const detail = drilldown?.scope === identityScope ? drilldown.filters : null;
  useEffect(() => {
    setDrilldown(current => (current?.scope === identityScope ? current : null));
  }, [identityScope]);
  const fixed = useMemo(() => {
    const endAt = Math.min(range.endAt, Date.now());
    return {
      startAt: Math.max(range.startAt, endAt - 90 * 86400000),
      endAt,
      timezone: range.timezone,
    };
  }, [range.startAt, range.endAt, range.timezone, revision]);
  const needsSource = mode === 'reconciliation' || mode === 'performance' || mode === 'outcomes';
  const base = `/liekan/websites/${websiteId}`;
  const catalogScope = JSON.stringify([catalogReadId, websiteId, fixed, revision]);
  const endpoint =
    mode === 'reconciliation' || mode === 'observations'
      ? `${base}/traffic-quality/${mode}`
      : `${base}/crawler-analysis/${mode}`;
  const query =
    mode === 'observations'
      ? { ...observationWindow, timezone: fixed.timezone, subset, crawlerMetricsVersion: 1 }
      : {
          ...fixed,
          path,
          sourceId: sourceId || undefined,
          ...(mode === 'reconciliation'
            ? { hostname: sources.find(source => source.id === sourceId)?.domain || hostname }
            : {
                crawlerIdentityScope:
                  detail?.recognitionGroup === 'ambiguous' ? 'all' : identityScope,
                ...(botId && detail?.recognitionGroup !== 'ambiguous'
                  ? botId.startsWith('custom:')
                    ? { botName: botId.slice(7) }
                    : { botId }
                  : {}),
                ...(detail ? { view: 'requests', ...detail } : {}),
              }),
          crawlerMetricsVersion: 1,
        };
  const conditions = JSON.stringify(query);
  const requestKey = JSON.stringify([endpoint, conditions]);
  const result = response?.key === requestKey ? response.data : null;
  useEffect(() => {
    snapshot.current = undefined;
    setPage(1);
    setReasonsPage(1);
    setFieldCoveragePage(1);
    setResponse(null);
  }, [requestKey]);
  useEffect(() => {
    if (mode === 'observations') return;
    const abort = new AbortController();
    withClientFreshness(
      abort.signal,
      () =>
        featureRequest<any>(
          'GET',
          `${base}/crawler-analysis/evidence`,
          { ...fixed, crawlerMetricsVersion: 1 },
          abort.signal,
        ),
      { catalogScope },
    )
      .then(data => {
        if (abort.signal.aborted) return;
        setSources(data.meta.sources);
        if (needsSource)
          setSourceId(
            current =>
              current ||
              (data.meta.sources.length === 1
                ? data.meta.sources[0].id
                : data.meta.sources.length === 0
                  ? 'manual'
                  : ''),
          );
      })
      .catch(e => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [base, fixed, needsSource, mode, catalogScope]);
  useEffect(() => {
    if (needsSource && !sourceId) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError('');
    withClientFreshness(
      abort.signal,
      () =>
        featureRequest<any>(
          'GET',
          endpoint,
          {
            ...JSON.parse(conditions),
            page,
            ...(['outcomes', 'performance'].includes(mode) ? { reasonsPage } : {}),
            ...(mode === 'performance' ? { fieldCoveragePage } : {}),
            snapshot: snapshot.current,
          },
          abort.signal,
        ),
      { catalogScope },
    )
      .then(data => {
        if (abort.signal.aborted) return;
        if (mode === 'observations' && !observationWindow)
          setObservationWindow({
            startAt: data.meta.conditions.startAt,
            endAt: data.meta.conditions.endAt,
          });
        snapshot.current = data.meta.snapshot;
        setResponse({ key: requestKey, data });
        if (data.meta.reset) {
          setPage(1);
          setReasonsPage(1);
          setFieldCoveragePage(1);
        }
      })
      .catch(e => {
        if (!abort.signal.aborted) {
          setError(e.message);
          setResponse(null);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [
    conditions,
    endpoint,
    requestKey,
    page,
    reasonsPage,
    fieldCoveragePage,
    needsSource,
    sourceId,
    revision,
    catalogScope,
  ]);
  const identityUnavailable =
    result &&
    (!identityUsable(result.meta.browserPopulation) ||
      ['partial', 'unavailable'].includes(result.meta.observationIdentity?.status));
  const number = (value: unknown) =>
    value == null
      ? identityUnavailable
        ? '—'
        : i18n.text('未提供')
      : typeof value === 'number'
        ? value.toLocaleString(i18n.locale)
        : String(value);
  const exportCsv = async () => {
    setBusy(true);
    setError('');
    try {
      const exported = await downloadTrafficEvidence(
        mode === 'reconciliation' || mode === 'observations'
          ? `${base}/traffic-quality/export-evidence`
          : `${base}/crawler-analysis/export`,
        {
          kind: mode,
          query: JSON.parse(conditions),
          locale: i18n.locale,
          viewSnapshot: result.meta.snapshot,
          policySnapshot: result.meta.policySnapshot,
        },
        undefined,
        result.meta.registryVersion,
      );
      downloadFile(exported.csv, `liekan-${mode}.csv`);
      setExportMessage(
        `${i18n.text('导出读取时间')}：${exported.readAt || '—'} · ${i18n.text(exported.changed === 'true' ? '按导出时数据生成' : '页面数据未变化')}`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const matrix = ['verified_range', 'verified_dns', 'verified_edge', 'range_mismatch', 'unverified']
    .filter(identity => identityScope === 'all' || identity === identityScope)
    .map(identity => [
      i18n.text(identityLabels[identity]),
      ...responses.map(response => (
        <button
          type="button"
          onClick={() => {
            snapshot.current = undefined;
            setPage(1);
            setReasonsPage(1);
            setFieldCoveragePage(1);
            setDrilldown({
              scope: identityScope,
              filters: { responseGroup: response, verificationGroup: identity },
            });
          }}
          aria-label={`${i18n.text(identityLabels[identity])} ${response}`}
        >
          {number(
            result?.rows?.find(row => row.identity === identity && row.response === response)
              ?.requests ?? 0,
          )}
        </button>
      )),
    ]);
  return (
    <Panel
      title={i18n.text(
        {
          evidence: '身份与响应',
          reconciliation: '采集对账',
          performance: '资源与性能',
          outcomes: '业务效果',
          observations: '观察证据',
        }[mode],
      )}
      actions={
        <>
          <Button
            onClick={() => {
              snapshot.current = undefined;
              setPage(1);
              setReasonsPage(1);
              setFieldCoveragePage(1);
              setObservationWindow(null);
              setRevision(value => value + 1);
            }}
            disabled={loading}
          >
            {i18n.text('重新读取')}
          </Button>
          <Button onClick={exportCsv} disabled={busy || loading || !result}>
            {i18n.text('导出 CSV')}
          </Button>
        </>
      }
    >
      <div className="panel-body">
        {mode === 'observations' ? (
          <Select
            label={i18n.text('观察总体')}
            value={subset}
            onChange={event => setSubset(event.target.value)}
            options={[
              ['raw', i18n.text('原始公共采集 PV')],
              ['eligible', i18n.text('当前质量策略纳入的 PV')],
            ]}
          />
        ) : (
          <Select
            label={i18n.text('日志来源')}
            value={sourceId}
            onChange={event => {
              snapshot.current = undefined;
              setPage(1);
              setReasonsPage(1);
              setFieldCoveragePage(1);
              setSourceId(event.target.value);
            }}
            options={[
              [needsSource ? '' : '', i18n.text(needsSource ? '请选择一个来源' : '全部日志来源')],
              ...sources.map(
                source =>
                  [
                    source.id,
                    `${source.domain} · ${source.kind === 'server' ? i18n.text('服务器日志') : 'Cloudflare'}`,
                  ] as [string, string],
              ),
              ['manual', i18n.text('手动导入与历史来源')],
            ]}
          />
        )}
        {needsSource && !sourceId && <Notice>{i18n.text('请选择一个日志来源后读取统计。')}</Notice>}
        {loading && <Notice>{i18n.text('正在读取')}</Notice>}
        {error && <Notice tone="red">{i18n.system(error)}</Notice>}
        {exportMessage && <Notice>{exportMessage}</Notice>}
        {result && !loading && (
          <>
            {identityUnavailable && (
              <Notice tone="amber">{i18n.text(identityUnavailableReason)}</Notice>
            )}
            <p className="muted">
              {new Intl.DateTimeFormat(i18n.locale, {
                timeZone: fixed.timezone,
                dateStyle: 'short',
                timeStyle: 'short',
              }).format(new Date(result.meta.readAt))}{' '}
              ·{' '}
              {i18n.text(
                mode === 'observations'
                  ? result.state === 'available'
                    ? '已接收公共 PV 的观察记录齐全'
                    : '观察记录存在缺失或尚未积累'
                  : result.meta.quality.state === 'complete'
                    ? '观测窗口覆盖已确认'
                    : '当前为已观测数据，完整性尚未确认',
              )}
            </p>
            {result.meta.reset && <Notice>{i18n.text('窗口内数据已变化，已回到第一页。')}</Notice>}
            {mode === 'evidence' && !detail && (
              <>
                <Table
                  columns={[
                    i18n.text('身份'),
                    '1xx',
                    '2xx',
                    '3xx',
                    '304',
                    i18n.text('拒绝类'),
                    i18n.text('其他 4xx'),
                    '5xx',
                  ]}
                  rows={matrix}
                  numeric={[1, 2, 3, 4, 5, 6, 7]}
                  static={[0, 1, 2, 3, 4, 5, 6, 7]}
                />
                <p>
                  {i18n.text('所选请求')} {number(result.totals.requests)} · GET 2xx{' '}
                  {number(result.totals.get2xx)} · HEAD {number(result.totals.head)} · 204/205{' '}
                  {number(result.totals.getNoBody)} · 206 {number(result.totals.getPartial)}
                </p>
                <p>
                  {i18n.text('目录 GET 2xx 响应覆盖')}{' '}
                  {result.coverage.value == null
                    ? i18n.text('未提供')
                    : `${(result.coverage.value * 100).toFixed(1)}%`}{' '}
                  ({number(result.coverage.sampleCount)}/{number(result.coverage.populationCount)})
                </p>
                <p>
                  401: {number(result.totals.status401)} · 403: {number(result.totals.status403)} ·
                  429: {number(result.totals.status429)} · 451: {number(result.totals.status451)}
                </p>
                <p>
                  {i18n.text('有终止规则依据的阻断')} {number(result.totals.ownedTerminatingBlocks)}{' '}
                  · {i18n.text('规则匹配记录')} {number(result.totals.ownedMatches)}
                </p>
                <details>
                  <summary>{i18n.text('身份核验理由')}</summary>
                  <Table
                    columns={[i18n.text('理由'), i18n.text('请求数')]}
                    rows={result.reasons.map(row => [
                      i18n.system(verificationReasonLabel(row.reason)),
                      number(row.requests),
                    ])}
                  />
                </details>
                <Notice>
                  {i18n.text(
                    'GET 2xx 表示响应结果，204/205 可能没有正文，206 为分段响应；这些指标不能证明收录或引用。',
                  )}
                </Notice>
                {result.ambiguousRequests > 0 && (
                  <Notice>
                    {i18n.text('请求声明的名称存在歧义')} · {number(result.ambiguousRequests)} ·{' '}
                    <Button
                      onClick={() => {
                        setDrilldown({
                          scope: identityScope,
                          filters: { recognitionGroup: 'ambiguous', population: 'all_logs' },
                        });
                        setPage(1);
                        setReasonsPage(1);
                        setFieldCoveragePage(1);
                        snapshot.current = undefined;
                      }}
                    >
                      {i18n.text('查看未知／未分类请求日志')}
                    </Button>
                  </Notice>
                )}
                {result.outsideScope.length > 0 && (
                  <details>
                    <summary>{i18n.text('范围外参考')}</summary>
                    <Table
                      columns={[i18n.text('身份'), i18n.text('响应'), i18n.text('请求数')]}
                      rows={result.outsideScope.map(row => [
                        i18n.text(identityLabels[row.identity]),
                        i18n.system(responseLabel(row.response)),
                        <Button
                          onClick={() => {
                            onIdentityScope?.('all');
                            setDrilldown({
                              scope: 'all',
                              filters: {
                                responseGroup: row.response,
                                verificationGroup: row.identity,
                              },
                            });
                            setPage(1);
                            setReasonsPage(1);
                            setFieldCoveragePage(1);
                            snapshot.current = undefined;
                          }}
                        >
                          {number(row.requests)} · {i18n.text('切换到全部声明查看')}
                        </Button>,
                      ])}
                      numeric={[2]}
                    />
                  </details>
                )}
              </>
            )}
            {mode === 'evidence' && detail && (
              <>
                <Button
                  onClick={() => {
                    setDrilldown(null);
                    setPage(1);
                    setReasonsPage(1);
                    setFieldCoveragePage(1);
                    snapshot.current = undefined;
                  }}
                >
                  {i18n.text('返回身份矩阵')}
                </Button>
                <Table
                  columns={[
                    i18n.text('时间'),
                    i18n.text('页面路径'),
                    i18n.text('请求方式'),
                    i18n.text('响应'),
                    i18n.text('蜘蛛'),
                  ]}
                  rows={result.rows.map(row => [
                    row.time,
                    row.path,
                    row.method,
                    row.status,
                    row.bot,
                  ])}
                  page={result.meta.page}
                  pages={Math.ceil(result.meta.total / 20)}
                  onPage={setPage}
                />
              </>
            )}
            {mode === 'reconciliation' && (
              <>
                <Notice>
                  {i18n.text(
                    '人类候选请求包含未识别身份。差额可能受到缓存、SPA 路由、脚本拦截和日志缺口影响。',
                  )}
                </Notice>
                {result.reasonCode && (
                  <Notice>{i18n.text(reasons[result.reasonCode] || '证据不足')}</Notice>
                )}
                <Table
                  columns={[
                    i18n.text('页面路径'),
                    'GET 2xx',
                    i18n.text('蜘蛛请求'),
                    i18n.text('人类候选请求'),
                    i18n.text('已确认 HTML'),
                    i18n.text('内容类型覆盖率'),
                    'PV',
                    'UV',
                    i18n.text('会话'),
                    i18n.text('差额'),
                  ]}
                  rows={result.rows.map(row => [
                    row.encodedPaths.join(' / '),
                    number(row.get2xx),
                    number(row.crawler),
                    number(row.candidate),
                    number(row.confirmedHtml),
                    row.contentType.coverage === null
                      ? i18n.text('未提供')
                      : `${(row.contentType.coverage * 100).toFixed(1)}%`,
                    number(row.pv),
                    number(row.uv),
                    number(row.visits),
                    row.difference.value == null
                      ? i18n.text(reasons[row.difference.reasonCode] || '不可比较')
                      : number(row.difference.value),
                  ])}
                  numeric={[1, 2, 3, 4, 5, 6]}
                  page={result.meta.page}
                  pages={Math.ceil(result.meta.total / 20)}
                  onPage={setPage}
                />
              </>
            )}
            {mode === 'observations' && (
              <>
                <Notice>
                  {i18n.text(
                    '采集请求上下文仅供观察，字段缺失不会改变人类流量过滤。统计按接收时间展示最近 7 个完整自然日。',
                  )}
                </Notice>
                <p>
                  {i18n.text('原始或纳入子集 PV')} {number(result.totals.pv)} ·{' '}
                  {i18n.text('已观察')} {number(result.totals.observed)} ·{' '}
                  {i18n.text('未采集观察行')} {number(result.totals.notCollected)}
                </p>
                <Table
                  columns={[
                    i18n.text('字段'),
                    i18n.text('有效样本'),
                    i18n.text('总体'),
                    i18n.text('覆盖率'),
                  ]}
                  rows={Object.entries(result.coverage).map(([field, value]: [string, any]) => [
                    field,
                    number(value.sampleCount),
                    number(value.populationCount),
                    value.coverage === null
                      ? i18n.text('未提供')
                      : `${(value.coverage * 100).toFixed(1)}%`,
                  ])}
                />
                <Table
                  columns={[
                    i18n.text('浏览器'),
                    i18n.text('上报来源'),
                    i18n.text('质量分类'),
                    i18n.text('请求特征'),
                    'PV',
                    'UV',
                    i18n.text('样本说明'),
                  ]}
                  rows={result.rows.map(row => [
                    row.browser,
                    i18n.system(row.source),
                    i18n.system(row.classification),
                    row.features
                      ? Object.entries(row.features)
                          .map(
                            ([key, value]: [string, any]) =>
                              `${key}: ${i18n.system(fieldStateLabels[value.state] || '未知')} ${Array.isArray(value.values) ? value.values.join(' / ') : ''}`,
                          )
                          .join(' · ')
                      : i18n.text('未采集观察行'),
                    row.pv,
                    number(row.uv),
                    i18n.text(row.smallSample ? '小样本' : '已观测'),
                  ])}
                  page={result.meta.page}
                  pages={Math.ceil(result.meta.total / 20)}
                  onPage={setPage}
                />
                <p>
                  {i18n.text('与既有行为观察重叠的 PV / UV')} {number(result.totals.flaggedPv)} /{' '}
                  {number(result.totals.flaggedUv)}
                </p>
                <Notice>
                  {i18n.text(
                    'Accept 标签可以重叠，分类 UV 不相加；缺少整条观察记录与请求头缺失分别统计。',
                  )}
                </Notice>
                {result.meta.observationState && (
                  <p>
                    {i18n.text('首次观察时间')} {result.meta.observationState.firstReceivedAt}
                  </p>
                )}
                {result.meta.historicalReception === 'unknown' && (
                  <Notice>{i18n.text('接收时间未知的历史记录不归入观察窗口。')}</Notice>
                )}
              </>
            )}
            {mode === 'outcomes' && (
              <>
                <Notice>
                  {i18n.text(
                    '抓取按所选蜘蛛范围计算，引荐按所属平台计算；两者是平台级并列关系，不能证明因果。',
                  )}
                </Notice>
                <Table
                  columns={[
                    i18n.text('平台'),
                    i18n.text('请求数'),
                    'GET 2xx',
                    i18n.text('目录响应页'),
                    i18n.text('引荐会话'),
                    i18n.text('转化会话'),
                    i18n.text('目标事件'),
                    i18n.text('会话转化率'),
                  ]}
                  {...(result.meta.sectionPages?.reasons
                    ? {
                        page: result.meta.sectionPages.reasons.page,
                        pages: Math.ceil(
                          result.meta.sectionPages.reasons.total /
                            result.meta.sectionPages.reasons.pageSize,
                        ),
                        onPage: setReasonsPage,
                      }
                    : {})}
                  rows={result.reasons.map(row => [
                    row.platformId,
                    number(row.requests),
                    number(row.get2xx),
                    number(row.catalogPaths),
                    number(row.visits),
                    number(row.conversions),
                    number(row.goalEvents),
                    row.conversionRate === null
                      ? i18n.text('未提供')
                      : `${(row.conversionRate * 100).toFixed(1)}%`,
                  ])}
                />
                <Table
                  columns={[
                    i18n.text('平台'),
                    i18n.text('落地页'),
                    i18n.text('请求数'),
                    i18n.text('引荐会话'),
                    i18n.text('转化会话'),
                    i18n.text('每引荐会话对应的观测抓取请求数'),
                  ]}
                  rows={result.rows.map(row => [
                    row.platformId,
                    row.path,
                    number(row.requests),
                    number(row.visits),
                    number(row.conversions),
                    row.ratio.value === null
                      ? i18n.text(reasons[row.ratio.reasonCode] || '不可比较')
                      : number(row.ratio.value),
                  ])}
                  page={result.meta.page}
                  pages={Math.ceil(result.meta.total / 20)}
                  onPage={setPage}
                />
              </>
            )}
            {mode === 'performance' && (
              <>
                <Notice>
                  {i18n.text(
                    '字节按单位分别计算。峰值为完整 UTC 分钟内的已观测值，字段覆盖不足时表示下界。',
                  )}
                </Notice>
                <Table
                  columns={[
                    i18n.text('字节单位'),
                    i18n.text('已观测字节小计'),
                    i18n.text('有效样本'),
                    i18n.text('请求数'),
                    i18n.text('峰值分钟字节'),
                  ]}
                  rows={result.rows.map(row => [
                    i18n.text(
                      {
                        edge_body: '边缘响应正文',
                        combined_response: '日志响应字节',
                        unknown: '单位未知',
                      }[row.unit] || '单位未知',
                    ),
                    number(row.observedBytes),
                    number(row.samples),
                    number(row.requests),
                    number(row.peakMinuteBytes),
                  ])}
                />
                <p>
                  {i18n.text('观测峰值 RPM')} {number(result.totals.rpm)} ·{' '}
                  {i18n.text('峰值分钟内平均 RPS')} {number(result.totals.peakMinuteAverageRps)} ·{' '}
                  {i18n.text('不完整分钟请求数')} {number(result.totals.incompleteMinuteRequests)}
                </p>
                <Table
                  columns={[
                    i18n.text('指标'),
                    i18n.text('数值'),
                    i18n.text('有效样本'),
                    i18n.text('总体'),
                  ]}
                  rows={Object.entries(result.coverage).map(([key, value]: [string, any]) => [
                    i18n.text(
                      {
                        edgeP50: '边缘完整响应 P50（ms）',
                        edgeP95: '边缘完整响应 P95（ms）',
                        originP50: '上游响应 P50（ms）',
                        originP95: '上游响应 P95（ms）',
                        cacheHitRatio: '已知缓存状态中的命中占比',
                      }[key],
                    ),
                    number(value.value),
                    number(value.sampleCount),
                    number(value.populationCount),
                  ])}
                />
                <Notice>
                  {i18n.text(
                    '耗时采用精确连续分位数；少于 20 个样本时需谨慎解释。上游耗时包含连接与路由时间，状态 0 表示未取得可归因上游响应。',
                  )}
                </Notice>
                <Table
                  columns={[i18n.text('缓存状态'), i18n.text('请求数')]}
                  {...(result.meta.sectionPages?.reasons
                    ? {
                        page: result.meta.sectionPages.reasons.page,
                        pages: Math.ceil(
                          result.meta.sectionPages.reasons.total /
                            result.meta.sectionPages.reasons.pageSize,
                        ),
                        onPage: setReasonsPage,
                      }
                    : {})}
                  rows={(result.reasons || []).map(row => [row.status, number(row.requests)])}
                />
                <details>
                  <summary>{i18n.text('边缘字段可用性与分布')}</summary>
                  <Table
                    columns={[
                      i18n.text('字段'),
                      i18n.text('状态'),
                      i18n.text('数值'),
                      i18n.text('请求数'),
                    ]}
                    {...(result.meta.sectionPages?.fieldCoverage
                      ? {
                          page: result.meta.sectionPages.fieldCoverage.page,
                          pages: Math.ceil(
                            result.meta.sectionPages.fieldCoverage.total /
                              result.meta.sectionPages.fieldCoverage.pageSize,
                          ),
                          onPage: setFieldCoveragePage,
                        }
                      : {})}
                    rows={(result.fieldCoverage || []).map(row => [
                      row.field,
                      i18n.system(fieldStateLabels[row.state] || '未知'),
                      number(row.value),
                      number(row.requests),
                    ])}
                  />
                </details>
                <Notice>
                  {i18n.text('采样和来源缺口可能改变分布；此处保留已观测样本，不外推全站总量。')}
                </Notice>
                <p>
                  {i18n.text('超限边缘 / 上游样本')} {number(result.totals.edgeOverLimit)} /{' '}
                  {number(result.totals.originOverLimit)} · {i18n.text('未取得可归因上游响应')}{' '}
                  {number(result.totals.unattributedOrigin)}
                </p>
              </>
            )}
            <p className="muted">
              {i18n.text(
                '导出按提交时数据生成，并记录读取时间；持续采集可能使数字与本次页面读取不同。',
              )}
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}
