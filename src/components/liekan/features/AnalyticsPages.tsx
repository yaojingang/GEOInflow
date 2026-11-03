'use client';
import { calendarDayRange, shiftCalendarRange } from '@/lib/liekan/contracts/calendar';
import { identityUsable } from '@/lib/liekan/contracts/browser-population';
import { identityUnavailableReason } from '@/lib/liekan/contracts/population-results';
import { TableCell } from './ui';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';

import { useManualRefresh } from '@/lib/liekan/contracts/manual-refresh';
import Link from '@/components/liekan/Link';
import { useEffect, useState } from 'react';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import {
  conditionsToQuery,
  duration,
  percentage,
  retentionSummary,
  completedObservationDate,
  relativeDaySeries,
  savedConditionParameters,
  decodePropertyConditions,
  type AnalysisCondition,
  type JourneyData,
} from '@/lib/liekan/contracts/analysis';
import { visitorGeographyLabel } from '@/lib/liekan/contracts/geography';
import { classifyEntrySourceForDisplay } from '@/lib/liekan/contracts/sources';
import { numberLabel, rowsOf } from '@/lib/liekan/contracts/features';
import { getAllFeatureRows } from '@/lib/liekan/upstream/features-client';
import { pageLink, pageSequence } from '../PageLink';
import { useFeature, useData, useAction } from './context';
import { Chart } from './Chart';
import {
  Badge,
  Body,
  Button,
  Definition,
  LiekanDialog,
  DialogActions,
  Field,
  Form,
  Icon,
  LinkButton,
  Metrics,
  MatrixTable,
  Notice,
  Panel,
  QueryState,
  Select,
  Table,
  Tabs,
  Textarea,
} from './ui';

export const analysisPages = new Set([
  'realtime',
  'events',
  'event-detail',
  'sessions',
  'session-detail',
  'filters',
  'segments',
  'segment-editor',
  'cohorts',
  'cohort-editor',
  'retention',
  'journeys',
  'path-detail',
  'utm',
  'attribution',
  'breakdown',
  'compare',
  'annotations',
]);
const n = numberLabel;
function useScope(extra: any = {}) {
  const c = useFeature();
  return { ...c.range, ...c.filters, ...extra };
}
function useWebsiteData(
  key: any[],
  suffix: string,
  params: any = {},
  enabled = true,
  owned = false,
) {
  const c = useFeature();
  return useData(
    key,
    signal => c.api.get(`${owned ? '/liekan' : ''}/websites/${c.siteId}/${suffix}`, params, signal),
    !!c.siteId && enabled,
    ['sessions', 'session', 'session-properties', 'events', 'realtime'].includes(params.kind) ||
      suffix.startsWith('journeys/details')
      ? {
          queryKey: ['liekan-feature', c.user.id, c.siteId, ...key, params],
          staleTime: 0,
          direct: true,
        }
      : undefined,
  );
}
const visitor = (id: string) => `访客 ${id?.replaceAll('-', '').slice(-6) || '—'}`;
type SourceDisplay = { source: string; sourceLabel?: 'direct' };
const sourceText = (value: SourceDisplay, display: (source: string) => string) =>
  value.sourceLabel === 'direct' ? display('直接访问') : value.source;
function sourceCell(value: SourceDisplay, i18n: ReturnType<typeof useLiekanI18n>) {
  return (
    <TableCell sortValue={value.source} searchValue={sourceText(value, i18n.english.text)}>
      {sourceText(value, i18n.text)}
    </TableCell>
  );
}
function date(value: any, timezone: string) {
  return value ? formatInTimeZone(value, timezone, 'yyyy-MM-dd HH:mm:ss') : '—';
}
// 报表分组桶是服务端 date_trunc 生成的文本；按 unit 渲染成紧凑标签，解析失败时原样展示。
function bucketLabel(value: any, unit: string | undefined, timezone: string) {
  if (value == null || Number.isNaN(Date.parse(value))) return value;
  const pattern =
    unit === 'minute' || unit === 'hour'
      ? 'MM-dd HH:mm'
      : unit === 'month'
        ? 'yyyy-MM'
        : unit === 'year'
          ? 'yyyy'
          : 'MM-dd';
  return formatInTimeZone(value, timezone, pattern);
}
export function canManage(c: ReturnType<typeof useFeature>) {
  return (
    c.user.isAdmin ||
    c.site?.userId === c.user.id ||
    c.teams.some(
      t =>
        t.id === c.site?.teamId &&
        t.members?.some(
          (m: any) =>
            m.userId === c.user.id &&
            ['team-owner', 'team-manager', 'team-member'].includes(m.role),
        ),
    )
  );
}
function ActionLink({
  page,
  params = {},
  children,
}: {
  page: string;
  params?: any;
  children: any;
}) {
  const c = useFeature();
  return (
    <Link
      prefetch={false}
      href={c.href(page, {
        ...c.filters,
        date: `range:${c.range.startAt}:${c.range.endAt}:${c.range.unit}`,
        ...params,
      })}
    >
      {children} →
    </Link>
  );
}

export function SessionTable({
  title = '访问记录',
  params = {},
}: {
  title?: string;
  params?: any;
}) {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const [page, setPage] = useState(1);
  const scope = useScope({ ...params, kind: 'sessions', page });
  useEffect(
    () => setPage(1),
    [c.siteId, JSON.stringify(c.filters), c.range.startAt, c.range.endAt, JSON.stringify(params)],
  );
  const query = useWebsiteData(['sessions-rich', scope], 'analytics', scope, true, true);
  const data = query.data;
  return (
    <Panel
      title={i18n.system(title)}
      subtitle={i18n.text('按当前日期与条件读取访问记录。会话是一次连续访问，访客标识脱敏显示。')}
      actions={<LinkButton page="filters">{i18n.text('筛选')}</LinkButton>}
    >
      <QueryState query={query}>
        <Table
          className="session-records-table"
          search
          columns={['访客', '访问时间', '地域', '来源', '当前页面', '页面数', '时长', '操作']}
          numeric={[5, 6]}
          page={page}
          pages={Math.ceil((data?.count || 0) / 25)}
          onPage={setPage}
          rows={(data?.rows || []).map((r: any) => [
            <TableCell sortValue={visitor(r.id)} searchValue={i18n.english.system(visitor(r.id))}>
              {i18n.system(visitor(r.id))}
            </TableCell>,
            date(r.lastAt, c.range.timezone),
            <TableCell
              sortValue={visitorGeographyLabel(r, 'zh-CN')}
              searchValue={visitorGeographyLabel(r, 'en-US')}
            >
              {visitorGeographyLabel(r, i18n.locale)}
            </TableCell>,
            sourceCell(classifyEntrySourceForDisplay({ referrer: r.referrerDomain }), i18n),
            <TableCell
              sortValue={pageLink(r.urlPath, c.site?.domain, undefined, undefined, 'zh-CN')}
              searchValue={pageLink(r.urlPath, c.site?.domain, undefined, undefined, 'en-US')}
            >
              {pageLink(r.urlPath, c.site?.domain, undefined, undefined, i18n.locale)}
            </TableCell>,
            n(r.views),
            <TableCell
              sortValue={duration(r.seconds, 'zh-CN')}
              searchValue={duration(r.seconds, 'en-US')}
            >
              {duration(r.seconds, i18n.locale)}
            </TableCell>,
            <TableCell sortValue={i18n.source('详情')} searchValue={i18n.english.text('详情')}>
              <ActionLink page="session-detail" params={{ id: r.id }} key={r.id}>
                {i18n.text('详情')}
              </ActionLink>
            </TableCell>,
          ])}
        />
      </QueryState>
    </Panel>
  );
}
function Realtime() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const reading = useManualRefresh();
  const [initialTick] = useState(Date.now());
  const tick = reading?.page.now ?? initialTick;
  const scope = {
    startAt: tick - 30 * 60000,
    endAt: tick,
    timezone: c.range.timezone,
    unit: 'minute',
    ...c.filters,
  };
  const query = useData(
    ['realtime-rich', tick],
    signal => {
      const endAt = Date.now();
      return c.api.get(
        `/liekan/websites/${c.siteId}/analytics`,
        {
          ...scope,
          kind: 'realtime',
          startAt: endAt - 30 * 60000,
          endAt,
        },
        signal,
      );
    },
    !!c.siteId,
  );
  const timeline = useData(
    ['realtime-series', tick],
    signal =>
      c.api.get(
        `/realtime/${c.siteId}`,
        { timezone: c.range.timezone, unit: 'minute', ...c.filters },
        signal,
      ),
    !!c.siteId,
  );
  const totals = query.data?.totals;
  const series = timeline.data?.series?.visitors || [];
  return (
    <>
      <Metrics
        loading={query.isPending}
        items={[
          [
            i18n.text('当前活跃'),
            totals ? n(totals.active) : null,
            i18n.text('过去 5 分钟'),
            'blue',
          ],
          [i18n.text('页面访问'), totals ? n(totals.views) : null, i18n.text('过去 30 分钟')],
          [i18n.text('访问事件'), totals ? n(totals.events) : null, i18n.text('过去 30 分钟')],
          [i18n.text('AI 引荐访客'), totals ? n(totals.ai) : null, i18n.text('由访问来源识别')],
        ]}
      />
      <Panel
        title={i18n.text('过去 30 分钟的访客')}
        subtitle={i18n.text('本次读取的过去 30 分钟，访客序列以分钟聚合。')}
        actions={<Button onClick={() => c.refresh()}>{i18n.text('刷新')}</Button>}
      >
        <QueryState query={timeline}>
          <Chart
            interactionKey={JSON.stringify(['realtime', c.user.id, c.siteId, scope, timeline.data])}
            type="bar"
            labels={series.map((r: any) => r.x)}
            series={[
              {
                name: i18n.text('访客'),
                values: series.map((r: any) => (r.y == null ? null : Number(r.y))),
              },
            ]}
          />
        </QueryState>
      </Panel>
      <div className="two">
        <Panel title={i18n.text('热门页面')} subtitle={i18n.text('当前活跃访客访问的页面。')}>
          <QueryState query={query}>
            <Table
              columns={['页面', '活跃访客']}
              rows={(query.data?.pages || []).map((r: any) => [
                <TableCell
                  sortValue={pageLink(r.name, c.site?.domain, undefined, undefined, 'zh-CN')}
                  searchValue={pageLink(r.name, c.site?.domain, undefined, undefined, 'en-US')}
                >
                  {pageLink(r.name, c.site?.domain, undefined, undefined, i18n.locale)}
                </TableCell>,
                n(r.value),
              ])}
              numeric={[1]}
            />
          </QueryState>
        </Panel>
        <Panel title={i18n.text('访问来源')} subtitle={i18n.text('来源识别基于可用的引荐信息。')}>
          <QueryState query={query}>
            <Table
              columns={['来源', '活跃访客']}
              rows={(query.data?.sources || []).map((r: any) => [
                sourceCell({ source: r.name, sourceLabel: r.sourceLabel }, i18n),
                n(r.value),
              ])}
              numeric={[1]}
            />
          </QueryState>
        </Panel>
      </div>
      <SessionTable title={i18n.text('最新访问')} params={scope} />
    </>
  );
}
function Events() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const [page, setPage] = useState(1);
  const scope = useScope();
  useEffect(
    () => setPage(1),
    [c.siteId, c.range.startAt, c.range.endAt, JSON.stringify(c.filters)],
  );
  const query = useWebsiteData(
    ['events-rich', page],
    'analytics',
    { ...scope, kind: 'events', page },
    true,
    true,
  );
  const timeline = useWebsiteData(['event-series'], 'events/series', scope);
  const d = query.data,
    t = d?.totals;
  const points: any[] = timeline.data || [];
  const buckets = [...new Set(points.map(r => r.t))];
  const labels = buckets.map(t => bucketLabel(t, scope.unit, scope.timezone));
  const names = [...new Set(points.map(r => r.x))];
  return (
    <>
      <Metrics
        loading={query.isPending}
        items={[
          [i18n.text('事件触发次数'), t ? n(t.total) : null, i18n.text('当前期间')],
          [i18n.text('事件种类'), t ? n(t.types) : null, i18n.text('按事件名称聚合')],
          [i18n.text('关联独立访客'), t ? n(t.visitors) : null, i18n.text('事件触发访客')],
          [
            i18n.text('带属性事件'),
            t ? n(t.withProperties) : null,
            i18n.text('有属性的事件触发次数'),
          ],
        ]}
      />
      <Panel title={i18n.text('事件触发趋势')} subtitle={i18n.text('日期范围与下方明细一致。')}>
        <QueryState query={timeline}>
          <Chart
            interactionKey={JSON.stringify(['events', c.user.id, c.siteId, scope, timeline.data])}
            labels={labels}
            series={names.map(name => ({
              name,
              values: buckets.map(bucket =>
                points
                  .filter(r => r.x === name && r.t === bucket)
                  .reduce((s, r) => (s === null || r.y === null ? null : s + Number(r.y)), 0),
              ),
            }))}
          />
        </QueryState>
      </Panel>
      <Panel
        title={i18n.text('事件列表')}
        subtitle={i18n.text('点击事件名称查看属性分布与关联访问记录。')}
      >
        <QueryState query={query}>
          <Table
            search
            columns={['事件名称', '触发次数', '触发访客', '属性数', '最近触发', '操作']}
            numeric={[1, 2, 3]}
            page={page}
            pages={Math.ceil((d?.count || 0) / 100)}
            onPage={setPage}
            rows={(d?.rows || []).map((r: any) => [
              <ActionLink page="event-detail" params={{ eventName: r.name }} key={r.name}>
                <code>{r.name}</code>
              </ActionLink>,
              n(r.triggers),
              n(r.visitors),
              n(r.properties),
              date(r.lastAt, scope.timezone),
              <TableCell sortValue={i18n.source('属性')} searchValue={i18n.english.text('属性')}>
                <ActionLink page="event-detail" params={{ eventName: r.name }} key={r.name}>
                  {i18n.text('属性')}
                </ActionLink>
              </TableCell>,
            ])}
          />
        </QueryState>
      </Panel>
    </>
  );
}
function EventDetail() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const name = c.query.eventName || '';
  const [property, setProperty] = useState('');
  const scope = useScope({ eventName: name, kind: 'events', propertyName: property });
  const query = useWebsiteData(['event-detail', name, property], 'analytics', scope, !!name, true);
  const d = query.data,
    t = d?.totals;
  const properties = [...new Set<string>((d?.properties || []).map((r: any) => r.name))];
  useEffect(() => {
    if (d && !properties.includes(property)) setProperty(properties[0] || '');
  }, [!!d, JSON.stringify(properties)]);
  if (!name)
    return (
      <Notice>
        {i18n.fragment('请从事件列表选择一个事件。', false, true)}
        <LinkButton page="events">{i18n.text('返回事件列表')}</LinkButton>
      </Notice>
    );
  const present = (d?.properties || [])
    .filter((r: any) => r.name === property)
    .reduce((s: number, r: any) => s + Number(r.total), 0);
  const values = [...(d?.values || [])];
  if (t && property && present < t.total)
    values.push({ value: null, dataType: 0, total: t.total - present });
  const types: Record<number, string> = {
    0: '缺失',
    1: '字符串',
    2: '数值',
    3: '布尔值',
    4: '日期',
    5: '数组',
  };
  return (
    <>
      <div className="row between">
        <div>
          <Badge tone="blue">{i18n.text('事件')}</Badge> <code>{name}</code>
        </div>
        <LinkButton page="events">{i18n.text('返回事件列表')}</LinkButton>
      </div>
      <Metrics
        loading={query.isPending}
        items={[
          [i18n.text('触发次数'), t ? n(t.total) : null, i18n.text('当前期间')],
          [i18n.text('触发访客'), t ? n(t.visitors) : null, i18n.text('独立访客')],
          [
            i18n.text('属性字段'),
            d ? n(properties.length) : null,
            properties.length ? <>{properties.join('、')}</> : i18n.text('当前事件未提供属性'),
          ],
          [
            i18n.text('最近触发'),
            t ? date(t.lastAt, c.range.timezone) : null,
            i18n.text('当前期间'),
          ],
        ]}
      />
      <QueryState query={query}>
        <div className="two">
          <Panel
            title={i18n.text('事件属性分布')}
            subtitle={i18n.text('{v0} 的各属性值对应触发次数。', [
              property || i18n.text('未提供属性'),
            ])}
            actions={
              <Tabs items={properties.map(p => [p, p])} active={property} onChange={setProperty} />
            }
          >
            <Chart
              interactionKey={JSON.stringify([
                'event-property',
                c.user.id,
                c.siteId,
                scope,
                query.data,
              ])}
              type="bar"
              horizontal
              labels={values.map(r => r.value ?? i18n.text('未提供'))}
              series={[{ name: i18n.text('触发次数'), values: values.map(r => Number(r.total)) }]}
            />
          </Panel>
          <Panel title={i18n.text('属性值明细')} subtitle={i18n.text('值类型和缺失状态分别显示。')}>
            <Table
              columns={['属性值', '类型', '触发次数', '占比']}
              rows={values.map(r => [
                <TableCell
                  sortValue={r.value == null ? i18n.source('未提供') : r.value}
                  searchValue={
                    r.value == null ? i18n.english.system(i18n.english.text('未提供')) : r.value
                  }
                >
                  {r.value == null ? <Badge>{i18n.text('未提供')}</Badge> : r.value}
                </TableCell>,
                <TableCell
                  sortValue={types[r.dataType] ? types[r.dataType] : i18n.source('未识别类型')}
                  searchValue={
                    types[r.dataType]
                      ? i18n.english.label(types[r.dataType], 'event-property-type')
                      : i18n.english.text('未识别类型')
                  }
                >
                  {types[r.dataType]
                    ? i18n.label(types[r.dataType], 'event-property-type')
                    : i18n.text('未识别类型')}
                </TableCell>,
                n(r.total),
                percentage(r.total, t?.total),
              ])}
              numeric={[2, 3]}
            />
            {d?.limited && (
              <Notice>
                {i18n.text('属性值较多，当前显示前 100 项；占比使用全部事件作分母。')}
              </Notice>
            )}
          </Panel>
        </div>
      </QueryState>
      <SessionTable title={i18n.text('关联访问记录')} params={{ drill_event: `eq.${name}` }} />
    </>
  );
}
function Sessions() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const [tab, setTab] = useState(c.query.tab || 'activity'),
    [page, setPage] = useState(1);
  useEffect(() => {
    setTab(c.query.tab || 'activity');
    setPage(1);
  }, [c.query.tab, JSON.stringify(c.filters)]);
  useEffect(
    () => setPage(1),
    [c.siteId, c.range.startAt, c.range.endAt, JSON.stringify(c.filters)],
  );
  const scope = useScope({ kind: tab === 'properties' ? 'session-properties' : 'sessions', page });
  const query = useWebsiteData(
    ['session-tab', tab, page],
    'analytics',
    scope,
    tab !== 'activity',
    true,
  );
  return (
    <>
      <Tabs
        items={[
          ['activity', i18n.text('访问活动')],
          ['visitors', i18n.text('访客')],
          ['properties', i18n.text('会话属性')],
        ]}
        active={tab}
        onChange={t => {
          setTab(t);
          setPage(1);
        }}
      />
      {tab === 'activity' ? (
        <SessionTable />
      ) : (
        <Panel
          title={i18n.system(tab === 'properties' ? i18n.text('会话属性') : i18n.text('访客记录'))}
          subtitle={i18n.system(
            tab === 'properties'
              ? i18n.text('按已提供的身份属性查看人群。')
              : i18n.text('以脱敏访客标识聚合访问。'),
          )}
        >
          <QueryState query={query}>
            <Table
              search
              columns={
                tab === 'properties'
                  ? ['属性名称', '属性值', '关联会话', '操作']
                  : ['访客', '最近访问', '会话次数', '访问页面', '操作']
              }
              rows={(query.data?.rows || []).map((r: any) =>
                tab === 'properties'
                  ? [
                      r.name,
                      <TableCell
                        sortValue={r.value ?? i18n.source('未提供')}
                        searchValue={r.value ?? i18n.english.text('未提供')}
                      >
                        {r.value ?? i18n.text('未提供')}
                      </TableCell>,
                      n(r.sessions),
                      <TableCell
                        sortValue={i18n.source('详情')}
                        searchValue={i18n.english.text('详情')}
                      >
                        <ActionLink
                          page="sessions"
                          key={`${r.name}:${r.value}`}
                          params={{
                            spf0: `${r.dataType}.eq.${encodeURIComponent(r.name).replaceAll('.', '%2E')}.${r.value}`,
                            tab: 'activity',
                          }}
                        >
                          {i18n.text('详情')}
                        </ActionLink>
                      </TableCell>,
                    ]
                  : [
                      <TableCell
                        sortValue={visitor(r.id)}
                        searchValue={i18n.english.system(visitor(r.id))}
                      >
                        {i18n.system(visitor(r.id))}
                      </TableCell>,
                      date(r.lastAt, c.range.timezone),
                      n(r.visits),
                      <TableCell
                        sortValue={pageLink(
                          r.urlPath,
                          c.site?.domain,
                          undefined,
                          undefined,
                          'zh-CN',
                        )}
                        searchValue={pageLink(
                          r.urlPath,
                          c.site?.domain,
                          undefined,
                          undefined,
                          'en-US',
                        )}
                      >
                        {pageLink(r.urlPath, c.site?.domain, undefined, undefined, i18n.locale)}
                      </TableCell>,
                      <TableCell
                        sortValue={i18n.source('详情')}
                        searchValue={i18n.english.text('详情')}
                      >
                        <ActionLink page="session-detail" params={{ id: r.id }} key={r.id}>
                          {i18n.text('详情')}
                        </ActionLink>
                      </TableCell>,
                    ],
              )}
              numeric={[2]}
              page={page}
              pages={
                tab === 'properties'
                  ? query.data?.more
                    ? page + 1
                    : page
                  : Math.ceil((query.data?.count || 0) / 25)
              }
              onPage={setPage}
            />
          </QueryState>
        </Panel>
      )}
      <Notice>{i18n.text('访问记录保留时间、环境、来源和行为时间线，访客标识脱敏展示。')}</Notice>
    </>
  );
}
function SessionDetail() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const id = c.route.id;
  const [page, setPage] = useState(1);
  useEffect(
    () => setPage(1),
    [c.siteId, c.range.startAt, c.range.endAt, JSON.stringify(c.filters)],
  );
  const scope = useScope({ kind: 'session', sessionId: id, page });
  const query = useWebsiteData(['session-timeline', id, page], 'analytics', scope, !!id, true);
  const record = useWebsiteData(['session-record', id], `sessions/${id}`, {}, !!id);
  const props = useWebsiteData(['session-props', id], `sessions/${id}/properties`, {}, !!id);
  const replays = useWebsiteData(
    ['session-replays', id],
    `sessions/${id}/replays`,
    useScope(),
    !!id,
  );
  if (!id)
    return (
      <Notice>
        {i18n.fragment('请选择访问记录后查看详情。', false, true)}
        <LinkButton page="sessions">{i18n.text('返回访问记录')}</LinkButton>
      </Notice>
    );
  const unavailable = !identityUsable(query.data?.population);
  const r = record.data,
    rows = query.data?.rows || [],
    t = query.data?.totals,
    first =
      t && !unavailable
        ? { createdAt: t.firstAt, referrerDomain: t.referrerDomain, urlPath: t.entryPath }
        : undefined,
    last = t && !unavailable ? { createdAt: t.lastAt, urlPath: t.exitPath } : undefined,
    replay = rowsOf<any>(replays.data)[0];
  return (
    <>
      <div className="row between">
        <div className="row">
          <Badge tone="blue">{i18n.text('访问详情')}</Badge>
          <strong>{unavailable ? '—' : i18n.system(visitor(id))}</strong>
          <span className="muted">{date(first?.createdAt, c.range.timezone)}</span>
        </div>
        <div className="actions">
          <LinkButton page="sessions">{i18n.text('返回访问记录')}</LinkButton>
          {replay ? (
            <LinkButton page="replay-player" params={{ id: replay.id }}>
              {i18n.text('查看回放')}
            </LinkButton>
          ) : (
            <Button disabled>
              {replays.isPending
                ? i18n.text('正在读取回放')
                : replays.error
                  ? i18n.text('回放读取失败')
                  : i18n.text(unavailable ? '不可用' : '未采集回放')}
            </Button>
          )}
        </div>
      </div>
      {replays.error && <QueryState query={replays}>{null}</QueryState>}
      <Metrics
        loading={query.isPending}
        items={[
          [i18n.text('页面访问'), t ? n(t.views) : null, i18n.text('当前期间')],
          [i18n.text('事件触发'), t ? n(t.events) : null, i18n.text('当前期间')],
          [
            i18n.text('会话时长'),
            duration(t?.seconds, i18n.locale),
            i18n.text('首次至最近一次行为'),
          ],
          [
            i18n.text('访问来源'),
            first
              ? sourceText(
                  classifyEntrySourceForDisplay({ referrer: first.referrerDomain }),
                  i18n.text,
                )
              : null,
            i18n.text('引荐域名识别'),
            'blue',
          ],
        ]}
      />
      <div className="narrow-wide">
        <Panel title={i18n.text('访客信息')} subtitle={i18n.text('环境信息与已提供的会话属性。')}>
          <Body>
            <QueryState query={record}>
              <Definition
                items={[
                  [i18n.text('地域'), visitorGeographyLabel(r || {}, i18n.locale)],
                  [i18n.text('设备'), r?.device || i18n.text('未提供')],
                  [i18n.text('浏览器'), r?.browser || i18n.text('未提供')],
                  [i18n.text('操作系统'), r?.os || i18n.text('未提供')],
                  [i18n.text('语言'), r?.language || i18n.text('未提供')],
                  [
                    i18n.text('引荐来源'),
                    unavailable ? '—' : first?.referrerDomain || i18n.text('直接访问'),
                  ],
                  [
                    i18n.text('入口页面'),
                    pageLink(first?.urlPath, c.site?.domain, undefined, undefined, i18n.locale),
                  ],
                  [
                    i18n.text('出口页面'),
                    pageLink(last?.urlPath, c.site?.domain, undefined, undefined, i18n.locale),
                  ],
                ]}
              />
            </QueryState>
            <hr className="divider" />
            <h3>{i18n.text('会话属性')}</h3>
            <div style={{ marginTop: 12 }}>
              <QueryState query={props}>
                <Definition
                  items={(props.data || []).map((p: any) => [
                    p.dataKey,
                    p.stringValue ?? p.numberValue ?? p.dateValue ?? (
                      <Badge>{i18n.text('未提供')}</Badge>
                    ),
                  ])}
                />
                {!unavailable && !props.data?.length && (
                  <Notice>{i18n.text('当前会话未提供属性。')}</Notice>
                )}
              </QueryState>
            </div>
          </Body>
        </Panel>
        <Panel
          title={i18n.text('访问时间线')}
          subtitle={i18n.text('按当前期间的发生时间排列页面与事件。')}
        >
          <Body>
            <QueryState query={query}>
              <ul className="timeline">
                {rows.map((e: any) => (
                  <li key={e.eventId}>
                    <time className="timeline-time">{date(e.createdAt, c.range.timezone)}</time>
                    <strong>
                      {e.eventName ||
                        pageLink(
                          e.urlPath,
                          c.site?.domain,
                          i18n.text('未提供'),
                          {
                            query: e.urlQuery,
                            hostname: e.hostname,
                          },
                          i18n.locale,
                        )}
                    </strong>
                    <p>
                      {e.eventName ? i18n.text('事件触发') : i18n.text('页面访问')}
                      {e.urlQuery ? ` · ${e.urlQuery}` : ''}
                    </p>
                    {e.eventName && (
                      <>
                        <p>
                          {pageLink(
                            e.urlPath,
                            c.site?.domain,
                            i18n.text('未提供'),
                            {
                              query: e.urlQuery,
                              hostname: e.hostname,
                            },
                            i18n.locale,
                          )}
                        </p>
                        <ActionLink page="event-detail" params={{ eventName: e.eventName }}>
                          {i18n.text('查看事件属性')}
                        </ActionLink>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {!rows.length && !unavailable && (
                <Notice>{i18n.text('当前范围没有访问行为。')}</Notice>
              )}
              {(query.data?.more || page > 1) && (
                <div className="actions">
                  <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
                    {i18n.text('上一页')}
                  </Button>
                  <Button disabled={!query.data?.more} onClick={() => setPage(page + 1)}>
                    {i18n.text('下一页')}
                  </Button>
                </div>
              )}
            </QueryState>
          </Body>
        </Panel>
      </div>
    </>
  );
}

const fields: [string, string][] = [
  ['referrer', '来源'],
  ['country', '国家 / 地区'],
  ['path', '页面路径'],
  ['device', '设备'],
  ['browser', '浏览器'],
  ['channel', '渠道'],
  ['sessionPlan', '会话属性 · plan'],
];
function Conditions({
  value,
  onChange,
  match,
  setMatch,
  cohort = false,
}: {
  value: AnalysisCondition[];
  onChange: (v: AnalysisCondition[]) => void;
  match: string;
  setMatch: (v: string) => void;
  cohort?: boolean;
}) {
  const i18n = useLiekanI18n();
  return (
    <div className="condition-group" data-dirty-actions>
      <div className="row between" style={{ marginBottom: 16 }}>
        <h3>{i18n.text('访问条件')}</h3>
        <Select
          label={i18n.text('匹配规则')}
          name="match"
          options={[
            ['all', i18n.text('满足全部条件 (AND)')],
            ['any', i18n.text('满足任一条件 (OR)')],
          ]}
          localizeLabels
          value={match}
          onChange={e => setMatch(e.target.value)}
        />
      </div>
      <div>
        {value.map((row, i) => (
          <div className="condition" key={i}>
            <Select
              label={i18n.text('字段')}
              options={fields.map(([value, label]) => ({
                value,
                label,
                disabled: cohort && value === 'sessionPlan',
              }))}
              localizeLabels
              value={row.name}
              onChange={e =>
                onChange(value.map((c, j) => (i === j ? { ...c, name: e.target.value } : c)))
              }
            />
            <Select
              label={i18n.text('运算符')}
              options={[
                ['eq', i18n.text('等于')],
                ['neq', i18n.text('不等于')],
                ['c', i18n.text('包含')],
                ['dnc', i18n.text('不包含')],
                ['re', i18n.text('正则匹配')],
              ]}
              localizeLabels
              value={row.operator}
              onChange={e =>
                onChange(value.map((c, j) => (i === j ? { ...c, operator: e.target.value } : c)))
              }
            />
            <Field
              label={i18n.text('值')}
              value={row.value}
              required
              onChange={e =>
                onChange(value.map((c, j) => (i === j ? { ...c, value: e.target.value } : c)))
              }
            />
            <Button
              className="btn icon-btn"
              aria-label={i18n.text('移除条件 {v0}', [i + 1])}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <Icon name="close" />
            </Button>
          </div>
        ))}
      </div>
      <Button onClick={() => onChange([...value, { name: 'referrer', operator: 'eq', value: '' }])}>
        <Icon name="plus" />
        {i18n.fragment('添加条件', true, false)}
      </Button>
    </div>
  );
}
function queryConditions(query: Record<string, string>): AnalysisCondition[] {
  return Object.entries(query)
    .filter(([key]) => fields.some(([f]) => key.replace(/\d+$/, '') === f))
    .map(([key, v]) => {
      const m = v.match(/^([a-z]+)\.(.*)$/);
      return { name: key.replace(/\d+$/, ''), operator: m?.[1] || 'eq', value: m?.[2] || v };
    });
}
function FilterEditor({
  kind = 'filters',
}: {
  kind?: 'filters' | 'segment-editor' | 'cohort-editor';
}) {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    action = useAction();
  const isCohort = kind === 'cohort-editor',
    id = c.route.id;
  const record = useWebsiteData(
    ['definition', id],
    `segments/${id}`,
    {},
    !!id && kind !== 'filters',
  );
  const initialProps = decodePropertyConditions(c.filters);
  const [conditions, setConditions] = useState<AnalysisCondition[]>([
    ...queryConditions(c.filters),
    ...(isCohort ? [] : initialProps.plans),
  ]);
  const [match, setMatch] = useState(c.filters.match || 'all'),
    [property, setProperty] = useState(initialProps.property),
    [propertyValue, setPropertyValue] = useState(initialProps.value),
    [preservedProps, setPreservedProps] = useState<any[]>(initialProps.preserved),
    [preview, setPreview] = useState<number | null>(null);
  useEffect(() => {
    if (record.data) {
      const allProps = record.data.parameters.sessionPropertyFilters || [];
      const plans = allProps.filter((p: any) => p.propertyName === 'plan' && p.dataType === 1);
      setConditions([
        ...(record.data.parameters.filters || []),
        ...plans.map((p: any) => ({ name: 'sessionPlan', operator: p.operator, value: p.value })),
      ]);
      setMatch(record.data.parameters.match || 'all');
      const others = allProps.filter((p: any) => !plans.includes(p));
      const f = others.find((p: any) => p.dataType === 1 && p.operator === 'eq');
      setPreservedProps(others.filter((p: any) => p !== f));
      setProperty(f?.propertyName || '');
      setPropertyValue(f?.value || '');
    }
  }, [record.data]);
  const definitionParams = () =>
    savedConditionParameters(
      isCohort ? conditions.filter(c => c.name !== 'sessionPlan') : conditions,
      match,
      isCohort ? '' : property,
      isCohort ? '' : propertyValue,
      isCohort ? [] : preservedProps,
    );
  const previewMatches = async () => {
    const params = conditionsToQuery(conditions, match, property, propertyValue, preservedProps);
    const stats = await c.api.get(`/websites/${c.siteId}/stats`, { ...c.range, ...params });
    setPreview(stats.visitors == null ? null : Number(stats.visitors));
  };
  const form = (
    <Form
      disabled={kind !== 'filters' && !canManage(c)}
      busy={action.busy}
      error={action.error}
      submitLabel={i18n.system(
        kind === 'filters'
          ? i18n.text('应用筛选')
          : isCohort
            ? i18n.text('保存行为人群')
            : i18n.text('保存分群'),
      )}
      cancel={
        kind !== 'filters' ? (
          <LinkButton page={isCohort ? 'cohorts' : 'segments'}>{i18n.text('取消')}</LinkButton>
        ) : undefined
      }
      onSubmit={async values => {
        if (kind === 'filters') {
          c.navigate('sessions', {
            ...Object.fromEntries(Object.keys(c.filters).map(key => [key, undefined])),
            ...conditionsToQuery(conditions, match, property, propertyValue, preservedProps),
            date: `range:${c.range.startAt}:${c.range.endAt}:${c.range.unit}`,
          });
          return;
        }
        if (!canManage(c)) throw new Error(isCohort ? '无权保存此行为人群' : '无权保存此分群');
        const parameters = {
          ...definitionParams(),
          ...(isCohort
            ? {
                action: { type: values.actionType, value: values.actionValue },
                dateRange: values.dateRange,
              }
            : {}),
        };
        await action.run(
          () =>
            c.api.post(`/websites/${c.siteId}/segments${id ? `/${id}` : ''}`, {
              name: values.name,
              type: isCohort ? 'cohort' : 'segment',
              parameters,
            }),
          isCohort ? '行为人群已保存' : '分群已保存',
        );
        c.navigate(isCohort ? 'cohorts' : 'segments');
      }}
    >
      {kind !== 'filters' && (
        <Field
          label={isCohort ? i18n.text('行为人群名称') : i18n.text('分群名称')}
          name="name"
          required
          maxLength={200}
          defaultValue={record.data?.name || ''}
        />
      )}
      {isCohort && (
        <div className="form-grid">
          <Select
            label={i18n.text('行为类型')}
            name="actionType"
            options={[
              ['path', i18n.text('访问页面')],
              ['event', i18n.text('触发事件')],
            ]}
            localizeLabels
            defaultValue={record.data?.parameters.action?.type || 'event'}
          />
          <Field
            label={i18n.text('行为值')}
            name="actionValue"
            required
            defaultValue={record.data?.parameters.action?.value || ''}
          />
          <Select
            label={i18n.text('日期范围')}
            name="dateRange"
            options={[
              ['7day', i18n.text('过去 7 天')],
              ['30day', i18n.text('过去 30 天')],
              ['0month', i18n.text('本月')],
              ...(!['7day', '30day', '0month'].includes(
                record.data?.parameters.dateRange || '30day',
              )
                ? [
                    [
                      record.data.parameters.dateRange,
                      `已保存：${record.data.parameters.dateRange}`,
                    ] as [string, string],
                  ]
                : []),
            ]}
            localizeLabels
            defaultValue={record.data?.parameters.dateRange || '30day'}
          />
        </div>
      )}
      <Conditions
        value={conditions}
        onChange={setConditions}
        match={match}
        setMatch={setMatch}
        cohort={isCohort}
      />
      {isCohort && (
        <p className="field-help">
          {i18n.text('行为人群暂不支持会话属性条件；该字段保留为不可选状态。')}
        </p>
      )}
      {!isCohort && (
        <div className={kind === 'filters' ? 'condition-group' : 'form-grid'}>
          {kind === 'filters' && <h3 style={{ marginBottom: 12 }}>{i18n.text('会话属性')}</h3>}
          <div className="form-grid">
            <Field
              label={kind === 'filters' ? i18n.text('属性名称') : i18n.text('会话属性（可选）')}
              value={property}
              onChange={e => setProperty(e.target.value)}
            />
            <Field
              label={i18n.text('属性值')}
              value={propertyValue}
              onChange={e => setPropertyValue(e.target.value)}
            />
          </div>
          {kind === 'filters' && (
            <p className="field-help">{i18n.text('会话属性条件与访问条件共同限定结果。')}</p>
          )}
        </div>
      )}
      {isCohort ? (
        <Notice>
          {i18n.text('行为人群的附加条件使用来源、地域、设备等维度。动作由上方字段单独定义。')}
        </Notice>
      ) : (
        <>
          <div className="row">
            <Button onClick={previewMatches}>{i18n.text('预览匹配人数')}</Button>
            {kind === 'filters' && (
              <Button
                data-dirty-action="true"
                onClick={() => {
                  setConditions([]);
                  setProperty('');
                  setPropertyValue('');
                  setPreservedProps([]);
                  setMatch('all');
                  setPreview(null);
                }}
              >
                {i18n.text('重置条件')}
              </Button>
            )}
          </div>
          <p className="blue num">
            {preview == null
              ? i18n.text('点击预览计算当前匹配访客')
              : i18n.text('匹配 {v0} 位访客', [n(preview)])}
          </p>
        </>
      )}
    </Form>
  );
  const editor = (
    <Panel
      title={i18n.system(
        kind === 'filters'
          ? i18n.text('条件筛选')
          : isCohort
            ? id
              ? i18n.text('编辑行为人群')
              : i18n.text('创建行为人群')
            : id
              ? i18n.text('编辑已保存分群')
              : i18n.text('创建已保存分群'),
      )}
      subtitle={i18n.system(
        kind === 'filters'
          ? i18n.text('访问条件按全部或任一组合，会话属性单独设置。应用后查看匹配的访问记录。')
          : isCohort
            ? i18n.text('指定时间内完成一个页面访问或事件行为。')
            : i18n.text('名称、匹配逻辑、访问条件与会话属性。'),
      )}
    >
      <Body>
        {id && record.isPending ? (
          <QueryState query={record}>{null}</QueryState>
        ) : id && record.error ? (
          <QueryState query={record}>{null}</QueryState>
        ) : (
          <div key={`${id || 'new'}:${record.data?.id || ''}:${c.siteId}`}>{form}</div>
        )}
      </Body>
    </Panel>
  );
  return kind === 'filters' ? (
    <div className="wide-narrow">
      {editor}
      <Panel title={i18n.text('保存与复用')} subtitle={i18n.text('将当前条件加入已保存分群。')}>
        <Body>
          <p className="muted">{i18n.text('日期范围变化后，分群按相同条件重新计算。')}</p>
          <div className="form-actions">
            <LinkButton
              page="segment-editor"
              params={{
                ...Object.fromEntries(Object.keys(c.filters).map(key => [key, undefined])),
                ...conditionsToQuery(conditions, match, property, propertyValue, preservedProps),
              }}
              primary
            >
              {i18n.text('保存为分群')}
            </LinkButton>
          </div>
          <hr className="divider" />
          <Definition
            items={[
              [i18n.text('当前网站'), c.site?.name],
              [
                i18n.text('日期'),
                i18n.text('{v0} 至 {v1}', [
                  date(c.range.startAt, c.range.timezone),
                  date(c.range.endAt, c.range.timezone),
                ]),
              ],
              [
                i18n.text('当前逻辑'),
                match === 'all' ? i18n.text('全部匹配 (AND)') : i18n.text('任一匹配 (OR)'),
              ],
            ]}
          />
        </Body>
      </Panel>
    </div>
  ) : (
    editor
  );
}
function Audiences({ cohort = false }: { cohort?: boolean }) {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const type = cohort ? 'cohort' : 'segment';
  const query = useData(
    ['audience-list', type],
    signal => getAllFeatureRows(`/websites/${c.siteId}/segments`, { type }, signal),
    !!c.siteId,
  );
  const stats = useData<Record<string, any>>(
    ['audience-stats', type, (query.data || []).map(row => row.id)],
    async signal =>
      Object.fromEntries(
        await Promise.all(
          (query.data || []).map(async row => [
            row.id,
            await c.api.get(
              `/websites/${c.siteId}/stats`,
              { ...c.range, ...c.filters, [type]: row.id },
              signal,
            ),
          ]),
        ),
      ),
    !!c.siteId && !!query.data?.length && query.isSuccess && !query.isPlaceholderData,
  );
  const results = stats.data || {};
  const total = useWebsiteData(['audience-total'], 'stats', useScope());
  return (
    <>
      <Panel
        title={i18n.system(cohort ? i18n.text('行为人群') : i18n.text('已保存分群'))}
        subtitle={i18n.system(
          cohort
            ? i18n.text('以指定时间内完成某个行为的访客为分析人群。')
            : i18n.text('动态匹配访问维度和会话属性。'),
        )}
        actions={
          canManage(c) && (
            <LinkButton primary page={cohort ? 'cohort-editor' : 'segment-editor'}>
              <Icon name="plus" />
              {i18n.fragment('创建', true, true)}
              {cohort ? i18n.text('行为人群') : i18n.text('分群')}
            </LinkButton>
          )
        }
      >
        <QueryState query={query.isPending || query.error || !query.data?.length ? query : stats}>
          <Table
            mobile
            rowKeys={(query.data || []).map((row: any) => row.id)}
            search
            columns={
              cohort
                ? ['行为人群名称', '行为与期间', '访客', '更新时间', '操作']
                : ['分群名称', '条件摘要', '匹配访客', '占比', '操作']
            }
            rows={(query.data || []).map((r: any) => [
              r.name,
              <TableCell
                sortValue={
                  cohort
                    ? `${r.parameters.action?.value || i18n.source('未提供')} · ${r.parameters.dateRange}`
                    : (r.parameters.filters || [])
                        .map(
                          (f: any) =>
                            `${fields.find(([k]) => k === f.name)?.[1] || f.name} ${f.operator} ${f.value}`,
                        )
                        .join(
                          r.parameters.match === 'any' ? i18n.source(' 或 ') : i18n.source(' 且 '),
                        ) || i18n.source('全部访客')
                }
                searchValue={
                  cohort
                    ? `${r.parameters.action?.value || i18n.english.text('未提供')} · ${r.parameters.dateRange}`
                    : (r.parameters.filters || [])
                        .map(
                          (f: any) =>
                            `${i18n.english.system(fields.find(([k]) => k === f.name)?.[1]) || f.name} ${f.operator} ${f.value}`,
                        )
                        .join(
                          r.parameters.match === 'any'
                            ? i18n.english.text(' 或 ')
                            : i18n.english.text(' 且 '),
                        ) || i18n.english.text('全部访客')
                }
              >
                {cohort
                  ? `${r.parameters.action?.value || i18n.text('未提供')} · ${r.parameters.dateRange}`
                  : (r.parameters.filters || [])
                      .map(
                        (f: any) =>
                          `${i18n.system(fields.find(([k]) => k === f.name)?.[1]) || f.name} ${f.operator} ${f.value}`,
                      )
                      .join(r.parameters.match === 'any' ? i18n.text(' 或 ') : i18n.text(' 且 ')) ||
                    i18n.text('全部访客')}
              </TableCell>,
              <TableCell
                sortValue={
                  results[r.id]?.error
                    ? i18n.source('读取失败')
                    : results[r.id]
                      ? n(results[r.id].visitors)
                      : i18n.source('正在加载')
                }
                searchValue={
                  results[r.id]?.error
                    ? i18n.english.text('读取失败')
                    : results[r.id]
                      ? n(results[r.id].visitors)
                      : i18n.english.text('正在加载')
                }
              >
                {results[r.id]?.error
                  ? i18n.text('读取失败')
                  : results[r.id]
                    ? n(results[r.id].visitors)
                    : i18n.text('正在加载')}
              </TableCell>,
              <TableCell
                sortValue={
                  cohort
                    ? date(r.updatedAt || r.createdAt, c.range.timezone)
                    : results[r.id]?.error || total.error
                      ? i18n.source('读取失败')
                      : results[r.id] && total.data
                        ? percentage(results[r.id].visitors, total.data.visitors)
                        : i18n.source('未提供')
                }
                searchValue={
                  cohort
                    ? date(r.updatedAt || r.createdAt, c.range.timezone)
                    : results[r.id]?.error || total.error
                      ? i18n.english.text('读取失败')
                      : results[r.id] && total.data
                        ? percentage(results[r.id].visitors, total.data.visitors)
                        : i18n.english.text('未提供')
                }
              >
                {cohort
                  ? date(r.updatedAt || r.createdAt, c.range.timezone)
                  : results[r.id]?.error || total.error
                    ? i18n.text('读取失败')
                    : results[r.id] && total.data
                      ? percentage(results[r.id].visitors, total.data.visitors)
                      : i18n.text('未提供')}
              </TableCell>,
              <TableCell
                sortValue={
                  canManage(c)
                    ? cohort
                      ? i18n.source('编辑行为人群')
                      : i18n.source('编辑分群')
                    : cohort
                      ? i18n.source('查看行为人群')
                      : i18n.source('查看分群')
                }
                searchValue={
                  canManage(c)
                    ? cohort
                      ? i18n.english.text('编辑行为人群')
                      : i18n.english.text('编辑分群')
                    : cohort
                      ? i18n.english.text('查看行为人群')
                      : i18n.english.text('查看分群')
                }
              >
                <ActionLink
                  page={cohort ? 'cohort-editor' : 'segment-editor'}
                  params={{ id: r.id }}
                  key={r.id}
                >
                  {canManage(c)
                    ? cohort
                      ? i18n.text('编辑行为人群')
                      : i18n.text('编辑分群')
                    : cohort
                      ? i18n.text('查看行为人群')
                      : i18n.text('查看分群')}
                </ActionLink>
              </TableCell>,
            ])}
            numeric={cohort ? [2] : [2, 3]}
          />
        </QueryState>
      </Panel>
      {!cohort && total.error && <QueryState query={total}>{null}</QueryState>}
      {cohort ? (
        <div className="two">
          <Panel
            title={i18n.text('行为人群与留存')}
            subtitle={i18n.text('观察完成行为后的访客是否返回。')}
          >
            <Body>
              <p className="muted">{i18n.text('行为人群定义保留行为、日期范围和访问条件。')}</p>
              <div className="form-actions">
                <LinkButton page="retention">{i18n.text('查看留存矩阵')}</LinkButton>
              </div>
            </Body>
          </Panel>
          <Panel
            title={i18n.text('行为人群与路径')}
            subtitle={i18n.text('观察人群的访问行为组合。')}
          >
            <Body>
              <p className="muted">{i18n.text('在旅程中选择已保存的人群条件。')}</p>
              <div className="form-actions">
                <LinkButton page="journeys">{i18n.text('查看访问旅程')}</LinkButton>
              </div>
            </Body>
          </Panel>
        </div>
      ) : (
        <Notice>
          {i18n.text('分群保存条件定义，不固定一份访客列表。可从分析页复用并按所选日期重新计算。')}
        </Notice>
      )}
    </>
  );
}

function Retention() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const reading = useManualRefresh();
  const [enteredAt] = useState(Date.now());
  const epoch = `${reading?.page.token}:${reading?.page.round}`;
  const [selectionClock, setSelectionClock] = useState({
    epoch,
    at: reading?.page.now ?? enteredAt,
  });
  const readAt =
    selectionClock.epoch === epoch ? selectionClock.at : (reading?.page.now ?? enteredAt);
  const initial = formatInTimeZone(c.range.endAt, c.range.timezone, 'yyyy-MM');
  const audience = c.filters.cohort
    ? `cohort:${c.filters.cohort}`
    : c.filters.segment
      ? `segment:${c.filters.segment}`
      : '';
  const [month, setMonth] = useState(initial),
    [detail, setDetail] = useState<any>(null),
    [info, setInfo] = useState(false);
  const months = Array.from({ length: 12 }, (_, i) => {
    const date = new Date(`${initial}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() - i);
    const value = date.toISOString().slice(0, 7);
    return [value, `${value.slice(0, 4)} 年 ${Number(value.slice(5))} 月`] as [string, string];
  });
  const people = useData(
    ['retention-audiences'],
    async signal => {
      const [segments, cohorts] = await Promise.all(
        ['segment', 'cohort'].map(type =>
          getAllFeatureRows<any>(`/websites/${c.siteId}/segments`, { type }, signal),
        ),
      );
      return [
        ...segments.map(r => ({ ...r, type: 'segment' })),
        ...cohorts.map(r => ({ ...r, type: 'cohort' })),
      ];
    },
    !!c.siteId,
  );
  const startAt = +fromZonedTime(`${month}-01T00:00:00`, c.range.timezone);
  const next = new Date(`${month}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const endAt = Math.min(
    readAt,
    +fromZonedTime(`${next.toISOString().slice(0, 10)}T00:00:00`, c.range.timezone) - 1,
  );
  const { segment: ignoredSegment, cohort: ignoredCohort, ...rest } = c.filters;
  const [type, id] = audience.split(':');
  const scope = { ...c.range, startAt, endAt, ...rest, ...(id ? { [type]: id } : {}) };
  const query = useWebsiteData(['retention', month, audience], 'retention', scope);
  const rows: any[] = query.data || [];
  const cohorts = rows.filter(r => Number(r.day) === 0);
  const cutoff = completedObservationDate(endAt, c.range.timezone);
  const days = [1, 2, 3, 4, 5, 6, 7, 14, 21, 28];
  const summary = days
    .filter(d => [1, 7, 28].includes(d))
    .map(d => retentionSummary(rows, d, cutoff));
  return (
    <>
      <div className="row between">
        <div className="row">
          <Select
            label={i18n.text('月份')}
            value={month}
            options={months}
            localizeLabels
            onChange={e => {
              setSelectionClock({ epoch, at: Date.now() });
              setMonth(e.target.value);
            }}
          />
          <Select
            label={i18n.text('人群')}
            value={audience}
            options={[
              ['', i18n.text('全部访客')],
              ...(audience && !(people.data || []).some(r => `${r.type}:${r.id}` === audience)
                ? [
                    {
                      value: audience,
                      label: `${type === 'cohort' ? i18n.text('所选人群') : i18n.text('所选分群')}${i18n.locale === 'en-US' ? ' (' : '（'}${people.isPending ? i18n.text('正在读取') : people.error ? i18n.text('读取失败') : i18n.text('不可用')}${i18n.locale === 'en-US' ? ')' : '）'}`,
                      disabled: true,
                    },
                  ]
                : []),
              ...(people.data || []).map(r => [`${r.type}:${r.id}`, r.name] as [string, string]),
            ]}
            onChange={e => {
              setSelectionClock({ epoch, at: Date.now() });
              const [type, id] = e.target.value.split(':');
              c.updateQuery({
                cohort: type === 'cohort' ? id : undefined,
                segment: type === 'segment' ? id : undefined,
              });
            }}
          />
        </div>
        <Button onClick={() => setInfo(true)}>{i18n.text('口径说明')}</Button>
      </div>
      <Metrics
        loading={query.isPending}
        items={[
          [
            i18n.text('入组访客'),
            query.data
              ? n(
                  cohorts.some(r => r.visitors === null)
                    ? null
                    : cohorts.reduce((s, r) => s + Number(r.visitors), 0),
                )
              : null,
            i18n.text('按所选期间首次访问日期分组'),
          ],
          ...summary.map(
            (s, i) =>
              [
                i === 0
                  ? i18n.text('次日留存')
                  : i === 1
                    ? i18n.text('第 7 天留存')
                    : i18n.text('第 28 天留存'),
                s.percentage == null ? i18n.text('待观察') : `${s.percentage.toFixed(2)}%`,
                i18n.text('完整观察队列'),
              ] as [string, string, string],
          ),
        ]}
      />
      <Panel
        title={i18n.text('日队列留存矩阵')}
        subtitle={i18n.text('点击单元格查看分子、分母及关联记录。未到观察日的格子显示“待观察”。')}
      >
        <QueryState query={query}>
          <div className="table-wrap">
            <MatrixTable
              headings={[
                i18n.text('入组日期 / 人数'),
                ...days.map(d => i18n.text('第 {v0} 天', [d])),
              ]}
            >
              <tbody>
                {cohorts.map(cohort => {
                  const day = String(cohort.date).slice(0, 10);
                  return (
                    <tr key={day}>
                      <td>
                        <strong>{day.slice(5)}</strong>
                        <small style={{ display: 'block' }}>
                          {n(cohort.visitors)}
                          {i18n.fragment(' 位访客', true, false)}
                        </small>
                      </td>
                      {days.map(d => {
                        const target = new Date(`${day}T00:00:00Z`);
                        target.setUTCDate(target.getUTCDate() + d);
                        if (target.toISOString().slice(0, 10) > cutoff)
                          return (
                            <td key={d}>
                              <span className="heat-cell unobserved" style={{ display: 'block' }}>
                                {i18n.text('待观察')}
                              </span>
                            </td>
                          );
                        const matched = rows.find(
                          r => String(r.date).slice(0, 10) === day && Number(r.day) === d,
                        );
                        const returned =
                          matched?.returnVisitors === null
                            ? null
                            : Number(matched?.returnVisitors || 0);
                        const pct =
                          cohort.visitors === null || returned === null
                            ? null
                            : (returned / Number(cohort.visitors)) * 100;
                        return (
                          <td key={d}>
                            <button
                              className="heat-cell"
                              style={{ background: `rgba(15,98,254,${(pct ?? 0) / 90 + 0.06})` }}
                              disabled={pct === null}
                              aria-label={i18n.text('{v0} 入组，第 {v1} 天，留存 {v2}%', [
                                day,
                                d,
                                pct?.toFixed(2),
                              ])}
                              onClick={() =>
                                setDetail({
                                  day,
                                  date: day,
                                  offset: d,
                                  total: Number(cohort.visitors),
                                  returned,
                                })
                              }
                            >
                              {pct === null ? '—' : `${pct.toFixed(2)}%`}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </MatrixTable>
          </div>
          {!cohorts.length && <Notice>{i18n.text('当前月份与人群条件没有入组访客。')}</Notice>}
          <div className="table-footer">
            <span>{i18n.text('深浅表示留存比例，百分比同时显示。')}</span>
            <span>
              {i18n.fragment('观察截止：', false, true)}
              {cutoff}
            </span>
          </div>
        </QueryState>
      </Panel>
      <Notice>
        {i18n.text(
          '按所选期间首次访问日期入组，以第 N 天再次访问衡量留存。汇总只统计已完整观察的队列；0% 与待观察分别表达。',
        )}
      </Notice>
      {info && (
        <LiekanDialog title={i18n.text('留存计算说明')} onClose={() => setInfo(false)}>
          <Definition
            items={[
              [i18n.text('入组'), i18n.text('按所选期间首次访问日期分组')],
              [i18n.text('留存'), i18n.text('第 N 天再次访问的人数')],
              [i18n.text('分母'), i18n.text('当日入组访客数')],
              [i18n.text('待观察'), i18n.text('尚未达到对应观察日')],
              [i18n.text('零值'), i18n.text('已经观察，返回人数为 0')],
            ]}
          />
          <hr className="divider" />
          <Notice>{i18n.text('汇总按入组人数加权，仅纳入观察日已完整结束的队列。')}</Notice>
        </LiekanDialog>
      )}
      {detail && (
        <LiekanDialog title={i18n.text('留存详情')} onClose={() => setDetail(null)}>
          <Definition
            items={[
              [i18n.text('入组日期'), detail.date],
              [i18n.text('观察时间'), i18n.text('第 {v0} 天', [detail.offset])],
              [i18n.text('入组访客'), n(detail.total)],
              [i18n.text('返回访客'), n(detail.returned)],
              [i18n.text('留存比例'), percentage(detail.returned, detail.total)],
            ]}
          />
          <hr className="divider" />
          <DialogActions>
            <LinkButton
              page="sessions"
              params={{
                ...rest,
                segment: undefined,
                cohort: undefined,
                ...(id ? { [type]: id } : {}),
                retentionDate: detail.date,
                retentionDay: detail.offset,
                date: `range:${startAt}:${endAt}:day`,
              }}
            >
              {i18n.text('查看关联访问记录')}
            </LinkButton>
          </DialogActions>
        </LiekanDialog>
      )}
    </>
  );
}
function Journeys({ detail = false }: { detail?: boolean }) {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const [conditions, setConditions] = useState({
    type: c.query.type || 'all',
    steps: Number(c.query.steps) || 3,
    startStep: c.query.startStep || '',
    endStep: c.query.endStep || '',
  });
  const scope = useScope({ ...conditions, ...(detail ? { sequence: c.query.sequence } : {}) });
  const [page, setPage] = useState(1);
  useEffect(
    () => setPage(1),
    [
      c.siteId,
      c.range.startAt,
      c.range.endAt,
      JSON.stringify(c.filters),
      JSON.stringify(conditions),
    ],
  );
  const query = useWebsiteData(
    ['journey-rich', scope, page],
    detail ? 'journeys/details' : 'journeys',
    { ...scope, page },
    !detail || !!c.query.sequence,
    true,
  );
  const d = query.data as JourneyData;
  const unavailable = !identityUsable(d?.population);
  const rows = d?.rows || [];
  const nodes: any[] = [],
    links: any[] = [],
    nodeIds = new Set();
  for (const row of rows) {
    row.nodes.forEach((label, i) => {
      const name = `${i}:${label}`;
      if (!nodeIds.has(name)) {
        nodeIds.add(name);
        nodes.push({ name, label: { formatter: label } });
      }
      if (i)
        links.push({ source: `${i - 1}:${row.nodes[i - 1]}`, target: name, value: row.visitors });
    });
  }
  const graph = {
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'sankey',
        data: nodes,
        links,
        emphasis: { focus: 'adjacency' },
        lineStyle: { color: 'source', opacity: 0.16, curveness: 0.5 },
        left: 20,
        right: 110,
        top: 32,
        bottom: 30,
        layoutIterations: 32,
        nodeWidth: 14,
        nodeGap: 24,
        label: { fontSize: 11, color: '#697386' },
      },
    ],
  };
  if (detail) {
    if (!c.query.sequence)
      return (
        <Notice>
          {i18n.fragment('请选择访问路径。', false, true)}
          <LinkButton page="journeys">{i18n.text('返回访问旅程')}</LinkButton>
        </Notice>
      );
    const row = rows[0];
    return (
      <>
        <div className="row between">
          <h2>
            {row
              ? conditions.type === 'pages'
                ? pageSequence(row.nodes, c.site?.domain, i18n.locale)
                : row.nodes.join(' → ')
              : i18n.text('所选访问路径')}
          </h2>
          <LinkButton page="journeys" params={conditions}>
            {i18n.text('返回访问旅程')}
          </LinkButton>
        </div>
        <QueryState query={query}>
          <Metrics
            loading={query.isPending}
            items={[
              [
                i18n.text('完成路径'),
                row ? n(row.visitors) : unavailable ? '—' : '0',
                i18n.text('独立访客'),
              ],
              [
                i18n.text('路径占比'),
                row ? percentage(row.visitors, d.visitors) : '—',
                row
                  ? `${n(row.visitors)} / ${n(d.visitors)}`
                  : i18n.text(unavailable ? identityUnavailableReason : '当前范围无匹配路径'),
              ],
              [
                i18n.text('平均完成时间'),
                duration(row?.seconds, i18n.locale),
                unavailable
                  ? i18n.text(identityUnavailableReason)
                  : i18n.text('{v0} 步路径', [row?.nodes.length || 0]),
              ],
              [
                i18n.text('主要来源'),
                row?.source || (unavailable ? '—' : i18n.text('直接访问')),
                i18n.text('按完成路径的访客数排序'),
              ],
            ]}
          />
          <Panel title={i18n.text('路径节点')} subtitle={i18n.text('展示所选行为路径。')}>
            <Body>
              <ol className="timeline">
                {row?.nodes.map((node, i) => (
                  <li key={`${i}:${node}`}>
                    <strong>
                      {conditions.type === 'pages'
                        ? pageLink(node, c.site?.domain, undefined, undefined, i18n.locale)
                        : node}
                    </strong>
                    <p>
                      {i === 0
                        ? i18n.text('所选路径入口')
                        : i === row.nodes.length - 1
                          ? i18n.text('{v0} 位访客完成所选路径', [n(row.visitors)])
                          : i18n.text('所选路径中间节点')}
                    </p>
                  </li>
                ))}
              </ol>
              {!row && (
                <Notice>
                  {i18n.text(
                    unavailable
                      ? identityUnavailableReason
                      : '当前条件没有匹配路径，请返回访问旅程调整条件。',
                  )}
                </Notice>
              )}
            </Body>
          </Panel>
          <Panel
            title={i18n.text('完成路径的访问记录')}
            subtitle={i18n.text('与所选节点序列、类型、步数、日期及筛选条件一致。')}
          >
            <Table
              className="session-records-table"
              columns={['访客', '访问时间', '地域', '来源', '当前页面', '页面数', '时长', '操作']}
              rows={(d?.sessions || []).map(r => [
                <TableCell
                  sortValue={visitor(r.id)}
                  searchValue={i18n.english.system(visitor(r.id))}
                >
                  {i18n.system(visitor(r.id))}
                </TableCell>,
                date(r.lastAt, c.range.timezone),
                <TableCell
                  sortValue={visitorGeographyLabel(r, 'zh-CN')}
                  searchValue={visitorGeographyLabel(r, 'en-US')}
                >
                  {visitorGeographyLabel(r, i18n.locale)}
                </TableCell>,
                sourceCell(classifyEntrySourceForDisplay({ referrer: r.referrerDomain }), i18n),
                <TableCell
                  sortValue={pageLink(r.urlPath, c.site?.domain, undefined, undefined, 'zh-CN')}
                  searchValue={pageLink(r.urlPath, c.site?.domain, undefined, undefined, 'en-US')}
                >
                  {pageLink(r.urlPath, c.site?.domain, undefined, undefined, i18n.locale)}
                </TableCell>,
                n(r.views),
                <TableCell
                  sortValue={duration(r.seconds, 'zh-CN')}
                  searchValue={duration(r.seconds, 'en-US')}
                >
                  {duration(r.seconds, i18n.locale)}
                </TableCell>,
                <TableCell sortValue={i18n.source('详情')} searchValue={i18n.english.text('详情')}>
                  <ActionLink page="session-detail" params={{ id: r.id }} key={r.id}>
                    {i18n.text('详情')}
                  </ActionLink>
                </TableCell>,
              ])}
              numeric={[5, 6]}
              page={page}
              pages={Math.ceil((d?.count || 0) / 25)}
              onPage={setPage}
            />
          </Panel>
        </QueryState>
      </>
    );
  }
  return (
    <>
      <Panel title={i18n.text('路径条件')}>
        <Body>
          <Form
            submitLabel={i18n.text('应用路径条件')}
            onSubmit={async v =>
              setConditions({
                type: v.type,
                steps: Number(v.steps),
                startStep: v.startStep || '',
                endStep: v.endStep || '',
              })
            }
          >
            <div className="form-grid">
              <Select
                label={i18n.text('路径类型')}
                name="type"
                options={[
                  ['all', i18n.text('页面与事件')],
                  ['pages', i18n.text('仅页面')],
                  ['events', i18n.text('仅事件')],
                ]}
                localizeLabels
                defaultValue={conditions.type}
              />
              <Select
                label={i18n.text('步数')}
                name="steps"
                options={[2, 3, 4, 5, 6, 7].map(n => [String(n), String(n)])}
                localizeLabels
                defaultValue={String(conditions.steps)}
              />
              <Field
                label={i18n.text('起点（可选）')}
                name="startStep"
                defaultValue={conditions.startStep}
                help={i18n.text('输入当前类型中的页面或事件。')}
              />
              <Field
                label={i18n.text('终点（可选）')}
                name="endStep"
                defaultValue={conditions.endStep}
                help={i18n.text('留空时显示全部终点。')}
              />
            </div>
          </Form>
        </Body>
      </Panel>
      <Panel
        title={i18n.text('从内容到转化的访问路径')}
        subtitle={i18n.text('连线宽度代表访客量，下方路径明细可查看关联访问记录。')}
      >
        <QueryState query={query}>
          {rows.length ? (
            <Chart
              interactionKey={JSON.stringify([
                'journeys',
                c.user.id,
                c.siteId,
                scope,
                page,
                query.data,
              ])}
              type="sankey"
              height={400}
              labels={[]}
              series={[]}
              option={graph}
              onClick={event => {
                const row = rows.find(r =>
                  r.nodes.some((label, i) => `${i}:${label}` === event.name),
                );
                if (row)
                  c.navigate('path-detail', {
                    ...c.filters,
                    ...conditions,
                    sequence: JSON.stringify(row.nodes),
                    date: `range:${c.range.startAt}:${c.range.endAt}:${c.range.unit}`,
                  });
              }}
            />
          ) : (
            <Notice>{i18n.text('当前条件没有匹配路径，请调整类型、起点或终点。')}</Notice>
          )}
        </QueryState>
      </Panel>
      <Panel title={i18n.text('路径明细')} subtitle={i18n.text('按选定条件展示行为组合。')}>
        <QueryState query={query}>
          <Table
            search
            columns={['路径', '访客', '完成比例', '操作']}
            rows={rows.map(row => [
              <TableCell
                sortValue={
                  conditions.type === 'pages'
                    ? pageSequence(row.nodes, c.site?.domain, 'zh-CN')
                    : row.nodes.join(' → ')
                }
                searchValue={
                  conditions.type === 'pages'
                    ? pageSequence(row.nodes, c.site?.domain, 'en-US')
                    : row.nodes.join(' → ')
                }
              >
                {conditions.type === 'pages'
                  ? pageSequence(row.nodes, c.site?.domain, i18n.locale)
                  : row.nodes.join(' → ')}
              </TableCell>,
              n(row.visitors),
              percentage(row.visitors, d.visitors),
              <TableCell sortValue={i18n.source('详情')} searchValue={i18n.english.text('详情')}>
                <ActionLink
                  key={JSON.stringify(row.nodes)}
                  page="path-detail"
                  params={{ ...conditions, sequence: JSON.stringify(row.nodes) }}
                >
                  {i18n.text('详情')}
                </ActionLink>
              </TableCell>,
            ])}
            numeric={[1, 2]}
          />
          {d?.limited && (
            <Notice>
              {i18n.text('当前展示访客数最多的 100 条路径；完成比例使用全部匹配访客作分母。')}
            </Notice>
          )}
        </QueryState>
      </Panel>
    </>
  );
}
function UTM() {
  const i18n = useLiekanI18n();
  const [dimension, setDimension] = useState('source');
  const scope = useScope();
  const summary = useWebsiteData(['utm-total'], 'analytics', { ...scope, kind: 'utm' }, true, true);
  const query = useWebsiteData(
    ['utm-dimension', dimension],
    'analytics',
    { ...scope, kind: 'utm', dimension },
    true,
    true,
  );
  const rows: any[] = query.data?.rows || [],
    total = Number(query.data?.dimensionTotal || 0);
  const c = useFeature();
  const goals = useData(
    ['utm-goal-list'],
    signal => getAllFeatureRows<any>(`/websites/${c.siteId}/goals`, {}, signal),
    !!c.siteId,
  );
  const selected = goals.data?.[0];
  const goal = useWebsiteData(
    ['utm-goal', selected?.id],
    `goals/${selected?.id}/analytics`,
    {
      ...scope,
      requireUtm: '1',
    },
    !!selected && goals.isSuccess && !goals.isPlaceholderData,
    true,
  );
  const filterNames: Record<string, string> = {
    source: 'utmSource',
    medium: 'utmMedium',
    campaign: 'utmCampaign',
    content: 'utmContent',
    term: 'utmTerm',
  };
  return (
    <>
      <Tabs
        items={[
          ['source', i18n.text('来源 source')],
          ['medium', i18n.text('媒介 medium')],
          ['campaign', i18n.text('活动 campaign')],
          ['content', i18n.text('内容 content')],
          ['term', i18n.text('关键词 term')],
        ]}
        active={dimension}
        onChange={setDimension}
      />
      <Metrics
        loading={[
          summary.isPending,
          summary.isPending,
          goals.isPending || (!!selected && goal.isPending),
          false,
        ]}
        items={[
          [
            i18n.text('带 UTM 访问'),
            summary.data ? n(summary.data.views) : null,
            i18n.text('有至少一个 UTM 字段'),
          ],
          [
            i18n.text('带 UTM 访客'),
            summary.data ? n(summary.data.visitors) : null,
            i18n.text('独立访客'),
          ],
          [
            i18n.text('已标记转化'),
            goals.error || goal.error
              ? i18n.text('读取失败')
              : goals.isPending || (selected && goal.isPending)
                ? i18n.text('正在读取')
                : selected && goal.data
                  ? n(goal.data.conversions)
                  : selected
                    ? i18n.text('未提供')
                    : i18n.text('尚未配置'),
            selected
              ? i18n.text('目标：{v0}', [selected.name])
              : goals.error
                ? i18n.text('目标读取失败')
                : i18n.text('请先创建网站目标'),
          ],
          [i18n.text('字段缺失'), i18n.text('分别保留'), i18n.text('未提供字段不补推断')],
        ]}
      />
      {summary.error && <QueryState query={summary}>{null}</QueryState>}
      {goals.error && <QueryState query={goals}>{null}</QueryState>}
      {goal.error && <QueryState query={goal}>{null}</QueryState>}
      <QueryState query={query}>
        <div className="two">
          <Chart
            interactionKey={JSON.stringify([
              'utm',
              c.user.id,
              c.siteId,
              scope,
              dimension,
              query.data,
            ])}
            title={i18n.text('utm_{v0} 分布', [dimension])}
            subtitle={i18n.text('按当前维度的访问次数排序。')}
            type="bar"
            horizontal
            labels={rows.map(r => r.utm || i18n.text('未提供'))}
            series={[
              { name: i18n.label('访问次数', 'pageviews'), values: rows.map(r => Number(r.views)) },
            ]}
          />
          <Panel title={i18n.text('维度明细')} subtitle={i18n.text('点击属性值筛选关联访问。')}>
            <Table
              columns={['属性值', '访问次数', '占比', '操作']}
              rows={rows.map(r => [
                <TableCell
                  sortValue={r.utm || i18n.source('未提供')}
                  searchValue={r.utm || i18n.english.text('未提供')}
                >
                  {r.utm || i18n.text('未提供')}
                </TableCell>,
                n(r.views),
                percentage(r.views, total),
                <TableCell sortValue={i18n.source('访问')} searchValue={i18n.english.text('访问')}>
                  <ActionLink
                    page="sessions"
                    params={{ [`drill_${filterNames[dimension]}`]: `eq.${r.utm}` }}
                    key={r.utm}
                  >
                    {i18n.text('访问')}
                  </ActionLink>
                </TableCell>,
              ])}
              numeric={[1, 2]}
            />
          </Panel>
        </div>
      </QueryState>
      <Notice>
        {i18n.text(
          'UTM 活动按五个 URL 标记字段分别聚合。来源识别与 UTM 命名相互独立，AI 来源不会自动写入缺失的 UTM 字段。',
        )}
      </Notice>
    </>
  );
}
function Attribution() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const [settings, setSettings] = useState({ model: 'first-click', type: 'event', step: '' });
  const scope = useScope(settings);
  const query = useWebsiteData(
    ['attribution', settings],
    'analytics',
    { ...scope, kind: 'attribution' },
    !!settings.step,
    true,
  );
  const d = query.data;
  const rows = d?.referrer || [];
  const total = d?.total?.visitors == null ? null : Number(d.total.visitors),
    attributed = d?.total?.attributed == null ? null : Number(d.total.attributed);
  return (
    <>
      <Panel title={i18n.text('归因设置')}>
        <Body>
          <Form
            submitLabel={i18n.text('应用归因设置')}
            onSubmit={async v => setSettings({ model: v.model, type: v.type, step: v.step })}
          >
            <div className="form-grid">
              <Select
                label={i18n.text('归因模型')}
                name="model"
                options={[
                  ['first-click', i18n.text('首次点击')],
                  ['last-click', i18n.text('末次点击')],
                ]}
                localizeLabels
                defaultValue={settings.model}
              />
              <Select
                label={i18n.text('转化类型')}
                name="type"
                options={[
                  ['path', i18n.text('访问页面')],
                  ['event', i18n.text('触发事件')],
                ]}
                localizeLabels
                defaultValue={settings.type}
              />
              <Field
                label={i18n.text('转化步骤')}
                name="step"
                defaultValue={settings.step}
                required
                help={i18n.text('填写实际页面路径或事件名称。')}
              />
            </div>
          </Form>
        </Body>
      </Panel>
      <Metrics
        loading={[
          !!settings.step && query.isPending,
          false,
          !!settings.step && query.isPending,
          !!settings.step && query.isPending,
        ]}
        items={[
          [
            i18n.text('归因转化'),
            d ? n(total) : null,
            i18n.text('目标：{v0}', [settings.step || i18n.text('待设置')]),
          ],
          [
            i18n.text('归因模型'),
            settings.model === 'first-click' ? i18n.text('首次点击') : i18n.text('末次点击'),
            i18n.text('两种模型使用相同转化访客集合'),
          ],
          [i18n.text('可归因转化'), d ? n(attributed) : null, i18n.text('有来源路径的转化访客')],
          [
            i18n.text('直接 / 未知'),
            d ? n(Math.max(0, total - attributed)) : null,
            i18n.text('单独保留'),
          ],
        ]}
      />
      {settings.step ? (
        <QueryState query={query}>
          <Chart
            interactionKey={JSON.stringify(['attribution', c.user.id, c.siteId, scope, query.data])}
            title={i18n.text('渠道贡献')}
            subtitle={i18n.text('按所选模型分配转化访客。')}
            type="bar"
            horizontal
            labels={rows.map((r: any) => r.name)}
            series={[
              {
                name: i18n.text('转化访客'),
                values: rows.map((r: any) => (r.value == null ? null : Number(r.value))),
              },
            ]}
          />
          <Panel
            title={i18n.text('归因明细')}
            subtitle={i18n.text('上游归因按独立转化访客统计，同一访客的多次转化合并。')}
          >
            <Table
              search
              columns={['渠道', '转化次数', '贡献占比', '操作']}
              rows={rows.map((r: any) => [
                sourceCell(classifyEntrySourceForDisplay({ referrer: r.name }), i18n),
                n(r.value),
                percentage(r.value, total),
                <TableCell sortValue={i18n.source('会话')} searchValue={i18n.english.text('会话')}>
                  <ActionLink
                    page="sessions"
                    params={{
                      attributionStep: settings.step,
                      attributionModel: settings.model,
                      attributionType: settings.type,
                      attributionSource: r.name,
                    }}
                    key={r.name}
                  >
                    {i18n.text('会话')}
                  </ActionLink>
                </TableCell>,
              ])}
              numeric={[1, 2]}
            />
          </Panel>
        </QueryState>
      ) : (
        <Notice>{i18n.text('填写转化步骤并应用设置后显示真实归因。')}</Notice>
      )}
      <Notice>
        {i18n.text(
          'AI 引荐按真实 referrer 识别。来源缺失时显示直接或未知。此表次数采用上游独立转化访客口径。',
        )}
      </Notice>
    </>
  );
}
function Breakdown() {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const [fields, setFields] = useState(['path', 'country']),
    [draftFields, setDraftFields] = useState(fields),
    [open, setOpen] = useState(false);
  const scope = useScope({ fields: JSON.stringify(fields) });
  const query = useWebsiteData(['breakdown', fields], 'breakdown', scope);
  const options: [string, string][] = [
    ['path', '页面路径'],
    ['country', '国家 / 地区'],
    ['browser', '浏览器'],
    ['device', '设备'],
    ['referrer', '来源'],
    ['event', '事件名称'],
  ];
  const labels = fields.map(f => options.find(([key]) => key === f)?.[1] || f);
  const rows: any[] = [...(query.data || [])].sort((a, b) => Number(b.views) - Number(a.views));
  return (
    <>
      <div className="row between">
        <div className="row">
          {labels.map(l => (
            <Badge key={l}>{l}</Badge>
          ))}
        </div>
        <Button
          primary
          onClick={() => {
            setDraftFields(fields);
            setOpen(true);
          }}
        >
          {i18n.text('选择维度')}
        </Button>
      </div>
      <QueryState query={query}>
        <Chart
          interactionKey={JSON.stringify([
            'breakdown',
            c.user.id,
            c.siteId,
            scope,
            fields,
            query.data,
          ])}
          title={i18n.text('{v0}的访问次数', [labels.map(i18n.system).join(' × ')])}
          subtitle={i18n.text('维度组合按访问次数排序。')}
          option={{ grid: { left: 150, right: 56, top: 34, bottom: 26 } }}
          type="bar"
          horizontal
          labels={rows.map(r => fields.map(f => r[f] || i18n.text('未提供')).join(' × '))}
          series={[
            { name: i18n.label('访问次数', 'pageviews'), values: rows.map(r => Number(r.views)) },
          ]}
        />
        <Panel
          title={i18n.text('组合明细')}
          subtitle={i18n.text('选择维度后，表格字段随组合更新。')}
        >
          <Table
            search
            columns={[...labels, '访问次数', '访客', '操作']}
            rows={rows.map((r, i) => [
              ...fields.map(f => (
                <TableCell
                  key={f}
                  sortValue={f === 'path' ? pageLink(r[f], c.site?.domain) : r[f] || '未提供'}
                  searchValue={
                    f === 'path'
                      ? pageLink(r[f], c.site?.domain, undefined, undefined, 'en-US')
                      : r[f] || i18n.english.text('未提供')
                  }
                >
                  {f === 'path'
                    ? pageLink(r[f], c.site?.domain, undefined, undefined, i18n.locale)
                    : r[f] || i18n.text('未提供')}
                </TableCell>
              )),
              n(r.views),
              n(r.visitors),
              <TableCell sortValue={i18n.source('访问')} searchValue={i18n.english.text('访问')}>
                <ActionLink
                  key={i}
                  page="sessions"
                  params={Object.fromEntries(
                    fields.map(f => [
                      `drill_${f}`,
                      r[f] == null || r[f] === '' ? 'empty.' : `eq.${r[f]}`,
                    ]),
                  )}
                >
                  {i18n.text('访问')}
                </ActionLink>
              </TableCell>,
            ])}
            numeric={[fields.length, fields.length + 1]}
          />
        </Panel>
      </QueryState>
      <Notice>
        {i18n.text(
          '维度拆分使用多字段组合，保留缺失维度的“未提供”记录。事件名称沿用上游字段选择范围。',
        )}
      </Notice>
      {open && (
        <LiekanDialog title={i18n.text('选择拆分维度')} onClose={() => setOpen(false)}>
          <Form
            submitLabel={i18n.text('应用维度')}
            onSubmit={async (v, form) => {
              const next = Array.from(new FormData(form).getAll('dimension')).map(String);
              if (!next.length || next.length > 3) throw new Error('请选择 1 至 3 个维度');
              setFields(next);
              setOpen(false);
            }}
          >
            <p className="muted" aria-live="polite">
              {i18n.fragment('已选择 ', false, true)}
              {draftFields.length}
              {i18n.fragment(' / 3 个维度', true, false)}
            </p>
            <p className="muted">
              {i18n.text('请选择 1 至 3 个维度；取消后保留当前页面的拆分方式。')}
            </p>
            <div className="form-grid">
              {options.map(([key, label]) => (
                <label className="check" key={key}>
                  <input
                    type="checkbox"
                    name="dimension"
                    value={key}
                    checked={draftFields.includes(key)}
                    disabled={draftFields.length >= 3 && !draftFields.includes(key)}
                    onChange={event =>
                      setDraftFields(current =>
                        event.target.checked
                          ? [...current, key]
                          : current.filter(field => field !== key),
                      )
                    }
                  />
                  <span>{i18n.system(label)}</span>
                </label>
              ))}
            </div>
          </Form>
        </LiekanDialog>
      )}
    </>
  );
}
function Compare() {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    scope = useScope();
  const size = c.range.endAt - c.range.startAt + 1;
  const day = calendarDayRange(c.range.startAt, c.range.timezone);
  const previous =
    day.startAt === c.range.startAt && day.endAt === c.range.endAt
      ? shiftCalendarRange(c.range.startAt, c.range.endAt, -1, c.range.timezone)
      : { startAt: Math.max(0, c.range.startAt - size), endAt: c.range.startAt - 1 };
  const [comparison, setComparison] = useState(previous),
    [open, setOpen] = useState(false);
  useEffect(() => setComparison(previous), [c.range.startAt, c.range.endAt, c.range.timezone]);
  const query = useData(
    ['compare-rich', comparison],
    async signal => {
      const [current, previous, currentSeries, previousSeries, sources, oldSources] =
        await Promise.all([
          c.api.get(`/websites/${c.siteId}/stats`, scope, signal),
          c.api.get(`/websites/${c.siteId}/stats`, { ...scope, ...comparison }, signal),
          c.api.get(`/websites/${c.siteId}/pageviews`, { ...scope, unit: 'day' }, signal),
          c.api.get(
            `/websites/${c.siteId}/pageviews`,
            { ...scope, ...comparison, unit: 'day' },
            signal,
          ),
          c.api.get(
            `/liekan/websites/${c.siteId}/analytics`,
            { ...scope, kind: 'sources' },
            signal,
          ),
          c.api.get(
            `/liekan/websites/${c.siteId}/analytics`,
            { ...scope, ...comparison, kind: 'sources' },
            signal,
          ),
        ]);
      return {
        current,
        previous,
        currentSeries,
        previousSeries,
        sources,
        oldSources,
        population:
          [current.population, previous.population].find(
            population =>
              population && ['partial', 'unavailable'].includes(population.identity.status),
          ) || current.population,
      };
    },
    !!c.siteId && comparison.startAt >= 0,
  );
  const d = query.data;
  const change = (a: number | null, b: number | null) =>
    a == null || b == null
      ? '—'
      : b
        ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(2)}%`
        : a
          ? i18n.text('新增')
          : '0%';
  const rate = (r: any) => (r?.visits ? (r.bounces / r.visits) * 100 : null);
  const views = (r: any) =>
    r?.population?.metricScope === 'qualified-browser' && !identityUsable(r.population)
      ? null
      : r?.pageviews;
  const currentUsable = identityUsable(d?.sources?.population || d?.current?.population);
  const previousUsable = identityUsable(d?.oldSources?.population || d?.previous?.population);
  const channels = new Map<
    string,
    { label: SourceDisplay; current: number | null; previous: number | null }
  >();
  for (const [rows, period] of [
    [d?.sources?.rows || [], 'current'],
    [d?.oldSources?.rows || [], 'previous'],
  ] as const) {
    for (const row of rows) {
      const generated = classifyEntrySourceForDisplay({ referrer: row.referrer });
      const label = generated.sourceLabel ? generated : { source: row.referrer };
      const key = JSON.stringify([label.source, generated.sourceLabel ?? null]);
      if (!channels.has(key))
        channels.set(key, {
          label,
          current: currentUsable ? 0 : null,
          previous: previousUsable ? 0 : null,
        });
      channels.get(key)[period] =
        row.visitors == null || channels.get(key)[period] === null
          ? null
          : channels.get(key)[period] + Number(row.visitors);
    }
  }
  const first = relativeDaySeries(
      d?.currentSeries?.sessions || [],
      c.range.startAt,
      c.range.endAt,
      c.range.timezone,
      d?.currentSeries?.population || d?.current?.population,
    ),
    second = relativeDaySeries(
      d?.previousSeries?.sessions || [],
      comparison.startAt,
      comparison.endAt,
      c.range.timezone,
      d?.previousSeries?.population || d?.previous?.population,
    );
  const count = Math.max(first.length, second.length);
  return (
    <>
      <div className="notice row between">
        <span>
          <strong>{i18n.text('当前：')}</strong>
          {date(c.range.startAt, c.range.timezone)}
          {i18n.fragment(' 至 ', true, true)}
          {date(c.range.endAt, c.range.timezone)}　<strong>{i18n.text('对照：')}</strong>
          {date(comparison.startAt, c.range.timezone)}
          {i18n.fragment(' 至 ', true, true)}
          {date(comparison.endAt, c.range.timezone)}
        </span>
        <Button onClick={() => setOpen(true)}>{i18n.text('调整对照期间')}</Button>
      </div>
      <QueryState query={query}>
        <Metrics
          loading={query.isPending}
          items={[
            [
              i18n.text('访客'),
              d ? n(d.current.visitors) : null,
              d
                ? i18n.text('较对照期 {v0}', [change(d.current.visitors, d.previous.visitors)])
                : '',
              'blue',
            ],
            [
              i18n.text('页面访问'),
              d ? n(views(d.current)) : null,
              d ? i18n.text('较对照期 {v0}', [change(views(d.current), views(d.previous))]) : '',
            ],
            [
              i18n.text('跳出率'),
              rate(d?.current) == null ? '—' : `${rate(d?.current).toFixed(2)}%`,
              rate(d?.current) != null && rate(d?.previous) != null
                ? i18n.text('较对照期 {v0} 个百分点', [
                    (rate(d.current) - rate(d.previous)).toFixed(2),
                  ])
                : i18n.text('对照期无有效访问'),
            ],
            [
              i18n.text('平均访问时长'),
              duration(
                d?.current?.visits ? d.current.totaltime / d.current.visits : null,
                i18n.locale,
              ),
              i18n.text('按同一访问口径计算'),
            ],
          ]}
        />
        <Chart
          interactionKey={JSON.stringify([
            'compare',
            c.user.id,
            c.siteId,
            scope,
            comparison,
            query.data,
          ])}
          title={i18n.text('同期访问趋势')}
          subtitle={i18n.text('对照序列按相对天数对齐，使用同一单位。')}
          labels={Array.from({ length: count }, (_, i) => i18n.text('第 {v0} 天', [i + 1]))}
          series={[
            {
              name: i18n.text('当前'),
              values: Array.from({ length: count }, (_, i) => (i < first.length ? first[i] : null)),
            },
            {
              name: i18n.text('对照'),
              dashed: true,
              values: Array.from({ length: count }, (_, i) =>
                i < second.length ? second[i] : null,
              ),
            },
          ]}
        />
        <Panel title={i18n.text('来源变化')} subtitle={i18n.text('各来源的绝对数量与变化比例。')}>
          <Table
            columns={['来源', '当前访客', '对照访客', '变化']}
            numeric={[1, 2, 3]}
            rows={[...channels.values()].map(({ label, current, previous }) => [
              sourceCell(label, i18n),
              n(current),
              n(previous),
              change(current, previous),
            ])}
          />
        </Panel>
      </QueryState>
      {open && (
        <LiekanDialog
          protectUnsaved={false}
          title={i18n.text('调整对照日期')}
          subtitle={i18n.system(c.range.timezone)}
          onClose={() => setOpen(false)}
        >
          <Form
            submitLabel={i18n.text('应用对照期间')}
            onSubmit={async v => {
              const startAt = +fromZonedTime(`${v.start}T00:00:00`, c.range.timezone),
                endAt = +fromZonedTime(`${v.end}T23:59:59.999`, c.range.timezone);
              if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt)
                throw new Error('对照日期范围无效');
              if (endAt - startAt > 1096 * 86400000) throw new Error('对照日期范围上限 3 年');
              setComparison({ startAt, endAt });
              setOpen(false);
            }}
          >
            <Definition
              items={[
                [
                  i18n.text('当前期间'),
                  i18n.text('{v0} 至 {v1}', [
                    date(c.range.startAt, c.range.timezone),
                    date(c.range.endAt, c.range.timezone),
                  ]),
                ],
                [i18n.text('统计时区'), c.range.timezone],
              ]}
            />
            <div className="form-grid">
              <Field
                label={i18n.text('开始日期')}
                type="date"
                name="start"
                required
                defaultValue={formatInTimeZone(comparison.startAt, c.range.timezone, 'yyyy-MM-dd')}
              />
              <Field
                label={i18n.text('结束日期')}
                type="date"
                name="end"
                required
                defaultValue={formatInTimeZone(comparison.endAt, c.range.timezone, 'yyyy-MM-dd')}
              />
            </div>
          </Form>
        </LiekanDialog>
      )}
    </>
  );
}
function Annotations() {
  const i18n = useLiekanI18n();
  const c = useFeature(),
    action = useAction();
  const scope = useScope();
  const [edit, setEdit] = useState<any>(null);
  const query = useData(
    ['annotation-list'],
    signal => getAllFeatureRows(`/websites/${c.siteId}/annotations`, scope, signal),
    !!c.siteId,
  );
  const chart = useWebsiteData(['annotations-chart'], 'pageviews', useScope({ unit: 'day' }));
  const values = relativeDaySeries(
    chart.data?.pageviews || [],
    c.range.startAt,
    c.range.endAt,
    c.range.timezone,
    chart.data?.population?.metricScope === 'qualified-browser' ? chart.data.population : undefined,
  );
  const firstDay = new Date(
    `${formatInTimeZone(c.range.startAt, c.range.timezone, 'yyyy-MM-dd')}T00:00:00Z`,
  );
  const points = values.map((y, i) => ({
    y,
    x: new Date(+firstDay + i * 86400000).toISOString().slice(0, 10),
  }));
  const dates = points.map(r => r.x);
  return (
    <>
      <Panel
        title={i18n.text('图表注释')}
        subtitle={i18n.text('记录产品上线、内容发布与推广日期。')}
        actions={
          canManage(c) && (
            <Button primary onClick={() => setEdit({})}>
              <Icon name="plus" />
              {i18n.fragment('添加注释', true, false)}
            </Button>
          )
        }
      >
        <QueryState query={query}>
          <Table
            mobile
            rowKeys={(query.data || []).map((row: any) => row.id)}
            search
            columns={['日期', '注释', '操作']}
            rows={(query.data || []).map((r: any) => [
              formatInTimeZone(r.date, c.range.timezone, 'yyyy-MM-dd'),
              r.note,
              <TableCell
                sortValue={i18n.source('编辑注释')}
                searchValue={i18n.english.text('编辑注释')}
              >
                <Button key={r.id} disabled={!canManage(c)} onClick={() => setEdit(r)}>
                  {i18n.text('编辑注释')}
                </Button>
              </TableCell>,
            ])}
          />
        </QueryState>
      </Panel>
      <Panel title={i18n.text('访问趋势')} subtitle={i18n.text('日期注释显示在相应时间节点。')}>
        <QueryState query={chart}>
          <Chart
            interactionKey={JSON.stringify([
              'annotations',
              c.user.id,
              c.siteId,
              scope,
              chart.data,
              query.data,
            ])}
            labels={dates}
            series={[
              {
                name: i18n.text('访问'),
                values: points.map((r: any) => (r.y == null ? null : Number(r.y))),
              },
            ]}
            option={{
              series: [
                {
                  type: 'line',
                  data: points.map((r: any) => (r.y == null ? null : Number(r.y))),
                  markLine: {
                    symbol: 'none',
                    label: { formatter: (p: any) => p.name },
                    data: (query.data || [])
                      .filter((r: any) =>
                        dates.includes(formatInTimeZone(r.date, c.range.timezone, 'yyyy-MM-dd')),
                      )
                      .map((r: any) => ({
                        xAxis: formatInTimeZone(r.date, c.range.timezone, 'yyyy-MM-dd'),
                        name: r.note,
                      })),
                  },
                },
              ],
            }}
          />
        </QueryState>
      </Panel>
      {edit && (
        <LiekanDialog
          title={i18n.system(edit.id ? i18n.text('编辑注释') : i18n.text('添加注释'))}
          protectUnsaved={!action.busy}
          onClose={() => !action.busy && setEdit(null)}
        >
          <Form
            busy={action.busy}
            error={action.error}
            submitLabel={i18n.system(edit.id ? i18n.text('保存注释') : i18n.text('添加注释'))}
            onSubmit={async v => {
              await action.run(
                () =>
                  c.api.post(`/websites/${c.siteId}/annotations${edit.id ? `/${edit.id}` : ''}`, {
                    date: fromZonedTime(`${v.date}T00:00:00`, c.range.timezone).toISOString(),
                    note: v.note,
                    allDay: true,
                  }),
                '注释已保存',
              );
              setEdit(null);
            }}
          >
            <Field
              label={i18n.text('日期')}
              type="date"
              name="date"
              required
              defaultValue={formatInTimeZone(
                edit.date || Date.now(),
                c.range.timezone,
                'yyyy-MM-dd',
              )}
            />
            <Textarea
              label={i18n.text('注释')}
              name="note"
              required
              maxLength={500}
              defaultValue={edit.note || ''}
            />
          </Form>
          {edit.id && (
            <Button
              danger
              disabled={action.busy}
              onClick={async () => {
                await action.run(
                  () => c.api.del(`/websites/${c.siteId}/annotations/${edit.id}`),
                  '已删除注释',
                );
                setEdit(null);
              }}
            >
              {i18n.text('删除注释')}
            </Button>
          )}
        </LiekanDialog>
      )}
    </>
  );
}
export function AnalyticsPages({ page }: { page: string }) {
  const i18n = useLiekanI18n();
  const c = useFeature();
  if (!analysisPages.has(page)) return null;
  if (!c.siteId)
    return (
      <Notice>
        {i18n.fragment('请先添加网站或切换网站后查看分析。', false, true)}
        <LinkButton page="websites">{i18n.text('网站管理')}</LinkButton>
      </Notice>
    );
  switch (page) {
    case 'realtime':
      return <Realtime />;
    case 'events':
      return <Events />;
    case 'event-detail':
      return <EventDetail />;
    case 'sessions':
      return <Sessions />;
    case 'session-detail':
      return <SessionDetail key={`${c.siteId}:${c.route.id}`} />;
    case 'filters':
      return <FilterEditor key={`${c.siteId}:${page}`} />;
    case 'segments':
      return <Audiences />;
    case 'cohorts':
      return <Audiences cohort />;
    case 'segment-editor':
      return <FilterEditor key={`${c.siteId}:${c.route.id}`} kind="segment-editor" />;
    case 'cohort-editor':
      return <FilterEditor key={`${c.siteId}:${c.route.id}`} kind="cohort-editor" />;
    case 'retention':
      return <Retention key={c.siteId} />;
    case 'journeys':
      return <Journeys />;
    case 'path-detail':
      return <Journeys detail key={c.query.sequence} />;
    case 'utm':
      return <UTM />;
    case 'attribution':
      return <Attribution />;
    case 'breakdown':
      return <Breakdown />;
    case 'compare':
      return <Compare />;
    case 'annotations':
      return <Annotations />;
    default:
      return null;
  }
}
