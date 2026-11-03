'use client';
import { identityUnavailableReason } from '@/lib/liekan/contracts/population-results';
import { CrawlerWorkflow } from './CrawlerWorkflow';
import { TrafficEvidencePanel } from './TrafficEvidencePanel';
import type { CrawlerIdentityScope } from '@/lib/liekan/contracts/crawler-metrics';
import { TableCell } from './ui';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';

import { useTaskPolling } from '@/lib/liekan/contracts/manual-refresh';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { CrawlerAnalysisResponse } from '@/lib/liekan/contracts/crawler-analysis';
import { featureRequest } from '@/lib/liekan/upstream/features-client';
import { withClientFreshness } from '@/lib/liekan/upstream/client-freshness';
import { crawlerPathSchema } from '@/lib/liekan/contracts/crawlers';
import { downloadFile } from '../data';
import { pageLink } from '../PageLink';
import { Badge, Button, Definition, LiekanDialog, Notice, Select, Table, Tabs } from './ui';
import { CrawlerPoliciesPanel } from './CrawlerPoliciesPanel';
import { RobotsManagementPanel } from './RobotsManagementPanel';

const labels = {
  training: 'AI 训练',
  search: 'AI 搜索',
  user: '用户触发',
  traditional_search: '传统搜索',
  other: '其他已知蜘蛛',
};
const riskLabels = {
  access: '访问受阻',
  origin: '服务异常',
  surge: '抓取强度',
  coverage: '抓取覆盖',
  expected_access: '期望访问冲突',
  identity: '身份核验',
  sensitive_path: '敏感路径',
  observation: '观测质量',
  execution: '策略执行',
};
const confidenceLabels = { confirmed: '已证实', possible: '可能', insufficient: '证据不足' };
const gradeLabels = { high: '高', medium: '中', info: '提示' };
const evidenceLabels: Record<string, string> = {
  requests: '请求数',
  denied403429: '403 / 429',
  ratio: '比例',
  comparableWindows: '可比窗口数',
  median: '同期中位数',
  catalogPages: '共同目录页',
  baselineGets: '前期有效 GET',
  before: '前期覆盖页',
  after: '本期覆盖页',
  decline: '下降比例',
  ownedTerminatingBlocks: '本平台终止拦截',
  verifiedSearchDenied: '已核验搜索受阻',
  rangeMismatches: '范围不匹配',
  sensitivePathRequests: '敏感路径请求',
  originErrors: '源站错误',
  status5xx: '5xx',
  denied: '受阻请求',
  count: '次数',
};
const num = (value: number | null | undefined) =>
  value == null ? '待接入' : value.toLocaleString('zh-CN');
const date = (value: string | number | undefined, timezone: string) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(value))
    : '尚未计算';

export function CrawlerDialog({
  websiteId,
  websiteName,
  websiteDomain,
  botName,
  selectedIdentity,
  onClose,
  range,
  controlPanel,
  identityScope = 'all',
}: {
  identityScope?: CrawlerIdentityScope;
  websiteId: string;
  websiteName?: string;
  websiteDomain?: string;
  botName?: string;
  selectedIdentity?: string | null;
  onClose: () => void;
  range?: { startAt: number; endAt: number; timezone: string };
  controlPanel?: (permissions: CrawlerAnalysisResponse['permissions']) => ReactNode;
}) {
  const i18n = useLiekanI18n();
  const [data, setData] = useState<CrawlerAnalysisResponse | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0);
  const [tab, setTab] = useState(botName ? 'detail' : 'risk'),
    [botId, setBotId] = useState(''),
    [critical, setCritical] = useState(''),
    [status, setStatus] = useState(''),
    [domain, setDomain] = useState<any>(null),
    [checks, setChecks] = useState<any[]>([]),
    [followingCheck, setFollowingCheck] = useState(''),
    [paths, setPaths] = useState('/'),
    [busy, setBusy] = useState(false),
    [fragment, setFragment] = useState(''),
    [criticalDirty, setCriticalDirty] = useState(false),
    [exportAction, setExportAction] = useState('block'),
    [exportMatch, setExportMatch] = useState<'exact' | 'prefix'>('exact'),
    [rate, setRate] = useState('10'),
    [burst, setBurst] = useState('20');
  const [robotsVisited, setRobotsVisited] = useState(false);
  const criticalDirtyRef = useRef(false);
  const [workflowKey, setWorkflowKey] = useState<string | null>(null);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [scope, setScope] = useState<CrawlerIdentityScope>(identityScope);
  const [evidenceBotId, setEvidenceBotId] = useState<string | null>(null);
  const base = `/liekan/websites/${websiteId}`;
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError('');
    const now = Date.now(),
      requestedEnd = Math.min(range?.endAt || now, now),
      endAt = requestedEnd > now - 30000 ? Math.floor(requestedEnd / 30000) * 30000 : requestedEnd;
    const params = {
      startAt: Math.max(
        range?.startAt ? range.startAt - (requestedEnd - endAt) : endAt - 7 * 86400000,
        endAt - 90 * 86400000,
      ),
      endAt,
      timezone: range?.timezone || 'Asia/Shanghai',
      crawlerIdentityScope: scope,
    };
    withClientFreshness(
      abort.signal,
      () =>
        featureRequest<CrawlerAnalysisResponse>(
          'GET',
          `${base}/crawler-analysis`,
          params,
          abort.signal,
        ),
      { refresh: version > 0 },
    )
      .then(result => {
        if (abort.signal.aborted) return;
        setData(result);
        if (!criticalDirtyRef.current) setCritical(result.criticalPaths.join('\n'));
        const entryBotId =
          (selectedIdentity !== undefined
            ? selectedIdentity === null
              ? `custom:${botName}`
              : selectedIdentity
            : null) ||
          (result.bots.some(bot => bot.name === botName && !bot.botId)
            ? `custom:${botName}`
            : null) ||
          result.bots.find(bot => bot.name === botName && bot.botId)?.botId ||
          result.directory.find(bot => bot.name === botName)?.id ||
          (botName ? `custom:${botName}` : '');
        setBotId(current => current || entryBotId || result.directory[0]?.id || '');
        setEvidenceBotId(current => current ?? entryBotId);
      })
      .catch(error => {
        if (abort.signal.aborted) return;
        if ([401, 403, 404].includes(error.status)) {
          setData(null);
          setCritical('');
          setCriticalDirty(false);
          criticalDirtyRef.current = false;
          setDomain(null);
          setChecks([]);
          setFollowingCheck('');
          setFragment('');
        }
        setError(error.message || '归因分析读取失败');
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [
    websiteId,
    botName,
    selectedIdentity,
    range?.startAt,
    range?.endAt,
    range?.timezone,
    scope,
    version,
  ]);
  const reload = () => {
    if (criticalDirtyRef.current) {
      setStatus('请先保存关键路径输入，再重新读取。');
      return;
    }
    setVersion(value => value + 1);
  };
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setStatus('');
    try {
      await work();
    } catch (error: any) {
      setStatus(error.message || '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }
  async function diagnostics(signal?: AbortSignal) {
    const [current, history] = await Promise.all([
      featureRequest<any>('GET', `${base}/crawler-domain-verification`, undefined, signal),
      featureRequest<any[]>('GET', `${base}/crawler-checks`, undefined, signal),
    ]);
    if (signal?.aborted) return;
    setDomain(old => ({
      ...current,
      ...(old?.hostname === current.hostname && old?.expiresAt === current.expiresAt && old?.value
        ? { value: old.value }
        : {}),
    }));
    setChecks(history);
    setFollowingCheck(
      current =>
        current || history.find(row => ['queued', 'running'].includes(row.state))?.id || '',
    );
  }
  useEffect(() => {
    if (tab !== 'checks') return;
    const abort = new AbortController();
    let live = true;
    const read = () =>
      diagnostics(abort.signal).catch(error => {
        if (live) setStatus(error.message);
      });
    void read();
    return () => {
      live = false;
      abort.abort();
    };
  }, [tab, websiteId]);
  const follow = useTaskPolling(
    `${websiteId}:${followingCheck}`,
    tab === 'checks' &&
      !!followingCheck &&
      checks.some(row => row.id === followingCheck && ['queued', 'running'].includes(row.state)),
    async signal => {
      const history = await featureRequest<any[]>(
        'GET',
        `${base}/crawler-checks`,
        undefined,
        signal,
      );
      if (signal.aborted) return;
      setChecks(history);
      if (
        !history.some(row => row.id === followingCheck && ['queued', 'running'].includes(row.state))
      )
        setFollowingCheck('');
    },
    10000,
  );

  const customName = botId.startsWith('custom:') ? botId.slice(7) : null;
  const matchesSelection = (row: { botId: string | null; name?: string }) =>
    customName !== null ? !row.botId && row.name === customName : row.botId === botId;
  const bot = data?.directory.find(bot => bot.id === botId),
    metrics = data?.bots.filter(matchesSelection) || [],
    pages = data?.pages.filter(matchesSelection) || [],
    platform = data?.platforms.find(row => row.platformId === bot?.platformId);
  const previousPlatform = data?.previous.platforms.find(row => row.platformId === bot?.platformId);
  const platformNumber = (value: number | null | undefined, state = platform?.state) =>
    state === 'unknown' && value == null ? '—' : num(value);
  const sum = (field: string) => metrics.reduce((total, row) => total + Number(row[field] || 0), 0);
  const botOptions = [
    ...(data?.directory || []).map(bot => ({ value: bot.id, label: bot.name })),
    ...new Set([
      ...(data?.bots || []).filter(row => !row.botId).map(row => row.name),
      ...(customName === null ? [] : [customName]),
      ...(evidenceBotId?.startsWith('custom:') ? [evidenceBotId.slice(7)] : []),
    ]),
  ].map(option =>
    typeof option === 'string'
      ? { value: `custom:${option}`, label: i18n.text('{v0}（自定义）', [option]) }
      : option,
  );
  const findings = data?.findings.filter(row => !botName || row.botId === botId) || [];
  const selectors = (match: 'exact' | 'prefix' = 'exact') =>
    paths
      .split('\n')
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => crawlerPathSchema.parse({ value, match }));
  return (
    <LiekanDialog
      title={i18n.system(
        botName ? i18n.text('{v0} · 归因与风险', [botName]) : i18n.text('AI 蜘蛛归因与控制'),
      )}
      subtitle={websiteName}
      size="wide"
      onClose={onClose}
    >
      <Tabs
        active={tab}
        onChange={next => {
          if (next === 'robots') setRobotsVisited(true);
          setTab(next);
        }}
        items={[
          ['detail', i18n.text('蜘蛛详情')],
          ['evidence', i18n.text('身份与响应')],
          ['performance', i18n.text('资源与性能')],
          ['outcomes', i18n.text('业务效果')],
          ['risk', i18n.text('风险证据')],
          ['checks', i18n.text('公开页面检查')],
          ['robots', i18n.text('robots.txt 管理')],
          ['control', i18n.text('访问策略与导出')],
        ]}
      />
      <div className="row between">
        <span className="muted">{i18n.text('归因与风险按本次读取展示')}</span>
        <Button disabled={loading || busy} onClick={reload}>
          {i18n.text('重新读取归因与风险')}
        </Button>
      </div>
      {loading && <Notice>{i18n.text('正在读取蜘蛛归因数据')}</Notice>}
      {error && (
        <Notice tone="red">
          {i18n.system(error)}
          <Button onClick={reload}>{i18n.text('重试读取')}</Button>
        </Notice>
      )}
      {status && <Notice>{i18n.system(status)}</Notice>}
      {data && (
        <>
          {data.quality.state !== 'complete' && (
            <Notice tone="amber">
              {i18n.fragment('采集覆盖', false, true)}
              {{
                partial: i18n.text('存在已知缺口'),
                unknown: i18n.text('缺少连续性证据'),
                missing: i18n.text('当前范围缺少输入'),
                unsupported: i18n.text('当前来源暂不支持'),
              }[data.quality.state] || i18n.text('尚未确认完整')}
              {i18n.fragment(
                '。当前数字来自已接收日志，趋势结论与恢复判定等待完整证据。',
                true,
                false,
              )}
            </Notice>
          )}
          {['evidence', 'performance', 'outcomes'].includes(tab) && (
            <Select
              label={i18n.text('蜘蛛')}
              value={evidenceBotId ?? ''}
              onChange={event => setEvidenceBotId(event.target.value)}
              options={[{ value: '', label: i18n.text('全部') }, ...botOptions]}
            />
          )}
          {tab === 'evidence' && (
            <>
              <Select
                label={i18n.text('蜘蛛身份范围')}
                value={scope}
                onChange={event => setScope(event.target.value as CrawlerIdentityScope)}
                options={[
                  ['all', i18n.text('全部声明')],
                  ['verified_range', i18n.text('官方范围匹配')],
                  ['verified_identity', i18n.text('已核验身份')],
                ]}
              />
              <TrafficEvidencePanel
                key={websiteId}
                websiteId={websiteId}
                hostname={websiteDomain}
                range={data.range}
                botId={evidenceBotId || undefined}
                identityScope={scope}
                onIdentityScope={setScope}
              />
            </>
          )}
          {tab === 'performance' && (
            <TrafficEvidencePanel
              websiteId={websiteId}
              hostname={websiteDomain}
              range={data.range}
              botId={evidenceBotId || undefined}
              identityScope={scope}
              mode="performance"
            />
          )}
          {tab === 'outcomes' && (
            <TrafficEvidencePanel
              websiteId={websiteId}
              hostname={websiteDomain}
              range={data.range}
              botId={evidenceBotId || undefined}
              identityScope={scope}
              mode="outcomes"
            />
          )}
          {tab === 'detail' && (
            <>
              <Select
                label={i18n.text('蜘蛛')}
                value={botId}
                onChange={event => setBotId(event.target.value)}
                options={botOptions}
              />
              {customName !== null && (
                <Notice>
                  {i18n.text(
                    '自定义或未映射身份，统计按日志名称展示；官方核验与访问控制能力不可用。',
                  )}
                </Notice>
              )}
              {bot && (
                <Definition
                  items={[
                    [
                      i18n.text('平台与用途'),
                      `${bot.platformId} · ${i18n.system(labels[bot.type])}`,
                    ],
                    [
                      i18n.text('匹配口径'),
                      bot.kind === 'robots_purpose'
                        ? i18n.text('robots 用途控制项，无独立 HTTP UA')
                        : i18n.text('按声明 UA 分类，官方范围核验单独统计'),
                    ],
                    [
                      i18n.text('官方说明'),
                      <a href={bot.documentationUrl} target="_blank" rel="noreferrer">
                        {i18n.text('查看供应商说明')}
                      </a>,
                    ],
                  ]}
                />
              )}
              {bot?.kind === 'robots_purpose' ? (
                <Notice>
                  {i18n.text(
                    'robots 用途控制项用于声明内容用途，不生成独立抓取量或 HTTP 屏蔽条件。',
                  )}
                </Notice>
              ) : (
                <>
                  <Definition
                    items={[
                      [
                        i18n.text('请求量 / 前期'),
                        `${num(sum('requests'))} / ${num(data.previous.bots.filter(matchesSelection).reduce((n, row) => n + row.requests, 0))}`,
                      ],
                      [
                        i18n.text('有效 GET / 目录页面'),
                        `${num(sum('successfulGets'))} / ${num(sum('successfulCatalogPages'))}`,
                      ],
                      [i18n.text('响应发送字节'), num(sum('bytes'))],
                      [
                        i18n.text('身份核验'),
                        i18n.text('范围 {v0} · DNS {v3} · 边缘 {v4} · 未匹配 {v1} · 未核验 {v2}', [
                          num(sum('verifiedRange')),
                          num(sum('rangeMismatch')),
                          num(sum('unverified')),
                          num(sum('verifiedDns')),
                          num(sum('verifiedEdge')),
                        ]),
                      ],
                    ]}
                  />
                  <Table
                    columns={['1xx', '2xx', '3xx（除 304）', '304', '4xx', '5xx', 'HEAD']}
                    rows={[
                      [
                        ...[
                          'status1xx',
                          'status2xx',
                          'status3xx',
                          'status304',
                          'status4xx',
                          'status5xx',
                          'head',
                        ].map(field => num(sum(field))),
                      ],
                    ]}
                    numeric={[0, 1, 2, 3, 4, 5, 6]}
                  />
                  {!metrics.length && (
                    <Notice>
                      {i18n.text(
                        '当前范围没有此蜘蛛的已映射请求。历史记录与自定义识别规则单列为未映射数据。',
                      )}
                    </Notice>
                  )}
                </>
              )}
              <h3>{i18n.text('所属平台关联')}</h3>
              {(customName !== null || platform?.state === 'unsupported') && (
                <Notice>{i18n.text('暂不支持来源归因')}</Notice>
              )}
              {platform?.state === 'missing' && <Notice>{i18n.text('缺少来源数据')}</Notice>}
              {(platform?.state === 'unknown' || previousPlatform?.state === 'unknown') && (
                <Notice tone="amber">{i18n.text(identityUnavailableReason)}</Notice>
              )}
              <p className="muted">
                {i18n.text(
                  '同一平台的引荐与转化只汇总一次，各蜘蛛详情引用同一份平台数据。抓取与引荐并列观察，单次转化的因果归属需要额外证据。',
                )}
              </p>
              <p className="muted">
                {i18n.text('前期采用相同长度时间窗。覆盖未知时仅供并列观察。')}
              </p>
              <Definition
                items={[
                  [
                    i18n.text('平台引荐会话 / 前期'),
                    `${platformNumber(platform?.visits)} / ${platformNumber(previousPlatform?.visits, previousPlatform?.state)}`,
                  ],
                  [
                    i18n.text('转化会话 / 目标事件'),
                    `${platform?.state === 'available' && platform.conversions == null ? i18n.text('未配置目标') : platformNumber(platform?.conversions)} / ${platform?.state === 'available' && platform.goalEvents == null ? i18n.text('未配置目标') : platformNumber(platform?.goalEvents)}`,
                  ],
                ]}
              />
              <Table
                columns={['原编码路径', 'GET + 2xx', '403 / 429', '本平台终止拦截', '规则匹配']}
                rows={pages.map(row => [
                  <TableCell
                    sortValue={pageLink(row.path, websiteDomain, undefined, undefined, 'zh-CN')}
                    searchValue={pageLink(row.path, websiteDomain, undefined, undefined, 'en-US')}
                  >
                    <span
                      title={i18n.system(
                        row.mergedPaths?.length > 1
                          ? i18n.text('多个编码路径映射到同一浏览器路径')
                          : undefined,
                      )}
                    >
                      {pageLink(row.path, websiteDomain, undefined, undefined, i18n.locale)}
                    </span>
                  </TableCell>,
                  num(row.successfulGets),
                  num(row.denied403429),
                  num(row.ownedTerminatingBlocks),
                  num(row.ownedMatches),
                ])}
                numeric={[1, 2, 3, 4]}
                empty={i18n.text('当前范围没有页面请求')}
              />
              {data.pagesTruncated && (
                <Notice>
                  {i18n.text('页面按请求量显示前 1,000 项，蜘蛛总量仍使用全部已接收日志。')}
                </Notice>
              )}
              <Table
                columns={['平台落地页', '引荐会话', '转化会话 / 目标事件']}
                rows={(platform?.landingPages || []).map(row => [
                  <TableCell
                    sortValue={pageLink(row.path, websiteDomain, undefined, undefined, 'zh-CN')}
                    searchValue={pageLink(row.path, websiteDomain, undefined, undefined, 'en-US')}
                  >
                    {pageLink(row.path, websiteDomain, undefined, undefined, i18n.locale)}
                  </TableCell>,
                  platformNumber(row.visits),
                  `${platformNumber(row.conversions)} / ${platformNumber(row.goalEvents)}`,
                ])}
                empty={i18n.text('尚无平台落地页证据')}
              />
              {platform?.landingPagesTruncated && (
                <Notice>{i18n.text('平台落地页按引荐量显示前 1,000 项。')}</Notice>
              )}
              <p className="muted">
                {i18n.text(
                  '本平台终止拦截要求终止动作为 block 且规则 ID 属于本平台；匹配数组单独计数。版本归因显示未知，源站日志无法观测 CDN 已拦请求。',
                )}
              </p>
              <details>
                <summary>{i18n.text('未映射的历史与自定义记录')}</summary>
                <Table
                  columns={['日志分类', '请求量', '历史分类版本缺失']}
                  rows={data.bots
                    .filter(row => !row.botId)
                    .map(row => [row.name, num(row.requests), num(row.legacyRecords)])}
                />
              </details>
            </>
          )}
          {tab === 'risk' && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={pendingOnly}
                  onChange={event => setPendingOnly(event.target.checked)}
                />
                {i18n.text('仅看待处理')}
              </label>
              {workflowKey && findings.some(row => row.key === workflowKey) && (
                <CrawlerWorkflow
                  key={workflowKey}
                  websiteId={websiteId}
                  hostname={websiteDomain}
                  finding={findings.find(row => row.key === workflowKey)}
                  timezone={data.range.timezone}
                  onChanged={reload}
                  onChecks={() => setTab('checks')}
                  onControl={() => setTab('control')}
                />
              )}
              <p className="muted">
                {i18n.text(
                  '等级与证据置信度分别展示。搜索可见性与平台处罚需要独立搜索数据；本页依据访问日志定位技术风险。',
                )}
              </p>
              <p>
                {i18n.fragment('最近计算：', false, true)}
                {date(data.analysis?.computedAt, data.range.timezone)}
                {data.analysis?.errorCode ? i18n.text(' · 更新失败，保留上次结果') : ''}
              </p>
              <Table
                columns={['蜘蛛 / 路径组', '风险', '等级 / 置信度', '证据与窗口', '状态 / 操作']}
                rows={findings
                  .filter(
                    row =>
                      !pendingOnly ||
                      (row.state === 'active' &&
                        (!row.workflow || row.workflow.state === 'pending')),
                  )
                  .map(row => [
                    `${data.directory.find(bot => bot.id === row.botId)?.name || row.botId} · ${row.pathGroup}`,
                    <TableCell
                      sortValue={riskLabels[row.type]}
                      searchValue={i18n.english.system(riskLabels[row.type])}
                    >
                      {i18n.system(riskLabels[row.type])}
                    </TableCell>,
                    <TableCell
                      sortValue={[gradeLabels[row.grade], ' ', confidenceLabels[row.confidence]]}
                      searchValue={[
                        i18n.english.system(i18n.english.system(gradeLabels[row.grade])),
                        ' ',
                        i18n.english.system(confidenceLabels[row.confidence]),
                      ]}
                    >
                      <>
                        <Badge
                          tone={
                            row.grade === 'high' ? 'red' : row.grade === 'medium' ? 'amber' : 'gray'
                          }
                        >
                          {i18n.system(gradeLabels[row.grade])}
                        </Badge>{' '}
                        {i18n.system(confidenceLabels[row.confidence])}
                      </>
                    </TableCell>,
                    <TableCell
                      sortValue={[
                        Object.entries(row.facts.evidence || {})
                          .map(
                            ([key, value]) =>
                              `${evidenceLabels[key] || key}: ${value ?? i18n.source('未知')}`,
                          )
                          .join(' · '),
                        [
                          i18n.source('累计 '),
                          row.occurrenceWindows,
                          i18n.source(' 个发生窗口 · 截至'),
                          ' ',
                          date(row.facts.windowEnd, data.range.timezone),
                        ],
                      ]}
                      searchValue={[
                        Object.entries(row.facts.evidence || {})
                          .map(
                            ([key, value]) =>
                              `${i18n.english.system(evidenceLabels[key]) || key}: ${value ?? i18n.english.text('未知')}`,
                          )
                          .join(' · '),
                        [
                          i18n.english.fragment('累计 ', false, true),
                          row.occurrenceWindows,
                          i18n.english.fragment(' 个发生窗口 · 截至', true, true),
                          ' ',
                          date(row.facts.windowEnd, data.range.timezone),
                        ],
                      ]}
                    >
                      <>
                        <span>
                          {Object.entries(row.facts.evidence || {})
                            .map(
                              ([key, value]) =>
                                `${i18n.system(evidenceLabels[key]) || key}: ${value ?? i18n.text('未知')}`,
                            )
                            .join(' · ')}
                        </span>
                        <small className="field-help">
                          {i18n.fragment('累计 ', false, true)}
                          {row.occurrenceWindows}
                          {i18n.fragment(' 个发生窗口 · 截至', true, true)}{' '}
                          {date(row.facts.windowEnd, data.range.timezone)}
                        </small>
                      </>
                    </TableCell>,
                    <TableCell
                      sortValue={[
                        row.state === 'ignored'
                          ? i18n.source('已忽略')
                          : row.state === 'resolved'
                            ? i18n.source('已解除')
                            : row.facts.status === 'pending'
                              ? i18n.source('待观察')
                              : i18n.source('待处理'),
                        data.permissions.canDraft &&
                          (row.state === 'ignored' ? i18n.source('恢复提醒') : i18n.source('忽略')),
                      ]}
                      searchValue={[
                        row.state === 'ignored'
                          ? i18n.english.text('已忽略')
                          : row.state === 'resolved'
                            ? i18n.english.text('已解除')
                            : row.facts.status === 'pending'
                              ? i18n.english.text('待观察')
                              : i18n.english.text('待处理'),
                        data.permissions.canDraft &&
                          (row.state === 'ignored'
                            ? i18n.english.text('恢复提醒')
                            : i18n.english.text('忽略')),
                      ]}
                    >
                      <>
                        {row.state === 'ignored'
                          ? i18n.text('已忽略')
                          : row.state === 'resolved'
                            ? i18n.text('已解除')
                            : row.facts.status === 'pending'
                              ? i18n.text('待观察')
                              : i18n.text('待处理')}
                        <Button onClick={() => setWorkflowKey(row.key)}>
                          {i18n.text('上下文与处理')}
                        </Button>
                        {data.permissions.canDraft && (
                          <Button
                            disabled={busy}
                            onClick={() =>
                              run(async () => {
                                await featureRequest(
                                  'PATCH',
                                  `${base}/crawler-findings/${row.key}`,
                                  {
                                    ignored: row.state !== 'ignored',
                                  },
                                );
                                reload();
                              })
                            }
                          >
                            {row.state === 'ignored' ? i18n.text('恢复提醒') : i18n.text('忽略')}
                          </Button>
                        )}
                      </>
                    </TableCell>,
                  ])}
                empty={i18n.text('尚无风险发现。异步计算完成后会显示证据；缺少数据时保持待观察。')}
              />
              <form data-unsaved={criticalDirty} onSubmit={event => event.preventDefault()}>
                <label className="field">
                  <span>{i18n.text('公开且期望搜索可访问的关键路径，每行一项')}</span>
                  <textarea
                    value={critical}
                    disabled={!data.permissions.canDraft || busy}
                    onChange={event => {
                      setCritical(event.target.value);
                      setCriticalDirty(true);
                      criticalDirtyRef.current = true;
                    }}
                    rows={4}
                  />
                  <small>
                    {i18n.text(
                      '关键页面可用低流量规则检查：24 小时内至少 3 次已核验搜索请求受阻。',
                    )}
                  </small>
                </label>
                <Button
                  disabled={!data.permissions.canDraft || busy}
                  onClick={() =>
                    run(async () => {
                      const values = critical
                        .split('\n')
                        .map(value => value.trim())
                        .filter(Boolean);
                      values.forEach(value => crawlerPathSchema.parse({ value, match: 'exact' }));
                      await featureRequest('PATCH', `${base}/crawler-analysis`, { paths: values });
                      setCriticalDirty(false);
                      criticalDirtyRef.current = false;
                      setStatus('关键路径已保存，等待下一轮风险计算。');
                      reload();
                    })
                  }
                >
                  {i18n.text('保存关键路径')}
                </Button>
              </form>
            </>
          )}
          {(tab === 'robots' || robotsVisited) && (
            <div hidden={tab !== 'robots'}>
              <RobotsManagementPanel key={websiteId} websiteId={websiteId} />
            </div>
          )}
          {tab === 'checks' && (
            <>
              <p>
                {i18n.text(
                  '先验证当前域名，再检查 robots.txt 和指定公开页面。检查使用独立自检 UA，页面正文不会保存。',
                )}
              </p>
              <Definition
                items={[
                  [i18n.text('TXT 记录名称'), domain?.name || i18n.text('正在读取')],
                  [i18n.text('TXT 值'), domain?.value || i18n.text('创建挑战后显示')],
                  [
                    i18n.text('验证状态'),
                    domain?.verifiedAt
                      ? date(domain.verifiedAt, data.range.timezone)
                      : i18n.text('待验证'),
                  ],
                ]}
              />
              <div className="form-actions">
                <Button
                  disabled={busy || !data.permissions.canDraft}
                  onClick={() =>
                    run(async () => {
                      setDomain(
                        await featureRequest('POST', `${base}/crawler-domain-verification`, {
                          action: 'create',
                        }),
                      );
                    })
                  }
                >
                  {i18n.text('创建 TXT 挑战')}
                </Button>
                <Button
                  disabled={busy || !data.permissions.canDraft}
                  onClick={() =>
                    run(async () => {
                      setDomain(
                        await featureRequest('POST', `${base}/crawler-domain-verification`, {
                          action: 'verify',
                        }),
                      );
                      setStatus('域名验证已通过。请保留 TXT 记录，执行前会再次核验。');
                    })
                  }
                >
                  {i18n.text('验证 TXT')}
                </Button>
              </div>
              <label className="field">
                <span>{i18n.text('检查路径，每行一项，最多 20 个')}</span>
                <textarea value={paths} onChange={event => setPaths(event.target.value)} rows={4} />
              </label>
              <Button
                disabled={busy || !data.permissions.canDraft || !domain?.verifiedAt}
                onClick={() =>
                  run(async () => {
                    const created = await featureRequest<{ id: string }>(
                      'POST',
                      `${base}/crawler-checks`,
                      {
                        paths: selectors().map(row => row.value),
                      },
                    );
                    setFollowingCheck(created.id);
                    setStatus('检查已排队，可在下方查看结果。');
                    await diagnostics();
                  })
                }
              >
                {i18n.text('检查公开页面')}
              </Button>
              <Button
                onClick={async () => {
                  await diagnostics();
                  follow.resume();
                }}
              >
                {follow.expired ? i18n.text('回查检查结果') : i18n.text('重新读取检查状态')}
              </Button>
              <Table
                columns={['创建时间', '状态', '结果']}
                rows={checks.map(check => [
                  date(check.createdAt, data.range.timezone),
                  <TableCell
                    sortValue={
                      {
                        queued: i18n.source('排队中'),
                        running: i18n.source('检查中'),
                        completed: i18n.source('已完成'),
                        failed: i18n.source('失败'),
                        cancelled: i18n.source('已取消'),
                      }[check.state] || check.state
                    }
                    searchValue={
                      {
                        queued: i18n.english.text('排队中'),
                        running: i18n.english.text('检查中'),
                        completed: i18n.english.text('已完成'),
                        failed: i18n.english.text('失败'),
                        cancelled: i18n.english.text('已取消'),
                      }[check.state] || check.state
                    }
                  >
                    {{
                      queued: i18n.text('排队中'),
                      running: i18n.text('检查中'),
                      completed: i18n.text('已完成'),
                      failed: i18n.text('失败'),
                      cancelled: i18n.text('已取消'),
                    }[check.state] || check.state}
                  </TableCell>,
                  <TableCell
                    sortValue={
                      check.result
                        ? [
                            i18n.source('查看 robots 与响应证据'),
                            JSON.stringify(check.result, null, 2),
                          ]
                        : check.errorCode || i18n.source('等待 worker 处理')
                    }
                    searchValue={
                      check.result
                        ? [
                            i18n.english.text('查看 robots 与响应证据'),
                            JSON.stringify(check.result, null, 2),
                          ]
                        : check.errorCode || i18n.english.text('等待 worker 处理')
                    }
                  >
                    {check.result ? (
                      <details>
                        <summary>{i18n.text('查看 robots 与响应证据')}</summary>
                        <pre className="code-block">{JSON.stringify(check.result, null, 2)}</pre>
                      </details>
                    ) : (
                      check.errorCode || i18n.text('等待 worker 处理')
                    )}
                  </TableCell>,
                ])}
              />
            </>
          )}
          {tab === 'control' && (
            <>
              {controlPanel ? (
                controlPanel(data.permissions)
              ) : (
                <CrawlerPoliciesPanel websiteId={websiteId} permissions={data.permissions} />
              )}
              <details>
                <summary>{i18n.text('导出 robots.txt 与 Nginx 配置')}</summary>
                <Select
                  label={i18n.text('蜘蛛')}
                  value={botId}
                  onChange={event => setBotId(event.target.value)}
                  options={data.directory.map(bot => [bot.id, bot.name])}
                />
                <Select
                  label={i18n.text('导出动作')}
                  value={exportAction}
                  onChange={event => setExportAction(event.target.value)}
                  options={[
                    ['block', i18n.text('禁止 / 屏蔽')],
                    ['allow', i18n.text('robots 允许')],
                    ['rate', i18n.text('Nginx 限速')],
                  ]}
                  localizeLabels
                />
                <Select
                  label={i18n.text('路径匹配')}
                  value={exportMatch}
                  onChange={event => setExportMatch(event.target.value as 'exact' | 'prefix')}
                  options={[
                    ['exact', i18n.text('精确路径')],
                    ['prefix', i18n.text('目录段前缀')],
                  ]}
                  localizeLabels
                />
                {exportAction === 'rate' && (
                  <div>
                    <label className="field">
                      <span>{i18n.text('每 IP 每秒请求数')}</span>
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        value={rate}
                        onChange={event => setRate(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>{i18n.text('突发请求数')}</span>
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        value={burst}
                        onChange={event => setBurst(event.target.value)}
                      />
                    </label>
                    <Notice>
                      {i18n.text(
                        'Nginx 片段按 IP 限速，初始为 dry-run。部署前核对真实 IP 与现有 limit_req 配置。',
                      )}
                    </Notice>
                  </div>
                )}
                <label className="field">
                  <span>{i18n.text('原编码路径，每行一项')}</span>
                  <textarea
                    value={paths}
                    onChange={event => setPaths(event.target.value)}
                    rows={4}
                  />
                </label>
                <div className="form-actions">
                  <Button
                    disabled={busy || !bot?.robotsToken || exportAction === 'rate'}
                    onClick={() =>
                      run(async () => {
                        const output = await featureRequest('POST', `${base}/crawler-exports`, {
                          kind: 'robots',
                          policy: {
                            botIds: [botId],
                            paths: selectors(exportMatch),
                            action: exportAction,
                          },
                        });
                        setFragment(output.content || output.fragment);
                        setStatus(
                          output.safe
                            ? '已保留原文件并生成追加内容。部署前请核对现网 robots.txt。'
                            : `需要手动合并：${output.reasons.join('；')}`,
                        );
                      })
                    }
                  >
                    {i18n.text('生成 robots.txt 草稿')}
                  </Button>
                  <Button
                    disabled={
                      busy ||
                      !bot?.control?.nginx ||
                      bot?.kind === 'robots_purpose' ||
                      exportAction === 'allow'
                    }
                    onClick={() =>
                      run(async () => {
                        const output = await featureRequest('POST', `${base}/crawler-exports`, {
                          kind: 'nginx',
                          policy: {
                            name: '导出策略',
                            botIds: [botId],
                            paths: selectors(exportMatch),
                            action: exportAction === 'rate' ? 'observe' : 'block',
                            expectedAccess: exportAction === 'rate' ? 'allow' : 'block',
                          },
                          ...(exportAction === 'rate'
                            ? {
                                rateLimit: {
                                  requestsPerSecond: Number(rate),
                                  burst: Number(burst),
                                  dryRun: true,
                                },
                              }
                            : {}),
                        });
                        setFragment(
                          exportAction === 'rate' && output.rateLimit
                            ? `${output.httpContext}\n${output.rateLimit.httpContext}\n${output.rateLimit.serverContext}`
                            : `${output.httpContext}\n${output.serverContext}`,
                        );
                        setStatus('配置片段已生成。请结合原配置核对并通过 nginx -t 后部署。');
                      })
                    }
                  >
                    {i18n.text('生成 Nginx 配置片段')}
                  </Button>
                  <Button
                    disabled={!fragment}
                    onClick={() =>
                      downloadFile(
                        fragment,
                        'liekan-crawler-policy.txt',
                        'text/plain;charset=utf-8',
                      )
                    }
                  >
                    {i18n.text('下载当前草稿')}
                  </Button>
                </div>
                {fragment && <pre className="code-block">{fragment}</pre>}
              </details>
            </>
          )}
        </>
      )}
    </LiekanDialog>
  );
}
