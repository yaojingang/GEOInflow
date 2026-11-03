'use client';
import { useEffect, useRef, useState } from 'react';
import { robotsAgentUrl } from '@/lib/liekan/upstream/robots-client';
import type {
  RobotsDeployment,
  RobotsManagement,
  RobotsManagementInput,
} from '@/lib/liekan/contracts/robots-management';
import { type RobotsOverviewRange, robotsPublicUrl } from '@/lib/liekan/contracts/robots-overview';
import { crawlerDirectory } from '@/lib/liekan/crawlers/directory';
import { setRobotsAccess } from '@/lib/liekan/crawlers/robots';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { featureRequest } from '@/lib/liekan/upstream/features-client';
import { downloadFile } from '../data';
import { RobotsOverview } from './RobotsOverview';
import { Button, Definition, Notice, Select, Tabs } from './ui';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function RobotsManagementPanel({
  websiteId,
  initialView = 'manage',
  range,
}: {
  websiteId: string;
  initialView?: 'overview' | 'manage';
  range?: RobotsOverviewRange;
}) {
  const i18n = useLiekanI18n();
  const [view, setView] = useState(initialView);
  const [overviewVisited, setOverviewVisited] = useState(initialView === 'overview');
  const [data, setData] = useState<RobotsManagement | null>(null);
  const [draft, setDraft] = useState(''),
    [dirty, setDirty] = useState(false);
  const [draftRevision, setDraftRevision] = useState(1),
    [loadLatestConfirmed, setLoadLatestConfirmed] = useState(false);
  const dirtyRef = useRef(false),
    busyRef = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const [domain, setDomain] = useState<any>(null),
    [pairCode, setPairCode] = useState('');
  const [previewId, setPreviewId] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [botId, setBotId] = useState('gptbot'),
    [path, setPath] = useState('/');
  const [interval, setIntervalValue] = useState<15 | 60 | 360>(60);
  const base = `/liekan/websites/${websiteId}`;
  const sequence = useRef(0);
  const accept = (next: RobotsManagement) => {
    setData(next);
    if (!dirtyRef.current) {
      setDraft(next.draft);
      setDraftRevision(next.revision);
      setIntervalValue(next.interval);
    }
  };
  const failure = (cause: any) => {
    setError(cause.message || 'robots 操作失败，请重新读取');
    if ([401, 403, 404].includes(cause.status)) {
      ++sequence.current;
      setData(null);
      setDraft('');
      setDraftRevision(1);
      setPairCode('');
      setDomain(null);
      setPreviewId('');
      dirtyRef.current = false;
      setDirty(false);
    }
  };
  async function load() {
    const current = ++sequence.current;
    const next = await featureRequest<RobotsManagement>('GET', `${base}/robots`);
    if (current === sequence.current) accept(next);
  }
  useEffect(() => {
    let alive = true;
    dirtyRef.current = false;
    setDirty(false);
    setData(null);
    setDraft('');
    setDraftRevision(1);
    setLoadLatestConfirmed(false);
    setPairCode('');
    setPreviewId('');
    const current = ++sequence.current;
    Promise.all([
      featureRequest<RobotsManagement>('GET', `${base}/robots`),
      featureRequest('GET', `${base}/crawler-domain-verification`),
    ])
      .then(([next, verification]) => {
        if (alive && current === sequence.current) {
          accept(next);
          setDomain(verification);
        }
      })
      .catch(cause => {
        if (alive) failure(cause);
      });
    return () => {
      alive = false;
      ++sequence.current;
    };
  }, [websiteId]);
  useEffect(() => {
    setLoadLatestConfirmed(false);
  }, [data?.revision]);
  const following =
    Boolean(pairCode) ||
    data?.deployments.some(job => ['queued', 'leased', 'applied'].includes(job.state));
  useEffect(() => {
    if (!following) return;
    let alive = true;
    const until = Date.now() + 10 * 60000;
    const timer = window.setInterval(() => {
      if (!alive || busyRef.current || document.hidden || Date.now() > until) return;
      load().catch(cause => {
        if (alive) failure(cause);
      });
    }, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [following, websiteId]);
  function edit(value: string) {
    setDraft(value);
    dirtyRef.current = true;
    setDirty(true);
    setLoadLatestConfirmed(false);
    setPreviewId('');
    setConfirmed(false);
  }
  async function run(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    ++sequence.current;
    try {
      await work();
    } catch (cause) {
      failure(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function action(input: RobotsManagementInput) {
    const result = await featureRequest<any>('POST', `${base}/robots`, input);
    accept(result.data ?? result);
    return result;
  }
  async function preview(rollbackOf?: string) {
    const result = await action({ action: 'preview', ...(rollbackOf ? { rollbackOf } : {}) });
    setPreviewId(result.id);
    setConfirmed(false);
  }
  const previewJob = data?.deployments.find(job => job.id === previewId);
  const bots = crawlerDirectory.filter(bot => bot.robotsToken);
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString(i18n.locale) : i18n.text('尚未检查');
  const jobLabel = (job: RobotsDeployment) =>
    i18n.system(
      (
        {
          preview: '待确认发布',
          queued: '发布排队中',
          leased: '服务器执行中',
          applied: '已写入，验证中',
          verified: '发布验证通过',
          verification_failed: '公开地址验证失败',
          conflict: '文件或授权已变化',
          failed: '服务器执行失败',
          unknown: '执行结果待核对',
          cancelled: '发布已取消',
        } as Record<string, string>
      )[job.state] || job.state,
    );
  return (
    <form
      className="form"
      data-unsaved={dirty ? 'true' : undefined}
      aria-busy={busy}
      onSubmit={event => event.preventDefault()}
      style={{ minWidth: 0 }}
    >
      <p>
        {i18n.text('读取线上 robots.txt，编辑草稿并预览发布。服务器助手仅能修改本机授权的文件。')}
      </p>
      {error && <Notice tone="red">{i18n.system(error)}</Notice>}
      {status && <Notice>{i18n.system(status)}</Notice>}
      <div className="form-actions">
        <Button disabled={busy} onClick={() => run(load)}>
          {i18n.text('重新读取 robots 状态')}
        </Button>
      </div>
      {data && (
        <>
          <Tabs
            items={[
              ['overview', i18n.text('概览与建议')],
              ['manage', i18n.text('编辑与发布')],
            ]}
            active={view}
            onChange={next => {
              setView(next as 'overview' | 'manage');
              if (next === 'overview') setOverviewVisited(true);
            }}
          />
          {overviewVisited && (
            <div hidden={view !== 'overview'}>
              <RobotsOverview
                key={websiteId}
                websiteId={websiteId}
                data={data}
                range={range}
                onManage={() => setView('manage')}
                busy={busy}
                onRead={() =>
                  run(async () => {
                    await action({ action: 'read' });
                    setStatus('线上 robots.txt 已读取，草稿保持当前内容。');
                  })
                }
              />
            </div>
          )}
          <div className="form-stack" hidden={view !== 'manage'}>
            <Definition
              items={[
                [i18n.text('网站域名'), data.hostname],
                [
                  i18n.text('公开访问地址'),
                  <a
                    key="robots-public-url"
                    href={robotsPublicUrl(data.hostname)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ overflowWrap: 'anywhere' }}
                  >
                    {robotsPublicUrl(data.hostname)}
                  </a>,
                ],
                [i18n.text('最近公开检查'), date(data.checkedAt)],
                [i18n.text('上次检查域名'), data.observedHostname || ''],
                [
                  i18n.text('公开响应状态'),
                  data.observedStatus === null
                    ? i18n.text('尚未检查')
                    : String(data.observedStatus),
                ],
                [i18n.text('服务器授权文件'), data.agent.path || i18n.text('尚未授权')],
                [i18n.text('服务器最近同步'), date(data.agent.seenAt)],
              ]}
            />
            {data.lastError && (
              <Notice tone="amber">
                {i18n.text('线上检查失败，保留上次成功读取的内容。请核对域名验证及网络状态。')}
              </Notice>
            )}
            {data.agent.connected && !data.agent.contextValid && (
              <Notice tone="amber">
                {i18n.text('网站归属或域名已变化，请重新授权服务器助手。')}
              </Notice>
            )}
            {data.changePending && (
              <Notice tone="amber">
                <p>{i18n.text('监控发现 robots.txt 已变更，请查看历史快照。')}</p>
                <Button
                  disabled={busy || !data.permissions.canDraft}
                  onClick={() =>
                    run(async () => {
                      await action({ action: 'acknowledge' });
                    })
                  }
                >
                  {i18n.text('标记变更已读')}
                </Button>
              </Notice>
            )}
            <details>
              <summary>{i18n.text('域名验证与线上文件')}</summary>
              <Definition
                items={[
                  [i18n.text('TXT 记录名称'), domain?.name || ''],
                  [i18n.text('TXT 值'), domain?.value || i18n.text('创建挑战后显示')],
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
            </details>
            <div className="form-actions">
              <Button
                disabled={busy || !data.permissions.canDraft}
                onClick={() =>
                  run(async () => {
                    await action({ action: 'read' });
                    setStatus('线上 robots.txt 已读取，草稿保持当前内容。');
                  })
                }
              >
                {i18n.text('读取线上 robots.txt')}
              </Button>
              <Button
                disabled={busy || !data.permissions.canDraft || data.observedStatus !== 200}
                onClick={() => edit(data.observedContent ?? '')}
              >
                {i18n.text('将线上文件载入草稿')}
              </Button>
            </div>
            {data.observedStatus !== null && (
              <details>
                <summary>{i18n.text('查看线上文件内容')}</summary>
                <pre
                  className="code-block"
                  style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {data.observedContent ?? i18n.text('线上 robots.txt 不存在（404）')}
                </pre>
              </details>
            )}
            <label className="field">
              <span>{i18n.text('robots.txt 内容')}</span>
              <textarea
                value={draft}
                rows={14}
                spellCheck={false}
                disabled={busy || !data.permissions.canDraft}
                onChange={event => edit(event.target.value)}
                style={{
                  fontFamily: 'monospace',
                  width: '100%',
                  maxWidth: '100%',
                  boxSizing: 'border-box',
                }}
              />
            </label>
            {dirty && draftRevision !== data.revision && (
              <Notice tone="amber">
                <p>{i18n.text('已保存草稿已更新。当前编辑内容已保留，请核对最新草稿后合并。')}</p>
                <details>
                  <summary>{i18n.text('查看最新保存草稿')}</summary>
                  <pre
                    className="code-block"
                    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                  >
                    {data.draft}
                  </pre>
                </details>
                <label className="field">
                  <span>
                    <input
                      type="checkbox"
                      checked={loadLatestConfirmed}
                      onChange={event => setLoadLatestConfirmed(event.target.checked)}
                    />{' '}
                    {i18n.text('我已核对最新草稿，确认替换当前编辑内容。')}
                  </span>
                </label>
                <Button
                  disabled={busy || !loadLatestConfirmed || !data.permissions.canDraft}
                  onClick={() =>
                    run(async () => {
                      dirtyRef.current = false;
                      setDirty(false);
                      setLoadLatestConfirmed(false);
                      setPreviewId('');
                      setConfirmed(false);
                      accept(data);
                    })
                  }
                >
                  {i18n.text('将最新保存草稿载入编辑器')}
                </Button>
              </Notice>
            )}
            <div className="form-actions">
              <Button
                disabled={busy || !dirty || !data.permissions.canDraft}
                onClick={() =>
                  run(async () => {
                    let result: any;
                    try {
                      result = await featureRequest<any>('POST', `${base}/robots`, {
                        action: 'save',
                        content: draft,
                        revision: draftRevision,
                      });
                    } catch (cause) {
                      if ((cause as { status?: number }).status === 409) await load();
                      throw cause;
                    }
                    dirtyRef.current = false;
                    setDirty(false);
                    setPreviewId('');
                    accept(result.data);
                    setStatus('robots 草稿已保存，发布需要单独预览确认。');
                  })
                }
              >
                {i18n.text('保存 robots 草稿')}
              </Button>
              <Button onClick={() => downloadFile(draft, 'robots.txt', 'text/plain;charset=utf-8')}>
                {i18n.text('下载 robots.txt')}
              </Button>
            </div>
            <details open>
              <summary>{i18n.text('一键允许或屏蔽')}</summary>
              <Select
                label={i18n.text('蜘蛛')}
                value={botId}
                onChange={event => setBotId(event.target.value)}
                options={bots.map(bot => [bot.id, bot.name])}
              />
              <label className="field">
                <span>{i18n.text('目录路径，填写 / 表示全站')}</span>
                <input
                  value={path}
                  onChange={event => setPath(event.target.value)}
                  disabled={busy || !data.permissions.canDraft}
                />
              </label>
              <div className="form-actions">
                {(['allow', 'block'] as const).map(choice => (
                  <Button
                    key={choice}
                    disabled={busy || !data.permissions.canDraft}
                    onClick={() =>
                      run(async () => {
                        const output = setRobotsAccess(draft, {
                          botIds: [botId as any],
                          paths: [{ value: path, match: 'prefix' }],
                          action: choice,
                        });
                        if (output.safe && output.content !== null) {
                          edit(output.content);
                          setStatus('规则已加入草稿，请保存并预览发布。');
                        } else {
                          setError('已有规则存在冲突，请在编辑器中核对合并。');
                          setStatus('请检查通配规则、扩展指令、内容大小及语法。');
                        }
                      })
                    }
                  >
                    {i18n.text(choice === 'allow' ? '添加允许规则' : '添加屏蔽规则')}
                  </Button>
                ))}
              </div>
              <p className="muted">
                {i18n.text('规则遵守取决于蜘蛛。需要强制拦截时，可使用现有 Cloudflare 访问策略。')}
              </p>
            </details>
            <details open>
              <summary>{i18n.text('定时监控')}</summary>
              <Select
                label={i18n.text('检查间隔')}
                value={String(interval)}
                onChange={event => setIntervalValue(Number(event.target.value) as 15 | 60 | 360)}
                options={[
                  ['15', i18n.text('每 15 分钟')],
                  ['60', i18n.text('每小时')],
                  ['360', i18n.text('每 6 小时')],
                ]}
              />
              <p>{i18n.text(data.monitor ? '定时监控已启用' : '定时监控已关闭')}</p>
              <div className="form-actions">
                <Button
                  disabled={busy || !data.permissions.canControl}
                  onClick={() =>
                    run(async () => {
                      await action({ action: 'monitor', enabled: true, interval });
                    })
                  }
                >
                  {i18n.text('启用或更新监控')}
                </Button>
                <Button
                  disabled={busy || !data.permissions.canControl || !data.monitor}
                  onClick={() =>
                    run(async () => {
                      await action({ action: 'monitor', enabled: false, interval });
                    })
                  }
                >
                  {i18n.text('关闭监控')}
                </Button>
              </div>
            </details>
            <details>
              <summary>{i18n.text('服务器授权与安装')}</summary>
              <p>
                {i18n.text(
                  '服务器需要 Node.js 22。请下载助手，指定实际 robots.txt 路径及私有状态目录，并使用有该目录写权限的账户运行。',
                )}
              </p>
              <a href={`${process.env.basePath || ''}/liekan-robots-agent.mjs`} download>
                {i18n.text('下载 robots 服务器助手')}
              </a>
              <div className="form-actions">
                <Button
                  disabled={busy || !data.permissions.canControl}
                  onClick={() =>
                    run(async () => {
                      const result = await action({ action: 'pair' });
                      setPairCode(result.code);
                    })
                  }
                >
                  {i18n.text('生成十分钟服务器授权码')}
                </Button>
                <Button
                  disabled={busy || !data.permissions.canControl || !data.agent.connected}
                  onClick={() =>
                    run(async () => {
                      await action({ action: 'revoke' });
                      setPairCode('');
                      setStatus('服务器授权已撤销。已发出的任务仍需核对执行结果。');
                    })
                  }
                >
                  {i18n.text('撤销服务器授权')}
                </Button>
              </div>
              {pairCode && (
                <pre
                  className="code-block"
                  style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >{`node liekan-robots-agent.mjs pair --url ${shellQuote(robotsAgentUrl(window.location.origin))} --code ${shellQuote(pairCode)} --hostname ${shellQuote(data.hostname)} --file /var/www/site/robots.txt --state /private/robots-state\nnode liekan-robots-agent.mjs run --state /private/robots-state`}</pre>
              )}
              <p className="muted">
                {i18n.text(
                  '授权码仅本次显示。网站转移或域名变化后须重新授权；助手保持运行才能发布。',
                )}
              </p>
            </details>
            <div className="form-actions">
              <Button
                disabled={
                  busy ||
                  dirty ||
                  !data.permissions.canControl ||
                  !data.agent.connected ||
                  !data.agent.contextValid
                }
                onClick={() => run(() => preview())}
              >
                {i18n.text('预览发布 robots.txt')}
              </Button>
            </div>
            {previewJob?.state === 'preview' && (
              <section>
                <h3>{i18n.text('核对发布前后内容')}</h3>
                <p>
                  {i18n.text('发布目标：{v0}', [data.hostname])} · {data.agent.path}
                </p>
                <p>{i18n.text('预览有效期至：{v0}', [date(previewJob.expires_at)])}</p>
                <label className="field">
                  <span>{i18n.text('发布前服务器文件')}</span>
                  <textarea
                    readOnly
                    rows={6}
                    value={previewJob.before_content ?? ''}
                    placeholder={i18n.text('文件不存在，发布会创建文件')}
                  />
                </label>
                <label className="field">
                  <span>{i18n.text('发布后服务器文件')}</span>
                  <textarea
                    readOnly
                    rows={6}
                    value={previewJob.content ?? ''}
                    placeholder={i18n.text('回滚会删除原先不存在的文件')}
                  />
                </label>
                <label className="field">
                  <span>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={event => setConfirmed(event.target.checked)}
                    />{' '}
                    {i18n.text('我已核对目标服务器、文件及访问规则，确认执行本次发布。')}
                  </span>
                </label>
                <Button
                  disabled={busy || dirty || !confirmed || !data.permissions.canControl}
                  onClick={() =>
                    run(async () => {
                      await action({ action: 'confirm', id: previewJob.id });
                      setPreviewId('');
                      setConfirmed(false);
                      setStatus('发布已提交，等待服务器执行及公开地址验证。');
                    })
                  }
                >
                  {i18n.text('确认发布到服务器')}
                </Button>
              </section>
            )}
            <details open>
              <summary>{i18n.text('发布记录与回滚')}</summary>
              {!data.deployments.length && <p>{i18n.text('暂无发布记录')}</p>}
              {data.deployments.map(job => (
                <div
                  key={job.id}
                  style={{
                    borderBottom: '1px solid var(--border-color, #e5e7eb)',
                    padding: '12px 0',
                    minWidth: 0,
                  }}
                >
                  <p>
                    {date(job.created_at)} · {jobLabel(job)}
                    {job.rollback_of ? ` · ${i18n.text('回滚')}` : ''}
                  </p>
                  {job.error_code && (
                    <p className="muted">
                      {i18n.text('请核对服务器状态、域名验证及公开地址缓存。')}
                    </p>
                  )}
                  <div className="form-actions">
                    {['applied', 'verified', 'verification_failed'].includes(job.state) && (
                      <Button
                        disabled={busy || dirty || !data.permissions.canControl}
                        onClick={() => run(() => preview(job.id))}
                      >
                        {i18n.text('预览回滚此发布')}
                      </Button>
                    )}
                    {job.state === 'verification_failed' && (
                      <Button
                        disabled={busy || !data.permissions.canControl}
                        onClick={() =>
                          run(async () => {
                            await action({ action: 'verify', id: job.id });
                          })
                        }
                      >
                        {i18n.text('重新验证公开地址')}
                      </Button>
                    )}
                    {job.state === 'unknown' && (
                      <Button
                        disabled={busy || !data.permissions.canControl}
                        onClick={() =>
                          run(async () => {
                            await action({ action: 'reconcile', id: job.id });
                          })
                        }
                      >
                        {i18n.text('核对未知发布结果')}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </details>
            <details>
              <summary>{i18n.text('线上变更快照')}</summary>
              {data.snapshots.map(snapshot => (
                <details key={snapshot.id}>
                  <summary>
                    {date(snapshot.created_at)} · {snapshot.hostname} · HTTP {snapshot.status}
                  </summary>
                  <pre
                    className="code-block"
                    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                  >
                    {snapshot.content ?? i18n.text('线上 robots.txt 不存在（404）')}
                  </pre>
                </details>
              ))}
            </details>
          </div>
        </>
      )}
    </form>
  );
}
