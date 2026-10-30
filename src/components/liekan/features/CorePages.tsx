'use client';
import { liekanProduct } from '@/lib/liekan/contracts/product';
import { TableCell } from './ui';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';

import { LanguageSelector } from '../LanguageSelector';
import { AccountTimezoneFields } from './AccountTimezoneFields';
import { saveAccountPreferences } from '@/lib/liekan/upstream/account-preferences-client';

import { formatInTimeZone } from 'date-fns-tz';
import Link from '@/components/liekan/Link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useManualRefresh } from '@/lib/liekan/contracts/manual-refresh';
import {
  type CoreFunnelStep,
  conversionRate,
  featureNavigationPath,
  funnelPayload,
  goalPayload,
  recorderPayload,
  safeCallbackUrl,
} from '@/lib/liekan/contracts/core';
import { countOf, type FeatureEntity, numberLabel, rowsOf } from '@/lib/liekan/contracts/features';
import { nativeMetric } from '@/lib/liekan/contracts/workspace';
import { identityUsable } from '@/lib/liekan/contracts/browser-population';
import {
  qualifiedBrowserReason,
  qualifiedBrowserUnavailableReason,
} from '@/lib/liekan/contracts/population-results';
import { websiteHandle } from '@/lib/liekan/website-handle';
import type { DataState, LiekanReport } from '@/lib/liekan/contracts/report';
import {
  featureSiteQuery,
  getFeatureWebsiteSummary,
  acceptFeatureLogin,
  clearFeatureLogin,
  featureApi,
  getFeaturePreferences,
  resumeFeatureLogin,
  saveFeaturePreferences,
  verifyFeatureSso,
  verifyFeatureTwoFactor,
} from '@/lib/liekan/upstream/features-client';
import {
  projectToday,
  projectTrend,
  websiteDayWindow,
} from '@/lib/liekan/upstream/website-day-metrics';
import { TrafficQuality } from './TrafficQuality';
import { Skeleton } from '../DataLoading';
import { ManagementDrawer } from '../ManagementDrawer';
import { CrawlerHandoffs } from './CrawlerHandoffs';
import { CrawlerDialog } from './CrawlerDialog';
import { managementLabels } from '@/lib/liekan/contracts/management';
import { Chart } from './Chart';
import { useAction, useData, useFeature } from './context';
import { CrawlerDisplaySettings } from './CrawlerDisplaySettings';
import {
  Badge,
  Body,
  Button,
  Check,
  Code,
  Definition,
  LiekanDialog,
  DialogActions,
  Field,
  Form,
  Icon,
  LinkButton,
  Metrics,
  Notice,
  Panel,
  QueryState,
  Select,
  Switch,
  Table,
  Tabs,
  Textarea,
} from './ui';
import { WebsiteSharing } from './WorkspacePages';
import { Installation, InstallationEntry } from './Installation';
import { TrackingCode } from './TrackingCode';
import { installationParams } from '@/lib/liekan/contracts/installation';
import { rememberAggregateFailure } from '@/lib/liekan/upstream/client-freshness';

const basePath = process.env.basePath || '';
const appPath = (path: string) => featureNavigationPath(path, basePath);
const formatDate = (value: any, timezone = getFeaturePreferences().timezone || 'Asia/Shanghai') =>
  value ? new Date(value).toLocaleString('zh-CN', { timeZone: timezone }) : '尚未接收';
const sitePath = (id: string) => `/websites/${id}`;
const transientCodes = new Map<string, string[]>();

function PasswordField({
  label,
  name,
  minLength,
}: {
  label: string;
  name: string;
  minLength?: number;
}) {
  const i18n = useLiekanI18n();
  const [visible, setVisible] = useState(false);
  return (
    <label className="field">
      <span>
        {i18n.system(label)} <span className="required">*</span>
      </span>
      <span className="password-wrap">
        <input
          required
          name={name}
          type={visible ? 'text' : 'password'}
          minLength={minLength}
          autoComplete={
            name === 'password' || name === 'currentPassword' ? 'current-password' : 'new-password'
          }
        />
        <button
          type="button"
          aria-label={i18n.system(visible ? i18n.text('隐藏密码') : i18n.text('显示密码'))}
          onClick={() => setVisible(!visible)}
        >
          <Icon name="eye" />
        </button>
      </span>
    </label>
  );
}

function useSiteRecord() {
  const c = useFeature();
  return useData(
    ['site-record', c.siteId],
    signal => c.api.get<FeatureEntity>(sitePath(c.siteId), undefined, signal),
    !!c.siteId,
    featureSiteQuery(c.user.id, c.siteId),
  );
}
function useInstall(id: string, createdAt?: string) {
  const c = useFeature();
  return useData(
    ['install', id, createdAt],
    async signal => {
      const status = await c.api.get(`/liekan/websites/${id}/installation`, undefined, signal);
      if (status?.browser?.pageviews == null || !Number.isFinite(countOf(status.browser.pageviews)))
        throw new Error('统计响应缺少有效的访问次数。');
      return {
        pageviews: countOf(status.browser.pageviews),
        lastAt: status.browser.lastAt,
        firstAt: status.browser.firstAt,
      };
    },
    !!id,
  );
}
function teamRole(c: ReturnType<typeof useFeature>, teamId: string) {
  const team = c.teams.find(team => team.id === teamId);
  return (
    team?.members?.find((member: any) => member.userId === c.user.id)?.role || team?.role || ''
  );
}
function canManageSite(c: ReturnType<typeof useFeature>, site: FeatureEntity) {
  if (!site || c.user.role === 'view-only') return false;
  if (c.user.isAdmin) return true;
  if (site.userId) return site.userId === c.user.id;
  return ['team-owner', 'team-manager', 'team-member'].includes(teamRole(c, site.teamId));
}
function teamCandidates(c: ReturnType<typeof useFeature>, permission: 'create' | 'transfer') {
  if (c.user.role === 'view-only') return [];
  const roles =
    permission === 'create'
      ? ['team-owner', 'team-manager', 'team-member']
      : ['team-owner', 'team-manager'];
  return c.teams.filter(team => c.user.isAdmin || roles.includes(teamRole(c, team.id)));
}
function canTransferSite(c: ReturnType<typeof useFeature>, site: FeatureEntity) {
  if (!site || c.user.role === 'view-only') return false;
  if (c.user.isAdmin) return !!site.teamId || teamCandidates(c, 'transfer').length > 0;
  if (site.teamId) return teamRole(c, site.teamId) === 'team-owner';
  return site.userId === c.user.id && teamCandidates(c, 'transfer').length > 0;
}
function MissingWebsite() {
  const i18n = useLiekanI18n();
  return (
    <Notice tone="amber">
      {i18n.fragment('请选择一个网站后继续。', false, true)}
      <div className="form-actions">
        <LinkButton page="websites">{i18n.text('网站管理')}</LinkButton>
        <LinkButton page="onboarding" primary>
          {i18n.text('添加网站')}
        </LinkButton>
      </div>
    </Notice>
  );
}
function ReadonlyNotice() {
  const i18n = useLiekanI18n();
  return (
    <Notice tone="amber">{i18n.text('当前角色可以查看此配置。保存操作需要网站管理权限。')}</Notice>
  );
}
const percentLabel = (value: number | null) => (value == null ? '—' : `${value.toFixed(2)}%`);
const bounceRateLabel = (row: any) => {
  const visits = Number(row?.visits ?? 0);
  return visits > 0 ? (Number(row?.bounces ?? 0) / visits) * 100 : null;
};
/** 今日 / 昨日 / 预计今日 three-line metric cell; rates have no projection. Row captions render once per table row, so later metric columns pass labels={false}. */
function MetricRows({
  today,
  yesterday,
  timezone,
  kind,
  labels = true,
  readAt,
  loading = false,
}: {
  today: number | null;
  yesterday: number | null;
  timezone: string;
  kind: 'count' | 'percent';
  labels?: boolean;
  readAt: number;
  loading?: boolean;
}) {
  const i18n = useLiekanI18n();
  const estimate = kind === 'count' ? projectToday(today, timezone, readAt) : null;
  const trend = projectTrend(estimate, yesterday);
  return (
    <div className="site-metrics" aria-busy={loading || undefined}>
      <div className={labels ? 'site-metric' : 'site-metric site-metric-bare'}>
        {labels && (
          <span
            className="site-metric-label"
            title={i18n.system(formatInTimeZone(readAt, timezone, 'yyyy-MM-dd'))}
          >
            {i18n.text('今日')}
          </span>
        )}
        <span className="site-metric-value">
          {loading ? (
            <Skeleton width="3em" />
          ) : kind === 'percent' ? (
            percentLabel(today)
          ) : today == null ? (
            '—'
          ) : (
            numberLabel(today)
          )}
        </span>
      </div>
      <div className={labels ? 'site-metric' : 'site-metric site-metric-bare'}>
        {labels && <span className="site-metric-label">{i18n.text('昨日')}</span>}
        <span className="site-metric-value">
          {loading ? (
            <Skeleton width="3em" />
          ) : kind === 'percent' ? (
            percentLabel(yesterday)
          ) : yesterday == null ? (
            '—'
          ) : (
            numberLabel(yesterday)
          )}
        </span>
      </div>
      <div className={labels ? 'site-metric' : 'site-metric site-metric-bare'}>
        {labels && <span className="site-metric-label">{i18n.text('预计今日')}</span>}
        <span className="site-metric-value">
          {loading && kind === 'count' ? (
            <Skeleton width="3em" />
          ) : estimate == null ? (
            '—'
          ) : (
            numberLabel(estimate)
          )}
          {trend === 1 && (
            <span className="metric-arrow metric-up" aria-label={i18n.text('预计高于昨日')}>
              ▲
            </span>
          )}
          {trend === -1 && (
            <span className="metric-arrow metric-down" aria-label={i18n.text('预计低于昨日')}>
              ▼
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function InstallSteps({ query, websiteId }: { query: any; websiteId: string }) {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const received = !query.error && query.data?.pageviews > 0;
  return (
    <ul className="timeline">
      <li>
        <div className="row between">
          <strong>{i18n.text('脚本加载')}</strong>
          <Badge key="badge" tone="gray">
            {i18n.text('需浏览器核对')}
          </Badge>
        </div>
        <p>{i18n.text('在目标网站的网络面板检查 script.js 加载和采集请求。')}</p>
      </li>
      <li>
        <div className="row between">
          <strong>{i18n.text('网站标识')}</strong>
          <Badge key="badge" tone="blue">
            {i18n.text('已生成')}
          </Badge>
        </div>
        <p>
          <code>{websiteId}</code>
          {i18n.fragment('，请核对页面中的 data-website-id。', true, false)}
        </p>
      </li>
      <li>
        <div className="row between">
          <strong>{i18n.text('首条访问')}</strong>
          <Badge key="badge" tone={received ? 'green' : 'gray'}>
            {query.error
              ? i18n.text('读取失败')
              : query.isPending
                ? i18n.text('正在检查')
                : received
                  ? i18n.text('已收到浏览数据')
                  : i18n.text('等待')}
          </Badge>
        </div>
        <p>
          {received
            ? i18n.text('最近接收：{v0}', [formatDate(query.data.lastAt, c.range.timezone)])
            : i18n.text('安装代码后打开目标网站，再检查首条页面访问。')}
        </p>
      </li>
    </ul>
  );
}
function Websites() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const reading = useManualRefresh();
  const enteredAt = useRef(Date.now());
  const readAt = reading?.page.now ?? enteredAt.current;
  const query = useData(
    ['website-management-stats', c.sites.map(site => site.id)],
    signal =>
      getFeatureWebsiteSummary(
        c.sites.map(site => site.id),
        c.range,
        signal,
        c.api.get,
      ),
    c.sitesReady !== false,
  );
  // 今日窗口自带 compare=昨日，四个指标列共用一次请求。
  const todayWindow = websiteDayWindow(c.range.timezone, readAt);
  const todayQuery = useData(
    ['website-management-today', c.sites.map(site => site.id), todayWindow.startAt],
    signal =>
      getFeatureWebsiteSummary(
        c.sites.map(site => site.id),
        todayWindow,
        signal,
        c.api.get,
      ),
    c.sitesReady !== false,
  );
  const stats = query.data || [];
  const todayStats = todayQuery.data || [];
  const readable = stats.filter(row => !row.error);
  const populations = [...readable, ...todayStats.filter(row => !row.error)]
    .map(row => row.population)
    .filter(population => population?.metricScope === 'qualified-browser');
  const populationNotice = populations.some(population => !identityUsable(population))
    ? qualifiedBrowserUnavailableReason
    : populations.some(population => population.identity.status === 'partial')
      ? qualifiedBrowserReason
      : null;
  const ready = !query.isPending && !query.error && Array.isArray(query.data);
  const partial = ready && readable.length < c.sites.length;
  const scope = c.route.teamId
    ? i18n.text('{v0}空间', [
        c.teams.find(team => team.id === c.route.teamId)?.name || i18n.text('当前团队'),
      ])
    : c.query.scope === 'all'
      ? i18n.text('全部可访问网站')
      : i18n.text('个人空间');
  const errorLabel = (error: any) =>
    error.status === 401 ? '需要重新登录' : error.status === 403 ? '无统计权限' : '读取失败';
  // 用户批准（2026-10-08）：页头沿用数据总览的指标卡模式，按当前空间所选网站汇总并对比前期。
  const cardSum = (pick: (row: any) => any): number | 'missing' | null => {
    if (!ready) return null;
    if (!c.sites.length) return 0;
    if (!readable.length) return null;
    const values = readable.map(row => nativeMetric(pick(row)));
    return values.every(value => value != null)
      ? values.reduce((total, value) => total + (value || 0), 0)
      : 'missing';
  };
  const cardValue = (value: number | 'missing' | null) =>
    value == null ? '—' : value === 'missing' ? i18n.text('未提供') : numberLabel(value);
  const changeLabel = (key: string) => {
    const current = cardSum(row => row[key]);
    const previous = cardSum(row => row.comparison?.[key]);
    return typeof current !== 'number' || typeof previous !== 'number'
      ? i18n.text('前期数据未提供')
      : i18n.text('前期 {v0} · 变化 {v1}', [
          numberLabel(previous),
          numberLabel(current - previous),
        ]);
  };
  const cardScope = partial
    ? i18n.text('已读取 {v0}/{v1} 个网站', [readable.length, c.sites.length])
    : i18n.text('所选 {v0} 个网站', [c.sites.length]);
  return (
    <>
      <Metrics
        loading={[query.isPending, query.isPending, query.isPending, false]}
        items={[
          [
            i18n.text('全部网站访客'),
            cardValue(cardSum(row => row.visitors)),
            `${cardScope} · ${changeLabel('visitors')}`,
          ],
          [
            i18n.text('页面访问'),
            cardValue(cardSum(row => row.pageviews)),
            changeLabel('pageviews'),
          ],
          [
            i18n.label('AI 引荐访客', 'ai-sessions'),
            cardValue(cardSum(row => row.aiVisits)),
            i18n.text('按网站累计，跨网站不去重'),
          ],
          [
            i18n.text('管理空间'),
            c.route.teamId ? i18n.text('团队') : i18n.text('个人 / 团队'),
            i18n.text('跨网站快速访问'),
          ],
        ]}
      />
      {populationNotice && <Notice>{i18n.text(populationNotice)}</Notice>}
      <Panel
        title={i18n.text('网站列表')}
        subtitle={i18n.text('管理{v0}中有权访问的网站。', [scope])}
        actions={
          c.user.role !== 'view-only' && (
            <>
              <LinkButton page="history-repair">{i18n.text('历史数据修复')}</LinkButton>
              <LinkButton page="onboarding" primary>
                <Icon name="plus" />
                {i18n.fragment('添加网站', true, false)}
              </LinkButton>
            </>
          )
        }
      >
        {/* Statistics report their own loading and failures; website metadata stays usable. */}
        <QueryState query={query} readOnly>
          {null}
        </QueryState>
        <Table
          mobile
          rowKeys={c.sites.map(site => site.id)}
          columns={[
            '网站',
            '所属空间',
            '浏览采集状态',
            '访问次数',
            '访客数',
            '跳出率',
            'AI访问次数',
            '操作',
          ]}
          numeric={[3, 4, 5, 6]}
          static={[3, 4, 5, 6]}
          search
          onRowClick={(_, index) =>
            c.navigate('overview', { websiteId: websiteHandle(c.sites[index]) })
          }
          rows={c.sites.map(site => {
            const stat =
              stats.find(row => row.id === site.id) ||
              (query.error ? { error: query.error } : undefined);
            const day = todayStats.find(row => row.id === site.id);
            const dayRead = day && !day.error ? day : null;
            const yesterday = dayRead ? dayRead.comparison : null;
            return [
              <>
                <Link
                  className="table-title"
                  href={c.href('overview', { websiteId: websiteHandle(site) })}
                >
                  {site.name}
                </Link>
                <span className="table-meta">{site.domain}</span>
              </>,
              <TableCell
                sortValue={
                  c.teams.find(team => team.id === site.teamId)?.name ||
                  (site.teamId ? i18n.source('团队空间') : i18n.source('个人空间'))
                }
                searchValue={
                  c.teams.find(team => team.id === site.teamId)?.name ||
                  (site.teamId ? i18n.english.text('团队空间') : i18n.english.text('个人空间'))
                }
              >
                {c.teams.find(team => team.id === site.teamId)?.name ||
                  (site.teamId ? i18n.text('团队空间') : i18n.text('个人空间'))}
              </TableCell>,
              <TableCell
                sortValue={
                  stat?.error
                    ? errorLabel(stat.error)
                    : stat?.received
                      ? i18n.source('已收到浏览数据')
                      : stat
                        ? i18n.source('待验证')
                        : i18n.source('等待查询')
                }
                searchValue={i18n.english.system(
                  stat?.error
                    ? errorLabel(stat.error)
                    : stat?.received
                      ? i18n.english.text('已收到浏览数据')
                      : stat
                        ? i18n.english.text('待验证')
                        : i18n.english.text('等待查询'),
                )}
              >
                <Badge
                  key="badge"
                  tone={
                    stat?.error
                      ? [401, 403].includes(stat.error.status)
                        ? 'gray'
                        : 'red'
                      : stat?.received
                        ? 'green'
                        : 'amber'
                  }
                >
                  {stat?.error
                    ? errorLabel(stat.error)
                    : stat?.received
                      ? i18n.text('已收到浏览数据')
                      : stat
                        ? i18n.text('待验证')
                        : i18n.text('等待查询')}
                </Badge>
              </TableCell>,
              <MetricRows
                key="views"
                loading={todayQuery.isPending}
                kind="count"
                timezone={c.range.timezone}
                readAt={readAt}
                today={dayRead ? dayRead.views : null}
                yesterday={yesterday ? yesterday.pageviews : null}
              />,
              <MetricRows
                key="visitors"
                loading={todayQuery.isPending}
                kind="count"
                labels={false}
                timezone={c.range.timezone}
                readAt={readAt}
                today={dayRead ? dayRead.visitors : null}
                yesterday={yesterday ? yesterday.visitors : null}
              />,
              <MetricRows
                key="bounce"
                loading={todayQuery.isPending}
                kind="percent"
                labels={false}
                timezone={c.range.timezone}
                readAt={readAt}
                today={dayRead ? bounceRateLabel(dayRead) : null}
                yesterday={yesterday ? bounceRateLabel(yesterday) : null}
              />,
              <MetricRows
                key="ai"
                loading={todayQuery.isPending}
                kind="count"
                labels={false}
                timezone={c.range.timezone}
                readAt={readAt}
                today={dayRead ? dayRead.aiVisits : null}
                yesterday={yesterday ? yesterday.aiVisits : null}
              />,
              <TableCell
                sortValue={[i18n.source('网站设置'), i18n.source('查看统计')]}
                searchValue={[i18n.english.text('网站设置'), i18n.english.text('查看统计')]}
              >
                <div className="actions" key="actions" onClick={event => event.stopPropagation()}>
                  <LinkButton page="website-settings" params={{ websiteId: websiteHandle(site) }}>
                    {i18n.text('网站设置')}
                  </LinkButton>
                  <LinkButton page="overview" params={{ websiteId: websiteHandle(site) }}>
                    {i18n.text('查看统计')}
                  </LinkButton>
                </div>
              </TableCell>,
            ];
          })}
          empty={i18n.text('还没有网站。添加网站后安装专用跟踪代码。')}
        />
        <p className="metric-note">
          {i18n.fragment(
            '口径：访问次数为页面浏览 PV；访客数与跳出率按会话统计；AI访问次数为 AI 搜索引荐会话；预计今日按当天已流逝进度折算，跳出率不提供预计值。 今日与预计今日对应',
            false,
            true,
          )}{' '}
          {formatInTimeZone(readAt, c.range.timezone, 'yyyy-MM-dd')}。
        </p>
      </Panel>
      {partial && (
        <Notice tone="amber">
          {i18n.fragment('统计汇总尚未读全。卡片仅统计已读取的 ', false, true)}
          {readable.length} / {c.sites.length}{' '}
          {i18n.fragment('个网站，未读取网站的数值显示“—”。', true, true)}
          <div className="form-actions">
            <Button disabled={query.isFetching} onClick={() => query.refetch()}>
              {i18n.text('重新读取统计')}
            </Button>
          </div>
        </Notice>
      )}
      <Notice>
        {i18n.text(
          '浏览采集状态根据真实浏览访问展示。日志、内容目录与行为录制可在各网站的设置中分别检查。',
        )}
      </Notice>
    </>
  );
}
function Onboarding() {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    action = useAction();
  const [created, setCreated] = useState<FeatureEntity>(null);
  const [step, setStep] = useState(1);
  const install = useInstall(created?.id, created?.createdAt);
  const teams = teamCandidates(c, 'create');
  const requestedTeam = c.route.teamId;
  const permittedTeam = teams.find(team => team.id === requestedTeam);
  const [space, setSpace] = useState(permittedTeam?.id || '');
  useEffect(() => setSpace(permittedTeam?.id || ''), [requestedTeam, permittedTeam?.id]);
  const received = !install.error && install.data?.pageviews > 0;
  const createdScope = created
    ? c.teams.find(team => team.id === created.teamId)?.name ||
      created.scopeName ||
      (created.teamId ? '团队空间' : '个人空间')
    : '';
  return (
    <div className="wide-narrow">
      <Panel title={i18n.text('接入一个新网站')} subtitle={i18n.text('三步完成创建、安装与验证。')}>
        <ol className="steps">
          {[i18n.text('网站信息'), i18n.text('安装脚本'), i18n.text('验证接入')].map((title, i) => (
            <li key={title} className={i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}>
              <span className="step-number">{i + 1 < step ? '✓' : i + 1}</span>
              {i18n.system(title)}
            </li>
          ))}
        </ol>
        <Body>
          {created && (
            <Definition
              items={[
                [i18n.text('网站名称'), created.name],
                [i18n.text('域名'), created.domain],
                [i18n.text('所属空间'), createdScope],
              ]}
            />
          )}
          {step === 1 ? (
            <Form
              busy={action.busy}
              error={action.error}
              disabled={c.user.role === 'view-only'}
              submitLabel={i18n.text('创建并继续')}
              cancel={<LinkButton page="websites">{i18n.text('取消')}</LinkButton>}
              onSubmit={async values => {
                if (c.user.role === 'view-only') throw new Error('当前角色没有创建网站权限。');
                const destination = teams.find(team => team.id === values.space);
                if (values.space && !destination)
                  throw new Error(
                    '当前账户没有在所选团队创建网站的权限。请选择个人空间或有权限的团队。',
                  );
                const site = await action.run(
                  () =>
                    c.api.post<FeatureEntity>('/websites', {
                      name: values.name,
                      domain: values.domain,
                      ...(values.space && { teamId: values.space }),
                    }),
                  '网站已创建',
                );
                if (!site?.id) throw new Error('创建响应缺少网站标识，请重新读取网站列表。');
                setCreated({
                  ...site,
                  teamId: site.teamId || destination?.id,
                  scopeName: destination?.name || '个人空间',
                });
                setStep(2);
              }}
            >
              {c.user.role === 'view-only' && (
                <Notice tone="amber">{i18n.text('当前角色没有创建网站权限。')}</Notice>
              )}
              {requestedTeam && !permittedTeam && (
                <Notice tone="amber">
                  {i18n.text(
                    '当前账户没有在所选团队创建网站的权限，所属空间已选为个人空间。请核对后继续。',
                  )}
                </Notice>
              )}
              <div className="form-grid">
                <Field
                  label={i18n.text('网站名称')}
                  name="name"
                  required
                  maxLength={100}
                  help={i18n.text('显示在侧栏和管理列表中。')}
                />
                <Field
                  label={i18n.text('域名')}
                  name="domain"
                  required
                  maxLength={500}
                  help={i18n.text('输入域名，如 example.com，无需 https://。')}
                />
              </div>
              <Select
                label={i18n.text('所属空间')}
                name="space"
                value={space}
                onChange={event => setSpace(event.target.value)}
                options={[
                  ['', i18n.text('个人空间')],
                  ...teams.map(team => [team.id, team.name] as [string, string]),
                ]}
              />
              <Notice tone="blue">
                {i18n.text('下一步会生成当前网站专用代码。网站名称和域名可在设置中修改。')}
              </Notice>
            </Form>
          ) : step === 2 ? (
            <>
              <Notice tone="blue">
                {i18n.text(
                  '网站已创建，浏览采集待验证。将下方脚本放入每个需要统计页面的 head 区域。',
                )}
              </Notice>
              <TrackingCode websiteId={created.id} />
              <div className="form-actions">
                <LinkButton page="website-settings" params={{ websiteId: created.id }}>
                  {i18n.text('编辑网站信息')}
                </LinkButton>
                <Button onClick={() => setStep(3)}>{i18n.text('检查安装（可选）')}</Button>
                <LinkButton
                  page="website-settings"
                  params={installationParams(created.id, 'js')}
                  primary
                >
                  {i18n.text('继续接入设置')}
                </LinkButton>
              </div>
            </>
          ) : (
            <>
              <Badge tone={install.error ? 'red' : received ? 'green' : 'amber'}>
                {install.error
                  ? i18n.text('读取失败')
                  : install.isPending
                    ? i18n.text('正在检查')
                    : received
                      ? i18n.text('已收到浏览数据')
                      : i18n.text('待验证')}
              </Badge>
              <hr className="divider" />
              <QueryState query={install}>
                <InstallSteps query={install} websiteId={created.id} />
              </QueryState>
              <div className="form-actions">
                <Button onClick={() => setStep(2)}>{i18n.text('返回安装代码')}</Button>
                <LinkButton page="website-settings" params={installationParams(created.id, 'js')}>
                  {i18n.text('跳过检查，继续设置')}
                </LinkButton>
                <Button primary disabled={install.isFetching} onClick={() => install.refetch()}>
                  {i18n.text('检查真实访问')}
                </Button>
                {received && (
                  <LinkButton page="overview" params={{ websiteId: created.id }} primary>
                    {i18n.text('查看该网站统计')}
                  </LinkButton>
                )}
              </div>
            </>
          )}
        </Body>
      </Panel>
      <Panel
        title={i18n.text('接入说明')}
        subtitle={i18n.text('从访问统计开始，逐步开启行为采集。')}
      >
        <Body>
          <ol style={{ paddingLeft: 20 }} className="stack">
            <li>{i18n.text('HTML 和常见框架使用同一网站标识。')}</li>
            <li>{i18n.text('首次接入后打开网站，等待首条访问。')}</li>
            <li>{i18n.text('回放与热力图需另外开启行为采集。')}</li>
          </ol>
          <hr className="divider" />
          {created ? (
            <div className="row">
              <LinkButton page="tracking" params={{ websiteId: created.id }}>
                {i18n.text('查看安装说明')}
              </LinkButton>
              <LinkButton page="recorder-settings" params={{ websiteId: created.id }}>
                {i18n.text('采集与隐私设置')}
              </LinkButton>
            </div>
          ) : (
            <p className="muted">{i18n.text('创建网站后可查看该网站的安装代码与采集设置。')}</p>
          )}
        </Body>
      </Panel>
    </div>
  );
}
function Tracking({ check = false }: { check?: boolean }) {
  const c = useFeature();
  const site = useSiteRecord();
  const install = useInstall(c.siteId, site.data?.createdAt);
  if (!c.siteId) return <MissingWebsite />;
  return (
    <QueryState query={site}>
      {site.data && (
        <Installation
          key={`${site.data.id}:${c.user.id}`}
          site={site.data}
          browser={install}
          manage={canManageSite(c, site.data)}
          entry={check ? 'check' : 'js'}
        />
      )}
    </QueryState>
  );
}
const websiteSections: [string, string][] = [
  ['basic', '基本信息'],
  ['install', '安装接入'],
  ['collection', '采集设置'],
  ['sharing', '分享设置'],
  ['danger', '危险操作'],
];
function setupState(query: any, state?: DataState, available = '已收到数据', absent = '尚未接入') {
  if (query.error)
    return (query.error as any).status === 401
      ? '需要重新登录'
      : (query.error as any).status === 403
        ? '无查看权限'
        : '读取失败';
  if (query.isPending) return '正在检查';
  if (!query.data || !state) return '状态未验证';
  return {
    available,
    empty: '当前范围无数据',
    not_connected: absent,
    unavailable: '身份指标不可用',
    unsupported: '当前实例不支持',
    estimated: '估算数据',
  }[state];
}
function SetupStatus({
  browser,
  report,
  site,
}: {
  browser: any;
  report: any;
  site: FeatureEntity;
}) {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const received = !browser.error && browser.data?.pageviews > 0;
  const browserState = setupState(
    browser,
    browser.data ? (received ? 'available' : 'empty') : undefined,
    '已收到浏览数据',
  );
  const config = site.replayConfig || {};
  return (
    <Panel
      title={i18n.text('采集状态')}
      subtitle={i18n.text('分别检查浏览访问、服务器日志、内容目录与行为录制。')}
    >
      <Body>
        <p className="field-help">
          {i18n.fragment('浏览采集核对网站创建至今的页面访问。日志统计期间：', false, true)}
          {formatInTimeZone(c.range.startAt, c.range.timezone || 'Asia/Shanghai', 'yyyy-MM-dd')}
          {i18n.fragment(' 至', true, true)}{' '}
          {formatInTimeZone(c.range.endAt, c.range.timezone || 'Asia/Shanghai', 'yyyy-MM-dd')} ·{' '}
          {c.range.timezone}。
        </p>
        <Definition
          items={[
            [
              i18n.text('浏览采集'),
              browserState === '当前范围无数据'
                ? i18n.text('尚未收到浏览数据')
                : i18n.system(browserState),
            ],
            [
              i18n.text('日志采集'),
              i18n.system(
                setupState(
                  report,
                  report.data?.states?.logs,
                  i18n.text('已收到日志数据'),
                  i18n.text('尚未导入日志'),
                ),
              ),
            ],
            [
              i18n.text('内容目录'),
              i18n.system(
                setupState(
                  report,
                  report.data?.states?.catalog,
                  i18n.text('已有内容目录'),
                  i18n.text('尚未导入内容目录'),
                ),
              ),
            ],
            [
              i18n.text('行为录制'),
              i18n.text('回放{v0} · 热力图{v1} · 数据状态未验证', [
                config.replayEnabled === true ? i18n.text('已启用') : i18n.text('未启用'),
                config.heatmapEnabled === true ? i18n.text('已启用') : i18n.text('未启用'),
              ]),
            ],
          ]}
        />
        {report.data?.meta?.latestImportAt && !report.error && (
          <p className="field-help">
            {i18n.fragment('最近导入日志：', false, true)}
            {formatDate(report.data.meta.latestImportAt, c.range.timezone)}
          </p>
        )}
        {report.data?.meta?.demo && !report.error && (
          <Notice tone="amber">{i18n.text('日志与内容目录状态包含当前网站的演示数据。')}</Notice>
        )}
        <div className="form-actions">
          <Button
            disabled={browser.isFetching || report.isFetching}
            onClick={async () => Promise.all([browser.refetch(), report.refetch()])}
          >
            {i18n.text('重新检查采集状态')}
          </Button>
        </div>
      </Body>
    </Panel>
  );
}
function WebsiteSettings() {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    query = useSiteRecord(),
    action = useAction();
  const section = websiteSections.some(([id]) => id === c.query.section)
    ? c.query.section
    : 'basic';
  const install = useInstall(c.siteId, query.data?.createdAt);
  const report = useData<LiekanReport>(
    ['website-setup-report', c.siteId, c.range.startAt, c.range.endAt, c.range.timezone],
    signal =>
      c.api.get(
        `/liekan/websites/${c.siteId}/report`,
        { resource: 'overview', ...c.range },
        signal,
      ),
    !!c.siteId && ['install', 'collection'].includes(section),
  );
  const [drawer, setDrawer] = useState('');
  useEffect(() => {
    setDrawer(
      section === 'collection' && c.query.panel === 'traffic-quality' ? 'traffic-quality' : '',
    );
  }, [c.siteId, section, c.query.panel]);
  const site = query.data,
    manage = canManageSite(c, site),
    teams = teamCandidates(c, 'transfer'),
    transfer = canTransferSite(c, site);
  const collectionActions = [
    '导入日志',
    'sitemap 管理',
    'robots.txt 编辑',
    '蜘蛛白名单',
    '特征库管理',
  ];
  if (!c.siteId) return <MissingWebsite />;
  return (
    <QueryState query={query}>
      {site && (
        <>
          <Tabs
            items={websiteSections.map(([id, label]) => [id, i18n.system(label)])}
            active={section}
            onChange={next => c.navigate('website-settings', { websiteId: site.id, section: next })}
          />
          {manage && (
            <Panel
              title={i18n.text('历史数据修复')}
              subtitle={i18n.text('本次升级专项：扫描、预览并确认旧数据的爬虫识别修正。')}
            >
              <Body>
                <LinkButton page="analytics-acceleration" params={{ websiteId: site.id }}>
                  {i18n.text('统计加速')}
                </LinkButton>
                <LinkButton page="history-repair" params={{ websiteId: site.id }}>
                  {i18n.text('查看历史数据修复')}
                </LinkButton>
              </Body>
            </Panel>
          )}
          {section === 'basic' ? (
            <>
              <div className="two">
                <Panel
                  title={i18n.text('基本信息')}
                  subtitle={i18n.text('编辑名称和域名不改变网站标识。')}
                >
                  <Body>
                    {!manage && <ReadonlyNotice />}
                    <Form
                      key={site.id}
                      resetKey={`${site.name}:${site.domain}`}
                      busy={action.busy}
                      error={action.error}
                      disabled={!manage}
                      submitLabel={i18n.text('保存网站设置')}
                      onSubmit={async values => {
                        if (!manage) throw new Error('需要网站管理权限。');
                        await action.run(
                          () =>
                            c.api.post(sitePath(site.id), {
                              name: values.name,
                              domain: values.domain,
                            }),
                          `「${values.name}」的网站设置已保存`,
                        );
                      }}
                    >
                      <Field
                        label={i18n.text('网站 ID')}
                        name="id"
                        defaultValue={site.id}
                        readOnly
                        help={i18n.text('当前网站的永久标识。')}
                      />
                      <Field
                        label={i18n.text('网站名称')}
                        name="name"
                        defaultValue={site.name}
                        required
                        readOnly={!manage}
                        maxLength={100}
                      />
                      <Field
                        label={i18n.text('域名')}
                        name="domain"
                        defaultValue={site.domain}
                        required
                        readOnly={!manage}
                        maxLength={500}
                      />
                    </Form>
                  </Body>
                </Panel>
                <Panel
                  title={i18n.text('网站归属')}
                  subtitle={i18n.text('在当前网站的设置中管理安装、采集与分享。')}
                >
                  <Body>
                    <Definition
                      items={[
                        [
                          i18n.text('所属空间'),
                          c.teams.find(team => team.id === site.teamId)?.name ||
                            (site.teamId ? i18n.text('团队空间') : i18n.text('个人空间')),
                        ],
                        [
                          i18n.text('公开分享'),
                          site.shareId ? i18n.text('已启用') : i18n.text('未启用'),
                        ],
                      ]}
                    />
                    <div className="form-actions">
                      <LinkButton page="overview" params={{ websiteId: site.id }}>
                        {i18n.text('查看该网站统计')}
                      </LinkButton>
                      <LinkButton
                        page="sharing"
                        params={{ websiteId: site.id, context: 'website' }}
                      >
                        {i18n.text('分享设置')}
                      </LinkButton>
                    </div>
                  </Body>
                </Panel>
              </div>
              <CrawlerDisplaySettings key={`${site.id}:${c.user.id}`} manage={manage} />
              <InstallationEntry key={`${site.id}:${c.user.id}`} site={site} browser={install} />
            </>
          ) : section === 'install' ? (
            <Installation
              key={`${site.id}:${c.user.id}`}
              site={site}
              browser={install}
              manage={manage}
            />
          ) : section === 'collection' ? (
            <>
              <SetupStatus browser={install} report={report} site={site} />
              <div className="two">
                <Panel
                  title={i18n.text('行为采集')}
                  subtitle={i18n.text('管理回放、热力图、采样与隐私规则。')}
                >
                  <Body>
                    <p className="muted">
                      {i18n.text(
                        '采集开关显示保存的配置。数据是否已收到，需要在对应分析页面检查。',
                      )}
                    </p>
                    <div className="form-actions">
                      <LinkButton page="recorder-settings" params={{ websiteId: site.id }}>
                        {i18n.text('回放与热力图设置')}
                      </LinkButton>
                      <LinkButton page="replays" params={{ websiteId: site.id }}>
                        {i18n.text('查看会话回放')}
                      </LinkButton>
                      <LinkButton page="heatmaps" params={{ websiteId: site.id }}>
                        {i18n.text('查看热力图')}
                      </LinkButton>
                    </div>
                  </Body>
                </Panel>
                <Panel
                  title={i18n.text('日志与内容目录')}
                  subtitle={i18n.text('导入当前网站的日志和内容页面资料。')}
                >
                  <Body>
                    {!manage && <ReadonlyNotice />}
                    <div className="form-actions">
                      <Button disabled={!manage} onClick={() => setDrawer('导入日志')}>
                        {i18n.text('导入网站日志')}
                      </Button>
                      <Button disabled={!manage} onClick={() => setDrawer('sitemap 管理')}>
                        {i18n.text('管理内容目录')}
                      </Button>
                    </div>
                  </Body>
                </Panel>
                <Panel
                  title={i18n.text('蜘蛛识别与访问策略')}
                  subtitle={i18n.text('管理当前网站的 robots.txt、CIDR 白名单和蜘蛛识别规则。')}
                >
                  <Body>
                    <p className="muted">
                      {i18n.text('robots.txt 保存后可下载，由网站管理员部署到目标网站。')}
                    </p>
                    <div className="form-actions">
                      {collectionActions.slice(2).map(item => (
                        <Button
                          key={item}
                          disabled={!manage}
                          onClick={() =>
                            item === '特征库管理'
                              ? c.navigate('crawlers-manage', { site: site.id })
                              : setDrawer(item)
                          }
                        >
                          {i18n.system(managementLabels[item])}
                        </Button>
                      ))}
                      <Button onClick={() => setDrawer('crawler')}>
                        {i18n.text('归因、风险与访问控制')}
                      </Button>
                      <Button onClick={() => setDrawer('traffic-quality')}>
                        {i18n.text('浏览流量质量')}
                      </Button>
                    </div>
                  </Body>
                </Panel>
              </div>
            </>
          ) : section === 'sharing' ? (
            <WebsiteSharing />
          ) : (
            <div className="two">
              <Panel
                title={i18n.text('转移网站')}
                subtitle={i18n.text('保留历史数据，变更资源所属空间。')}
              >
                <Body>
                  <p className="muted">
                    {i18n.text('只有拥有相应团队管理权限的成员可以转移网站。')}
                  </p>
                  <div className="form-actions">
                    <Button disabled={!transfer} onClick={() => setDrawer('transfer')}>
                      {i18n.text('转移网站')}
                    </Button>
                  </div>
                </Body>
              </Panel>
              <Panel
                title={i18n.text('清空访问数据')}
                subtitle={i18n.text('保留网站标识、内容目录、策略与设置。')}
              >
                <Body>
                  <p className="muted">
                    {i18n.text(
                      '清空浏览访问、事件、会话、回放、热力图、收入记录，以及 GEOInflow 日志与导入记录。',
                    )}
                  </p>
                  <div className="form-actions">
                    <Button danger disabled={!manage} onClick={() => setDrawer('reset')}>
                      {i18n.text('清空访问数据')}
                    </Button>
                  </div>
                </Body>
              </Panel>
              <Panel
                title={i18n.text('删除网站')}
                subtitle={i18n.text('删除当前网站及其关联数据和设置。')}
              >
                <Body>
                  <p className="muted">{i18n.text('删除后无法恢复，请先核对当前网站。')}</p>
                  <div className="form-actions">
                    <Button danger disabled={!manage} onClick={() => setDrawer('delete')}>
                      {i18n.text('删除网站')}
                    </Button>
                  </div>
                </Body>
              </Panel>
            </div>
          )}
          {drawer === 'crawler' ? (
            <CrawlerDialog
              key={site.id}
              websiteId={site.id}
              websiteName={site.name}
              websiteDomain={site.domain}
              onClose={() => setDrawer('')}
            />
          ) : drawer === 'traffic-quality' ? (
            <TrafficQuality key={site.id} canManage={manage} onClose={() => setDrawer('')} />
          ) : collectionActions.includes(drawer) ? (
            <ManagementDrawer
              key={`${site.id}:${drawer}`}
              action={drawer}
              websiteId={site.id}
              websiteName={site.name}
              websiteDomain={site.domain}
              canManage={manage}
              onClose={() => setDrawer('')}
              onSaved={async () => {
                const results = await Promise.allSettled([
                  c.refresh(),
                  report.refetch({ throwOnError: true }),
                ]);
                const failure = results.find(result => result.status === 'rejected');
                if (failure) throw failure.reason;
              }}
              onSearch={search => c.navigate('geo-logs', { websiteId: site.id, search })}
              onRange={(start, end) =>
                c.navigate('geo-logs', { websiteId: site.id, date: `range:${start}:${end}` })
              }
              report={report.error ? undefined : report.data}
            />
          ) : (
            drawer && (
              <LiekanDialog
                subtitle={site.name + ' · ' + site.domain}
                title={i18n.system(
                  drawer === 'transfer'
                    ? i18n.text('转移网站所属空间')
                    : drawer === 'reset'
                      ? i18n.text('清空访问数据')
                      : i18n.text('删除网站'),
                )}
                onClose={() => setDrawer('')}
              >
                <Form
                  busy={action.busy}
                  error={action.error}
                  disabled={drawer === 'transfer' ? !transfer : !manage}
                  danger={drawer !== 'transfer'}
                  submitLabel={i18n.system(
                    drawer === 'transfer'
                      ? i18n.text('转移网站')
                      : drawer === 'reset'
                        ? i18n.text('清空访问数据')
                        : i18n.text('删除网站'),
                  )}
                  onSubmit={async values => {
                    if (!manage) throw new Error('需要网站管理权限。');
                    if (drawer === 'transfer') {
                      if (
                        !transfer ||
                        (!site.teamId && !teams.some(team => team.id === values.teamId))
                      )
                        throw new Error('需要相应的网站转移权限。');
                      await action.run(
                        () =>
                          c.api.post(
                            `${sitePath(site.id)}/transfer`,
                            site.teamId ? { userId: c.user.id } : { teamId: values.teamId },
                          ),
                        `「${site.name}」已转移`,
                      );
                    } else {
                      const expected = drawer === 'reset' ? 'RESET' : site.name;
                      if (values.confirmation !== expected) throw new Error('确认内容不匹配。');
                      await action.run(
                        () =>
                          drawer === 'reset'
                            ? c.api.post(`${sitePath(site.id)}/reset`)
                            : c.api.del(sitePath(site.id)),
                        drawer === 'reset'
                          ? `「${site.name}」的访问数据已清空`
                          : `「${site.name}」已删除`,
                        drawer === 'delete'
                          ? {
                              navigateTo: 'websites',
                              notice: {
                                kind: 'website-deleted',
                                name: site.name,
                                domain: site.domain,
                              },
                            }
                          : undefined,
                      );
                    }
                    setDrawer('');
                  }}
                >
                  {drawer === 'transfer' ? (
                    <>
                      <Field
                        label={i18n.text('当前空间')}
                        value={
                          site.teamId
                            ? c.teams.find(team => team.id === site.teamId)?.name || '团队空间'
                            : '个人空间'
                        }
                        readOnly
                      />
                      {site.teamId ? (
                        <Notice tone="amber">
                          {i18n.text(
                            '网站将转移到当前账户的个人空间。网站标识和历史数据保持一致。',
                          )}
                        </Notice>
                      ) : (
                        <>
                          <Select
                            label={i18n.text('目标空间')}
                            name="teamId"
                            options={teams.map(team => [team.id, team.name])}
                            required
                          />
                          <Notice tone="amber">
                            {i18n.text('仅可转移到当前账户拥有管理权限的团队。')}
                          </Notice>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <Notice tone="red">
                        {drawer === 'reset'
                          ? i18n.text(
                              '将清空「{v0}」的浏览访问、事件、会话、回放、热力图、收入记录，以及 GEOInflow 日志与导入记录。内容目录、策略、网站设置和安装标识继续保留。此操作无法恢复。',
                              [site.name],
                            )
                          : i18n.text('将删除「{v0}」及其关联数据和设置。此操作无法恢复。', [
                              site.name,
                            ])}
                      </Notice>
                      <Field
                        label={i18n.text('输入 {v0} 确认', [
                          drawer === 'reset' ? 'RESET' : site.name,
                        ])}
                        name="confirmation"
                        required
                        autoComplete="off"
                      />
                    </>
                  )}
                </Form>
              </LiekanDialog>
            )
          )}
        </>
      )}
    </QueryState>
  );
}
function RecorderSettings() {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    query = useSiteRecord(),
    action = useAction();
  const config = query.data?.replayConfig || {},
    manage = canManageSite(c, query.data);
  if (!c.siteId) return <MissingWebsite />;
  return (
    <div className="wide-narrow">
      <Panel
        title={i18n.text('回放与热力图')}
        subtitle={i18n.text('先选择采集能力，再设置采样与隐私规则。')}
      >
        <Body>
          <QueryState query={query}>
            {query.data && (
              <Form
                key={c.siteId}
                resetKey={JSON.stringify(config)}
                busy={action.busy}
                error={action.error}
                disabled={!manage}
                submitLabel={i18n.text('保存采集配置')}
                onSubmit={async values => {
                  if (!manage) throw new Error('需要网站管理权限。');
                  await action.run(() => c.api.post(sitePath(c.siteId), recorderPayload(values)));
                }}
              >
                {!manage && <ReadonlyNotice />}
                <Switch
                  label={i18n.text('启用会话回放')}
                  help={i18n.text('录制访问过程，默认遮蔽输入内容。')}
                  name="replay"
                  defaultChecked={config.replayEnabled === true}
                  disabled={!manage}
                />
                <Switch
                  label={i18n.text('启用热力图')}
                  help={i18n.text('记录点击与滚动，按页面聚合。')}
                  name="heatmap"
                  defaultChecked={config.heatmapEnabled === true}
                  disabled={!manage}
                />
                <div className="form-grid">
                  <Field
                    label={i18n.text('回放采样率 (%)')}
                    name="replayRate"
                    type="number"
                    defaultValue={(config.sampleRate ?? 0.15) * 100}
                    min={5}
                    max={100}
                    step={1}
                    required
                    readOnly={!manage}
                    help={i18n.text('范围 5% 至 100%。')}
                  />
                  <Field
                    label={i18n.text('热力图采样率 (%)')}
                    name="heatRate"
                    type="number"
                    defaultValue={(config.heatmapSampleRate ?? 0.15) * 100}
                    min={5}
                    max={100}
                    step={1}
                    required
                    readOnly={!manage}
                    help={i18n.text('范围 5% 至 100%。')}
                  />
                  <Select
                    label={i18n.text('隐私遮蔽级别')}
                    name="mask"
                    options={[
                      ['strict', i18n.text('严格：遮蔽文字与输入')],
                      ['moderate', i18n.text('标准：遮蔽输入内容')],
                    ]}
                    localizeLabels
                    defaultValue={config.maskLevel || 'strict'}
                    disabled={!manage}
                  />
                  <Select
                    label={i18n.text('最长录制时长')}
                    name="duration"
                    options={[
                      ['5', i18n.text('5 分钟')],
                      ['10', i18n.text('10 分钟')],
                      ['15', i18n.text('15 分钟')],
                      ['20', i18n.text('20 分钟')],
                    ]}
                    localizeLabels
                    defaultValue={String((config.maxDuration || 300000) / 60000)}
                    disabled={!manage}
                  />
                </div>
                <Field
                  label={i18n.text('排除元素选择器')}
                  name="blockSelector"
                  defaultValue={config.blockSelector || ''}
                  help={i18n.text('匹配元素不进入回放。')}
                  readOnly={!manage}
                />
                <TrackingCode websiteId={query.data.id} file="recorder.js" />
              </Form>
            )}
          </QueryState>
        </Body>
      </Panel>
      <Panel title={i18n.text('采集范围')} subtitle={i18n.text('按保存后的采样与隐私配置采集。')}>
        <Body>
          <Notice tone="amber">
            {i18n.text(
              '新网站默认关闭行为采集。开启后安装 recorder.js，输入内容按配置遮蔽。数据在收到真实访问后展示。',
            )}
          </Notice>
          <hr className="divider" />
          <div className="stack">
            <LinkButton page="heatmaps" params={{ websiteId: c.siteId }}>
              {i18n.text('查看热力图')}
            </LinkButton>
            <LinkButton page="replays" params={{ websiteId: c.siteId }}>
              {i18n.text('查看会话回放')}
            </LinkButton>
            <LinkButton page="tracking" params={{ websiteId: c.siteId }}>
              {i18n.text('跟踪代码')}
            </LinkButton>
          </div>
        </Body>
      </Panel>
    </div>
  );
}

export function FeatureAuthPage({ page }: { page: 'login' | 'login-2fa' | 'sso' }) {
  const i18n = useLiekanI18n();
  const router = useRouter(),
    search = useSearchParams();
  const [busy, setBusy] = useState(false),
    [restoring, setRestoring] = useState(page === 'login'),
    [error, setError] = useState(''),
    [method, setMethod] = useState('otp');
  const [lockedUntil, setLockedUntil] = useState(0),
    [now, setNow] = useState(Date.now());
  const started = useRef(false);
  useEffect(() => {
    if (page !== 'login') return;
    const controller = new AbortController();
    setRestoring(true);
    resumeFeatureLogin(controller.signal)
      .then(path => {
        if (!controller.signal.aborted && path) router.replace(appPath(path));
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('暂时无法恢复登录，请重试或重新登录。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setRestoring(false);
      });
    return () => controller.abort();
  }, [page, router]);
  useEffect(() => {
    if (page === 'login-2fa' && !sessionStorage.getItem('umami.partial-token'))
      router.replace('/login');
  }, [page, router]);
  useEffect(() => {
    if (!lockedUntil) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [lockedUntil]);
  useEffect(() => {
    if (page !== 'sso' || started.current) return;
    const token = search.get('token'),
      url = safeCallbackUrl(search.get('url'));
    if (!token) {
      setError('未收到身份提供方返回的登录凭据。请重新发起登录。');
      return;
    }
    if (!url) {
      setError('回调地址无效。请重新发起登录。');
      return;
    }
    started.current = true;
    setBusy(true);
    verifyFeatureSso(token)
      .then(() => router.replace(appPath(url)))
      .catch((error: any) => {
        clearFeatureLogin();
        setError(error.message || '单点登录验证失败。');
      })
      .finally(() => setBusy(false));
  }, [page, search, router]);
  async function submit(values: Record<string, string>) {
    setBusy(true);
    setError('');
    try {
      const response =
        page === 'login'
          ? await featureApi.post('/auth/login', {
              username: values.username,
              password: values.password,
            })
          : await verifyFeatureTwoFactor(
              method === 'backup' ? { backupCode: values.token } : { token: values.token },
            );
      router.replace(appPath(acceptFeatureLogin(response)));
    } catch (error: any) {
      const locked = error.details?.lockedUntil || error.lockedUntil;
      if (locked) setLockedUntil(new Date(locked).getTime());
      setError(error.message || '登录失败，请重试。');
      throw error;
    } finally {
      setBusy(false);
    }
  }
  const locked = lockedUntil > now;
  const title = page === 'login' ? '欢迎回来' : page === 'login-2fa' ? '验证登录' : '单点登录';
  const description =
    page === 'login'
      ? '登录GEOInflow，查看 AI 与搜索流量。'
      : page === 'login-2fa'
        ? '完成验证后进入工作台。'
        : '正在等待身份提供方回调。';
  return (
    <div data-liekan-features>
      <div className="auth-page">
        <aside data-liekan-auth-copy className="auth-info">
          <Link prefetch={false} className="auth-brand" href="/">
            <img src={`${basePath}/liekan/features/logo.svg`} alt="" />
            <span className="brand-name" style={{ color: 'var(--ink)' }}>
              {liekanProduct.name}
              <span className="brand-caption">{liekanProduct.caption}</span>
            </span>
          </Link>
          <div className="auth-intro">
            <h1>
              {i18n.fragment('从 AI 与搜索访问，', false, true)}
              <br />
              {i18n.fragment('看见内容的增长路径', true, false)}
            </h1>
            <p>{i18n.text('把访问来源、内容表现和目标转化放在同一处，理解每一步增长。')}</p>
            <div className="auth-feature">
              {i18n.fragment('AI 引荐 · 传统搜索 · 内容转化', false, true)}
              <br />
              {liekanProduct.name}
            </div>
          </div>
          <small>{i18n.text('GEOInflow · MIT 开源')}</small>
        </aside>
        <main className="auth-main" id="main-content">
          <div className="auth-form">
            <Badge key="badge" tone="blue">
              {liekanProduct.name}
            </Badge>
            <h1>{i18n.system(title)}</h1>
            <p className="sub">{i18n.system(description)}</p>
            {page === 'sso' ? (
              <>
                <div style={{ margin: '24px 0' }}>
                  <Notice tone={error ? 'red' : 'blue'}>
                    {i18n.system(error) ||
                      (busy ? i18n.text('正在验证登录凭据。') : i18n.text('等待登录验证。'))}
                  </Notice>
                </div>
                <div className="stack">
                  <Link prefetch={false} className="btn" href="/login">
                    {i18n.text('返回用户名登录')}
                  </Link>
                </div>
              </>
            ) : (
              <>
                {page === 'login-2fa' && (
                  <Tabs
                    items={[
                      ['otp', i18n.text('验证器验证码')],
                      ['backup', i18n.text('恢复码')],
                    ]}
                    active={method}
                    onChange={value => {
                      setMethod(value);
                      setError('');
                    }}
                  />
                )}
                {locked && (
                  <Notice tone="amber">
                    {i18n.fragment('尝试次数过多，请在 ', false, true)}
                    {formatDate(lockedUntil)}
                    {i18n.fragment(' 后重试。', true, false)}
                  </Notice>
                )}
                <Form
                  key={method}
                  onSubmit={submit}
                  busy={busy || locked || restoring}
                  error={i18n.system(error)}
                  submitLabel={i18n.system(
                    page === 'login' ? i18n.text('登录') : i18n.text('确认登录'),
                  )}
                  cancel={
                    page === 'login-2fa' ? (
                      <Link prefetch={false} className="btn" href="/login">
                        {i18n.text('返回登录')}
                      </Link>
                    ) : undefined
                  }
                >
                  {page === 'login' ? (
                    <>
                      <Field
                        label={i18n.text('用户名')}
                        name="username"
                        autoComplete="username"
                        required
                      />
                      <PasswordField label={i18n.text('密码')} name="password" />
                    </>
                  ) : (
                    <Field
                      label={method === 'backup' ? i18n.text('恢复码') : i18n.text('6 位验证码')}
                      name="token"
                      required
                      autoComplete={method === 'backup' ? 'off' : 'one-time-code'}
                      inputMode={method === 'backup' ? 'text' : 'numeric'}
                      maxLength={method === 'backup' ? undefined : 6}
                      minLength={method === 'backup' ? 1 : 6}
                      pattern={method === 'backup' ? undefined : '[0-9]{6}'}
                      className={method === 'backup' ? '' : 'otp'}
                      help={i18n.system(
                        method === 'backup'
                          ? i18n.text('每个恢复码仅能使用一次。')
                          : i18n.text('输入验证器当前显示的验证码。'),
                      )}
                    />
                  )}
                </Form>
              </>
            )}
            <div className="auth-bottom">
              <span>{liekanProduct.name}</span>
              <span>{i18n.text('使用当前实例账户')}</span>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function Account() {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    action = useAction();
  const profile = useData(['account-profile'], signal => c.api.get('/me', undefined, signal));
  const user = profile.data?.user?.id === c.user.id ? profile.data.user : c.user;
  const [drawer, setDrawer] = useState('');
  return (
    <>
      <div className="two">
        <Panel title={i18n.text('账户信息')} subtitle={i18n.text('当前身份与角色。')}>
          <Body>
            <QueryState query={profile}>
              <Definition
                items={[
                  [i18n.text('用户名'), user.username],
                  [
                    i18n.text('角色'),
                    <Badge key="badge" tone="blue">
                      {user.isAdmin
                        ? i18n.text('系统管理员')
                        : user.role === 'view-only'
                          ? i18n.text('只读用户')
                          : i18n.text('用户')}
                    </Badge>,
                  ],
                  [
                    i18n.text('所属团队'),
                    c.teams.map(team => team.name).join('、') || i18n.text('尚未加入团队'),
                  ],
                  [i18n.text('账户来源'), i18n.text('当前实例账户')],
                ]}
              />
            </QueryState>
            <div className="form-actions">
              <Button disabled={!user.isAdmin} onClick={() => setDrawer('username')}>
                {i18n.text('修改用户名')}
              </Button>
            </div>
            {!user.isAdmin && <p className="field-help">{i18n.text('用户名由系统管理员维护。')}</p>}
          </Body>
        </Panel>
        <Panel title={i18n.text('登录密码')} subtitle={i18n.text('已修改的密码会保留。')}>
          <Body>
            <p className="muted">{i18n.text('修改时需要当前密码，新密码至少 8 位。')}</p>
            <div className="form-actions">
              <Button primary onClick={() => setDrawer('password')}>
                {i18n.text('修改密码')}
              </Button>
            </div>
          </Body>
        </Panel>
        <Panel
          title={i18n.text('安全与偏好')}
          subtitle={i18n.text('管理双重验证、API 密钥和显示偏好。')}
        >
          <Body>
            <div className="row">
              <LinkButton page="security">{i18n.text('账户安全')}</LinkButton>
              <LinkButton page="api-keys">{i18n.text('API 密钥')}</LinkButton>
              <LinkButton page="preferences">{i18n.text('偏好设置')}</LinkButton>
              <Button onClick={() => setDrawer('crawler-handoffs')}>
                {i18n.text('蜘蛛规则交接记录')}
              </Button>
            </div>
          </Body>
        </Panel>
      </div>
      {drawer === 'crawler-handoffs' ? (
        <CrawlerHandoffs onClose={() => setDrawer('')} />
      ) : (
        drawer && (
          <LiekanDialog
            subtitle={i18n.text('当前账户：') + user.username}
            title={i18n.system(
              drawer === 'username' ? i18n.text('修改用户名') : i18n.text('修改密码'),
            )}
            onClose={() => setDrawer('')}
          >
            <Form
              busy={action.busy}
              error={action.error}
              submitLabel={i18n.system(
                drawer === 'password' ? i18n.text('保存密码') : i18n.text('保存用户名'),
              )}
              onSubmit={async values => {
                if (drawer === 'username') {
                  if (!user.isAdmin) throw new Error('用户名由系统管理员维护。');
                  await action.run(() =>
                    c.api.post(`/users/${c.user.id}`, { username: values.username }),
                  );
                  try {
                    await c.refresh();
                  } catch {
                    c.notify('用户名已保存，页面状态刷新失败，请重新读取。');
                  }
                } else {
                  if (values.newPassword !== values.confirmPassword)
                    throw new Error('两次输入的新密码不一致。');
                  await action.run(
                    () =>
                      c.api.post('/me/password', {
                        currentPassword: values.currentPassword,
                        newPassword: values.newPassword,
                      }),
                    '密码已更新，请重新登录',
                  );
                  clearFeatureLogin();
                  window.location.assign(`${basePath}/login`);
                }
                setDrawer('');
              }}
            >
              {drawer === 'username' ? (
                <Field
                  label={i18n.text('用户名')}
                  name="username"
                  defaultValue={user.username}
                  required
                  maxLength={255}
                />
              ) : (
                <>
                  <Notice>{i18n.text('密码更新后需要重新登录。')}</Notice>
                  <PasswordField label={i18n.text('当前密码')} name="currentPassword" />
                  <PasswordField label={i18n.text('新密码')} name="newPassword" minLength={8} />
                  <PasswordField
                    label={i18n.text('确认新密码')}
                    name="confirmPassword"
                    minLength={8}
                  />
                </>
              )}
            </Form>
          </LiekanDialog>
        )
      )}
    </>
  );
}
function Security() {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    action = useAction();
  const status = useData('2fa-status', signal => c.api.get('/2fa/status', undefined, signal));
  const [disable, setDisable] = useState(false);
  const data = status.data;
  return (
    <QueryState query={status}>
      {data && (
        <>
          <div className="wide-narrow">
            <Panel
              title={i18n.text('双重验证')}
              subtitle={i18n.text('在密码之外增加验证器验证码。')}
            >
              <Body>
                <div className="row between">
                  <strong>{i18n.text('当前状态')}</strong>
                  <Badge key="badge" tone={data.isEnabled ? 'green' : 'gray'}>
                    {data.isEnabled ? i18n.text('已启用') : i18n.text('未启用')}
                  </Badge>
                </div>
                <hr className="divider" />
                {data.isRequired ? (
                  <Notice tone="amber">
                    {i18n.text('当前系统、账户或团队要求启用双重验证，账户无法自行关闭。')}
                  </Notice>
                ) : (
                  <Notice>
                    {i18n.text('启用后，登录流程会要求验证码。恢复码用于无法访问验证器的情况。')}
                  </Notice>
                )}
                <div className="form-actions">
                  {data.isEnabled ? (
                    <Button
                      disabled={data.isRequired || !data.isConfigured}
                      onClick={() => setDisable(true)}
                    >
                      {i18n.text('关闭双重验证')}
                    </Button>
                  ) : data.isConfigured ? (
                    <LinkButton page="two-factor" primary>
                      {i18n.text('启用双重验证')}
                    </LinkButton>
                  ) : (
                    <Button disabled>{i18n.text('启用双重验证')}</Button>
                  )}
                </div>
              </Body>
            </Panel>
            <Panel
              title={i18n.text('策略状态')}
              subtitle={i18n.text('读取当前实例与账户的安全策略。')}
            >
              <Body>
                {!data.isConfigured ? (
                  <Notice tone="red">
                    {i18n.text('服务尚未配置双重验证加密密钥。请由系统管理员完成配置后启用。')}
                  </Notice>
                ) : (
                  <Definition
                    items={[
                      [
                        i18n.text('加密配置'),
                        <Badge key="badge" tone="green">
                          {i18n.text('已配置')}
                        </Badge>,
                      ],
                      [
                        i18n.text('启用要求'),
                        data.isRequired
                          ? data.requiredReason === 'team'
                            ? i18n.text('团队强制启用')
                            : data.requiredReason === 'user'
                              ? i18n.text('账户强制启用')
                              : i18n.text('系统强制启用')
                          : i18n.text('自主选择'),
                      ],
                    ]}
                  />
                )}
              </Body>
            </Panel>
          </div>
          {disable && (
            <LiekanDialog title={i18n.text('关闭双重验证')} onClose={() => setDisable(false)}>
              <Form
                busy={action.busy}
                error={action.error}
                danger
                trackUnsaved={false}
                submitLabel={i18n.text('关闭双重验证')}
                onSubmit={async values => {
                  if (data.isRequired) throw new Error('当前策略要求启用双重验证。');
                  await action.run(
                    () =>
                      c.api.post('/2fa/disable', {
                        password: values.currentPassword,
                        token: values.token,
                      }),
                    '双重验证已关闭',
                  );
                  setDisable(false);
                }}
              >
                <Notice tone="amber">
                  {i18n.text('关闭后登录只使用密码。系统、账户或团队强制要求时无法关闭。')}
                </Notice>
                <PasswordField label={i18n.text('当前密码')} name="currentPassword" />
                <Field
                  label={i18n.text('6 位验证码')}
                  name="token"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                />
              </Form>
            </LiekanDialog>
          )}
        </>
      )}
    </QueryState>
  );
}
function TwoFactor() {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    action = useAction();
  const [setup, setSetup] = useState<any>(null);
  const setupGeneration = useRef(0);
  const phase = useRef<'idle' | 'initiating' | 'confirming' | 'canceling'>('idle');
  useEffect(
    () => () => {
      setupGeneration.current += 1;
    },
    [],
  );
  async function cancelSetup() {
    if (action.busy || phase.current !== 'idle') return;
    const generation = ++setupGeneration.current;
    phase.current = 'canceling';
    try {
      await action.run(() => c.api.post('/2fa/setup/cancel'), '已取消绑定');
      if (generation !== setupGeneration.current) return;
      setSetup(null);
      c.navigate('security');
    } finally {
      phase.current = 'idle';
    }
  }
  const status = useData('2fa-status', signal => c.api.get('/2fa/status', undefined, signal));
  return (
    <Panel title={i18n.text('设置验证器')} subtitle={i18n.text('绑定、确认、保存恢复码。')}>
      <Body>
        <div className="steps">
          <span className="blue">{i18n.text('① 绑定验证器')}</span>
          <span style={{ margin: '0 20px' }}>{i18n.text('② 验证代码')}</span>
          <span>{i18n.text('③ 保存恢复码')}</span>
        </div>
        <QueryState query={status}>
          {status.data?.isEnabled ? (
            <Notice tone="blue">
              {i18n.fragment('双重验证已启用。', false, true)}
              <LinkButton page="security">{i18n.text('返回账户安全')}</LinkButton>
            </Notice>
          ) : !status.data?.isConfigured ? (
            <Notice tone="red">
              {i18n.text('服务尚未配置双重验证加密密钥。请由系统管理员完成配置后启用。')}
            </Notice>
          ) : !setup ? (
            <div className="form-actions">
              <Button
                primary
                disabled={action.busy}
                onClick={async () => {
                  if (phase.current !== 'idle') return;
                  const generation = ++setupGeneration.current;
                  phase.current = 'initiating';
                  try {
                    const result = await action.run(
                      () => c.api.post('/2fa/setup/initiate'),
                      '绑定信息已生成',
                    );
                    if (generation === setupGeneration.current) setSetup(result);
                  } finally {
                    phase.current = 'idle';
                  }
                }}
              >
                {i18n.text('生成绑定信息')}
              </Button>
              <Button disabled={action.busy} onClick={cancelSetup}>
                {i18n.text('取消')}
              </Button>
            </div>
          ) : (
            <>
              <div className="row" style={{ margin: '24px 0' }}>
                <img
                  src={setup.qrCodeDataUrl}
                  alt={i18n.text('用于绑定验证器的二维码')}
                  width={180}
                  height={180}
                />
                <div>
                  <h3>{i18n.text('使用验证器扫描')}</h3>
                  <p className="muted">{i18n.text('也可以在验证器中手动输入下方密钥。')}</p>
                  <p style={{ margin: '10px 0' }}>
                    <code>{setup.manualKey}</code>
                  </p>
                  <Button
                    onClick={async () => {
                      await navigator.clipboard.writeText(setup.manualKey);
                      c.notify('绑定密钥已复制');
                    }}
                  >
                    {i18n.text('复制密钥')}
                  </Button>
                </div>
              </div>
              <Form
                busy={action.busy}
                error={action.error}
                submitLabel={i18n.text('验证并继续')}
                cancel={
                  <Button disabled={action.busy} onClick={cancelSetup}>
                    {i18n.text('取消')}
                  </Button>
                }
                onSubmit={async values => {
                  if (phase.current !== 'idle') return;
                  phase.current = 'confirming';
                  try {
                    const result = await action.run(
                      () => c.api.post('/2fa/setup/confirm', { token: values.token }),
                      '双重验证已启用',
                    );
                    transientCodes.set(c.user.id, result.backupCodes);
                    setSetup(null);
                    c.navigate('backup-codes');
                  } finally {
                    phase.current = 'idle';
                  }
                }}
              >
                <Field
                  label={i18n.text('6 位验证码')}
                  name="token"
                  required
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  autoComplete="one-time-code"
                  className="otp"
                  help={i18n.text('输入验证器当前显示的验证码。')}
                />
              </Form>
            </>
          )}
        </QueryState>
      </Body>
    </Panel>
  );
}
function BackupCodes() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const [codes] = useState(() => {
    return transientCodes.get(c.user.id) || [];
  });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    transientCodes.delete(c.user.id);
  }, [c.user.id]);
  return (
    <Panel title={i18n.text('双重验证已启用')} subtitle={i18n.text('保存恢复码后完成设置。')}>
      <Body>
        {codes.length ? (
          <>
            <Notice tone="amber">
              {i18n.text('恢复码只在本次设置完成时展示。每个恢复码仅能使用一次，请妥善保管。')}
            </Notice>
            <div className="backup-grid" style={{ margin: '20px 0' }}>
              {codes.map(code => (
                <code className="backup-code" key={code}>
                  {code}
                </code>
              ))}
            </div>
            <Button
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([codes.join('\n')], { type: 'text/plain;charset=utf-8' }),
                );
                const a = document.createElement('a');
                a.href = url;
                a.download = 'liekan-backup-codes.txt';
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              {i18n.text('下载恢复码')}
            </Button>
            <div style={{ marginTop: 16 }}>
              <Check
                label={i18n.text('我已妥善保存恢复码')}
                checked={saved}
                onChange={event => setSaved(event.target.checked)}
              />
            </div>
            <div className="form-actions">
              <Button primary disabled={!saved} onClick={() => c.navigate('security')}>
                {i18n.text('完成设置')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Notice tone="amber">
              {i18n.text('本次页面没有可展示的恢复码。恢复码仅在启用验证后的当前会话中展示。')}
            </Notice>
            <div className="form-actions">
              <LinkButton page="security">{i18n.text('返回账户安全')}</LinkButton>
            </div>
          </>
        )}
      </Body>
    </Panel>
  );
}
function ApiKeys() {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    action = useAction();
  const query = useData('api-keys', signal => c.api.get('/me/api-keys', undefined, signal));
  const [drawer, setDrawer] = useState<any>(null),
    [createdKey, setCreatedKey] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const open = (next: any) => {
    generation.current += 1;
    setCreatedKey('');
    setDrawer({ ...next, generation: generation.current });
  };
  if ((query.error as any)?.status === 404)
    return (
      <Panel
        title={i18n.text('API 密钥')}
        subtitle={i18n.text('密钥继承账户权限，完整值仅在创建时显示一次。')}
      >
        <Body>
          <Notice tone="amber">
            {i18n.text('当前实例未启用 API 密钥。请由系统管理员开启后使用。')}
          </Notice>
        </Body>
      </Panel>
    );
  const close = () => {
    generation.current += 1;
    setDrawer(null);
    setCreatedKey('');
  };
  return (
    <>
      <Panel
        title={i18n.text('API 密钥')}
        subtitle={i18n.text('密钥继承账户权限，完整值仅在创建时显示一次。')}
        actions={
          <Button
            primary
            disabled={query.isPending || !!query.error}
            onClick={() => open({ type: 'create' })}
          >
            <Icon name="plus" />
            {i18n.fragment('创建密钥', true, false)}
          </Button>
        }
      >
        <QueryState query={query}>
          <Table
            mobile
            rowKeys={rowsOf<any>(query.data).map(key => key.id)}
            columns={['名称', '密钥', '创建时间', '最近使用', '操作']}
            search
            rows={rowsOf<any>(query.data).map(key => [
              key.name,
              <code key="prefix">{key.keyPrefix}••••</code>,
              formatDate(key.createdAt, c.range.timezone),
              <TableCell
                sortValue={
                  key.lastUsedAt
                    ? formatDate(key.lastUsedAt, c.range.timezone)
                    : i18n.source('尚未使用')
                }
                searchValue={
                  key.lastUsedAt
                    ? formatDate(key.lastUsedAt, c.range.timezone)
                    : i18n.english.text('尚未使用')
                }
              >
                {key.lastUsedAt
                  ? formatDate(key.lastUsedAt, c.range.timezone)
                  : i18n.text('尚未使用')}
              </TableCell>,
              <TableCell sortValue={i18n.source('撤销')} searchValue={i18n.english.text('撤销')}>
                <Button key="revoke" onClick={() => open({ type: 'revoke', key })}>
                  {i18n.text('撤销')}
                </Button>
              </TableCell>,
            ])}
            empty={i18n.text('尚未创建 API 密钥。')}
          />
        </QueryState>
      </Panel>
      <Notice tone="blue">
        {i18n.text('创建密钥后可复制一次，关闭弹窗后列表仅显示掩码。请将完整密钥保存到安全位置。')}
      </Notice>
      {drawer && (
        <LiekanDialog
          protectUnsaved={false}
          title={i18n.system(
            drawer.type === 'create' ? i18n.text('创建 API 密钥') : i18n.text('撤销 API 密钥'),
          )}
          onClose={close}
        >
          {createdKey ? (
            <>
              <Notice tone="amber">
                {i18n.text('完整密钥仅在此处展示一次。关闭后无法再次读取。')}
              </Notice>
              <Code>{createdKey}</Code>
              <Button
                onClick={async () => {
                  await navigator.clipboard.writeText(createdKey);
                  c.notify('密钥已复制');
                }}
              >
                {i18n.text('复制密钥')}
              </Button>
              <DialogActions>
                <Button primary onClick={close}>
                  {i18n.text('已保存，关闭')}
                </Button>
              </DialogActions>
            </>
          ) : (
            <Form
              busy={action.busy}
              error={action.error}
              danger={drawer.type !== 'create'}
              trackUnsaved={false}
              submitLabel={i18n.system(
                drawer.type === 'create' ? i18n.text('创建 API 密钥') : i18n.text('撤销 API 密钥'),
              )}
              onSubmit={async values => {
                if (drawer.type === 'create') {
                  const key = await action.run(
                    () => c.api.post('/me/api-keys', { name: values.name }),
                    '密钥已创建',
                  );
                  if (generation.current === drawer.generation) setCreatedKey(key.key);
                } else {
                  if (values.confirmation !== 'REVOKE') throw new Error('请输入 REVOKE 确认。');
                  await action.run(() => c.api.del(`/me/api-keys/${drawer.key.id}`), '密钥已撤销');
                  close();
                }
              }}
            >
              {drawer.type === 'create' ? (
                <Field
                  label={i18n.text('密钥名称')}
                  name="name"
                  required
                  maxLength={255}
                  help={i18n.text('如：研究报告集成。')}
                />
              ) : (
                <>
                  <Notice tone="red">
                    {i18n.fragment('撤销「', false, true)}
                    {drawer.key.name}
                    {i18n.fragment('」后对应集成将失去访问权限。', true, false)}
                  </Notice>
                  <Field
                    label={i18n.text('输入 REVOKE 确认')}
                    name="confirmation"
                    required
                    autoComplete="off"
                  />
                </>
              )}
            </Form>
          )}
        </LiekanDialog>
      )}
    </>
  );
}
function Preferences() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const [prefs, setPrefs] = useState<any>(null);
  useEffect(() => setPrefs(getFeaturePreferences()), []);
  return (
    <Panel
      title={i18n.text('显示与分析偏好')}
      subtitle={i18n.text('设置默认时间范围、时区与界面语言。')}
    >
      <Body>
        {prefs ? (
          <Form
            key={JSON.stringify(prefs)}
            submitLabel={i18n.text('保存偏好')}
            onSubmit={async values => {
              await saveAccountPreferences({
                countryCode: values.countryCode,
                timezone: values.timezone,
                range: values.range,
              });
              saveFeaturePreferences({
                range: values.range,
                timezone: values.timezone,
                theme: values.theme,
              });
              setPrefs(getFeaturePreferences());
              c.notify('偏好已保存');
            }}
          >
            <div className="form-grid">
              <Select
                label={i18n.text('默认日期范围')}
                name="range"
                options={[
                  ['0day', i18n.text('今天')],
                  ['7day', i18n.text('过去 7 天')],
                  ['30day', i18n.text('过去 30 天')],
                  ['0month', i18n.text('本月')],
                  ...(!['0day', '7day', '30day', '0month'].includes(prefs.range)
                    ? [[prefs.range, i18n.text('当前已保存范围')] as [string, string]]
                    : []),
                ]}
                localizeLabels
                defaultValue={prefs.range}
              />
              <AccountTimezoneFields countryCode={prefs.countryCode} timezone={prefs.timezone} />
              <LanguageSelector field />
              <label className="field">
                <span>{i18n.text('主题')}</span>
                <span className="select-wrap">
                  <select name="theme" defaultValue={prefs.theme}>
                    <option value="light">{i18n.text('浅色')}</option>
                    <option value="dark" disabled>
                      {i18n.text('深色（当前不可用）')}
                    </option>
                    <option value="system" disabled>
                      {i18n.text('跟随系统（当前不可用）')}
                    </option>
                  </select>
                  <Icon />
                </span>
                <small className="field-help">{i18n.text('当前界面支持浅色主题。')}</small>
              </label>
            </div>
            <Notice>
              {i18n.text(
                '当前 GEOInflow 界面使用已确认的浅色规范。分析时区和默认日期范围沿用账户偏好。',
              )}
            </Notice>
            <hr className="divider" />
            <Definition
              items={[
                [
                  i18n.text('当前运行系统'),
                  `${liekanProduct.name} v${liekanProduct.displayVersion}`,
                ],
                [
                  i18n.text('界面版本'),
                  `${liekanProduct.name} UI v${liekanProduct.displayVersion}`,
                ],
                [i18n.text('许可'), 'MIT'],
              ]}
            />
          </Form>
        ) : (
          <Notice>{i18n.text('正在读取偏好设置。')}</Notice>
        )}
      </Body>
    </Panel>
  );
}

function Goals() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const [page, setPage] = useState(1),
    [remove, setRemove] = useState<FeatureEntity>(null);
  const action = useAction();
  const query = useData(
    ['goals', page],
    signal => c.api.get(`${sitePath(c.siteId)}/goals`, { page, pageSize: 20 }, signal),
    !!c.siteId,
  );
  useEffect(() => {
    const count = Number(query.data?.count);
    if (
      query.isPlaceholderData ||
      query.error ||
      query.data?.count == null ||
      !Number.isFinite(count) ||
      count < 0
    )
      return;
    const lastPage = Math.max(1, Math.ceil(count / 20));
    setPage(current => (current > lastPage ? 1 : current));
  }, [query.data?.count, query.isPlaceholderData, query.error]);
  const goals = rowsOf<FeatureEntity>(query.data);
  const stats = useData(
    ['goal-results', goals.map(goal => goal.id)],
    async signal => {
      const results = await Promise.all(
        goals.map(async goal => {
          try {
            return {
              id: goal.id,
              ...(await c.api.get(
                `/liekan/websites/${c.siteId}/goals/${goal.id}/analytics`,
                { ...c.range, ...c.filters },
                signal,
              )),
            };
          } catch (error: any) {
            if (error.name === 'AbortError') throw error;
            return { id: goal.id, error };
          }
        }),
      );
      if (results.some(row => 'error' in row))
        rememberAggregateFailure(
          results,
          Math.max(...results.map(row => Number(row.error?.retryAfterMs) || 0)),
        );
      return results;
    },
    goals.length > 0 && query.isSuccess && !query.isPlaceholderData,
  );
  const manage = canManageSite(c, c.site);
  if (!c.siteId) return <MissingWebsite />;
  const result = stats.data || [],
    first = goals[0],
    firstResult = result.find(row => row.id === first?.id);
  return (
    <>
      <Metrics
        loading={[
          query.isPending,
          query.isPending || (goals.length > 0 && stats.isPending),
          query.isPending || (goals.length > 0 && stats.isPending),
          false,
        ]}
        items={[
          [
            i18n.text('目标数量'),
            query.isPending ? '—' : String(query.data?.count ?? goals.length),
            i18n.text('当前网站'),
          ],
          [
            first?.name || i18n.text('目标转化次数'),
            firstResult && !firstResult.error ? numberLabel(firstResult.conversions) : '—',
            i18n.text('转化次数'),
            'blue',
          ],
          [
            i18n.text('目标转化率'),
            firstResult && !firstResult.error
              ? conversionRate(firstResult.num, firstResult.total)
              : '—',
            firstResult && !firstResult.error
              ? i18n.text('{v0} 位转化访客 / {v1} 位访客', [
                  numberLabel(firstResult.num),
                  numberLabel(firstResult.total),
                ])
              : i18n.text('按独立转化访客计算'),
          ],
          [i18n.text('目标类型'), i18n.text('页面 / 事件'), i18n.text('保留原有目标条件')],
        ]}
      />
      <Panel
        title={i18n.text('网站目标')}
        subtitle={i18n.text('按页面访问或事件触发定义目标。')}
        actions={
          manage && (
            <LinkButton page="goal-editor" primary>
              <Icon name="plus" />
              {i18n.fragment('创建目标', true, false)}
            </LinkButton>
          )
        }
      >
        <QueryState query={query}>
          <Table
            mobile
            rowKeys={goals.map(goal => goal.id)}
            columns={['目标', '触发条件', '转化次数', '转化率', '操作']}
            numeric={[2, 3]}
            search
            page={page}
            pages={Math.ceil((query.data?.count || 0) / 20)}
            onPage={setPage}
            rows={goals.map(goal => {
              const value = result.find(row => row.id === goal.id);
              return [
                <>
                  <span className="table-title">{goal.name}</span>
                  {goal.description && <span className="table-meta">{goal.description}</span>}
                </>,
                <TableCell
                  sortValue={`${goal.parameters?.type === 'path' ? i18n.source('页面') : i18n.source('事件')} · ${goal.parameters?.value || i18n.source('未配置')}`}
                  searchValue={`${goal.parameters?.type === 'path' ? i18n.english.text('页面') : i18n.english.text('事件')} · ${goal.parameters?.value || i18n.english.text('未配置')}`}
                >{`${goal.parameters?.type === 'path' ? i18n.text('页面') : i18n.text('事件')} · ${goal.parameters?.value || i18n.text('未配置')}`}</TableCell>,
                <TableCell
                  sortValue={
                    value?.error
                      ? i18n.source('读取失败')
                      : value
                        ? numberLabel(value.conversions)
                        : i18n.source('正在加载')
                  }
                  searchValue={
                    value?.error
                      ? i18n.english.text('读取失败')
                      : value
                        ? numberLabel(value.conversions)
                        : i18n.english.text('正在加载')
                  }
                >
                  {value?.error
                    ? i18n.text('读取失败')
                    : value
                      ? numberLabel(value.conversions)
                      : i18n.text('正在加载')}
                </TableCell>,
                value?.error ? '—' : value ? conversionRate(value.num, value.total) : '—',
                <TableCell
                  sortValue={[
                    manage ? i18n.source('编辑') : i18n.source('查看'),
                    manage && i18n.source('删除'),
                  ]}
                  searchValue={[
                    manage ? i18n.english.text('编辑') : i18n.english.text('查看'),
                    manage && i18n.english.text('删除'),
                  ]}
                >
                  <div className="actions" key="actions">
                    <LinkButton page="goal-editor" params={{ id: goal.id }}>
                      {manage ? i18n.text('编辑') : i18n.text('查看')}
                    </LinkButton>
                    {manage && <Button onClick={() => setRemove(goal)}>{i18n.text('删除')}</Button>}
                  </div>
                </TableCell>,
              ];
            })}
            empty={i18n.text('尚未创建目标。创建页面或事件目标后查看转化。')}
          />
        </QueryState>
      </Panel>
      {goals.length > 0 ? (
        <QueryState query={stats}>
          <Chart
            interactionKey={JSON.stringify([
              'goal',
              c.user.id,
              c.siteId,
              c.range,
              c.filters,
              first,
              firstResult,
            ])}
            title={i18n.text('{v0}的转化趋势', [first.name])}
            subtitle={i18n.text('当前所选期间')}
            labels={(firstResult?.series || []).map(point => point.x)}
            series={[
              {
                name: i18n.text('转化次数'),
                values: (firstResult?.series || []).map(point => point.y),
              },
            ]}
          >
            {firstResult?.error && (
              <Notice tone="red">
                {i18n.fragment('该目标的转化统计读取失败：', false, true)}
                {i18n.system(firstResult.error.message)}
              </Notice>
            )}
          </Chart>
        </QueryState>
      ) : (
        <Chart
          interactionKey={JSON.stringify(['goals-empty', c.user.id, c.siteId, c.range, c.filters])}
          title={i18n.text('目标转化趋势')}
          subtitle={i18n.text('当前所选期间')}
        />
      )}
      <Notice>
        {i18n.text(
          '目标转化次数和独立转化访客分别展示。转化率按独立转化访客计算，没有访客时显示“—”。',
        )}
      </Notice>
      {remove && (
        <LiekanDialog title={i18n.text('删除目标')} onClose={() => setRemove(null)}>
          <Form
            busy={action.busy}
            error={action.error}
            danger
            submitLabel={i18n.text('删除目标')}
            onSubmit={async values => {
              if (values.confirmation !== remove.name) throw new Error('确认内容不匹配。');
              await action.run(
                () => c.api.del(`${sitePath(c.siteId)}/goals/${remove.id}`),
                '目标已删除',
              );
              setRemove(null);
            }}
          >
            <Notice tone="red">
              {i18n.fragment('删除「', false, true)}
              {remove.name}
              {i18n.fragment('」的目标定义，已采集的访问与事件数据继续保留。', true, false)}
            </Notice>
            <Field
              label={i18n.text('输入 {v0} 确认', [remove.name])}
              name="confirmation"
              required
            />
          </Form>
        </LiekanDialog>
      )}
    </>
  );
}
function GoalEditor() {
  const c = useFeature();
  const id = c.route.id;
  const query = useData(
    ['goal-definition', id],
    signal => c.api.get(`${sitePath(c.siteId)}/goals/${id}`, undefined, signal),
    !!c.siteId && !!id,
  );
  if (!c.siteId) return <MissingWebsite />;
  return (
    <>
      {id ? (
        <QueryState query={query}>
          {query.data && <GoalForm key={`${c.siteId}:${query.data.id}`} goal={query.data} />}
        </QueryState>
      ) : (
        <GoalForm key={`${c.siteId}:new`} />
      )}
    </>
  );
}
function GoalForm({ goal }: { goal?: FeatureEntity }) {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    action = useAction(),
    manage = canManageSite(c, c.site);
  return (
    <div className="wide-narrow">
      <Panel title={i18n.text('目标条件')} subtitle={i18n.text('与上游页面或事件目标保持一致。')}>
        <Body>
          {!manage && <ReadonlyNotice />}
          <Form
            busy={action.busy}
            error={action.error}
            disabled={!manage}
            submitLabel={i18n.text('保存目标')}
            cancel={<LinkButton page="goals">{i18n.text('取消')}</LinkButton>}
            onSubmit={async values => {
              if (!manage) throw new Error('需要网站管理权限。');
              await action.run(
                () =>
                  c.api.post(
                    `${sitePath(c.siteId)}/goals${goal ? `/${goal.id}` : ''}`,
                    goalPayload(values),
                  ),
                '目标已保存',
              );
              c.navigate('goals');
            }}
          >
            <Field
              label={i18n.text('目标名称')}
              name="name"
              defaultValue={goal?.name || ''}
              required
              readOnly={!manage}
              maxLength={200}
            />
            <Select
              label={i18n.text('触发类型')}
              name="goalType"
              options={[
                ['path', i18n.text('访问页面')],
                ['event', i18n.text('触发事件')],
              ]}
              localizeLabels
              defaultValue={goal?.parameters?.type || 'path'}
              disabled={!manage}
            />
            <Field
              label={i18n.text('页面路径或事件名称')}
              name="value"
              defaultValue={goal?.parameters?.value || ''}
              required
              readOnly={!manage}
              help={i18n.text('页面填 /pricing，事件填自定义事件名称。')}
            />
            <Textarea
              label={i18n.text('说明（可选）')}
              name="description"
              defaultValue={goal?.description || ''}
              maxLength={500}
              readOnly={!manage}
              help={i18n.text('用于团队理解目标定义。')}
            />
          </Form>
        </Body>
      </Panel>
      <Panel title={i18n.text('口径说明')} subtitle={i18n.text('一个目标对应一个行为条件。')}>
        <Body>
          <div className="stack">
            <div>
              <h3>{i18n.text('访问页面')}</h3>
              <p className="muted">{i18n.text('使用采集到的路径定义目标。')}</p>
            </div>
            <div>
              <h3>{i18n.text('触发事件')}</h3>
              <p className="muted">{i18n.text('使用自定义事件名称定义目标。')}</p>
            </div>
          </div>
          <hr className="divider" />
          <LinkButton page="events">{i18n.text('查看事件属性')}</LinkButton>
        </Body>
      </Panel>
    </div>
  );
}
function Funnels() {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    action = useAction();
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState(c.route.id || ''),
    [remove, setRemove] = useState<FeatureEntity>(null);
  const query = useData(
    ['funnels', page],
    signal => c.api.get(`${sitePath(c.siteId)}/funnels`, { page, pageSize: 20 }, signal),
    !!c.siteId,
  );
  useEffect(() => {
    const count = Number(query.data?.count);
    if (
      query.isPlaceholderData ||
      query.error ||
      query.data?.count == null ||
      !Number.isFinite(count) ||
      count < 0
    )
      return;
    const lastPage = Math.max(1, Math.ceil(count / 20));
    setPage(current => (current > lastPage ? 1 : current));
  }, [query.data?.count, query.isPlaceholderData, query.error]);
  const funnels = rowsOf<FeatureEntity>(query.data);
  const funnel = funnels.find(funnel => funnel.id === selected) || funnels[0];
  const stats = useData(
    ['funnel-results', funnel?.id],
    signal =>
      c.api.get(
        `${sitePath(c.siteId)}/funnels/${funnel?.id}/stats`,
        { ...c.range, ...c.filters },
        signal,
      ),
    !!funnel && query.isSuccess && !query.isPlaceholderData,
  );
  const results = rowsOf<any>(stats.data),
    first = results[0]?.visitors,
    last = results.at(-1)?.visitors;
  const manage = canManageSite(c, c.site);
  if (!c.siteId) return <MissingWebsite />;
  return (
    <>
      <Metrics
        loading={[
          query.isPending || (!!funnel && stats.isPending),
          query.isPending || (!!funnel && stats.isPending),
          query.isPending || (!!funnel && stats.isPending),
          query.isPending,
        ]}
        items={[
          [
            i18n.text('进入漏斗'),
            stats.isPending || stats.error
              ? '—'
              : numberLabel(first === null ? null : (first ?? 0)),
            i18n.text('当前范围访客'),
          ],
          [
            i18n.text('完成路径'),
            stats.isPending || stats.error ? '—' : numberLabel(last === null ? null : (last ?? 0)),
            i18n.text('完成访客'),
            'blue',
          ],
          [i18n.text('整体转化率'), conversionRate(last, first), i18n.text('相对首次进入')],
          [
            i18n.text('步骤数量'),
            funnel ? String(funnel.parameters?.steps?.length || 0) : '0',
            i18n.text('按已保存配置展示'),
          ],
        ]}
      />
      <QueryState query={query}>
        {funnel ? (
          <>
            <Panel
              title={funnel.name}
              subtitle={i18n.text('{v0} 步 · 同一访客 · {v1} 分钟窗口', [
                funnel.parameters?.steps?.length || 0,
                funnel.parameters?.window,
              ])}
              actions={
                <div className="actions" key="actions">
                  {manage && (
                    <LinkButton page="funnel-editor" params={{ id: funnel.id }} primary>
                      {i18n.text('配置漏斗')}
                    </LinkButton>
                  )}
                </div>
              }
            >
              <Body>
                {funnels.length > 1 && (
                  <Select
                    label={i18n.text('已保存漏斗')}
                    value={funnel.id}
                    onChange={event => setSelected(event.target.value)}
                    options={funnels.map(funnel => [funnel.id, funnel.name])}
                  />
                )}
                <QueryState query={stats}>
                  {results.map((step, i) => (
                    <div className="funnel-row" key={i}>
                      <strong>
                        {i + 1} · {step.value}
                      </strong>
                      <div className="funnel-bar">
                        <i
                          style={{
                            width: `${first > 0 ? Math.min(100, (Number(step.visitors) / Number(first)) * 100) : 0}%`,
                          }}
                        />
                      </div>
                      <span className="num numeric">{numberLabel(step.visitors)}</span>
                    </div>
                  ))}
                  <hr className="divider" />
                  <Table
                    columns={['步骤', '到达访客', '相对上步转化', '累计转化']}
                    numeric={[1, 2, 3]}
                    rows={results.map((step, i) => [
                      step.value,
                      numberLabel(step.visitors),
                      i === 0
                        ? Number(step.visitors) > 0
                          ? '100.00%'
                          : '—'
                        : conversionRate(step.visitors, results[i - 1]?.visitors),
                      conversionRate(step.visitors, first),
                    ])}
                  />
                </QueryState>
              </Body>
            </Panel>
            <Panel
              title={i18n.text('网站漏斗')}
              subtitle={i18n.text('管理当前网站已保存的路径。')}
              actions={
                manage && (
                  <LinkButton page="funnel-editor" primary>
                    <Icon name="plus" />
                    {i18n.fragment('创建漏斗', true, false)}
                  </LinkButton>
                )
              }
            >
              <Table
                mobile
                rowKeys={funnels.map(funnel => funnel.id)}
                columns={['漏斗', '步骤数量', '转化窗口', '操作']}
                page={page}
                pages={Math.ceil((query.data?.count || 0) / 20)}
                onPage={setPage}
                rows={funnels.map(funnel => [
                  funnel.name,
                  String(funnel.parameters?.steps?.length || 0),
                  <TableCell
                    sortValue={i18n.source('{v0} 分钟', [funnel.parameters?.window])}
                    searchValue={i18n.english.text('{v0} 分钟', [funnel.parameters?.window])}
                  >
                    {i18n.text('{v0} 分钟', [funnel.parameters?.window])}
                  </TableCell>,
                  <TableCell
                    sortValue={[
                      i18n.source('查看结果'),
                      manage ? i18n.source('编辑') : i18n.source('查看'),
                      manage && i18n.source('删除'),
                    ]}
                    searchValue={[
                      i18n.english.text('查看结果'),
                      manage ? i18n.english.text('编辑') : i18n.english.text('查看'),
                      manage && i18n.english.text('删除'),
                    ]}
                  >
                    <div className="actions" key="actions">
                      <Button onClick={() => setSelected(funnel.id)}>
                        {i18n.text('查看结果')}
                      </Button>
                      <LinkButton page="funnel-editor" params={{ id: funnel.id }}>
                        {manage ? i18n.text('编辑') : i18n.text('查看')}
                      </LinkButton>
                      {manage && (
                        <Button onClick={() => setRemove(funnel)}>{i18n.text('删除')}</Button>
                      )}
                    </div>
                  </TableCell>,
                ])}
              />
            </Panel>
          </>
        ) : (
          <Panel
            title={i18n.text('网站漏斗')}
            subtitle={i18n.text('至少两步，最多八步。')}
            actions={
              manage && (
                <LinkButton page="funnel-editor" primary>
                  <Icon name="plus" />
                  {i18n.fragment('创建漏斗', true, false)}
                </LinkButton>
              )
            }
          >
            <Body>
              <Notice>{i18n.text('尚未创建漏斗。配置并保存路径后查看真实转化结果。')}</Notice>
            </Body>
          </Panel>
        )}
      </QueryState>
      <Notice>
        {i18n.text(
          '步骤、名称、事件属性条件与窗口按保存配置计算。转化数量来自当前网站所选范围，没有访客时转化率显示“—”。',
        )}
      </Notice>
      {remove && (
        <LiekanDialog title={i18n.text('删除漏斗')} onClose={() => setRemove(null)}>
          <Form
            busy={action.busy}
            error={action.error}
            danger
            submitLabel={i18n.text('删除漏斗')}
            onSubmit={async values => {
              if (values.confirmation !== remove.name) throw new Error('确认内容不匹配。');
              await action.run(
                () => c.api.del(`${sitePath(c.siteId)}/funnels/${remove.id}`),
                '漏斗已删除',
              );
              setRemove(null);
            }}
          >
            <Notice tone="red">
              {i18n.fragment('删除「', false, true)}
              {remove.name}
              {i18n.fragment('」的漏斗定义，已采集的访问与事件数据继续保留。', true, false)}
            </Notice>
            <Field
              label={i18n.text('输入 {v0} 确认', [remove.name])}
              name="confirmation"
              required
            />
          </Form>
        </LiekanDialog>
      )}
    </>
  );
}
function FunnelEditor() {
  const c = useFeature(),
    id = c.route.id;
  const query = useData(
    ['funnel-definition', id],
    signal => c.api.get(`${sitePath(c.siteId)}/funnels/${id}`, undefined, signal),
    !!c.siteId && !!id,
  );
  if (!c.siteId) return <MissingWebsite />;
  return (
    <>
      {id ? (
        <QueryState query={query}>
          {query.data && <FunnelForm key={`${c.siteId}:${query.data.id}`} funnel={query.data} />}
        </QueryState>
      ) : (
        <FunnelForm key={`${c.siteId}:new`} />
      )}
    </>
  );
}
function FunnelForm({ funnel }: { funnel?: FeatureEntity }) {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    action = useAction(),
    manage = canManageSite(c, c.site);
  const blankStep = (): CoreFunnelStep => ({ type: 'path', value: '', filters: [] });
  const [steps, setSteps] = useState<CoreFunnelStep[]>(
    () =>
      funnel?.parameters?.steps?.map((step: CoreFunnelStep) => ({
        ...step,
        filters: step.filters || [],
      })) || [blankStep(), blankStep()],
  );
  const update = (index: number, change: Partial<CoreFunnelStep>) =>
    setSteps(current => current.map((step, i) => (i === index ? { ...step, ...change } : step)));
  const move = (index: number, delta: number) =>
    setSteps(current => {
      const next = [...current];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
  const changeFilter = (i: number, j: number, change: any) =>
    update(i, {
      filters: steps[i].filters.map((filter, index) =>
        index === j ? { ...filter, ...change } : filter,
      ),
    });
  return (
    <div className="wide-narrow">
      <Panel
        title={i18n.text('漏斗配置')}
        subtitle={i18n.text('至少两步，最多八步。事件步骤可设置属性条件。')}
      >
        <Body>
          {!manage && <ReadonlyNotice />}
          <Form
            busy={action.busy}
            error={action.error}
            disabled={!manage}
            submitLabel={i18n.text('保存漏斗')}
            cancel={<LinkButton page="funnels">{i18n.text('取消')}</LinkButton>}
            onSubmit={async values => {
              if (!manage) throw new Error('需要网站管理权限。');
              await action.run(
                () =>
                  c.api.post(
                    `${sitePath(c.siteId)}/funnels${funnel ? `/${funnel.id}` : ''}`,
                    funnelPayload(values, steps),
                  ),
                '漏斗已保存',
              );
              c.navigate('funnels');
            }}
          >
            <Field
              label={i18n.text('漏斗名称')}
              name="name"
              defaultValue={funnel?.name || ''}
              required
              maxLength={200}
              readOnly={!manage}
            />
            <Field
              label={i18n.text('转化窗口（分钟）')}
              name="window"
              type="number"
              defaultValue={funnel?.parameters?.window ?? ''}
              required
              min={1}
              step={1}
              readOnly={!manage}
              help={i18n.text('大于 0，同一访客需要在窗口内按顺序完成。')}
            />
            <Textarea
              label={i18n.text('说明（可选）')}
              name="description"
              defaultValue={funnel?.description || ''}
              maxLength={500}
              readOnly={!manage}
            />
            <div id="funnel-steps" data-dirty-actions>
              {steps.map((step, i) => (
                <div className="step-editor" key={i}>
                  <div className="step-editor-head">
                    <strong>
                      {i18n.fragment('步骤 ', false, true)}
                      {i + 1}
                    </strong>
                    <div className="actions" key="actions">
                      <Button
                        aria-label={i18n.text('上移步骤 {v0}', [i + 1])}
                        disabled={!manage || i === 0}
                        onClick={() => move(i, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        aria-label={i18n.text('下移步骤 {v0}', [i + 1])}
                        disabled={!manage || i === steps.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        aria-label={i18n.text('移除步骤 {v0}', [i + 1])}
                        disabled={!manage || steps.length <= 2}
                        onClick={() =>
                          setSteps(current => current.filter((_, index) => index !== i))
                        }
                      >
                        <Icon name="close" />
                      </Button>
                    </div>
                  </div>
                  <div className="two">
                    <Select
                      label={i18n.text('行为类型')}
                      name={`step-type-${i}`}
                      value={step.type}
                      disabled={!manage}
                      options={[
                        ['path', i18n.text('访问页面')],
                        ['event', i18n.text('触发事件')],
                      ]}
                      localizeLabels
                      onChange={event =>
                        update(i, { type: event.target.value as 'path' | 'event', filters: [] })
                      }
                    />
                    <Field
                      label={i18n.text('路径或事件名称')}
                      name={`step-value-${i}`}
                      value={step.value}
                      required
                      readOnly={!manage}
                      onChange={event => update(i, { value: event.target.value })}
                    />
                  </div>
                  {step.type === 'event' && (
                    <div style={{ marginTop: 12 }}>
                      {step.filters.map((filter, j) => (
                        <div className="condition" key={j}>
                          <Field
                            label={i18n.text('事件属性')}
                            name={`property-${i}-${j}`}
                            value={filter.property}
                            required
                            readOnly={!manage}
                            onChange={event => changeFilter(i, j, { property: event.target.value })}
                          />
                          <Select
                            label={i18n.text('运算符')}
                            name={`operator-${i}-${j}`}
                            value={filter.operator}
                            disabled={!manage}
                            options={[
                              ['eq', i18n.text('等于')],
                              ['neq', i18n.text('不等于')],
                              ['c', i18n.text('包含')],
                              ['dnc', i18n.text('不包含')],
                            ]}
                            localizeLabels
                            onChange={event => changeFilter(i, j, { operator: event.target.value })}
                          />
                          <Field
                            label={i18n.text('属性值')}
                            name={`filtervalue-${i}-${j}`}
                            value={filter.value}
                            required
                            readOnly={!manage}
                            onChange={event => changeFilter(i, j, { value: event.target.value })}
                          />
                          <Button
                            aria-label={i18n.text('移除属性条件')}
                            disabled={!manage}
                            onClick={() =>
                              update(i, { filters: step.filters.filter((_, index) => index !== j) })
                            }
                          >
                            <Icon name="close" />
                          </Button>
                        </div>
                      ))}
                      <Button
                        disabled={!manage}
                        onClick={() =>
                          update(i, {
                            filters: [...step.filters, { property: '', operator: 'eq', value: '' }],
                          })
                        }
                      >
                        {i18n.text('添加事件属性')}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <Button
              data-dirty-action="true"
              disabled={!manage || steps.length >= 8}
              onClick={() => setSteps(current => [...current, blankStep()])}
            >
              <Icon name="plus" />
              {i18n.fragment('添加步骤', true, false)}
            </Button>
            <p className="field-help">
              {i18n.fragment('已配置 ', false, true)}
              {steps.length}
              {i18n.fragment(' / 8 步。', true, false)}
            </p>
          </Form>
        </Body>
      </Panel>
      <Panel title={i18n.text('配置预览')} subtitle={i18n.text('步骤顺序决定转化路径。')}>
        <Body>
          <ol className="timeline">
            {steps.map((step, i) => (
              <li key={i}>
                <strong>
                  {i + 1} · {step.value || i18n.text('未填写')}
                </strong>
                <p>
                  {step.type === 'path' ? i18n.text('页面访问') : i18n.text('事件触发')}
                  {step.filters.length ? i18n.text(' · 带属性条件') : ''}
                </p>
              </li>
            ))}
          </ol>
        </Body>
      </Panel>
    </div>
  );
}

export function CorePages({ page }: { page: string }): ReactNode {
  switch (page) {
    case 'websites':
      return <Websites />;
    case 'onboarding':
      return <Onboarding />;
    case 'tracking':
      return <Tracking />;
    case 'install-check':
      return <Tracking check />;
    case 'website-settings':
      return <WebsiteSettings />;
    case 'recorder-settings':
      return <RecorderSettings />;
    case 'login':
    case 'login-2fa':
    case 'sso':
      return <FeatureAuthPage page={page} />;
    case 'account':
      return <Account />;
    case 'security':
      return <Security />;
    case 'two-factor':
      return <TwoFactor />;
    case 'backup-codes':
      return <BackupCodes />;
    case 'api-keys':
      return <ApiKeys />;
    case 'preferences':
      return <Preferences />;
    case 'goals':
      return <Goals />;
    case 'goal-editor':
      return <GoalEditor />;
    case 'funnels':
      return <Funnels />;
    case 'funnel-editor':
      return <FunnelEditor />;
    default:
      return null;
  }
}
