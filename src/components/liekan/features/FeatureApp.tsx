'use client';
import { AnalysisPendingNotice } from '../AnalysisPendingNotice';
import { liekanProduct } from '@/lib/liekan/contracts/product';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { useLiekanPageTitle } from '@/lib/liekan/i18n/client';
import { LanguageSelector } from '../LanguageSelector';
import localeStyles from '@/styles/liekan/LanguageSelector.module.css';

import {
  useManualQuery as useQuery,
  useManualRefresh,
} from '@/lib/liekan/contracts/manual-refresh';
import { useQueryClient } from '@tanstack/react-query';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import Link from '@/components/liekan/Link';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { featureDateRange } from '@/lib/liekan/contracts/analysis';
import {
  type FeatureEntity,
  type FeatureRoute,
  type FeatureUser,
  rowsOf,
} from '@/lib/liekan/contracts/features';
import { useFeatureDateRange, useNavigation } from '@/lib/liekan/upstream/client';
import { useAccountPreferences } from '@/lib/liekan/upstream/account-preferences-client';
import {
  featureApi,
  featureSiteQuery,
  getAllFeatureRows,
  getFeaturePreferences,
  getFeatureSites,
  refreshFeatureIdentity,
  invalidateFeatureUserQueries,
} from '@/lib/liekan/upstream/features-client';
import { websiteHandle, websiteMatchesHandle } from '@/lib/liekan/website-handle';
import '@/styles/liekan/Features.module.css';
import shellStyles from '@/styles/liekan/Shell.module.css';
import {
  hasDateControl,
  navigationFor,
  needsWebsite,
  resourceListPages,
  websiteAnalysisFamily,
} from '@/lib/liekan/contracts/navigation';
import { AnalysisTabs } from '../AnalysisTabs';
import { DataLoading } from '../DataLoading';
import { Navigation, useSidebarWidth } from '../Navigation';
import { ProductFooter } from '../ProductFooter';
import { WebsiteToolbar } from '../WebsiteToolbar';
import { ManualRefreshControl } from '../ManualRefreshControl';
import { activeQuickDateRange, QuickRangeButtons } from '../date-quick-range';
import { AnalyticsPages, analysisPages } from './AnalyticsPages';
import { CorePages } from './CorePages';
import { AiPages, aiPages } from './AiPages';
import dynamic from 'next/dynamic';
const CrawlerRegistryPage = dynamic(() =>
  import('./CrawlerRegistryPage').then(module => module.CrawlerRegistryPage),
);
const HelpCenter = dynamic(() => import('./HelpCenter').then(module => module.HelpCenter));
const AnalyticsEnginePage = dynamic(() => import('./AnalyticsEnginePage').then(module => module.AnalyticsEnginePage));
const AnalyticsAccelerationPage = dynamic(() =>
  import('./AnalyticsAccelerationPage').then(module => module.AnalyticsAccelerationPage),
);
const HistoryRepairPage = dynamic(() =>
  import('./HistoryRepairPage').then(module => module.HistoryRepairPage),
);
import { HistoryRepairNotice } from './HistoryRepairNotice';
import { FeatureProvider, type WebsiteDeletedNotice } from './context';
import { ExtendedPages, extendedPages } from './ExtendedPages';
import { LinksPixelsPages, linksPixelsPages } from './LinksPixelsPages';
import { featureHref, featureNavigationHref, featurePages, normalizeFeatureScope } from './routes';
import { SavedSegments } from './SavedSegments';
import { Button, DialogActions, LiekanDialog, Field, Form, Icon, Notice, QueryState } from './ui';
import { WorkspacePages, workspacePages } from './WorkspacePages';

export const coreFeaturePages = new Set([
  'admin-analytics-engine',
  'history-repair',
  'analytics-acceleration',
  'crawlers-manage',
  'help',
  'websites',
  'onboarding',
  'tracking',
  'install-check',
  'website-settings',
  'recorder-settings',
  'account',
  'security',
  'two-factor',
  'backup-codes',
  'api-keys',
  'preferences',
  'goals',
  'goal-editor',
  'funnels',
  'funnel-editor',
  'access-denied',
  'session-expired',
  'not-found',
]);
export function canRenderFeatureRoute(route: FeatureRoute | null) {
  return (
    !!route &&
    [
      coreFeaturePages,
      analysisPages,
      extendedPages,
      workspacePages,
      linksPixelsPages,
      aiPages,
    ].some(pages => pages.has(route.page))
  );
}
export function FeatureApp({
  user,
  route: requestedRoute,
  forceSetup = false,
}: {
  user: FeatureUser;
  route: FeatureRoute;
  forceSetup?: boolean;
}) {
  const i18n = useLiekanI18n();
  const [entity, setEntity] = useState<FeatureEntity>(null);
  const ownedEntity = entity?.id === requestedRoute.id ? entity : undefined;
  const scopedRoute = normalizeFeatureScope({
    ...requestedRoute,
    ...(ownedEntity &&
    navigationFor(requestedRoute).scope === 'global' &&
    !['team-detail'].includes(requestedRoute.page)
      ? { teamId: ownedEntity.teamId || undefined }
      : {}),
  });
  const route: FeatureRoute =
    navigationFor(scopedRoute).scope === 'admin' && !user.isAdmin
      ? { page: 'access-denied' }
      : scopedRoute;
  const nav = useNavigation();
  const client = useQueryClient();
  const reading = useManualRefresh();
  const [toast, setToast] = useState('');
  const [websiteDeleted, setWebsiteDeleted] = useState<{
    userId: string;
    notice: WebsiteDeletedNotice;
  }>(null);
  const mainContent = useRef<HTMLElement>(null);
  const restoreResultFocus = useRef(false);
  const closeWebsiteDeleted = () => {
    restoreResultFocus.current = true;
    setWebsiteDeleted(null);
  };
  useEffect(() => {
    if (!websiteDeleted && restoreResultFocus.current) {
      restoreResultFocus.current = false;
      mainContent.current?.focus({ preventScroll: true });
    }
  }, [websiteDeleted]);
  const [width, setWidth] = useSidebarWidth();
  const [dateOpen, setDateOpen] = useState(false);
  const meta = navigationFor(route);
  const websiteRequired = needsWebsite(route);
  const datePage = hasDateControl(route);
  const teamMetadataRequired =
    meta.scope === 'global' &&
    (resourceListPages.has(route.page) ||
      [
        'onboarding',
        'board-editor',
        'board-view',
        'board-design',
        'link-editor',
        'pixel-editor',
        'link-detail',
        'pixel-detail',
        'team-detail',
      ].includes(route.page));
  const sourceTeam =
    !websiteRequired &&
    route.teamId &&
    (!route.id || ownedEntity) &&
    ['boards', 'board-editor', 'board-view', 'board-design'].includes(route.page)
      ? route.teamId
      : undefined;
  const siteScope =
    route.page === 'crawlers-manage' ||
    ['boards', 'board-view', 'board-editor', 'board-design'].includes(route.page) ||
    websiteRequired ||
    nav.query.scope === 'all'
      ? 'all'
      : 'personal';
  const needsSites =
    route.page === 'crawlers-manage' ||
    websiteRequired ||
    [
      'websites',
      'boards',
      'board-view',
      'board-editor',
      'board-design',
      'sharing',
      'team-detail',
    ].includes(route.page);
  const preferences = getFeaturePreferences();
  const accountPreferences = useAccountPreferences();
  const timezone = accountPreferences?.timezone || preferences.timezone || 'Asia/Shanghai';
  const { dateRange, invalidDate } = useFeatureDateRange(timezone);
  const range = useMemo(
    () => featureDateRange(dateRange, timezone),
    [+dateRange.startDate, +dateRange.endDate, dateRange.value, dateRange.unit, timezone],
  );
  const setup = forceSetup || ['two-factor', 'backup-codes'].includes(route.page);
  const sitesQuery = useQuery({
    queryKey: [
      'liekan-feature',
      user.id,
      'sites',
      websiteRequired ? undefined : route.teamId,
      siteScope,
      sourceTeam,
    ],
    queryFn: async ({ signal }) => {
      const source = getFeatureSites(
        signal,
        websiteRequired ||
          ['boards', 'board-view', 'board-editor', 'board-design'].includes(route.page)
          ? undefined
          : route.teamId,
        siteScope,
      );
      if (!sourceTeam) return source;
      const collections = await Promise.all([source, getFeatureSites(signal, sourceTeam, 'all')]);
      return [...new Map(collections.flat().map(site => [site.id, site])).values()];
    },
    enabled: !setup && needsSites,
    retry: false,
    staleTime: 300000,
    gcTime: 600000,
  });
  const sites = rowsOf<FeatureEntity>(sitesQuery.data);
  const teamsQuery = useQuery({
    queryKey: ['liekan-feature', user.id, 'teams'],
    queryFn: ({ signal }) => getAllFeatureRows<FeatureEntity>('/me/teams', {}, signal),
    enabled: !setup && route.page !== 'help',
    retry: false,
    staleTime: 300000,
    gcTime: 600000,
  });
  const listedTeams: FeatureEntity[] = teamsQuery.data || [];
  const resolveTeam =
    !setup &&
    teamMetadataRequired &&
    route.teamId &&
    (!route.id ||
      resourceListPages.has(route.page) ||
      ownedEntity ||
      route.page === 'team-detail') &&
    teamsQuery.isSuccess &&
    !listedTeams.some(team => team.id === route.teamId);
  const scopeTeamQuery = useQuery<FeatureEntity>({
    queryKey: ['liekan-feature', user.id, 'scope-team', route.teamId],
    queryFn: ({ signal }) => featureApi.get(`/teams/${route.teamId}`, {}, signal),
    enabled: !!resolveTeam,
    retry: false,
  });
  const teams =
    resolveTeam && scopeTeamQuery.data ? [...listedTeams, scopeTeamQuery.data] : listedTeams;
  const teamState =
    teamMetadataRequired && (teamsQuery.isPending || teamsQuery.error)
      ? teamsQuery
      : resolveTeam
        ? scopeTeamQuery
        : undefined;
  const siteId = websiteRequired
    ? sites.find(site => websiteMatchesHandle(site, route.websiteId))?.id || route.websiteId || ''
    : '';
  const siteQuery = useQuery({
    ...featureSiteQuery(user.id, siteId),
    enabled: !!siteId && !setup,
    retry: false,
  });
  const site = siteQuery.data || sites.find(s => websiteMatchesHandle(s, siteId));
  const current = forceSetup ? { ...route, page: 'two-factor' } : route;
  const websiteLayout = meta.scope === 'website';
  const [segmentsOpen, setSegmentsOpen] = useState(false);
  const [websiteContextTarget, setWebsiteContextTarget] = useState<HTMLDivElement>(null);
  const page = featurePages.find(p => p.id === current.page);
  useLiekanPageTitle(
    current.id && /-editor$/.test(current.page)
      ? (page?.title || '').replace(/^创建/, '编辑')
      : page?.title || '网站管理',
  );
  const href = useCallback(
    (page: string, params: Record<string, any> = {}) =>
      featureNavigationHref(route, nav.query, page, params),
    [route.page, route.websiteId, route.id, route.teamId, route.context, JSON.stringify(nav.query)],
  );
  const navigate = useCallback(
    (page: string, params: Record<string, any> = {}, options: { replace?: boolean } = {}) =>
      options.replace
        ? nav.router.replace(href(page, params))
        : nav.router.push(href(page, params)),
    [href, nav.router],
  );
  const pendingQuery = useRef<Record<string, any>>(null);
  const updateQuery = useCallback(
    (params: Record<string, any>) => {
      if (pendingQuery.current) {
        Object.assign(pendingQuery.current, params);
        return;
      }
      pendingQuery.current = { ...params };
      queueMicrotask(() => {
        const next = pendingQuery.current;
        pendingQuery.current = null;
        nav.router.replace(nav.updateParams(next), { scroll: false });
      });
    },
    [nav.router, nav.updateParams],
  );
  const notify = useCallback(
    (message: string, notice?: WebsiteDeletedNotice) => {
      if (notice?.kind === 'website-deleted') {
        setToast('');
        setWebsiteDeleted({ userId: user.id, notice });
      } else setToast(message);
    },
    [user.id],
  );
  const refresh = useCallback(async () => {
    await refreshFeatureIdentity();
    await reading?.refresh(reading.page.token);
  }, [client, user.id, reading?.refresh, reading?.page.token]);
  const filters = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(websiteRequired ? nav.query : {}).filter(([key]) =>
          /^(drill_|path|referrer|channel|title|query|os|device|browser|country|region|city|event|tag|hostname|distinctId|language|utm|segment|cohort|match|excludeBounce|attribution|retentionDate|retentionDay|spf\d|epf\d)/.test(
            key,
          ),
        ),
      ),
    [websiteRequired, JSON.stringify(nav.query)],
  );
  useEffect(() => {
    setDateOpen(false);
    setSegmentsOpen(false);
  }, [nav.pathname, route.websiteId, route.id]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (
      websiteDeleted &&
      (websiteDeleted.userId !== user.id || !['website-settings', 'websites'].includes(route.page))
    )
      setWebsiteDeleted(null);
  }, [user.id, route.page, websiteDeleted]);
  const value = {
    user,
    route: current,
    api: featureApi,
    sites,
    sitesLoading: needsSites && sitesQuery.isPending,
    sitesReady: sitesQuery.isSuccess && !sitesQuery.isPlaceholderData,
    teamsReady: teamsQuery.isSuccess && !teamsQuery.isPlaceholderData,
    teams,
    siteId,
    site,
    range,
    filters,
    query: nav.query,
    href,
    navigate,
    notify,
    refresh,
    entity: ownedEntity,
    setEntity,
    updateQuery,
  };
  if (current.page === 'share-preview')
    return (
      <FeatureProvider value={value}>
        <div data-liekan-features lang={i18n.locale} style={{ minHeight: '100dvh' }}>
          <div className={localeStyles.share} data-public-language>
            <LanguageSelector toolbar />
          </div>
          <WorkspacePages page="share-preview" />
        </div>
      </FeatureProvider>
    );
  const family = websiteAnalysisFamily(current);
  const currentTitle =
    family && !meta.parent && current.page !== 'segments'
      ? family.label
      : current.id && /-editor$/.test(current.page)
        ? (page?.title || '').replace(/^创建/, '编辑')
        : page?.title || liekanProduct.name;
  const pageKey = `${siteId || current.teamId || user.id}:${current.page}:${current.id || ''}`;
  const invalidRange = datePage && range.endAt - range.startAt > 1096 * 86400000;
  const readOnlyGlobalPage = !setup && ['websites'].includes(current.page);
  const metadata = teamState?.isPending || teamState?.error ? teamState : sitesQuery;
  const showAnalysisTools =
    websiteRequired &&
    !['tracking', 'install-check', 'website-settings', 'recorder-settings', 'sharing'].includes(
      current.page,
    ) &&
    !!siteId;
  const rangeContext = datePage && !['realtime', 'retention'].includes(current.page) && (
    <div className="range-context">
      {i18n.fragment('统计期间：', false, true)}
      {formatInTimeZone(range.startAt, timezone, 'yyyy-MM-dd')}
      {i18n.fragment(' 至', true, true)} {formatInTimeZone(range.endAt, timezone, 'yyyy-MM-dd')}
      {i18n.fragment(' · 统计时区：', true, true)}
      {timezone}
    </div>
  );
  const analysisTabs = (
    <AnalysisTabs
      route={current}
      href={href}
      onSegments={siteId && !meta.parent ? () => setSegmentsOpen(true) : undefined}
    />
  );
  const content =
    readOnlyGlobalPage && !invalidRange ? (
      <QueryState readOnly={!metadata.error || !!metadata.data} query={metadata}>
        <FeaturePage key={pageKey} page={current.page} />
      </QueryState>
    ) : !setup && (teamState?.isPending || (teamState?.error && !teamState?.data)) ? (
      <QueryState query={teamState}>{null}</QueryState>
    ) : !setup && websiteRequired && !siteId ? (
      <Notice>
        {i18n.fragment('请选择需要查看的网站。', false, true)}
        <QueryState query={sitesQuery}>
          <div className="form-actions">
            {sites.map(item => (
              <Link
                key={item.id}
                className="btn"
                href={featureHref(current.page, { websiteId: websiteHandle(item) })}
              >
                {item.name}
              </Link>
            ))}
            {!sites.length && (
              <Link className="btn" href={featureHref('websites')}>
                {i18n.text('返回网站列表')}
              </Link>
            )}
          </div>
        </QueryState>
      </Notice>
    ) : !setup && websiteRequired && siteQuery.isSuccess && siteQuery.data === null ? (
      <Notice tone="red">
        <p>{i18n.text('此网站不存在或已删除。')}</p>
        <Link className="btn" href={href('websites')}>
          {i18n.text('返回网站列表')}
        </Link>
      </Notice>
    ) : !setup && websiteRequired && siteQuery.error && !siteQuery.data ? (
      <QueryState query={siteQuery}>{null}</QueryState>
    ) : !setup &&
      needsSites &&
      !websiteRequired &&
      (sitesQuery.isPending || (sitesQuery.error && !sitesQuery.data)) ? (
      <QueryState query={sitesQuery}>{null}</QueryState>
    ) : invalidRange ? (
      <Notice>{i18n.text('日期范围上限 3 年，请调整日期后查看。')}</Notice>
    ) : (
      <FeaturePage key={pageKey} page={current.page} />
    );
  const dateControl = datePage && (
    <Button onClick={() => setDateOpen(true)}>
      {formatInTimeZone(range.startAt, timezone, 'yyyy-MM-dd')}
      {i18n.fragment(' 至', true, true)} {formatInTimeZone(range.endAt, timezone, 'MM-dd')}
      <Icon name="down" />
    </Button>
  );
  // 快捷时间按钮只进网站项目工具栏；非 websiteLayout 的页头（dateControl 的另一处渲染）不加。
  const websiteDateActions = websiteLayout &&
    datePage &&
    !['realtime', 'retention'].includes(route.page) && (
      <>
        <QuickRangeButtons
          variant="btn"
          activeToken={activeQuickDateRange(nav.query)}
          onSelect={token =>
            nav.router.push(
              nav.updateParams({
                date: token,
                unit: undefined,
                offset: undefined,
                dateMode: undefined,
                live: undefined,
              }),
            )
          }
        />
        {dateControl}
      </>
    );
  if (setup)
    return (
      <FeatureProvider value={value}>
        <div data-liekan-features lang={i18n.locale} className="identity-flow">
          <div className={localeStyles.standalone}>
            <LanguageSelector toolbar />
          </div>
          <main className="content" id="main-content" ref={mainContent} tabIndex={-1}>
            <h1 data-liekan-page-title>{i18n.system(currentTitle)}</h1>
            <AnalysisTabs
              route={current}
              href={href}
              onSegments={siteId && !meta.parent ? () => setSegmentsOpen(true) : undefined}
            />
            <AnalysisPendingNotice
              websiteId={site?.id || siteId}
              websiteHandle={current.websiteId}
            />
            {content}
          </main>
          <ProductFooter />
          {toast && (
            <div className="toast" role="status">
              {i18n.system(toast)}
            </div>
          )}
        </div>
      </FeatureProvider>
    );
  return (
    <FeatureProvider value={value}>
      <div
        data-liekan-features
        data-website-layout={websiteLayout || undefined}
        lang={i18n.locale}
        style={
          {
            minHeight: '100dvh',
            '--lk-side-w': `${width}px`,
            '--side': `${width}px`,
          } as CSSProperties
        }
      >
        <a className="skip" href="#main-content">
          {i18n.text('跳到主要内容')}
        </a>
        <Navigation
          user={user}
          route={current}
          site={site}
          siteUnavailable={websiteRequired && siteQuery.isSuccess && siteQuery.data === null}
          width={width}
          onWidth={setWidth}
          href={href}
          websiteContextTarget={websiteContextTarget}
        />
        <div className="shell-content">
          {websiteLayout && (
            <WebsiteToolbar
              contextRef={setWebsiteContextTarget}
              actions={websiteDateActions}
              websiteId={websiteMatchesHandle(site, siteId) ? site.id : undefined}
              range={range}
            />
          )}
          <header className="header">
            <div className="header-inner">
              <div>
                <h1 data-liekan-page-title>{i18n.system(currentTitle)}</h1>
              </div>
              <div className="header-actions">
                {current.page !== 'help' && (
                  <ManualRefreshControl
                    showTime={datePage || readOnlyGlobalPage}
                    beforeRefresh={refreshFeatureIdentity}
                  />
                )}
                {!websiteLayout && dateControl}
                {resourceListPages.has(current.page) && meta.scope === 'global' && (
                  <label className="context-select">
                    <span>{i18n.text('所属空间')}</span>
                    <select
                      aria-label={i18n.text('所属空间')}
                      value={
                        route.teamId ||
                        (current.page === 'websites' && nav.query.scope === 'all' ? 'all' : '')
                      }
                      onChange={event =>
                        nav.router.push(
                          featureHref(current.page, {
                            ...Object.fromEntries(
                              Object.entries(nav.query).filter(([key]) =>
                                [
                                  'date',
                                  'unit',
                                  'offset',
                                  'compare',
                                  'search',
                                  'sort',
                                  'direction',
                                ].includes(key),
                              ),
                            ),
                            ...(event.target.value === 'all'
                              ? { scope: 'all' }
                              : event.target.value
                                ? { teamId: event.target.value }
                                : {}),
                          }),
                        )
                      }
                    >
                      <option value="">{i18n.text('个人空间')}</option>
                      {route.teamId && !teams.some(team => team.id === route.teamId) && (
                        <option value={route.teamId} disabled>
                          {teamsQuery.error || scopeTeamQuery.error
                            ? i18n.text('所选团队（无法访问）')
                            : i18n.text('正在确认团队空间')}
                        </option>
                      )}
                      {current.page === 'websites' && (
                        <option value="all">{i18n.text('全部可访问网站')}</option>
                      )}
                      {teams.map(team => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                    <Icon name="down" />
                  </label>
                )}
              </div>
              {!websiteLayout && <LanguageSelector toolbar />}
            </div>
          </header>
          {showAnalysisTools && (
            <>
              <div className={shellStyles.tabsFrame} data-analysis-tabs-frame>
                {analysisTabs}
              </div>
              <div className={`analysis-context ${shellStyles.analysisTools}`}>
                {rangeContext}
                <div className="analysis-tools">
                  <Link href={href('filters')}>{i18n.text('高级筛选')}</Link>
                  <Link href={href('annotations')}>{i18n.text('图表注释')}</Link>
                  <Link href={href('exports')}>{i18n.text('导出数据')}</Link>
                </div>
              </div>
            </>
          )}
          <main className="content" id="main-content" ref={mainContent} tabIndex={-1}>
            {datePage && invalidDate && (
              <Notice tone="amber">
                {i18n.fragment('日期参数无效，当前使用默认日期范围。', false, true)}
                <Button
                  onClick={() =>
                    updateQuery({
                      date: '0day',
                      unit: undefined,
                      offset: undefined,
                      dateMode: undefined,
                      live: undefined,
                    })
                  }
                >
                  {i18n.text('重置日期')}
                </Button>
              </Notice>
            )}
            {!showAnalysisTools && rangeContext}
            {websiteRequired && nav.query.clearedFilters === '1' && (
              <Notice>{i18n.text('已清除当前页面不支持的筛选，统计采用页面显示的条件。')}</Notice>
            )}
            {!showAnalysisTools && analysisTabs}
            <AnalysisPendingNotice
              websiteId={site?.id || siteId}
              websiteHandle={current.websiteId}
            />
            {content}
          </main>
          <ProductFooter />
        </div>
        {current.page !== 'history-repair' && <HistoryRepairNotice userId={user.id} />}
        {toast && (
          <div className="toast" role="status">
            {i18n.system(toast)}
          </div>
        )}
        {websiteDeleted?.userId === user.id && current.page === 'websites' && (
          <LiekanDialog
            title={i18n.text('网站删除成功')}
            size="wide"
            className="website-delete-success"
            protectUnsaved={false}
            onClose={closeWebsiteDeleted}
          >
            <div className="website-delete-result">
              <div className="website-delete-result-icon" aria-hidden="true">
                <Icon name="check" />
              </div>
              <div className="website-delete-result-content">
                <h3 className="website-delete-result-name">{websiteDeleted.notice.name}</h3>
                {websiteDeleted.notice.domain && (
                  <p className="website-delete-result-domain">{websiteDeleted.notice.domain}</p>
                )}
                <p className="website-delete-result-description">
                  {i18n.text('该网站及其关联数据和设置已删除，无法恢复。')}
                </p>
                <p className="website-delete-result-hint">
                  {i18n.text('其他网站的数据和设置保持不变。你可以继续管理网站，或添加新网站。')}
                </p>
              </div>
            </div>
            <DialogActions>
              <button type="button" className="btn primary" autoFocus onClick={closeWebsiteDeleted}>
                {i18n.text('知道了')}
              </button>
            </DialogActions>
          </LiekanDialog>
        )}
        {segmentsOpen && <SavedSegments onClose={() => setSegmentsOpen(false)} />}
        {dateOpen && (
          <LiekanDialog
            title={i18n.text('选择日期范围')}
            subtitle={i18n.system(timezone)}
            protectUnsaved={false}
            onClose={() => setDateOpen(false)}
          >
            <Form
              trackUnsaved={false}
              submitLabel={i18n.text('应用日期范围')}
              onSubmit={async d => {
                const startAt = +fromZonedTime(`${d.start}T00:00:00.000`, timezone);
                const endAt = +fromZonedTime(`${d.end}T23:59:59.999`, timezone);
                if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt)
                  throw new Error('日期范围无效');
                if (endAt - startAt > 1096 * 86400000) throw new Error('日期范围上限 3 年');
                nav.router.push(
                  nav.updateParams({
                    date: `range:${startAt}:${endAt}:day`,
                    unit: 'day',
                    offset: undefined,
                    dateMode: undefined,
                    live: undefined,
                  }),
                );
                setDateOpen(false);
              }}
            >
              <div className="form-grid">
                <Field
                  label={i18n.text('开始日期')}
                  name="start"
                  type="date"
                  defaultValue={formatInTimeZone(range.startAt, timezone, 'yyyy-MM-dd')}
                  required
                />
                <Field
                  label={i18n.text('结束日期')}
                  name="end"
                  type="date"
                  defaultValue={formatInTimeZone(range.endAt, timezone, 'yyyy-MM-dd')}
                  required
                />
              </div>
            </Form>
          </LiekanDialog>
        )}
      </div>
    </FeatureProvider>
  );
}

function FeaturePage({ page }: { page: string }) {
  const i18n = useLiekanI18n();
  if (['access-denied', 'session-expired', 'not-found'].includes(page))
    return (
      <Notice>
        {page === 'access-denied'
          ? i18n.text('当前账户没有访问此资源的权限。')
          : page === 'session-expired'
            ? i18n.text('请重新登录后继续。')
            : i18n.text('页面不存在或已被移除。')}
        <div className="form-actions">
          <Link className="btn" href={page === 'session-expired' ? '/login' : '/websites'}>
            {page === 'session-expired' ? i18n.text('重新登录') : i18n.text('返回工作台')}
          </Link>
        </div>
      </Notice>
    );
  if (aiPages.has(page)) return <AiPages page={page} />;
  if (page === 'help') return <HelpCenter />;
  if (page === 'crawlers-manage') return <CrawlerRegistryPage />;
  if (page === 'admin-analytics-engine') return <AnalyticsEnginePage />;
  if (page === 'analytics-acceleration') return <AnalyticsAccelerationPage />;
  if (page === 'history-repair') return <HistoryRepairPage />;
  if (coreFeaturePages.has(page)) return <CorePages page={page} />;
  if (analysisPages.has(page)) return <AnalyticsPages page={page} />;
  if (extendedPages.has(page)) return <ExtendedPages page={page} />;
  if (workspacePages.has(page)) return <WorkspacePages page={page} />;
  if (linksPixelsPages.has(page)) return <LinksPixelsPages page={page} />;
  return null;
}
