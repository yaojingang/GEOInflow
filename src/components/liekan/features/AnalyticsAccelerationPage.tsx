'use client';
import { useEffect, useRef, useState } from 'react';
import { fromZonedTime } from 'date-fns-tz';
import type {
  AnalysisBuildDto,
  AnalysisStatusDto,
  AnalysisWebsiteList,
} from '@/lib/liekan/contracts/analysis-acceleration';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { useManualQuery, useManualRefresh } from '@/lib/liekan/contracts/manual-refresh';
import { useFeature } from './context';
import { Body, Button, Definition, Field, LinkButton, Notice, Panel, Select, Table } from './ui';
const labels = {
  queued: '排队中',
  running: '构建中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  invalidated: '已失效',
  capacity_limited: '容量受限',
};
export function AnalyticsAccelerationPage() {
  const c = useFeature(),
    i18n = useLiekanI18n(),
    reading = useManualRefresh();
  const [list, setList] = useState<AnalysisWebsiteList>(),
    [cursor, setCursor] = useState('');
  const [siteId, setSiteId] = useState(c.query.websiteId || ''),
    [detail, setDetail] = useState<AnalysisStatusDto>();
  const [preset, setPreset] = useState('common'),
    [start, setStart] = useState(''),
    [end, setEnd] = useState('');
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [pollPaused, setPollPaused] = useState(false),
    [pollRound, setPollRound] = useState(0),
    [restricted, setRestricted] = useState(false);
  const restrictedAt = useRef(0);
  const failure = (error: any) => {
    setError(error.message);
    if ([401, 403, 404, 409, 410].includes(error.status)) {
      restrictedAt.current = Date.now();
      setRestricted(true);
      setDetail(undefined);
    }
  };
  const scope = `${c.user.id}:${siteId}:${reading?.page.token}:${reading?.page.round}`;
  const current = useRef(scope);
  current.current = scope;
  const authorized = reading?.authorized !== false;
  const endpoint = (id = siteId) => `/liekan/websites/${id}/analytics-acceleration`;
  const listRead = useManualQuery<AnalysisWebsiteList>({
    queryKey: ['analytics-acceleration-list', c.user.id, cursor],
    queryFn: ({ signal }) => c.api.get('/liekan/analytics-acceleration', { cursor }, signal),
  });
  const detailRead = useManualQuery<AnalysisStatusDto>({
    queryKey: ['analytics-acceleration-status', c.user.id, siteId],
    enabled: !!siteId && listRead.data?.supported !== false,
    queryFn: ({ signal }) => c.api.get(endpoint(siteId), undefined, signal),
  });
  useEffect(() => {
    setSiteId(c.query.websiteId || '');
  }, [c.query.websiteId]);
  useEffect(() => {
    setList(listRead.data);
  }, [listRead.data]);
  useEffect(() => {
    setDetail(undefined);
    setError('');
    setMessage('');
    setPollPaused(false);
    setBusy(false);
  }, [scope]);
  useEffect(() => {
    if (
      authorized &&
      detailRead.data?.websiteId === siteId &&
      (!restricted || detailRead.dataUpdatedAt > restrictedAt.current)
    ) {
      setRestricted(false);
      setDetail(detailRead.data);
    }
  }, [detailRead.data, detailRead.dataUpdatedAt, authorized, siteId, restricted]);
  useEffect(() => {
    const error = detailRead.error || listRead.error;
    if (error) failure(error);
  }, [detailRead.error, listRead.error]);
  const active = !!detail?.builds?.some(row => ['queued', 'running'].includes(row.status));
  useEffect(() => {
    if (!authorized || restricted || !siteId || !active) return;
    const controller = new AbortController();
    const expectedScope = scope;
    let timer: ReturnType<typeof setTimeout>;
    let visibleMs = 0,
      last = Date.now();
    const load = async () => {
      if (controller.signal.aborted || current.current !== expectedScope) return;
      const now = Date.now();
      if (document.visibilityState !== 'hidden') visibleMs += now - last;
      last = now;
      if (visibleMs >= 15 * 60000) {
        setPollPaused(true);
        return;
      }
      if (document.visibilityState === 'hidden' || navigator.onLine === false) {
        timer = setTimeout(load, 3000);
        return;
      }
      try {
        const value = await c.api.get<AnalysisStatusDto>(
          endpoint(siteId),
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted || current.current !== expectedScope) return;
        setDetail(value);
        setError('');
        if (value.builds.some(row => ['queued', 'running'].includes(row.status)))
          timer = setTimeout(load, 3000);
      } catch (e: any) {
        if (!controller.signal.aborted && current.current === expectedScope) failure(e);
      }
    };
    timer = setTimeout(load, 3000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [siteId, scope, pollRound, active, authorized, restricted]);
  async function act(work: () => Promise<unknown>) {
    if (!authorized || restricted || busy) return;
    const expectedScope = scope;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      if (current.current !== expectedScope) return;
      const value = await detailRead.refetch();
      if (current.current !== expectedScope) return;
      if (value.error) throw value.error;
      setDetail(value.data);
      setMessage(i18n.text('操作已提交，关闭页面后后台继续处理。'));
      setPollPaused(false);
      setPollRound(value => value + 1);
    } catch (e: any) {
      if (current.current === expectedScope) failure(e);
    } finally {
      if (current.current === expectedScope) setBusy(false);
    }
  }
  const action = (action: string, build?: AnalysisBuildDto) =>
    act(() =>
      c.api.post(`${endpoint()}/action`, {
        action,
        buildId: build?.id,
        requestId: crypto.randomUUID(),
        expectedRevision: build?.revision ?? detail.revision,
      }),
    );
  const date = (value: string) =>
    i18n.system(new Date(value).toLocaleString(i18n.locale, { timeZone: c.range.timezone }));
  const bytes = (value: string | number) => `${(Number(value) / 1024 / 1024).toFixed(1)} MiB`;
  return (
    <>
      {error && <Notice tone="red">{i18n.system(error)}</Notice>}
      {message && <Notice>{message}</Notice>}
      <Panel
        title={i18n.text('统计加速')}
        subtitle={
          list?.backend === 'clickhouse'
            ? i18n.text('ClickHouse 已直接提供统计，无需构建旧汇总')
            : i18n.text('自动维护新增数据的汇总。历史范围由网站管理者启动构建。')
        }
      >
        <Body>
          <Select
            label={i18n.text('选择网站')}
            value={siteId}
            onChange={e => {
              setSiteId(e.target.value);
              c.navigate('analytics-acceleration', { websiteId: e.target.value });
            }}
            options={[
              ['', i18n.text('请选择网站')],
              ...(list?.websites || []).map(site => [site.id, site.name] as [string, string]),
            ]}
          />
          {list?.nextCursor && (
            <Button onClick={() => setCursor(list.nextCursor)}>{i18n.text('下一页')}</Button>
          )}
          {cursor && <Button onClick={() => setCursor('')}>{i18n.text('返回第一页')}</Button>}
        </Body>
      </Panel>
      {list?.supported !== false && siteId && !detail && !error && (
        <Notice>{i18n.text('正在读取加速状态')}</Notice>
      )}
      {list?.supported !== false && authorized && !restricted && detail?.websiteId === siteId && (
        <>
          {detail.expansion && (!detail.expansion.path || !detail.expansion.visit) && (
            <Notice>{i18n.text('高基数扩展已暂停，未覆盖范围继续使用原始事实。')}</Notice>
          )}
          <Panel
            title={i18n.text('实时维护')}
            actions={
              <Button
                disabled={busy}
                onClick={() => action(detail.mode === 'live' ? 'disable' : 'enable')}
              >
                {i18n.text(detail.mode === 'live' ? '停用加速' : '启用加速')}
              </Button>
            }
          >
            <Body>
              <Definition
                items={[
                  [i18n.text('维护状态'), i18n.text(detail.mode === 'live' ? '已启用' : '已停用')],
                  [i18n.text('新增输入捕获起点'), date(detail.captureFrom)],
                  [
                    i18n.text('网站派生空间估算'),
                    `${bytes(detail.capacity.siteBytes)} / ${bytes(detail.capacity.siteLimit)}`,
                  ],
                  [
                    i18n.text('实例派生空间'),
                    `${bytes(detail.capacity.globalBytes)} / ${bytes(detail.capacity.globalLimit)}`,
                  ],
                ]}
              />
              <p className="muted">
                {i18n.text('停用后关闭本站的变更捕获，统计使用原始事实。重新启用会建立新基线。')}
              </p>
            </Body>
          </Panel>
          <Panel title={i18n.text('历史范围构建')}>
            <Body>
              <Select
                label={i18n.text('构建范围')}
                value={preset}
                onChange={e => setPreset(e.target.value)}
                options={[
                  ['common', i18n.text('常用报表范围')],
                  ['custom', i18n.text('自定义范围')],
                  ['retained', i18n.text('全部留存历史')],
                ]}
              />
              <p className="muted">{i18n.text('常用范围包括近 30 天、对比期及六个自然月趋势。')}</p>
              {preset === 'custom' && (
                <div className="two">
                  <Field
                    label={i18n.text('开始日期')}
                    type="date"
                    value={start}
                    onChange={e => setStart(e.target.value)}
                  />
                  <Field
                    label={i18n.text('结束日期（不含）')}
                    type="date"
                    value={end}
                    onChange={e => setEnd(e.target.value)}
                  />
                </div>
              )}
              <Button
                primary
                disabled={
                  busy ||
                  detail.mode !== 'live' ||
                  (preset === 'custom' && (!start || !end || start >= end))
                }
                onClick={() =>
                  act(() =>
                    c.api.post(`${endpoint()}/build`, {
                      preset,
                      requestId: crypto.randomUUID(),
                      expectedRevision: detail.revision,
                      timezone: c.range.timezone,
                      locale: i18n.locale,
                      ...(preset === 'custom'
                        ? {
                            startAt: +fromZonedTime(`${start}T00:00:00`, c.range.timezone),
                            endAt: +fromZonedTime(`${end}T00:00:00`, c.range.timezone),
                          }
                        : {}),
                    }),
                  )
                }
              >
                {i18n.text('开始构建')}
              </Button>
            </Body>
          </Panel>
          <Panel
            title={i18n.text('构建记录')}
            actions={
              pollPaused && (
                <Button
                  onClick={() => {
                    setPollPaused(false);
                    setPollRound(value => value + 1);
                  }}
                >
                  {i18n.text('继续查看计算状态')}
                </Button>
              )
            }
          >
            <Table
              columns={['状态', '进度', '构建范围', '最近更新', '操作'].map(label =>
                i18n.text(label),
              )}
              rows={detail.builds.map(build => [
                <span>
                  {i18n.text(labels[build.status])}
                  {build.errorCode && <small> · {i18n.text('请重试或检查后台服务')}</small>}
                </span>,
                <span className="num">
                  {build.progress}% · {build.completedUnits}/{build.totalUnits}
                </span>,
                <span>
                  {date(build.rangeStart)}
                  <br />
                  {date(build.rangeEnd)}
                </span>,
                date(build.updatedAt),
                <>
                  {['queued', 'running'].includes(build.status) && (
                    <Button disabled={busy} onClick={() => action('pause', build)}>
                      {i18n.text('暂停')}
                    </Button>
                  )}
                  {build.status === 'paused' && (
                    <Button disabled={busy} onClick={() => action('resume', build)}>
                      {i18n.text('继续')}
                    </Button>
                  )}
                  {['failed', 'capacity_limited'].includes(build.status) && (
                    <Button disabled={busy} onClick={() => action('retry', build)}>
                      {i18n.text('重试')}
                    </Button>
                  )}
                </>,
              ])}
            />
          </Panel>
          <Panel
            title={i18n.text('已发布覆盖')}
            subtitle={i18n.text('缺口和当前未结束范围仍由原始事实补齐。')}
          >
            <Table
              columns={['指标族', '开始时间', '结束时间', '状态'].map(label => i18n.text(label))}
              rows={detail.coverage.map(row => [
                i18n.text(row.family === 'log' ? 'AI 抓取' : '访客统计'),
                date(row.rangeStart),
                date(row.rangeEnd),
                i18n.text(row.current ? '有效' : '待更新'),
              ])}
            />
          </Panel>
        </>
      )}
      <LinkButton page="websites">{i18n.text('返回网站管理')}</LinkButton>
    </>
  );
}
