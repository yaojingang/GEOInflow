'use client';
import { useEffect, useState } from 'react';
import type {
  AnalyticsEngineAction,
  AnalyticsEngineStatus,
} from '@/lib/liekan/contracts/analytics-engine';
import { useManualQuery } from '@/lib/liekan/contracts/manual-refresh';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { useFeature } from './context';
import { Body, Button, Definition, Notice, Panel, Table } from './ui';

export function AnalyticsEnginePage() {
  const c = useFeature(),
    i18n = useLiekanI18n();
  const [status, setStatus] = useState<AnalyticsEngineStatus>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [denied, setDenied] = useState(false),
    [pollRound, setPollRound] = useState(0),
    [pollPaused, setPollPaused] = useState(false),
    [cursor, setCursor] = useState(''),
    [previous, setPrevious] = useState<string[]>([]);
  const receive = (value: AnalyticsEngineStatus) =>
    setStatus(previous => (!previous || value.revision >= previous.revision ? value : previous));
  const fail = (e: any) => {
    setError(e.message);
    if ([401, 403].includes(e.status)) {
      setDenied(true);
      setStatus(undefined);
    }
  };
  const timestamp = (v: string) =>
    new Date(v).toLocaleString(i18n.locale, { timeZone: c.range.timezone });
  const read = () =>
    c.api.get<AnalyticsEngineStatus>(
      '/liekan/admin/analytics-engine',
      cursor ? { cursor } : undefined,
    );
  const q = useManualQuery<AnalyticsEngineStatus>({
    queryKey: ['analytics-engine', c.user.id, cursor],
    enabled: !!c.user.isAdmin,
    queryFn: read,
  });
  useEffect(() => {
    if (q.error) fail(q.error);
  }, [q.error]);
  useEffect(() => {
    if (q.data) receive(q.data);
  }, [q.data]);
  useEffect(() => {
    if (!status?.syncing || !c.user.isAdmin) return;
    const started = Date.now();
    let cancelled = false,
      checking = false;
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden' || !navigator.onLine || checking) return;
      if (Date.now() - started > 15 * 60000) {
        setPollPaused(true);
        return;
      }
      checking = true;
      void read()
        .then(value => {
          if (!cancelled) receive(value);
        })
        .catch(e => {
          if (!cancelled) fail(e);
        })
        .finally(() => {
          checking = false;
        });
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status?.syncing, c.user.id, c.user.isAdmin, pollRound, cursor]);
  if (!c.user.isAdmin || denied)
    return <Notice tone="red">{i18n.text('此操作需要系统管理员完整登录')}</Notice>;
  const act = async (action: AnalyticsEngineAction['action']) => {
    if (!status || busy) return;
    setBusy(true);
    setError('');
    try {
      setCursor('');
      setPrevious([]);
      receive(
        await c.api.post<AnalyticsEngineStatus>('/liekan/admin/analytics-engine', {
          action,
          requestId: crypto.randomUUID(),
          expectedRevision: status.revision,
          locale: i18n.locale,
        }),
      );
    } catch (e: any) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const action = (kind: AnalyticsEngineAction['action'], label: string, disabled = false) => (
    <Button key={kind} disabled={busy || disabled} onClick={() => void act(kind)}>
      {i18n.text(label)}
    </Button>
  );
  return (
    <>
      {pollPaused && (
        <Button
          onClick={() => {
            setPollPaused(false);
            setPollRound(n => n + 1);
          }}
        >
          {i18n.text('继续查看')}
        </Button>
      )}
      {(error || q.error) && <Notice tone="red">{i18n.system(error || q.error?.message)}</Notice>}
      <Panel
        title={i18n.text('分析引擎')}
        subtitle={i18n.text('PostgreSQL 保留原始事实，ClickHouse 分担历史日志聚合。')}
      >
        <Body>
          <Definition
            items={[
              [
                i18n.text('当前模式'),
                status
                  ? status.enabled && status.configured && status.healthy
                    ? 'PostgreSQL + ClickHouse'
                    : 'PostgreSQL'
                  : i18n.text('未提供'),
              ],
              [
                i18n.text('连接状态'),
                status?.configured
                  ? i18n.text(status.healthy ? '连接正常' : '待检查')
                  : i18n.text(status ? '未配置' : '未提供'),
              ],
              [i18n.text('连接地址'), status?.connection || i18n.text('未提供')],
              [i18n.text('服务版本'), status?.version || i18n.text('未提供')],
              [
                i18n.text('最近检查'),
                status?.checkedAt ? timestamp(status.checkedAt) : i18n.text('未提供'),
              ],
              [
                i18n.text('后台心跳'),
                status?.workerAt ? timestamp(status.workerAt) : i18n.text('未提供'),
              ],
            ]}
          />
          <div className="actions">{action('check', '检查连接', !status?.configured)}</div>
          {!status?.configured && (
            <Notice tone="blue">
              {i18n.text(
                '由部署管理员配置 LIEKAN_ANALYTICS_CLICKHOUSE_URL，然后检查连接。密码仅保存在服务端。',
              )}
            </Notice>
          )}
          {status?.error && (
            <Notice tone="red">
              {i18n.text('分析副本暂不可用，查询继续使用 PostgreSQL。请检查连接或重试同步。')}
            </Notice>
          )}
        </Body>
      </Panel>
      <Panel
        title={i18n.text('历史日志同步')}
        subtitle={i18n.text('准备数据并校验有效覆盖，关闭页面后后台任务继续。')}
      >
        <Body>
          <div className="actions">
            {action('prepare', '准备数据', !status?.healthy)}
            {action('verify', '执行对账', !status?.healthy)}
            {status?.syncing
              ? action('pause', '暂停同步')
              : action('resume', '恢复同步', !status?.configured)}
            {action('retry', '重试同步', !status?.configured)}
          </div>
          <Table
            columns={[
              i18n.text('网站'),
              i18n.text('已完成'),
              i18n.text('待处理'),
              i18n.text('失败'),
              i18n.text('分析记录'),
              i18n.text('最近发布'),
              i18n.text('已准备范围'),
            ]}
            rows={(status?.sites || []).map(site => [
              site.name,
              site.completed,
              site.pending,
              site.failed,
              site.rows,
              site.purgePending
                ? i18n.text('等待清理')
                : site.lastPublishedAt
                  ? timestamp(site.lastPublishedAt)
                  : i18n.text('未提供'),
              site.rangeStart && site.rangeEnd
                ? `${timestamp(site.rangeStart)} ~ ${timestamp(site.rangeEnd)}`
                : i18n.text('未提供'),
            ])}
          />
          {(previous.length > 0 || status?.nextCursor) && (
            <div className="actions">
              <Button
                disabled={!previous.length}
                onClick={() => {
                  setCursor(previous.at(-1) || '');
                  setPrevious(p => p.slice(0, -1));
                }}
              >
                {i18n.text('上一页')}
              </Button>
              <Button
                disabled={!status?.nextCursor}
                onClick={() => {
                  setPrevious(p => [...p, cursor]);
                  setCursor(status.nextCursor);
                }}
              >
                {i18n.text('下一页')}
              </Button>
            </div>
          )}
          {status && !status.sites.length && (
            <Notice tone="blue">{i18n.text('尚未准备历史分析副本。')}</Notice>
          )}
        </Body>
      </Panel>
      <Panel
        title={i18n.text('使用控制')}
        subtitle={i18n.text('统一应用于整个实例，已验证的历史日志查询自动选择分析引擎。')}
      >
        <Body>
          <Notice tone="blue">
            {i18n.text(
              '实时尾部、缺口、明细、导出及浏览器统计继续使用现有 PostgreSQL 路径。原始日志继续完整保留。',
            )}
          </Notice>
          <div className="actions">
            {action('enable', '启用 ClickHouse 分析', !status?.healthy)}
            {action('disable', '切回 PostgreSQL', !status?.enabled && !status?.syncing)}
          </div>
        </Body>
      </Panel>
    </>
  );
}
