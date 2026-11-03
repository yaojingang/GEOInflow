'use client';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';

import { useTaskPolling } from '@/lib/liekan/contracts/manual-refresh';
import { useEffect, useRef, useState } from 'react';
import {
  logPublicOrigin,
  type InstallationStatus,
  type LogCapability,
  type LogSetupCheckId,
} from '@/lib/liekan/contracts/installation';
import { useFeature } from './context';
import { Badge, Button, Code, Field, Form, LiekanDialog, Notice } from './ui';
import styles from '@/styles/liekan/Installation.module.css';

const setupLabels: Record<LogSetupCheckId, string> = {
  'public-url': '公网 HTTPS 地址',
  queue: '日志队列',
  worker: '日志处理服务',
  'agent-package': '采集器部署包',
  'cloudflare-oauth': 'Cloudflare 授权应用',
  'credentials-key': '凭据加密密钥',
};
function ReceiverSetupGuide({
  method,
  capability,
  available,
  refresh,
}: {
  method: 'server' | 'cloudflare';
  capability?: LogCapability;
  available: boolean;
  refresh: () => Promise<unknown>;
}) {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const [draft, setDraft] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const value = draft ?? capability?.publicUrl ?? '';
  const origin = logPublicOrigin(value.trim());
  const checks = capability?.checks ?? [];
  const missing = (id: LogSetupCheckId) =>
    checks.find(check => check.id === id)?.state === 'missing';
  const credentialConfig = [
    ...(missing('cloudflare-oauth')
      ? ['CLOUDFLARE_OAUTH_CLIENT_ID=填写应用ID', 'CLOUDFLARE_OAUTH_CLIENT_SECRET=填写应用密钥']
      : []),
    ...(missing('credentials-key')
      ? ['LIEKAN_LOG_CREDENTIALS_KEY=填写32字节随机密钥的Base64']
      : []),
  ].join('\n');
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    if (active.current) c.notify('配置说明已复制');
  };
  return (
    <section className={styles.setupGuide} aria-label={i18n.text('接收服务配置引导')}>
      <div>
        <h3>{i18n.text('配置日志接收服务')}</h3>
        <p className="muted">
          {i18n.text(
            '由部署管理员配置一次，供本实例的所有网站使用。填写地址后，按下方步骤应用到部署环境。',
          )}
        </p>
        {!c.user?.isAdmin && (
          <Notice tone="amber">
            {i18n.text(
              '请将配置说明交给部署管理员。你可以在这里查看要求，并在配置完成后重新检查。',
            )}
          </Notice>
        )}
        {!checks.length && (
          <Notice tone="amber">
            {i18n.text(
              '当前服务尚未返回逐项检查结果。请重新检查，并由部署管理员确认已有配置后再修改。',
            )}
          </Notice>
        )}
      </div>
      <div className="stack">
        <strong>{i18n.text('1. 准备统计服务的公网地址')}</strong>
        <Field
          label={i18n.text('统计服务公网地址')}
          aria-label={i18n.text('统计服务公网地址')}
          type="url"
          placeholder="https://stats.example.com"
          maxLength={255}
          value={value}
          onChange={event => {
            setDraft(event.target.value);
            setChecked(false);
          }}
          help={i18n.text(
            '填写GEOInflow的访问域名。域名需指向统计服务，配置有效的 HTTPS 证书，并允许外部访问日志接收接口。',
          )}
          error={
            value && !origin
              ? i18n.text('请输入 HTTPS 根地址，使用公网域名，去掉路径、参数和账号信息。')
              : undefined
          }
        />
        {origin && <Code>{`LIEKAN_PUBLIC_URL=${origin}`}</Code>}
        <div className="row">
          <Button disabled={!origin} onClick={() => copy(`LIEKAN_PUBLIC_URL=${origin}`)}>
            {i18n.text('复制地址配置')}
          </Button>
        </div>
        <p className="field-help">
          {i18n.text(
            'Docker 部署：更新GEOInflow 部署目录的 .env 中对应项。其他部署：在托管平台的环境变量中更新。页面填写用于生成配置说明。',
          )}
        </p>
        {capability?.publicUrl && (
          <p className="field-help">
            {i18n.fragment('当前运行地址：', false, true)}
            {capability.publicUrl}
          </p>
        )}
      </div>
      {method === 'cloudflare' && (
        <div className="stack">
          <strong>{i18n.text('2. 配置 Cloudflare 授权应用')}</strong>
          <p>
            {i18n.text(
              '在 Cloudflare 账户的 Manage Account → OAuth clients 创建服务器端应用，使用 Authorization Code 流程和 client_secret_basic，配置读取 Zone 与管理 Logpush 所需权限。',
            )}
          </p>
          <a
            href="https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/"
            target="_blank"
            rel="noreferrer"
          >
            {i18n.text('查看 Cloudflare 官方配置指南 ↗')}
          </a>
          <span className="field-help">{i18n.text('将以下地址登记为应用的回调地址：')}</span>
          {origin ? (
            <>
              <Code>{`${origin}/api/liekan/oauth/cloudflare/callback`}</Code>
              <div className="row">
                <Button onClick={() => copy(`${origin}/api/liekan/oauth/cloudflare/callback`)}>
                  {i18n.text('复制回调地址')}
                </Button>
              </div>
            </>
          ) : (
            <p className="muted">{i18n.text('填写有效的公网地址后显示回调地址。')}</p>
          )}
          {(missing('cloudflare-oauth') || missing('credentials-key')) && (
            <>
              <p className="field-help">
                {i18n.text(
                  '在部署环境补齐下列待配置项，用真实值替换占位文字；应用密钥和加密密钥由部署管理员保管。',
                )}
              </p>
              <Code>{credentialConfig}</Code>
              <div className="row">
                <Button onClick={() => copy(credentialConfig)}>{i18n.text('复制待配置项')}</Button>
              </div>
              {missing('credentials-key') && (
                <details>
                  <summary>{i18n.text('如何生成凭据加密密钥')}</summary>
                  <p className="field-help">
                    {i18n.text(
                      '在部署服务器运行下方命令，将结果填入对应环境变量；已有密钥请保留，轮换需按部署文档执行。',
                    )}
                  </p>
                  <Code>{`node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"`}</Code>
                </details>
              )}
            </>
          )}
        </div>
      )}
      <div className="stack">
        <strong>
          {method === 'cloudflare' ? '3' : '2'}
          {i18n.fragment('. 应用配置并重新检查', true, false)}
        </strong>
        <p>
          {i18n.text(
            '应用与日志处理服务需使用同一份配置。Docker 部署在GEOInflow 部署目录执行下方命令；其他部署请更新并重启这两个进程。',
          )}
        </p>
        <p className="field-help">
          {i18n.text('配置完成后，通过该公网域名打开 GEOInflow，再继续授权或安装。')}
        </p>
        <Code>docker compose -f docker-compose.liekan.yml up -d --no-deps app log-worker</Code>
        {missing('queue') && (
          <details>
            <summary>{i18n.text('日志队列待初始化或无法读取')}</summary>
            <p className="field-help">
              {i18n.text('确认数据库可连接、增量迁移已完成，再由部署管理员初始化队列。')}
            </p>
            <Code>
              {
                'docker compose -f docker-compose.liekan.yml exec app node scripts/liekan-queue-bootstrap.mjs'
              }
            </Code>
          </details>
        )}
        {method === 'server' && missing('agent-package') && (
          <details>
            <summary>{i18n.text('准备采集器部署包')}</summary>
            <p className="field-help">
              {i18n.text(
                '在受控构建环境设置 LIEKAN_AGENT_SIGNING_KEY_FILE，执行下方命令，再重新构建并部署包含 public/liekan-agent 的应用镜像。',
              )}
            </p>
            <Code>pnpm liekan:build-agent</Code>
          </details>
        )}
        <div className={styles.setupChecks} aria-label={i18n.text('当前运行配置')}>
          {checks.map(check => (
            <div key={check.id}>
              <span>{i18n.system(setupLabels[check.id])}</span>
              <Badge tone={check.state === 'ready' ? 'green' : 'gray'}>
                {check.state === 'ready'
                  ? i18n.text('已就绪')
                  : check.state === 'unverified'
                    ? i18n.text('未能读取')
                    : i18n.text('待配置')}
              </Badge>
            </div>
          ))}
        </div>
        <p className="field-help">
          {i18n.text(
            '检查核对运行中的配置、服务心跳和安装资产。公网连通性与真实日志到达可在连接后继续检查。',
          )}
        </p>
        <div className="row">
          <Button
            primary
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              setError('');
              setChecked(false);
              try {
                const result: any = await refresh();
                if (result?.error) throw result.error;
                if (active.current) setChecked(true);
              } catch (e) {
                if (active.current)
                  setError(e instanceof Error ? e.message : '配置读取失败，请重试。');
              } finally {
                if (active.current) setChecking(false);
              }
            }}
          >
            {checking ? i18n.text('正在检查配置…') : i18n.text('重新检查配置')}
          </Button>
        </div>
        <div aria-live="polite">
          {checked && (
            <p className="field-help">
              {available
                ? i18n.text('接收服务已就绪，可以继续生成授权链接或安装命令。')
                : i18n.text('已重新读取运行配置，请继续完成上方待配置项。')}
            </p>
          )}
        </div>
        {error && <Notice tone="red">{i18n.system(error)}</Notice>}
      </div>
    </section>
  );
}

export function AutomaticLogSetup({
  websiteId,
  method,
  status,
  manage,
  refresh,
}: {
  websiteId: string;
  method: 'server' | 'cloudflare';
  status: InstallationStatus;
  manage: boolean;
  refresh: () => Promise<unknown>;
}) {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const runtimes = status.availability?.server?.runtimes;
  const [runtimeChoice, setRuntimeChoice] = useState<'docker' | 'systemd' | null>(null);
  const runtime = runtimeChoice ?? (runtimes?.docker === false ? 'systemd' : 'docker');
  const runtimeAvailable = !runtimes || runtimes[runtime];
  const [command, setCommand] = useState<{
    command: string;
    expiresAt: string;
    runtime?: 'docker' | 'systemd';
    pairingCode?: string;
  } | null>(null);
  const [deploymentCommand, setDeploymentCommand] = useState('');
  const scope = useRef('');
  scope.current = `${websiteId}:${method}:${runtime}`;
  useEffect(() => {
    setCommand(null);
    setDeploymentCommand('');
  }, [websiteId, method, runtime]);
  const [authorization, setAuthorization] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [zones, setZones] = useState<{
    domain: string;
    zones: { id: string; name: string }[];
  } | null>(null);
  const [zone, setZone] = useState(''),
    [costs, setCosts] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const available = !!status.capabilities[method];
  const reason = status.availability?.[method]?.reason || '当前实例尚未配置此接入服务。';
  const [sourceStatus, setSourceStatus] = useState<InstallationStatus['sources']>(null);
  useEffect(() => setSourceStatus(null), [status.sources, websiteId, method]);
  const sources = (sourceStatus || status.sources || []).filter(source => source.kind === method);
  const [disconnect, setDisconnect] = useState<{ id: string; domain: string } | null>(null);
  useEffect(() => setDisconnect(null), [websiteId, method]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : '操作失败，请重试。');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const follow = useTaskPolling(
    `${websiteId}:${method}`,
    sources.some(source => source.state === 'configuring'),
    async signal => {
      const result = await c.api.get<{ sources: InstallationStatus['sources'] }>(
        `/liekan/websites/${websiteId}/log-sources`,
        {},
        signal,
      );
      if (!signal.aborted && alive.current) setSourceStatus(result.sources);
    },
    5000,
  );
  const flowId = c.query.flow;
  useEffect(() => {
    if (method !== 'cloudflare' || !flowId || !manage) return;
    let cancelled = false;
    setBusy(true);
    c.api
      .post(`/liekan/websites/${websiteId}/log-sources/cloudflare/finalize`, { flowId })
      .then((data: any) => {
        if (cancelled) return;
        if (data.sourceId) {
          void refresh();
          return;
        }
        setZones(data);
        setZone(data.zones?.[0]?.id || '');
      })
      .catch(error => {
        if (!cancelled) setError(error.message || '授权确认读取失败。');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [flowId, websiteId, method, manage]);
  return (
    <>
      {follow.expired && (
        <Button onClick={() => follow.resume()}>{i18n.text('回查接入结果')}</Button>
      )}
      <p className="muted">
        {available ? i18n.text('按下方引导完成连接，检查可稍后进行。') : i18n.system(reason)}
      </p>
      {!available && (
        <p className="field-help">
          {i18n.text(
            '先完成实例配置，再为当前网站连接日志来源。下方引导可直接查看待配置项和操作步骤。',
          )}
        </p>
      )}
      {method === 'server' && available && (
        <div className="stack">
          <label>
            {i18n.fragment('服务器安装方式', false, true)}
            <select
              aria-label={i18n.text('服务器安装方式')}
              value={runtime}
              onChange={event => setRuntimeChoice(event.target.value as 'docker' | 'systemd')}
            >
              <option value="docker" disabled={runtimes?.docker === false}>
                {i18n.text('Docker / 宝塔（推荐）')}
              </option>
              <option value="systemd" disabled={runtimes?.systemd === false}>
                {i18n.text('直接安装到系统')}
              </option>
            </select>
          </label>
          <p className="field-help">
            {runtime === 'docker'
              ? i18n.text(
                  '在目标网站服务器运行一个采集容器。需要可用的 Docker 和 Compose V2；安装会检查日志读取权限、格式及 HTTPS 连接。',
                )
              : i18n.text(
                  '支持 Ubuntu 22.04/24.04、Debian 12 和 systemd，读取 Nginx / Apache Combined 访问日志。',
                )}
          </p>
        </div>
      )}
      <div className="form-actions">
        {!available ? (
          <Button primary aria-expanded={setupOpen} onClick={() => setSetupOpen(!setupOpen)}>
            {setupOpen
              ? i18n.text('收起配置引导')
              : c.user?.isAdmin
                ? i18n.text('开始配置')
                : i18n.text('查看配置说明')}
          </Button>
        ) : (
          <>
            <Button
              primary
              disabled={!available || !manage || busy || (method === 'server' && !runtimeAvailable)}
              onClick={() =>
                run(async () => {
                  const requestedScope = scope.current;
                  const data: any = await c.api.post(
                    `/liekan/websites/${websiteId}/log-sources/${method === 'server' ? 'server/pairing' : 'cloudflare/start'}`,
                    method === 'server' ? { runtime } : {},
                  );
                  if (!alive.current || scope.current !== requestedScope) return;
                  if (method === 'server') setCommand(data);
                  else setAuthorization(data.authorizationUrl);
                })
              }
            >
              {busy
                ? i18n.text('正在处理…')
                : method === 'server'
                  ? i18n.text('生成一次安装命令')
                  : i18n.text('生成授权链接')}
            </Button>
            {method === 'server' && runtime === 'docker' && (
              <Button
                disabled={!manage || busy || !runtimeAvailable}
                onClick={() =>
                  run(async () => {
                    const requestedScope = scope.current;
                    const data = await c.api.get<{
                      archive: string;
                      fileName: string;
                      command: string;
                    }>(`/liekan/websites/${websiteId}/log-sources/server/deployment`, {});
                    if (!alive.current || scope.current !== requestedScope) return;
                    const bytes = Uint8Array.from(atob(data.archive), character =>
                      character.charCodeAt(0),
                    );
                    const address = URL.createObjectURL(
                      new Blob([bytes], { type: 'application/zip' }),
                    );
                    const anchor = document.createElement('a');
                    anchor.href = address;
                    anchor.download = data.fileName;
                    anchor.click();
                    setTimeout(() => URL.revokeObjectURL(address), 1000);
                    setDeploymentCommand(data.command);
                    c.notify('部署包已下载，包内说明包含宝塔安装步骤');
                  })
                }
              >
                {i18n.text('下载 Docker 部署包')}
              </Button>
            )}
            <Button aria-expanded={setupOpen} onClick={() => setSetupOpen(!setupOpen)}>
              {setupOpen ? i18n.text('收起配置引导') : i18n.text('查看接收服务配置')}
            </Button>
          </>
        )}
      </div>
      {setupOpen && (
        <ReceiverSetupGuide
          method={method}
          capability={status.availability?.[method]}
          available={available}
          refresh={refresh}
        />
      )}
      {command && (
        <div className="stack">
          <p>
            {runtime === 'docker'
              ? i18n.text(
                  '在宝塔终端或网站服务器执行。按提示填写该网站的访问日志路径，检查通过后自动配对并启动容器。',
                )
              : i18n.text('在网站服务器执行。安装会询问当前网站的日志路径，并在本机校验读取权限。')}
          </p>
          <Code>{command.command}</Code>
          <p className="field-help">
            {i18n.fragment('命令仅可配对一次，失效时间：', false, true)}
            {new Date(command.expiresAt).toLocaleTimeString(i18n.locale)}。
            {runtime === 'docker'
              ? i18n.text('Linux x64 / arm64，Docker Compose V2，Nginx / Apache Combined 日志。')
              : i18n.text('支持 Ubuntu 22.04/24.04、Debian 12，Nginx / Apache Combined 日志。')}
          </p>
          <Button
            onClick={async () => {
              await navigator.clipboard.writeText(command.command);
              c.notify('安装命令已复制');
            }}
          >
            {i18n.text('复制安装命令')}
          </Button>
          {runtime === 'docker' && command.pairingCode && (
            <div className="stack">
              <span className="field-help">
                {i18n.text('通过部署包安装时，环境检查完成后输入此一次性配对码：')}
              </span>
              <Code>{command.pairingCode}</Code>
              <Button
                onClick={async () => {
                  await navigator.clipboard.writeText(command.pairingCode!);
                  c.notify('配对码已复制');
                }}
              >
                {i18n.text('复制配对码')}
              </Button>
            </div>
          )}
        </div>
      )}
      {method === 'server' && runtime === 'docker' && (
        <div className="stack">
          <p className="field-help">
            {i18n.text(
              '宝塔访问日志通常位于 /www/wwwlogs/，请在当前网站的日志设置中确认。部署包上传并解压到公开访问目录之外，在宝塔终端执行包内 start.sh；文件上传后还需要启动采集容器。',
            )}
          </p>
          <p className="field-help">
            {i18n.text(
              '先准备运行环境，再生成配对码。配对码过期时可重新生成；重复安装保留已有配对、缓存和采集进度。首次采集从启动后的新增日志开始，历史日志可手动导入。',
            )}
          </p>
          {deploymentCommand && (
            <>
              <ol className="field-help">
                <li>{i18n.text('上传并解压到非公开目录，例如 /opt/liekan-agent-package。')}</li>
                <li>{i18n.text('在宝塔管理员终端进入解压目录，执行下方启动命令。')}</li>
                <li>
                  {i18n.text('环境检查通过后，点击“生成一次安装命令”，复制配对码并输入终端。')}
                </li>
              </ol>
              <Code>sh start.sh</Code>
              <details>
                <summary>{i18n.text('通过命令准备运行环境（可选）')}</summary>
                <Code>{deploymentCommand}</Code>
                <Button
                  onClick={async () => {
                    await navigator.clipboard.writeText(deploymentCommand);
                    c.notify('准备命令已复制');
                  }}
                >
                  {i18n.text('复制准备命令')}
                </Button>
              </details>
            </>
          )}
        </div>
      )}
      {authorization && (
        <div className="stack">
          <p>{i18n.text('前往 Cloudflare 选择账户并授权，返回后确认网站域名。')}</p>
          <Button primary onClick={() => window.location.assign(authorization)}>
            {i18n.text('前往 Cloudflare 授权')}
          </Button>
        </div>
      )}
      {zones && (
        <div className="stack">
          <label>
            {i18n.fragment('匹配网站域名：', false, true)}
            {zones.domain}
            <select
              aria-label={i18n.text('Cloudflare 域名')}
              value={zone}
              onChange={event => setZone(event.target.value)}
            >
              {zones.zones.map(row => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={costs}
              onChange={event => setCosts(event.target.checked)}
            />
            {i18n.fragment(
              '我已了解：Logpush 需要账户支持，供应商可能收费；连接成功后将成为主要日志来源。',
              true,
              false,
            )}
          </label>
          <Button
            primary
            disabled={busy || !costs || !zone}
            onClick={() =>
              run(async () => {
                await c.api.post(`/liekan/websites/${websiteId}/log-sources/cloudflare/finalize`, {
                  flowId,
                  zoneId: zone,
                  acceptCosts: true,
                });
                if (!alive.current) return;
                setZones(null);
                await refresh();
                c.notify('连接已保存，正在配置日志推送');
              })
            }
          >
            {i18n.text('确认并连接')}
          </Button>
        </div>
      )}
      {sources.map(source => (
        <div className={styles.entryRow} key={source.id}>
          <div>
            <strong>{source.domain}</strong>{' '}
            <Badge tone={source.primary ? 'blue' : 'gray'}>
              {source.primary
                ? i18n.text('主要来源')
                : {
                    configuring: i18n.text('配置中'),
                    paused: i18n.text('已暂停'),
                    error: i18n.text('需要处理'),
                    active: i18n.text('已连接'),
                    disconnected: i18n.text('正在断开'),
                  }[source.state] || source.state}
            </Badge>
            <p className="muted">
              {method === 'server' ? i18n.text('采集服务：') : i18n.text('连接：')}
              {source.lastHeartbeatAt
                ? Date.now() - new Date(source.lastHeartbeatAt).getTime() > 180000
                  ? i18n.text('连接状态已过期')
                  : i18n.text('已连接')
                : i18n.text('等待连接')}{' '}
              {i18n.fragment('· 真实日志：', true, true)}
              {source.lastReceivedAt ? i18n.text('已接收') : i18n.text('等待接收')}
              {i18n.fragment(' · 处理：', true, true)}
              {source.lastProcessedAt ? i18n.text('已处理') : i18n.text('等待处理')}
              {i18n.fragment(' · 积压 ', true, true)}
              {source.backlog}
              {i18n.fragment(' 批', true, false)}
            </p>
            {method === 'server' &&
              source.health?.errorCode &&
              source.health.errorCode !== 'none' && (
                <p role="alert">
                  {{
                    unreadable: i18n.text('访问日志无法读取，请检查文件及轮转目录权限。'),
                    'format-error': i18n.text('存在无法识别的日志行，请检查 Combined 日志格式。'),
                    'buffer-full': i18n.text('本地缓存已满，请检查连接并等待积压处理。'),
                    'rotation-gap': i18n.text('日志轮转出现缺口，请检查日志保留时间与读取权限。'),
                    offline: i18n.text('采集器曾报告连接异常，请检查容器网络与统计服务地址。'),
                  }[String(source.health.errorCode)] ||
                    i18n.text('采集器需要检查，请查看目标服务器的容器日志。')}
                </p>
              )}
            {method === 'server' && (
              <p className="field-help">
                {i18n.fragment('本站 AI 蜘蛛匹配：', false, true)}
                {status.logs?.total
                  ? status.logs.ai
                    ? i18n.text('{v0} 次', [status.logs.ai.toLocaleString()])
                    : i18n.text('日志已收到，暂未匹配到 AI 蜘蛛请求。')
                  : source.lastReceivedAt
                    ? i18n.text('日志已接收，等待处理后的匹配结果。')
                    : i18n.text('等待真实访问日志。')}
              </p>
            )}
            {!!source.failed && (
              <p role="alert">
                {i18n.fragment('有 ', false, true)}
                {source.failed}{' '}
                {i18n.fragment(
                  '批日志处理失败，请核对事件格式或来源配置。已接收的其他批次会继续处理。',
                  true,
                  false,
                )}
              </p>
            )}
            {source.cleanupPending && (
              <p role="alert">
                {i18n.text(
                  '正在停用远端日志任务。若供应商授权已失效，请到 Cloudflare 核对停用结果。',
                )}
              </p>
            )}
            {source.errorCode && (
              <p role="alert">
                {source.errorCode === 'confirmation-required'
                  ? i18n.text('主要来源已变更；确认后可将此连接设为主要来源。')
                  : source.errorCode === 'reauthorization-required'
                    ? i18n.text('授权或网站配置已变更，请重新连接。')
                    : source.errorCode === 'provider-not-entitled'
                      ? i18n.text(
                          '当前 Cloudflare 账户尚未启用所需的 Logpush 能力，请核对启用与计费，或改用服务器采集。',
                        )
                      : source.errorCode === 'provider-permission-denied'
                        ? i18n.text(
                            'Cloudflare 授权缺少日志管理权限，请核对 Zone Logs 权限后重新连接。',
                          )
                        : i18n.text('日志推送暂时异常，请检查服务与权限。')}
              </p>
            )}
            {source.health?.gap === true && (
              <p role="alert">
                {i18n.text('采集器报告了日志轮转或重置缺口，请核对日志保留情况。')}
              </p>
            )}
            {source.health?.errorCode === 'buffer-full' && (
              <p role="alert">
                {i18n.text('本机缓冲已满或超过保留时间，读取已暂停；恢复连接后会继续发送。')}
              </p>
            )}
          </div>
          {manage && (
            <div className="row">
              <Button
                disabled={
                  busy ||
                  source.state === 'configuring' ||
                  source.state === 'disconnected' ||
                  source.cleanupPending
                }
                onClick={() =>
                  run(async () => {
                    await c.api.put(`/liekan/websites/${websiteId}/log-sources/${source.id}`, {
                      action: source.primary ? 'pause' : 'select',
                    });
                    await refresh();
                  })
                }
              >
                {source.primary ? i18n.text('暂停') : i18n.text('设为主要来源')}
              </Button>
              <Button
                disabled={busy}
                onClick={() => setDisconnect({ id: source.id, domain: source.domain })}
              >
                {i18n.text('断开连接')}
              </Button>
            </div>
          )}
        </div>
      ))}
      {disconnect && (
        <LiekanDialog
          title={i18n.text('断开日志连接')}
          subtitle={i18n.system(disconnect.domain)}
          protectUnsaved={false}
          onClose={() => !busy && setDisconnect(null)}
        >
          <Form
            busy={busy}
            danger
            trackUnsaved={false}
            submitLabel={i18n.text('断开连接')}
            cancel={
              <Button disabled={busy} onClick={() => setDisconnect(null)}>
                {i18n.text('保留连接')}
              </Button>
            }
            onSubmit={async () => {
              if (!manage || !sources.some(source => source.id === disconnect.id))
                throw new Error('连接或权限已变更，请重新读取后再操作。');
              setBusy(true);
              try {
                await c.api.del(`/liekan/websites/${websiteId}/log-sources/${disconnect.id}`);
                await refresh();
                if (alive.current) {
                  setDisconnect(null);
                  c.notify('日志连接已断开');
                }
              } finally {
                if (alive.current) setBusy(false);
              }
            }}
          >
            <Notice tone="amber">
              {i18n.fragment('断开「', false, true)}
              {disconnect.domain}
              {i18n.fragment('」的', true, true)}
              {method === 'server' ? i18n.text('服务器采集') : 'Cloudflare'}
              {i18n.fragment('日志连接后，该来源将停止接收新日志。历史数据继续保留。', true, false)}
            </Notice>
            {method === 'server' && (
              <p className="muted">{i18n.text('服务器采集服务可由管理员在对应服务器卸载。')}</p>
            )}
          </Form>
        </LiekanDialog>
      )}
      {error && <Notice tone="red">{i18n.system(error)}</Notice>}
      {sources.length > 0 && (
        <p className="field-help">
          {i18n.text(
            '每个网站使用一个主要自动来源；选择新来源会暂停之前的来源。同一时间的源站、CDN 与手动导入数据按生效区间统计。',
          )}
        </p>
      )}
    </>
  );
}
