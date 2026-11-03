'use client';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';

import Link from '@/components/liekan/Link';
import { useEffect, useRef, useState } from 'react';
import type { FeatureEntity } from '@/lib/liekan/contracts/features';
import {
  type InstallationAction,
  type InstallationIdentityObservation,
  type InstallationStatus,
  type InstallationStep,
  installationParams,
  installationStep,
  type LogMethod,
  logMethodLabels,
  logMethodSchema,
} from '@/lib/liekan/contracts/installation';
import styles from '@/styles/liekan/Installation.module.css';
import { ManagementDrawer } from '../ManagementDrawer';
import { useAction, useData, useFeature } from './context';
import { CrawlerDisplaySettings } from './CrawlerDisplaySettings';
import { AutomaticLogSetup } from './AutomaticLogSetup';
import { TrackingCode } from './TrackingCode';
import {
  Badge,
  Body,
  Button,
  Code,
  Definition,
  Icon,
  LinkButton,
  Notice,
  Panel,
  QueryState,
} from './ui';

function useInstallation(websiteId: string) {
  const c = useFeature();
  return useData<InstallationStatus>(
    ['website-installation', websiteId],
    signal => c.api.get(`/liekan/websites/${websiteId}/installation`, undefined, signal),
    !!websiteId,
  );
}
const dateLabel = (value: string | null, timezone: string) =>
  value ? new Date(value).toLocaleString('zh-CN', { timeZone: timezone }) : '尚未接收';
const demoCopy = '当前网站包含演示数据。示例浏览访问和日志不能证明网站 JS 或自动采集服务已经运行。';
function browserLabel(browser: any, deferred: boolean, demo = false) {
  if (browser.error) return '读取失败';
  if (browser.isPending) return '正在检查';
  if (!browser.data) return '状态未验证';
  if (browser.data.pageviews > 0) return demo ? '已有示例浏览数据' : '已收到浏览数据';
  return deferred ? '检查已延后' : '尚未收到浏览数据';
}
function logLabel(status: InstallationStatus) {
  if (status.logs.total > 0) return status.logs.demo ? '已有示例日志' : '已收到日志数据';
  return status.progress.logCheckDeferred ? '检查已延后' : '尚未收到日志';
}
function tone(label: string) {
  return label === '已收到浏览数据' || label === '已收到日志数据'
    ? 'green'
    : label === '读取失败'
      ? 'red'
      : 'gray';
}

export function IdentityObservation({
  observation,
  deferred,
  browserReceived,
  configured,
  timezone,
}: {
  observation: InstallationIdentityObservation;
  deferred: boolean;
  browserReceived: boolean;
  configured: boolean;
  timezone: string;
}) {
  const i18n = useLiekanI18n();
  const label =
    observation.status === 'demo'
      ? i18n.text('示例数据不用于接入核验')
      : observation.status === 'unsupported'
        ? i18n.text('当前观测不支持')
        : observation.status === 'temporarily_unavailable'
          ? i18n.text('身份诊断暂不可用')
          : observation.status === 'empty'
            ? configured
              ? i18n.text('已配置，等待采集核验')
              : i18n.text('等待采集核验')
            : observation.status === 'unknown'
              ? i18n.text('身份覆盖未知')
              : observation.smallSample
                ? i18n.text('样本不足')
                : observation.status === 'complete'
                  ? i18n.text('已收到可用身份事件')
                  : observation.status === 'partial'
                    ? i18n.text('部分身份可用')
                    : i18n.text('身份输入不足');
  const formatDate = (at: number | string) =>
    new Date(at).toLocaleString(i18n.locale, { timeZone: timezone });
  return (
    <div className={styles.checkRow}>
      <div>
        <strong>{i18n.text('最近接收的浏览身份')}</strong>
        {deferred && (
          <p className="muted">
            {i18n.text('浏览接入检查已延后。实际接收情况独立展示，日志功能可继续使用。')}
          </p>
        )}
        <p className="muted">{label}</p>
        {observation.sampleCount !== null && (
          <p className="muted">
            {i18n.text('样本 {v0} 条 · 身份可用 {v1} 条 · 覆盖率 {v2}', [
              observation.sampleCount.toLocaleString(i18n.locale),
              observation.availableIdentityCount?.toLocaleString(i18n.locale),
              observation.coverage === null
                ? i18n.text('未知')
                : new Intl.NumberFormat(i18n.locale, {
                    style: 'percent',
                    maximumFractionDigits: 1,
                  }).format(observation.coverage),
            ])}
          </p>
        )}
        {!!observation.unknownIdentityCount && (
          <p className="muted">
            {i18n.text('{v0} 条样本缺少身份资格证据，覆盖率保持未知。', [
              observation.unknownIdentityCount.toLocaleString(i18n.locale),
            ])}
          </p>
        )}
        {observation.smallSample && (
          <p className="muted">
            {i18n.text('当前少于 20 条样本，仅展示实际数量与覆盖，不据此判定代理故障。')}
          </p>
        )}
        {observation.status === 'unavailable' && (
          <p className="muted">
            {i18n.text('样本已收到，当前身份输入不足。请核对可信入口、代理覆盖及请求头重写。')}
          </p>
        )}
        {observation.status === 'partial' && (
          <p className="muted">{i18n.text('请核对缺少身份输入的访问范围。')}</p>
        )}
        {observation.status === 'complete' && (
          <p className="muted">
            {i18n.text('样本中的身份可用；代理覆盖与源站访问限制仍需部署侧核验。')}
          </p>
        )}
        {observation.status === 'empty' && browserReceived && (
          <p className="muted">
            {i18n.text('已有浏览记录；当前接收窗口、来源或证据范围内尚无可核验样本。')}
          </p>
        )}
        {observation.reasons.includes('reception_fallback') && (
          <p className="muted">
            {i18n.text('部分样本使用原始采集判定的接收时间回退，缺失的身份资格证据保持未知。')}
          </p>
        )}
        {observation.status === 'demo' && <p className="muted">{i18n.system(demoCopy)}</p>}
        {observation.status === 'temporarily_unavailable' && (
          <p className="muted">
            {i18n.text(
              '本次诊断未完成，覆盖率未知。原有接入设置与采集状态继续显示，可稍后重新检查。',
            )}
          </p>
        )}
        {observation.status === 'unsupported' && (
          <p className="muted">
            {i18n.text('当前数据库路径暂不支持身份观测，原有浏览采集与日志功能继续使用。')}
          </p>
        )}
        <p className="field-help">
          {i18n.text('接收窗口：{v0} 至 {v1}（结束时间不含在内）。', [
            formatDate(observation.range.startAt),
            formatDate(observation.range.endAt),
          ])}{' '}
          {i18n.text(
            '分母为具有会话关联和原始接收证据的公开浏览 PV，包含旧版覆盖来源；正式统计资格单独计算。',
          )}
          {observation.lastReceivedAt && (
            <> {i18n.text('最近接收：{v0}。', [formatDate(observation.lastReceivedAt)])}</>
          )}
        </p>
      </div>
      <Badge tone="gray">{deferred ? i18n.text('检查已延后') : label}</Badge>
    </div>
  );
}

export function InstallationEntry({ site, browser }: { site: FeatureEntity; browser: any }) {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const query = useInstallation(site.id);
  const status = query.data;
  return (
    <Panel
      title={i18n.text('数据接入')}
      subtitle={i18n.text('获取安装代码、连接日志，或继续上次的检查。')}
    >
      <Body>
        <QueryState query={query}>
          {status && (
            <div className={styles.summary}>
              <div>
                <strong>
                  {status.progress.completedAt
                    ? i18n.text('接入设置已保存')
                    : i18n.text('接入设置待完成')}
                </strong>
                <p className="muted">
                  {status.progress.completedAt
                    ? i18n.text('保存于 {v0}', [
                        i18n.system(
                          dateLabel(
                            status.progress.completedAt,
                            c.range.timezone || 'Asia/Shanghai',
                          ),
                        ),
                      ])
                    : i18n.text('检查可以延后，完成设置后可随时继续。')}
                </p>
              </div>
              <div className={styles.badges}>
                <Badge
                  tone={tone(
                    browserLabel(browser, status.progress.browserCheckDeferred, status.logs.demo),
                  )}
                >
                  JS ·{' '}
                  {i18n.system(
                    browserLabel(browser, status.progress.browserCheckDeferred, status.logs.demo),
                  )}
                </Badge>
                <Badge tone={tone(logLabel(status))}>
                  {i18n.fragment('日志 · ', false, true)}
                  {i18n.system(logLabel(status))}
                </Badge>
              </div>
            </div>
          )}
        </QueryState>
        {status?.logs.demo && <Notice tone="amber">{i18n.system(demoCopy)}</Notice>}
        {status?.identityIngress && (
          <Notice tone="amber">
            {status.identityIngress.configured
              ? i18n.text('已配置客户端 IP 请求头，仍需核对可信代理是否清除并重写入口请求头。')
              : i18n.text(
                  '尚未配置可信入口的客户端 IP 请求头。浏览量可记录，访客与会话指标需要可靠身份信息。',
                )}
          </Notice>
        )}
        <div className="form-actions">
          <LinkButton page="website-settings" params={installationParams(site.id, 'js')}>
            {i18n.text('获取 JS 代码')}
          </LinkButton>
          <LinkButton
            page="website-settings"
            params={installationParams(site.id, 'logs', 'cloudflare')}
          >
            {i18n.text('授权连接页面')}
          </LinkButton>
          <LinkButton
            page="website-settings"
            params={installationParams(site.id, 'logs', 'server')}
          >
            {i18n.text('服务器安装页面')}
          </LinkButton>
          <LinkButton page="website-settings" params={installationParams(site.id, 'check')}>
            {i18n.text('继续检查')}
          </LinkButton>
        </div>
      </Body>
    </Panel>
  );
}

export function Installation({
  site,
  browser,
  manage,
  entry,
}: {
  site: FeatureEntity;
  browser: any;
  manage: boolean;
  entry?: 'js' | 'check';
}) {
  const i18n = useLiekanI18n();
  const c = useFeature();
  const query = useInstallation(site.id);
  const action = useAction();
  const [importOpen, setImportOpen] = useState(false);
  const [draft, setDraft] = useState<{ method: LogMethod; navigationVersion: number } | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const status = query.data;
  const parsedMethod = logMethodSchema.safeParse(c.query.method);
  const step: InstallationStep =
    installationStep(c.query.step) ||
    entry ||
    (status?.progress.completedAt ? 'overview' : status?.progress.lastStep || 'js');
  const canSave = manage && !!status?.canManage;
  const navigationKey = JSON.stringify([
    entry,
    c.route.page,
    c.query.section,
    c.query.step,
    c.query.method,
  ]);
  const navigation = useRef({ key: navigationKey, version: 0 });
  if (navigation.current.key !== navigationKey) {
    navigation.current = { key: navigationKey, version: navigation.current.version + 1 };
  }
  const method: LogMethod = ['complete', 'overview', 'check'].includes(step)
    ? status?.progress.method || 'cloudflare'
    : draft?.navigationVersion === navigation.current.version
      ? draft.method
      : parsedMethod.success
        ? parsedMethod.data
        : status?.progress.method || 'cloudflare';
  const timezone = c.range.timezone || 'Asia/Shanghai';
  const href = (step: InstallationStep, chosen?: LogMethod) =>
    c.href('website-settings', installationParams(site.id, step, chosen));
  const navigate = (step: InstallationStep, chosen?: LogMethod) =>
    c.navigate('website-settings', installationParams(site.id, step, chosen));
  async function save(body: InstallationAction, next?: InstallationStep) {
    if (!canSave) throw new Error('保存接入设置需要网站管理权限。');
    const version = navigation.current.version;
    await action.run(
      () => c.api.post(`/liekan/websites/${site.id}/installation`, body),
      body.action === 'finish' ? `「${site.name}」的接入设置已保存` : '接入进度已保存',
    );
    if (next && active.current && version === navigation.current.version)
      navigate(next, 'method' in body ? body.method : method);
  }
  async function selectMethod(chosen: LogMethod) {
    setDraft({ method: chosen, navigationVersion: navigation.current.version });
    navigate('logs', chosen);
    await save({ action: 'select-method', method: chosen });
  }
  const checking = browser.isFetching || query.isFetching;
  async function recheck() {
    const results = await Promise.all([browser.refetch(), query.refetch()]);
    if (results.some(result => result.error))
      throw new Error('部分状态读取失败，请查看检查结果后重试。');
    c.notify('采集状态已更新');
  }
  const browserState = browserLabel(
    browser,
    !!status?.progress.browserCheckDeferred,
    status?.logs.demo,
  );
  const browserReceived = !browser.error && browser.data?.pageviews > 0;
  const logReceived = !!status?.logs.total;
  const summary = status && (
    <div className={styles.receipts}>
      <div>
        <span className="muted">{i18n.text('浏览采集')}</span>
        <Badge tone={tone(browserState)}>{i18n.system(browserState)}</Badge>
        <p className="muted">
          {browserReceived
            ? i18n.text('{v0} 次页面访问{v1}', [
                browser.data.pageviews.toLocaleString(),
                status.logs.demo ? i18n.text('（含示例数据）') : '',
              ])
            : i18n.text('JS 安装后，打开目标网站产生一次访问。')}
        </p>
      </div>
      <div>
        <span className="muted">{i18n.text('日志采集')}</span>
        <Badge tone={tone(logLabel(status))}>{i18n.system(logLabel(status))}</Badge>
        <p className="muted">
          {logReceived
            ? i18n.text('{v0} 条日志 · {v1} 次 AI 蜘蛛匹配', [
                status.logs.total.toLocaleString(),
                status.logs.ai.toLocaleString(),
              ])
            : i18n.text('服务器或 CDN 日志用于统计 AI 蜘蛛请求。')}
        </p>
      </div>
    </div>
  );
  const demoNotice = status?.logs.demo && <Notice tone="amber">{i18n.system(demoCopy)}</Notice>;
  const checks = status && (
    <div className={styles.checks}>
      <div className={styles.checkRow}>
        <div>
          <strong>{i18n.text('JS 浏览数据')}</strong>
          <p className="muted">
            {browserReceived && !status.logs.demo
              ? i18n.text('已收到页面访问；脚本加载仍可在目标网站核对。')
              : i18n.text('打开目标网站，确认脚本加载与网站标识，再检查访问是否到达。')}
          </p>
          {browser.error && (
            <p role="alert" className="field-error">
              {i18n.system(browser.error.message) || i18n.text('浏览统计读取失败，请重试。')}
            </p>
          )}
        </div>
        <Badge tone={tone(browserState)}>{i18n.system(browserState)}</Badge>
      </div>
      {status.identityIngress?.observation && (
        <IdentityObservation
          observation={status.identityIngress.observation}
          deferred={status.progress.browserCheckDeferred}
          browserReceived={browserReceived}
          configured={status.identityIngress.configured}
          timezone={timezone}
        />
      )}
      <div className={styles.checkRow}>
        <div>
          <strong>{i18n.text('自动日志接入')}</strong>
          <p className="muted">
            {status.sources?.some(source => source.primary)
              ? i18n.text('主要来源已连接；真实接收与处理状态见日志接入设置。')
              : i18n.text('可从日志接入设置连接来源，检查可以延后。')}
          </p>
        </div>
        <Badge>
          {status.sources?.some(source => source.primary)
            ? i18n.text('已配置')
            : i18n.text('待配置')}
        </Badge>
      </div>
      <div className={styles.checkRow}>
        <div>
          <strong>{i18n.text('日志接收')}</strong>
          <p className="muted">
            {logReceived
              ? i18n.text('最近日志：{v0}。', [
                  i18n.system(dateLabel(status.logs.latestAt, timezone)),
                ])
              : i18n.text('连接自动来源或导入真实访问日志后，检查接收条数与时间。')}
          </p>
        </div>
        <Badge tone={tone(logLabel(status))}>{i18n.system(logLabel(status))}</Badge>
      </div>
      <div className={styles.checkRow}>
        <div>
          <strong>{i18n.text('AI 蜘蛛匹配')}</strong>
          <p className="muted">
            {logReceived
              ? status.logs.ai
                ? i18n.text('根据日志中的请求特征匹配。身份核验结果可在日志中查看。')
                : i18n.text('日志已收到，暂未匹配到 AI 蜘蛛请求。')
              : i18n.text('收到有效日志后进行识别。')}
          </p>
        </div>
        <Badge tone={logReceived ? 'blue' : 'gray'}>
          {logReceived
            ? i18n.text('{v0} 次匹配', [status.logs.ai.toLocaleString()])
            : i18n.text('等待日志')}
        </Badge>
      </div>
      <p className="field-help">
        {i18n.text(
          '检查范围：当前网站创建至今的浏览访问与所有已导入日志。延后检查会保留实际数据和错误状态。',
        )}
      </p>
      {demoNotice}
      {status?.identityIngress && (
        <Notice tone="amber">
          {status.identityIngress.configured
            ? i18n.text('已配置客户端 IP 请求头，仍需核对可信代理是否清除并重写入口请求头。')
            : i18n.text(
                '尚未配置可信入口的客户端 IP 请求头。浏览量可记录，访客与会话指标需要可靠身份信息。',
              )}
        </Notice>
      )}
    </div>
  );

  return (
    <div className={styles.flow}>
      <div className={styles.context}>
        <div>
          <strong>{site.name}</strong>
          <span className="muted">{site.domain}</span>
        </div>
        <LinkButton page="website-settings" params={{ websiteId: site.id }}>
          {i18n.text('返回网站设置')}
        </LinkButton>
      </div>
      <QueryState query={query}>
        {status && (
          <>
            {!canSave && (
              <Notice tone="amber">
                {i18n.text('当前角色可查看安装说明。保存接入进度需要网站管理权限。')}
              </Notice>
            )}
            {['js', 'logs', 'finish'].includes(step) && (
              <nav className={styles.steps} aria-label={i18n.text('接入设置步骤')}>
                {(
                  [
                    ['js', i18n.text('安装 JS')],
                    ['logs', i18n.text('接入日志')],
                    ['finish', i18n.text('完成设置')],
                  ] as const
                ).map(([id, label], index) => (
                  <Link
                    key={id}
                    prefetch={false}
                    href={href(id, method)}
                    aria-current={step === id ? 'step' : undefined}
                  >
                    <span>{index + 1}</span>
                    <strong>{i18n.system(label)}</strong>
                  </Link>
                ))}
              </nav>
            )}
            {step === 'js' && (
              <div className={styles.layout}>
                <Panel
                  title={i18n.text('安装网站统计 JS')}
                  subtitle={i18n.text('将代码加入网站公共模板，覆盖需要统计的页面。')}
                >
                  <Body>
                    <TrackingCode websiteId={site.id} />
                    <div className={styles.inlineStatus}>
                      <Badge tone={tone(browserState)}>{i18n.system(browserState)}</Badge>
                      <Button disabled={checking} onClick={recheck}>
                        {i18n.text('检查安装结果（可选）')}
                      </Button>
                    </div>
                    {demoNotice}
                    <details className={styles.details}>
                      <summary>{i18n.text('安装说明与自定义事件')}</summary>
                      <div className="stack">
                        <p>
                          {i18n.text(
                            'HTML 网站放在公共模板的 head 中；Next.js 使用上方示例；标签管理器选择自定义 HTML 标签。',
                          )}
                        </p>
                        <p>
                          {i18n.text(
                            '单页应用默认跟踪路由变化。内容安全策略需允许统计服务的脚本和采集地址。',
                          )}
                        </p>
                        <Code>
                          {"umami.track('demo_submit', { plan: 'growth', placement: 'header' });"}
                        </Code>
                        <LinkButton page="recorder-settings" params={{ websiteId: site.id }}>
                          {i18n.text('回放与热力图设置')}
                        </LinkButton>
                      </div>
                    </details>
                    <div className={styles.footer}>
                      <span className="muted">{i18n.text('可以先完成设置，稍后验证安装。')}</span>
                      <div className="row">
                        {browserReceived &&
                          (canSave ? (
                            <Button
                              primary
                              disabled={action.busy}
                              onClick={() =>
                                save({ action: 'continue', step: 'logs', method }, 'logs')
                              }
                            >
                              {i18n.text('下一步：接入日志')}
                            </Button>
                          ) : (
                            <LinkButton
                              page="website-settings"
                              params={installationParams(site.id, 'logs', method)}
                              primary
                            >
                              {i18n.text('下一步：接入日志')}
                            </LinkButton>
                          ))}
                        <Button
                          primary={!browserReceived}
                          disabled={action.busy || !canSave}
                          onClick={() => save({ action: 'skip-browser' }, 'logs')}
                        >
                          {i18n.text('跳过检查，下一步')}
                        </Button>
                      </div>
                    </div>
                  </Body>
                </Panel>
                <Panel
                  title={i18n.text('两种数据，一处接入')}
                  subtitle={i18n.text('根据分析目标选择接入方式。')}
                >
                  <Body>
                    <div className="stack">
                      <div>
                        <h3>{i18n.text('浏览访问与转化')}</h3>
                        <p className="muted">
                          {i18n.text('网站 JS 采集页面访问和事件，支持来源、目标与漏斗分析。')}
                        </p>
                      </div>
                      <div>
                        <h3>{i18n.text('AI 蜘蛛与抓取')}</h3>
                        <p className="muted">
                          {i18n.text('日志记录请求与蜘蛛访问。多数蜘蛛不会执行页面 JS。')}
                        </p>
                      </div>
                      <div>
                        <h3>{i18n.text('随时继续')}</h3>
                        <p className="muted">
                          {i18n.text('每一步都可以延后检查，从网站设置回到当前网站的对应页面。')}
                        </p>
                      </div>
                    </div>
                  </Body>
                </Panel>
              </div>
            )}
            {step === 'logs' && (
              <Panel
                title={i18n.text('接入 AI 蜘蛛日志')}
                subtitle={i18n.text('选择日志来源；检查可以延后。')}
              >
                <Body>
                  <fieldset className={styles.methods}>
                    <legend>{i18n.text('选择接入方式')}</legend>
                    {(['cloudflare', 'server', 'manual'] as const).map(value => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="log-method"
                          value={value}
                          checked={method === value}
                          disabled={action.busy || !canSave}
                          onChange={() => {
                            void selectMethod(value).catch(() => {});
                          }}
                        />
                        <span>
                          <strong>{i18n.system(logMethodLabels[value])}</strong>
                          <small>
                            {value === 'cloudflare'
                              ? i18n.text('覆盖 CDN 边缘请求')
                              : value === 'server'
                                ? i18n.text('覆盖服务器回源请求')
                                : i18n.text('上传已有访问日志')}
                          </small>
                        </span>
                        <Badge
                          tone={value === 'manual' || status.capabilities[value] ? 'blue' : 'gray'}
                        >
                          {value === 'manual' || status.capabilities[value]
                            ? i18n.text('可用')
                            : i18n.text('待配置')}
                        </Badge>
                      </label>
                    ))}
                  </fieldset>
                  {method !== 'manual' ? (
                    <div className={styles.source}>
                      <div className={styles.sourceTitle}>
                        <Icon name={method === 'cloudflare' ? 'globe' : 'code'} />
                        <h3>{i18n.system(logMethodLabels[method])}</h3>
                        <Badge>
                          {status.capabilities[method]
                            ? i18n.text('可用')
                            : i18n.text('实例待配置')}
                        </Badge>
                      </div>
                      <p>
                        {method === 'cloudflare'
                          ? i18n.text('授权后选择与当前网站匹配的域名，由 CDN 持续推送访问日志。')
                          : i18n.text(
                              '在网站服务器执行一次安装，采集服务持续发送该网站的访问日志。',
                            )}
                      </p>
                      <AutomaticLogSetup
                        key={`${site.id}:${method}`}
                        websiteId={site.id}
                        method={method}
                        status={status}
                        manage={canSave}
                        refresh={() => query.refetch()}
                      />
                      <div className="form-actions">
                        <Button
                          disabled={action.busy || !canSave}
                          onClick={() => selectMethod('manual')}
                        >
                          {i18n.text('使用手动导入')}
                        </Button>
                      </div>
                      <p className="field-help">
                        {i18n.fragment('覆盖范围：', false, true)}
                        {method === 'cloudflare'
                          ? i18n.text('CDN 请求，可包含缓存命中；实际字段取决于账号能力。')
                          : i18n.text('源站请求；CDN 缓存命中与边缘拦截通常不进入源站日志。')}
                      </p>
                    </div>
                  ) : (
                    <div className={styles.source}>
                      <h3>{i18n.text('导入当前网站的访问日志')}</h3>
                      <p>
                        {i18n.text(
                          '支持 Nginx / Apache Combined 与标准 JSON，导入后自动解析请求并匹配蜘蛛。',
                        )}
                      </p>
                      <p className="muted">
                        {i18n.fragment(
                          '原生 CDN 日志需转换为支持的字段格式。请确认日志属于 ',
                          false,
                          true,
                        )}
                        {site.domain}。
                      </p>
                      <div className="form-actions">
                        <Button primary disabled={!canSave} onClick={() => setImportOpen(true)}>
                          {i18n.text('导入网站日志')}
                        </Button>
                        <LinkButton page="geo-logs" params={{ websiteId: site.id }}>
                          {i18n.text('查看该网站日志')}
                        </LinkButton>
                      </div>
                    </div>
                  )}
                  <div className={styles.inlineStatus}>
                    <Badge tone={tone(logLabel(status))}>{i18n.system(logLabel(status))}</Badge>
                    <Button disabled={checking} onClick={recheck}>
                      {i18n.text('检查日志接收（可选）')}
                    </Button>
                  </div>
                  {demoNotice}
                  <CrawlerDisplaySettings
                    manage={canSave}
                    guide
                    logsConnected={
                      status.sources?.some(source => source.state === 'active') ||
                      (!status.logs.demo && status.logs.total > 0)
                    }
                  />
                  <div className={styles.footer}>
                    <LinkButton page="website-settings" params={installationParams(site.id, 'js')}>
                      {i18n.text('上一步')}
                    </LinkButton>
                    <div className="row">
                      {logReceived &&
                        (canSave ? (
                          <Button
                            primary
                            disabled={action.busy}
                            onClick={() =>
                              save({ action: 'continue', step: 'finish', method }, 'finish')
                            }
                          >
                            {i18n.text('下一步：完成设置')}
                          </Button>
                        ) : (
                          <LinkButton
                            page="website-settings"
                            params={installationParams(site.id, 'finish', method)}
                            primary
                          >
                            {i18n.text('下一步：完成设置')}
                          </LinkButton>
                        ))}
                      <Button
                        primary={!logReceived}
                        disabled={action.busy || !canSave}
                        onClick={() => save({ action: 'skip-logs', method }, 'finish')}
                      >
                        {i18n.text('跳过检查，继续')}
                      </Button>
                    </div>
                  </div>
                </Body>
              </Panel>
            )}
            {step === 'finish' && (
              <Panel
                title={i18n.text('完成接入设置')}
                subtitle={i18n.text('确认当前网站的选择，检查结果可稍后补充。')}
              >
                <Body>
                  <Definition
                    items={[
                      [i18n.text('网站'), `${site.name} · ${site.domain}`],
                      [i18n.text('日志接入方式'), i18n.system(logMethodLabels[method])],
                      [
                        i18n.text('自动接入'),
                        status.sources?.some(source => source.primary)
                          ? i18n.text('主要来源已配置')
                          : i18n.text('等待连接'),
                      ],
                    ]}
                  />
                  {summary}
                  <CrawlerDisplaySettings
                    manage={canSave}
                    guide
                    logsConnected={
                      status.sources?.some(source => source.state === 'active') ||
                      (!status.logs.demo && status.logs.total > 0)
                    }
                  />
                  <Notice tone="blue">
                    {i18n.text(
                      '完成后会保存接入设置。尚未收到的数据仍显示等待，可从网站设置继续安装或检查。',
                    )}
                  </Notice>
                  <details className={styles.details}>
                    <summary>{i18n.text('查看检查结果（可选）')}</summary>
                    {checks}
                    <div className="form-actions">
                      <Button disabled={checking} onClick={recheck}>
                        {i18n.text('重新检查')}
                      </Button>
                    </div>
                  </details>
                  <div className={styles.footer}>
                    <LinkButton
                      page="website-settings"
                      params={installationParams(site.id, 'logs', method)}
                    >
                      {i18n.text('上一步')}
                    </LinkButton>
                    <Button
                      primary
                      disabled={action.busy || !canSave}
                      onClick={() => save({ action: 'finish', method }, 'complete')}
                    >
                      {action.busy ? i18n.text('正在保存…') : i18n.text('完成设置')}
                    </Button>
                  </div>
                </Body>
              </Panel>
            )}
            {(step === 'complete' || step === 'overview') && (
              <Panel
                title={i18n.system(
                  status.progress.completedAt
                    ? i18n.text('接入设置已保存')
                    : i18n.text('接入设置待完成'),
                )}
                subtitle={i18n.text('当前网站的安装、日志接入与检查入口。')}
              >
                <Body>
                  {status.progress.completedAt && (
                    <div className={styles.complete}>
                      <span>
                        <Icon name="check" />
                      </span>
                      <div>
                        <h3>{i18n.text('接入设置已保存')}</h3>
                        <p className="muted">{i18n.text('后续可随时调整安装方式并继续检查。')}</p>
                      </div>
                    </div>
                  )}
                  {summary}
                  <div className={styles.entryRow}>
                    <div>
                      <strong>{i18n.text('网站统计 JS')}</strong>
                      <p className="muted">{i18n.text('获取代码，或核对已安装的脚本。')}</p>
                    </div>
                    <LinkButton page="website-settings" params={installationParams(site.id, 'js')}>
                      {i18n.text('获取 JS 代码')}
                    </LinkButton>
                  </div>
                  <div className={styles.entryRow}>
                    <div>
                      <strong>{i18n.system(logMethodLabels[method])}</strong>
                      <p className="muted">
                        {method === 'manual'
                          ? i18n.text('导入真实日志后查看蜘蛛请求。')
                          : i18n.text('查看连接状态、调整主要来源或继续安装。')}
                      </p>
                    </div>
                    <LinkButton
                      page="website-settings"
                      params={installationParams(site.id, 'logs', method)}
                    >
                      {method === 'cloudflare'
                        ? i18n.text('授权连接页面')
                        : method === 'server'
                          ? i18n.text('服务器安装页面')
                          : i18n.text('日志导入页面')}
                    </LinkButton>
                  </div>
                  <div className={styles.entryRow}>
                    <div>
                      <strong>{i18n.text('接入检查')}</strong>
                      <p className="muted">{i18n.text('浏览访问、日志接收与 AI 蜘蛛匹配。')}</p>
                    </div>
                    <LinkButton
                      page="website-settings"
                      params={installationParams(site.id, 'check')}
                    >
                      {i18n.text('继续检查')}
                    </LinkButton>
                  </div>
                  {demoNotice}
                  <div className="form-actions">
                    <LinkButton page="website-settings" params={{ websiteId: site.id }} primary>
                      {i18n.text('返回网站设置')}
                    </LinkButton>
                    <LinkButton page="overview" params={{ websiteId: site.id }}>
                      {i18n.text('查看该网站统计')}
                    </LinkButton>
                    {!status.progress.completedAt && (
                      <LinkButton
                        page="website-settings"
                        params={installationParams(site.id, 'finish', method)}
                      >
                        {i18n.text('完成设置')}
                      </LinkButton>
                    )}
                  </div>
                </Body>
              </Panel>
            )}
            {step === 'check' && (
              <Panel
                title={i18n.text('接入检查')}
                subtitle={i18n.text('检查真实接收结果；每项检查均可延后。')}
                actions={
                  <Button disabled={checking} onClick={recheck}>
                    {i18n.text('重新检查')}
                  </Button>
                }
              >
                <Body>
                  {checks}
                  <div className="form-actions">
                    <LinkButton page="website-settings" params={installationParams(site.id, 'js')}>
                      {i18n.text('查看跟踪代码')}
                    </LinkButton>
                    <LinkButton
                      page="website-settings"
                      params={installationParams(site.id, 'logs', method)}
                    >
                      {i18n.text('日志接入设置')}
                    </LinkButton>
                    <LinkButton page="geo-logs" params={{ websiteId: site.id }}>
                      {i18n.text('查看该网站日志')}
                    </LinkButton>
                    <Button
                      primary
                      disabled={action.busy || !canSave}
                      onClick={() => save({ action: 'skip-checks', method }, 'finish')}
                    >
                      {i18n.text('跳过检查，继续设置')}
                    </Button>
                  </div>
                </Body>
              </Panel>
            )}
            {action.error && <Notice tone="red">{i18n.system(action.error)}</Notice>}
            {importOpen && (
              <ManagementDrawer
                key={site.id}
                action="导入日志"
                websiteId={site.id}
                websiteName={site.name}
                websiteDomain={site.domain}
                canManage={canSave}
                onClose={() => setImportOpen(false)}
                onSaved={async () => {
                  const results = await Promise.allSettled([
                    query.refetch({ throwOnError: true }),
                    c.refresh(),
                  ]);
                  const failure = results.find(result => result.status === 'rejected');
                  if (failure) throw failure.reason;
                }}
                onSearch={search => c.navigate('geo-logs', { websiteId: site.id, search })}
                onRange={(start, end) =>
                  c.navigate('geo-logs', { websiteId: site.id, date: `range:${start}:${end}` })
                }
              />
            )}
          </>
        )}
      </QueryState>
    </div>
  );
}
