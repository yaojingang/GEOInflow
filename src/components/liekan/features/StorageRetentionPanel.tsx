'use client';
import { useEffect, useRef, useState } from 'react';
import { useManualQuery, useManualRefresh } from '@/lib/liekan/contracts/manual-refresh';
import {
  defaultStorageSettings,
  type StorageAction,
  type StorageRun,
  type StorageSettings,
  type StorageState,
  storageHours,
  storageSettingsSchema,
} from '@/lib/liekan/contracts/storage-retention';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { useFeature } from './context';
import { Body, Button, Definition, Field, Notice, Panel, Select, Switch, Table } from './ui';

const statuses = {
  preview: '待确认',
  queued: '排队中',
  running: '清理中',
  completed: '已完成',
  stopped: '已停止',
  failed: '失败',
};
const isRunning = (run?: StorageRun) => run?.status === 'queued' || run?.status === 'running';
const pollInterval = 3000;
const foregroundBudget = 15 * 60000;
type WithoutRequestId<T> = T extends unknown ? Omit<T, 'requestId'> : never;
type Action = WithoutRequestId<StorageAction>;

type StoragePanelProps = { websiteId?: string; warehouseMode?: boolean };

export function StorageRetentionPanel({ websiteId, warehouseMode }: StoragePanelProps) {
  const c = useFeature();
  const reading = useManualRefresh();
  if (reading?.authorized === false || (!websiteId && c.user.role !== 'admin')) return null;
  const session = `${c.user.id}:${c.user.role}:${websiteId}:${reading?.page.token}`;
  return <StorageSelection key={session} websiteId={websiteId} warehouseMode={warehouseMode} />;
}

function StorageSelection({ websiteId, warehouseMode }: StoragePanelProps) {
  const c = useFeature();
  const i18n = useLiekanI18n();
  const reading = useManualRefresh();
  const [instance, setInstance] = useState(!websiteId);
  const selected = instance ? undefined : websiteId;
  return (
    <Panel
      title={i18n.text('存储与清理')}
      subtitle={i18n.text(
        warehouseMode
          ? '清理 PostgreSQL 中无引用的旧统计副本和已完成任务，不删除 ClickHouse 明细。'
          : '回收无引用的统计副本和超期完成流水，保留原始明细及历史统计。',
      )}
    >
      <Body>
        {c.user.role === 'admin' && websiteId && (
          <Select
            label={i18n.text('清理范围')}
            value={instance ? 'instance' : 'website'}
            onChange={e => setInstance(e.target.value === 'instance')}
            options={[
              ['website', i18n.text('当前网站统计副本')],
              ['instance', i18n.text('实例已完成任务')],
            ]}
          />
        )}
        <StorageScope
          key={`${selected || 'instance'}:${reading?.page.round}`}
          websiteId={selected}
          warehouseMode={warehouseMode}
        />
      </Body>
    </Panel>
  );
}

function StorageScope({ websiteId, warehouseMode }: StoragePanelProps) {
  const c = useFeature();
  const i18n = useLiekanI18n();
  const instance = !websiteId;
  const endpoint = instance ? '/liekan/storage' : `/liekan/websites/${websiteId}/storage`;
  const [state, setState] = useState<StorageState>();
  const [settings, setSettings] = useState<StorageSettings>(defaultStorageSettings);
  const [preview, setPreview] = useState<StorageRun>();
  const [active, setActive] = useState<StorageRun>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [pollPaused, setPollPaused] = useState(false);
  const [pollRound, setPollRound] = useState(0);
  const [previewExpired, setPreviewExpired] = useState(false);
  const alive = useRef(true);
  const acting = useRef(false);
  const policyRevision = useRef<number>(undefined);
  const restriction = useRef(0);
  const budget = useRef({ runId: '', elapsed: 0 });
  const query = useManualQuery<StorageState>({
    queryKey: ['storage-retention', c.user.id, websiteId || 'instance'],
    queryFn: ({ signal }) => c.api.get(endpoint, undefined, signal),
  });
  const canRead = (query as typeof query & { manualCanRead?: boolean }).manualCanRead !== false;
  const readable = useRef(canRead);
  readable.current = canRead;
  const authorization = useRef({ canRead, generation: 0 });
  if (authorization.current.canRead !== canRead)
    authorization.current = { canRead, generation: authorization.current.generation + 1 };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function clearPreview() {
    setPreview(undefined);
    setPreviewExpired(false);
  }
  function fail(value: any) {
    setError(value?.message || i18n.text('清理状态读取失败'));
    if ([401, 403, 404].includes(value?.status)) {
      restriction.current += 1;
      setBlocked(true);
      setState(undefined);
      clearPreview();
      setActive(undefined);
    }
    if ([409, 410].includes(value?.status)) clearPreview();
  }
  function accept(value: StorageState) {
    if (
      value?.websiteId !== (websiteId || null) ||
      value?.scope !== (instance ? 'instance' : 'website')
    )
      return;
    setState(value);
    setBlocked(false);
    setError('');
    if (policyRevision.current !== value.policy.revision) {
      const { revision, ...settings } = value.policy;
      policyRevision.current = revision;
      setSettings(settings);
      clearPreview();
    }
    setActive(value.runs.find(isRunning));
  }
  useEffect(() => {
    if (canRead && query.data && !query.error && !blocked) accept(query.data);
  }, [query.data, query.dataUpdatedAt, canRead]);
  useEffect(() => {
    if (query.error) fail(query.error);
  }, [query.error, query.errorUpdatedAt]);

  useEffect(() => {
    if (!canRead) {
      clearPreview();
      setState(undefined);
      setActive(undefined);
    }
  }, [canRead]);

  async function reload() {
    if (!readable.current) return;
    const generation = authorization.current.generation;
    const expectedRestriction = restriction.current;
    const result = await query.refetch();
    if (
      !alive.current ||
      !readable.current ||
      authorization.current.generation !== generation ||
      restriction.current !== expectedRestriction
    )
      return;
    if (result.error) fail(result.error);
    else if (result.data) accept(result.data);
  }

  useEffect(() => {
    if (!preview) return;
    const expiresIn = new Date(preview.expiresAt).getTime() - Date.now();
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      setPreviewExpired(true);
      return;
    }
    const timer = setTimeout(() => setPreviewExpired(true), expiresIn);
    return () => clearTimeout(timer);
  }, [preview?.id, preview?.expiresAt]);

  const running = isRunning(active);
  useEffect(() => {
    if (active?.id && budget.current.runId !== active.id) {
      budget.current = { runId: active.id, elapsed: 0 };
      setPollPaused(false);
    }
  }, [active?.id]);
  useEffect(() => {
    if (!canRead || !active || !running || blocked || pollPaused || busy) return;
    const controller = new AbortController();
    let polling = false;
    let finished = false;
    let last = Date.now();
    let foreground = document.visibilityState !== 'hidden' && navigator.onLine !== false;
    const accountTime = () => {
      const now = Date.now();
      if (foreground) budget.current.elapsed += Math.max(0, now - last);
      last = now;
      foreground = document.visibilityState !== 'hidden' && navigator.onLine !== false;
    };
    const poll = async () => {
      accountTime();
      if (controller.signal.aborted || finished) return;
      if (budget.current.elapsed >= foregroundBudget) {
        setPollPaused(true);
        controller.abort();
        return;
      }
      if (!foreground || polling) return;
      polling = true;
      try {
        const run = await c.api.get<StorageRun>(endpoint, { runId: active.id }, controller.signal);
        if (controller.signal.aborted || !alive.current || !readable.current) return;
        if (run.id !== active.id || run.websiteId !== (websiteId || null))
          throw new Error(i18n.text('清理状态读取失败'));
        setActive(run);
        setError('');
        if (!isRunning(run)) {
          finished = true;
          await reload();
        }
      } catch (value) {
        if (!controller.signal.aborted && alive.current) {
          fail(value);
          setPollPaused(true);
        }
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), pollInterval);
    document.addEventListener('visibilitychange', accountTime);
    window.addEventListener('online', accountTime);
    window.addEventListener('offline', accountTime);
    return () => {
      accountTime();
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', accountTime);
      window.removeEventListener('online', accountTime);
      window.removeEventListener('offline', accountTime);
    };
  }, [active?.id, running, canRead, blocked, pollPaused, busy, pollRound]);

  async function act(action: Action) {
    if (acting.current || !readable.current || blocked || !state) return;
    if (
      action.action === 'confirm' &&
      (!preview || previewExpired || new Date(preview.expiresAt).getTime() <= Date.now())
    )
      return;
    acting.current = true;
    const generation = authorization.current.generation;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const value = await c.api.post<StorageRun>(endpoint, {
        ...action,
        requestId: crypto.randomUUID(),
      });
      if (!alive.current || !readable.current || authorization.current.generation !== generation)
        return;
      if (action.action === 'preview') {
        setPreview(value);
        setPreviewExpired(false);
      } else {
        clearPreview();
        if (value?.id) setActive(value);
        setMessage(
          i18n.text(
            action.action === 'policy' ? '清理策略已保存' : '操作已提交，关闭页面后后台继续处理。',
          ),
        );
      }
      await reload();
    } catch (value) {
      if (alive.current && readable.current && authorization.current.generation === generation)
        fail(value);
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const validSettings = storageSettingsSchema.safeParse(settings).success;
  const bytes = (value: string | number) => `${(Number(value) / 1024 ** 2).toFixed(1)} MiB`;
  const changeSettings = (value: Partial<StorageSettings>) => {
    setSettings(previous => ({ ...previous, ...value }));
    clearPreview();
  };
  const hourOptions = storageHours.map(
    value => [String(value), i18n.text('{v0} 小时', [value])] as [string, string],
  );
  const field = (name: 'generationHours' | 'completedHours' | 'wakeHours', label: string) => (
    <Select
      label={i18n.system(label)}
      disabled={busy}
      value={String(settings[name])}
      options={hourOptions}
      onChange={e => changeSettings({ [name]: Number(e.target.value) })}
    />
  );
  const date = (value: string) =>
    new Date(value).toLocaleString(i18n.locale, { timeZone: state.policy.timezone });
  const runs = state?.runs.map(run => (active?.id === run.id ? active : run)) || [];
  const physicalChange = (run: StorageRun) =>
    run.physicalBytesBefore != null && run.physicalBytesAfter != null
      ? `${bytes(run.physicalBytesBefore)} → ${bytes(run.physicalBytesAfter)}`
      : i18n.text('未测量');
  if (!canRead) return null;
  return (
    <>
      {error && <Notice tone="red">{i18n.system(error)}</Notice>}
      {message && <Notice>{message}</Notice>}
      {!state && !error && <Notice>{i18n.text('正在读取清理状态')}</Notice>}
      <Button disabled={busy || query.isFetching} onClick={reload}>
        {i18n.text('重新读取')}
      </Button>
      {state && !blocked && (
        <>
          <Definition
            items={[
              [i18n.text('清理范围'), i18n.text(instance ? '实例已完成任务' : '当前网站统计副本')],
              ...(!warehouseMode && state.capacity
                ? [
                    [
                      i18n.text('网站派生空间估算'),
                      `${bytes(state.capacity.siteBytes)} / ${bytes(state.capacity.siteLimit)}`,
                    ] as [string, string],
                  ]
                : []),
              [
                i18n.text('候选记录'),
                String(instance ? state.preview.completedJobs : state.preview.candidateCount),
              ],
              [
                i18n.text(warehouseMode ? '预计可回收数据量' : '预计可回收额度'),
                instance ? i18n.text('按完成流水数量计量') : bytes(state.preview.estimatedBytes),
              ],
              ...(!instance
                ? [
                    [i18n.text('受保护的统计版本'), String(state.preview.protectedCount)] as [
                      string,
                      string,
                    ],
                  ]
                : []),
            ]}
          />
          <Switch
            label={i18n.text('自动清理')}
            disabled={busy}
            checked={settings.enabled}
            onChange={e => changeSettings({ enabled: e.target.checked })}
          />
          {!instance && !warehouseMode && (
            <Switch
              label={i18n.text('容量达到 80% 时提前回收')}
              disabled={busy}
              checked={settings.pressureEnabled}
              onChange={e => changeSettings({ pressureEnabled: e.target.checked })}
            />
          )}
          {!instance ? (
            field('generationHours', '无引用版本保留期')
          ) : (
            <>
              {field('wakeHours', '高频已完成任务保留期')}
              {field('completedHours', '其他已完成任务保留期')}
            </>
          )}
          <Field
            label={i18n.text('集中清理小时')}
            type="number"
            min={0}
            max={23}
            step={1}
            disabled={busy}
            value={Number.isFinite(settings.hour) ? settings.hour : ''}
            error={
              !Number.isInteger(settings.hour) || settings.hour < 0 || settings.hour > 23
                ? i18n.text('清理参数无效')
                : undefined
            }
            onChange={e => changeSettings({ hour: e.target.valueAsNumber })}
          />
          <Field
            label={i18n.text('清理时区')}
            disabled={busy}
            value={settings.timezone}
            error={
              !storageSettingsSchema.shape.timezone.safeParse(settings.timezone).success
                ? i18n.text('清理参数无效')
                : undefined
            }
            onChange={e => changeSettings({ timezone: e.target.value })}
          />
          <p className="muted">
            {i18n.text(
              warehouseMode
                ? '每小时回收高频和统计调度流水；旧统计副本及其他完成流水按集中时间回收。'
                : '每小时回收高频和统计调度流水；统计副本及其他完成流水按集中时间回收。容量紧张时提前处理。',
            )}
          </p>
          <div className="btn-row">
            <Button
              disabled={busy || !validSettings}
              onClick={() =>
                act({ action: 'policy', settings, expectedRevision: state.policy.revision })
              }
            >
              {i18n.text('保存清理策略')}
            </Button>
            <Button
              primary
              disabled={busy || running || !validSettings}
              onClick={() =>
                act({
                  action: 'preview',
                  generationHours: settings.generationHours,
                  completedHours: settings.completedHours,
                  wakeHours: settings.wakeHours,
                })
              }
            >
              {i18n.text('预览清理')}
            </Button>
          </div>
          {preview && (
            <Notice>
              <p>{i18n.text('预览 15 分钟内有效，确认后只处理本次候选；新增引用会自动跳过。')}</p>
              <p>
                {instance
                  ? `${i18n.text('候选记录')} ${preview.candidateCount} · ${i18n.text('按完成流水数量计量')}`
                  : i18n.text(
                      warehouseMode
                        ? '候选记录：{v0}，受保护版本：{v1}，预计可回收数据量：{v2}。'
                        : '候选记录：{v0}，受保护版本：{v1}，预计恢复额度：{v2}。',
                      [
                        preview.candidateCount,
                        preview.protectedCount,
                        bytes(preview.estimatedBytes),
                      ],
                    )}
              </p>
              {previewExpired && <p>{i18n.text('清理预览已过期，请重新预览')}</p>}
              <div className="btn-row">
                <Button
                  primary
                  disabled={busy || running || previewExpired}
                  onClick={() => act({ action: 'confirm', id: preview.id })}
                >
                  {i18n.text('确认清理')}
                </Button>
                <Button disabled={busy} onClick={() => act({ action: 'stop', id: preview.id })}>
                  {i18n.text('取消预览')}
                </Button>
              </div>
            </Notice>
          )}
          {running && (
            <Notice>
              <p>
                {i18n.text(
                  warehouseMode
                    ? '已清理 {v0} 个统计版本和 {v1} 条任务流水，已回收数据量 {v2}。'
                    : '已清理 {v0} 个统计版本和 {v1} 条任务流水，恢复额度 {v2}。',
                  [active.generationsDeleted, active.jobsDeleted, bytes(active.releasedBytes)],
                )}
              </p>
              <Button disabled={busy} onClick={() => act({ action: 'stop', id: active.id })}>
                {i18n.text('停止后续批次')}
              </Button>
              {pollPaused && (
                <>
                  <p>{i18n.text('已暂停自动查看，后台任务继续处理。')}</p>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      budget.current.elapsed = 0;
                      setPollPaused(false);
                      setPollRound(value => value + 1);
                    }}
                  >
                    {i18n.text('继续查看')}
                  </Button>
                </>
              )}
            </Notice>
          )}
          <Notice>
            {i18n.text(
              '原始浏览事件、服务器日志明细、当前及上一统计版本、可恢复任务、GEO 快照与历史修复依据继续保留。',
            )}
          </Notice>
          <p className="muted">
            {i18n.text(
              warehouseMode
                ? '回收数据量按 PostgreSQL 逻辑大小计量。数据库可复用已回收空间，物理文件大小可能暂时保持原值。'
                : '额度恢复和物理磁盘变化分别记录。数据库可先复用已回收空间，文件大小可能暂时保持原值。',
            )}
          </p>
          <Table
            columns={[
              i18n.text('创建时间'),
              i18n.text('状态'),
              i18n.text('统计版本'),
              i18n.text('任务流水'),
              i18n.text(warehouseMode ? '已回收数据量' : '恢复额度'),
              i18n.text('物理存储变化'),
            ]}
            numeric={[2, 3, 4, 5]}
            static={[5]}
            rowKeys={runs.map(run => run.id)}
            rows={runs.map(run => [
              date(run.createdAt),
              <span key={run.id} style={{ whiteSpace: 'nowrap' }}>
                {i18n.system(statuses[run.status])}
              </span>,
              String(run.generationsDeleted),
              String(run.jobsDeleted),
              bytes(run.releasedBytes),
              physicalChange(run),
            ])}
          />
        </>
      )}
    </>
  );
}
