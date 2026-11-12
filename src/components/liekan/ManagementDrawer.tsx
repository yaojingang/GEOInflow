'use client';

import { fromZonedTime } from 'date-fns-tz';
import { useEffect, useId, useRef, useState } from 'react';
import type { CatalogPayload } from '@/lib/liekan/contracts/crawler-registry';
import { managementLabels, parseEditableAllowlist } from '@/lib/liekan/contracts/management';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import type { BotRule } from '@/lib/liekan/rules/bots';
import type { CrawlerRuleConfiguration } from '@/lib/liekan/rules/configuration';
import { parseRuleEditorDraft, ruleEditorConfiguration } from '@/lib/liekan/rules/editor';
import { useApi, useNavigation } from '@/lib/liekan/upstream/client';
import { getFeaturePreferences } from '@/lib/liekan/upstream/features-client';
import styles from '@/styles/liekan/Shell.module.css';
import { columns, downloadFile, formatMetricValue, formatValue, stateLabels } from './data';
import { CrawlerCandidatesPanel } from './features/CrawlerCandidatesPanel';
import { CrawlerRulesEditor } from './features/CrawlerRulesEditor';
import { catalogBotRules } from './features/crawlerRegistryUi';
import { useDialog } from './features/LiekanDialog';
import { featureHref } from './features/routes';
import { Button, DialogActions, LiekanDialog } from './features/ui';
import { ReportRows, SortHeading } from './ReportComponents';
import type { LiekanReport } from './types';

type Settings = {
  robots: string;
  allowlist: string[];
  rules: BotRule[];
  crawlerRules?: CrawlerRuleConfiguration;
  rulesRevision?: number;
  classificationVersion?: string;
};
type ImportError = { line: number; reason: string };
type LogImportResult = {
  accepted: number;
  inserted: number;
  rejected: number;
  duplicate: boolean;
  errors: ImportError[];
};
export function ManagementDrawer(props: Parameters<typeof ManagementDrawerContent>[0]) {
  return ['特征库管理', '解析规则'].includes(props.action) && !props.centralCatalog ? (
    <CrawlerRegistryRedirect websiteId={props.websiteId} />
  ) : (
    <ManagementDrawerContent {...props} />
  );
}
function CrawlerRegistryRedirect({ websiteId }: { websiteId: string }) {
  const nav = useNavigation();
  useEffect(() => {
    nav.router.replace(featureHref('crawlers-manage', { site: websiteId }));
  }, [websiteId]);
  return null;
}
function ManagementDrawerContent({
  action,
  centralCatalog,
  websiteId,
  websiteName,
  websiteDomain,
  canManage,
  onClose,
  onSaved,
  onSearch,
  onRange,
  report,
  onPage,
  onLogsFilter,
  isFetching,
  logsFilter,
  initialSearch,
  comparison,
}: {
  action: string;
  centralCatalog?: CatalogPayload;
  websiteId: string;
  websiteName?: string;
  websiteDomain?: string;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onSearch: (value: string) => void;
  onRange: (start: number, end: number) => void;
  report?: LiekanReport;
  onPage?: (page: number) => void;
  onLogsFilter?: (label: string) => void;
  isFetching?: boolean;
  logsFilter?: string;
  initialSearch?: string;
  comparison?: {
    current?: LiekanReport;
    previous?: LiekanReport;
    startAt: number;
    endAt: number;
    previousStartAt: number;
    previousEndAt: number;
    labels: string[];
    error?: unknown;
    fetching?: boolean;
    refetch?: () => void;
  };
}) {
  const i18n = useLiekanI18n();
  const api = useApi();
  const timezone = getFeaturePreferences().timezone || 'Asia/Shanghai';
  const formId = useId();
  const saving = useRef(false);
  const [content, setContent] = useState(action === '日志查询' ? initialSearch || '' : '');
  const [importMode, setImportMode] = useState(false);
  const importDraft = useRef('');
  const importDirty = useRef(false);
  const queryDraft = useRef(initialSearch || '');
  const appliedSearch = useRef(initialSearch);
  const [format, setFormat] = useState(action === 'sitemap 管理' ? 'sitemap' : 'combined');
  const [settings, setSettings] = useState<Settings>(null);
  const [status, setStatus] = useState('');
  const [conversionConfirmed, setConversionConfirmed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadVersion, setLoadVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [importErrors, setImportErrors] = useState<ImportError[]>([]);
  const [totalErrors, setTotalErrors] = useState(0);
  const [busy, setBusy] = useState(false);
  const initialDate = (value?: number) =>
    value ? new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(value) : '';
  const [start, setStart] = useState(initialDate(report?.range.startAt));
  const [end, setEnd] = useState(
    initialDate(
      report?.meta.crawlerMetrics?.timeBoundary === 'half_open'
        ? Math.max(report.range.startAt, report.range.endAt - 1)
        : report?.range.endAt,
    ),
  );
  const settingsAction = ['robots.txt 编辑', '蜘蛛白名单', '特征库管理', '解析规则'].includes(
    action,
  );
  const isRules = ['特征库管理', '解析规则'].includes(action);
  const isCatalog = action === 'sitemap 管理';
  const isQuery = action === '日志查询' && !importMode;
  const isRange = action === '统计范围';
  const isComparison = action === '对比上周';
  const title =
    importMode || action === '导入日志' ? '导入访问日志' : managementLabels[action] || action;
  const submitLabel = isQuery
    ? '应用查询'
    : isRange
      ? '应用日期范围'
      : isCatalog
        ? '导入页面目录'
        : isRules
          ? '保存识别规则'
          : action === 'robots.txt 编辑'
            ? '保存 robots.txt'
            : action === '蜘蛛白名单'
              ? '保存白名单'
              : '导入日志';
  const currentWebsite = websiteName || report?.website?.name || '当前网站';
  const currentDomain = websiteDomain || report?.website?.domain;
  const comparisonDate = (value: number) =>
    new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
      hour12: false,
    }).format(value);
  useEffect(() => {
    if (initialSearch === appliedSearch.current) return;
    appliedSearch.current = initialSearch;
    queryDraft.current = initialSearch || '';
    if (isQuery) setContent(queryDraft.current);
  }, [initialSearch, isQuery]);
  useEffect(() => {
    if (!settingsAction) return;
    let alive = true;
    setBusy(true);
    setLoadError('');
    api
      .get('/liekan/websites/' + websiteId + '/settings')
      .then((data: Settings) => {
        if (!alive) return;
        setSettings(data);
        setConversionConfirmed(false);
        setContent(
          action === 'robots.txt 编辑'
            ? data.robots
            : action === '蜘蛛白名单'
              ? data.allowlist.join('\n')
              : JSON.stringify(ruleEditorConfiguration(data), null, 2),
        );
        setDirty(false);
      })
      .catch(error => {
        if (!alive) return;
        if ([401, 403, 404].includes(error.status)) {
          setSettings(null);
          setContent('');
          setDirty(false);
        }
        setLoadError(error.message || '无法读取设置');
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [action, websiteId, settingsAction, loadVersion]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || saving.current || isComparison) return;
    if (isRange) {
      const startAt = +fromZonedTime(`${start}T00:00:00`, timezone),
        endAt = +fromZonedTime(`${end}T23:59:59.999`, timezone);
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt > endAt) {
        setFailed(true);
        setStatus('请选择有效的起止日期');
        return;
      }
      onRange(startAt, endAt);
      onClose();
      return;
    }
    if (isQuery) {
      onSearch(content);
      return;
    }
    if (!canManage) {
      setFailed(true);
      setStatus('当前账号没有管理此站点的权限');
      return;
    }
    saving.current = true;
    setBusy(true);
    setFailed(false);
    setStatus('');
    setImportErrors([]);
    setTotalErrors(0);
    try {
      if (settingsAction) {
        if (!settings) throw new Error('请先读取设置');
        let patch: Partial<Settings> & {
          expectedRulesRevision?: number;
          conversionConfirmed?: boolean;
        };
        if (action === 'robots.txt 编辑') {
          if (content.length > 50000)
            throw new Error('robots.txt 最多 50,000 个字符，请缩减内容后保存。');
          patch = { robots: content };
        } else if (action === '蜘蛛白名单')
          patch = {
            allowlist: parseEditableAllowlist(content),
          };
        else {
          const crawlerRules = parseRuleEditorDraft(
            content,
            centralCatalog?.identities
              .filter(item => item.kind !== 'robots_purpose')
              .map(item => item.id),
          );
          patch = {
            crawlerRules,
            expectedRulesRevision: settings.rulesRevision ?? 0,
            ...(conversionConfirmed ? { conversionConfirmed: true } : {}),
          };
        }
        const saved: Settings = await api.put(`/liekan/websites/${websiteId}/settings`, patch);
        setSettings(saved);
        setConversionConfirmed(false);
        setContent(
          action === 'robots.txt 编辑'
            ? saved.robots
            : action === '蜘蛛白名单'
              ? saved.allowlist.join('\n')
              : JSON.stringify(ruleEditorConfiguration(saved), null, 2),
        );
        setStatus(
          action === 'robots.txt 编辑'
            ? 'robots.txt 已保存到当前网站设置。下载后部署到网站根目录。'
            : action === '蜘蛛白名单'
              ? i18n.source('白名单已保存，共 {v0} 条。', [saved.allowlist.length])
              : i18n.source('蜘蛛识别规则已保存，共 {v0} 条。', [saved.rules.length]),
        );
      } else if (isCatalog) {
        const result: { accepted: number; mode: string } = await api.put(
          `/liekan/websites/${websiteId}/catalog`,
          { format, content },
        );
        setStatus(
          i18n.source('{v0} {v1} 个页面', [
            result.mode === 'upsert' ? '已新增或更新' : '已导入',
            formatValue(result.accepted),
          ]),
        );
      } else {
        const payload =
          format === 'json' ? { format, records: JSON.parse(content) } : { format, content };
        const result: LogImportResult = await api.post(
          `/liekan/websites/${websiteId}/logs/import`,
          payload,
        );
        const duplicate = result.accepted - result.inserted;
        setStatus(
          `校验通过 ${formatValue(result.accepted)} 条 · 新增 ${formatValue(result.inserted)} 条 · 重复 ${formatValue(duplicate)} 条 · 拒绝 ${formatValue(result.rejected)} 条${result.rejected > 0 ? '，部分记录未导入。' : result.duplicate ? '，该批次已导入。' : '。'}`,
        );
        setImportErrors(result.errors || []);
        setTotalErrors(result.rejected);
      }
      if (action === '日志查询' && importMode) {
        importDraft.current = content;
        importDirty.current = false;
      }
      setDirty(false);
      try {
        await onSaved();
      } catch {
        setStatus(current => `${current} 页面状态刷新失败，请刷新页面确认已保存结果。`);
      }
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <LiekanDialog
      title={i18n.system(title)}
      size={isRange || action === '蜘蛛白名单' ? 'standard' : 'wide'}
      subtitle={i18n.system(
        <>
          {currentWebsite}
          {currentDomain ? ' · ' + currentDomain : ''}
          {isRange || isComparison || isQuery ? ' · ' + timezone : ''}
        </>,
      )}
      protectUnsaved={!busy}
      onClose={() => {
        if (!saving.current) onClose();
      }}
    >
      <form
        id={formId}
        className={styles.form}
        onSubmit={submit}
        data-unsaved={dirty ? 'true' : 'false'}
        onChange={() => {
          if (!isQuery && !isRange && !isComparison) setDirty(true);
        }}
      >
        {action === '日志查询' && (
          <div className="tabs" role="tablist" aria-label={i18n.text('访问日志操作')}>
            <button
              type="button"
              role="tab"
              aria-selected={!importMode}
              className={!importMode ? 'tab on' : 'tab'}
              disabled={busy}
              onClick={() => {
                if (busy || saving.current) return;
                if (importMode) {
                  importDraft.current = content;
                  importDirty.current = dirty;
                }
                setImportMode(false);
                setContent(queryDraft.current);
                setDirty(importDirty.current);
              }}
            >
              {i18n.text('查询记录')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={importMode}
              className={importMode ? 'tab on' : 'tab'}
              disabled={busy}
              onClick={() => {
                if (busy || saving.current) return;
                if (!importMode) queryDraft.current = content;
                setImportMode(true);
                setContent(importDraft.current);
                setDirty(importDirty.current);
              }}
            >
              {i18n.text('导入日志')}
            </button>
          </div>
        )}
        {loadError && (
          <div className="notice red" role="alert">
            {i18n.fragment('无法读取设置：', false, true)}
            {i18n.system(loadError)}{' '}
            <Button disabled={busy || dirty} onClick={() => setLoadVersion(v => v + 1)}>
              {i18n.text('重新读取设置')}
            </Button>
          </div>
        )}
        {busy && settingsAction && !saving.current && (
          <p role="status" className="muted">
            {i18n.text('正在读取网站设置…')}
          </p>
        )}
        {isComparison ? (
          <>
            <div className="management-grid">
              <div>
                <h3>{i18n.text('当前期间')}</h3>
                <p className={styles.help}>
                  {comparisonDate(comparison.startAt)}
                  {i18n.fragment(' 至 ', true, true)}
                  {comparisonDate(comparison.endAt)}
                </p>
              </div>
              <div>
                <h3>{i18n.text('上周期间')}</h3>
                <p className={styles.help}>{i18n.text('整体前移 7 天')}</p>
                <p className={styles.help}>
                  {comparisonDate(comparison.previousStartAt)}
                  {i18n.fragment(' 至', true, true)} {comparisonDate(comparison.previousEndAt)}
                </p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="management-comparison">
                <thead>
                  <tr>
                    <th>{i18n.text('指标')}</th>
                    <th>{i18n.text('当前期间')}</th>
                    <th>{i18n.text('上周期间')}</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.current?.cards
                    .filter(
                      card =>
                        comparison.labels.includes(card.label) && !card.label.startsWith('今日'),
                    )
                    .map(card => {
                      const previous = comparison.previous?.cards.find(
                        item => item.key === card.key,
                      );
                      return (
                        <tr key={card.key}>
                          <td>{i18n.system(card.label)}</td>
                          <td>
                            {formatMetricValue(card, i18n.locale, i18n.system)}
                            {i18n.system(stateLabels[card.state])
                              ? ' · ' + i18n.system(stateLabels[card.state])
                              : ''}
                          </td>
                          <td>
                            {previous
                              ? formatMetricValue(previous, i18n.locale, i18n.system)
                              : i18n.text('暂无数据')}
                            {previous && i18n.system(stateLabels[previous.state])
                              ? ' · ' + i18n.system(stateLabels[previous.state])
                              : ''}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            {comparison.fetching ? (
              <p role="status">{i18n.text('正在读取上周数据…')}</p>
            ) : comparison.error ? (
              <div className="notice red" role="alert">
                {i18n.fragment('上周数据读取失败。', false, true)}
                <Button onClick={comparison.refetch}>{i18n.text('重新读取')}</Button>
              </div>
            ) : (
              !comparison.previous && <p className="muted">{i18n.text('上周期间暂无数据。')}</p>
            )}
          </>
        ) : isRange ? (
          <>
            <div className={styles.dateFields}>
              <label>
                {i18n.fragment('开始日期', false, true)}
                <input
                  type="date"
                  required
                  value={start}
                  onChange={e => setStart(e.target.value)}
                />
              </label>
              <label>
                {i18n.fragment('结束日期', false, true)}
                <input type="date" required value={end} onChange={e => setEnd(e.target.value)} />
              </label>
            </div>
            <p className={styles.help}>
              {i18n.fragment('日期按 ', false, true)}
              {timezone}
              {i18n.fragment(' 时区统计，选择后应用到当前页面。', true, false)}
            </p>
          </>
        ) : isQuery ? (
          <>
            <div className="management-grid">
              <label>
                {i18n.fragment('查询关键词', false, true)}
                <input
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  placeholder={i18n.text('User-Agent、页面路径或状态码')}
                />
              </label>
              <label>
                {i18n.fragment('请求类型', false, true)}
                <select
                  aria-label={i18n.text('日志请求类型')}
                  value={logsFilter || '全部'}
                  onChange={e => onLogsFilter?.(e.target.value)}
                >
                  <option value="全部">{i18n.text('全部')}</option>
                  <option value="仅 AI 蜘蛛">{i18n.text('仅 AI 蜘蛛')}</option>
                  <option value="未知／未分类">{i18n.text('未知／未分类')}</option>
                  <option value="仅异常">{i18n.text('仅异常')}</option>
                </select>
              </label>
            </div>
            <p className={styles.help}>
              {i18n.text(
                '查询当前统计期间的已导入脱敏记录。“未知／未分类”显示未识别或存在多候选身份的请求。',
              )}
            </p>
            {report && (
              <div className={styles.logResults}>
                <div className={styles.logTable}>
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr>
                        {columns.logBody.map(([, label]) => (
                          <SortHeading key={label} className="px-4 py-3" label={label} />
                        ))}
                      </tr>
                    </thead>
                    <ReportRows
                      table="logBody"
                      report={report}
                      limit={report.meta.pageSize || 100}
                    />
                  </table>
                </div>
                <div className={styles.pagination}>
                  <span>
                    {isFetching
                      ? i18n.text('正在读取记录…')
                      : report.meta.logReadBoundary && typeof report.meta.totalLogs !== 'number'
                        ? i18n.text(
                            report.meta.logParts?.count === 'failed'
                              ? '无法读取此范围的数据'
                              : '正在读取记录…',
                          )
                        : i18n.text('共 ') +
                          (report.meta.totalLogs ?? report.tables.logBody?.length ?? 0) +
                          i18n.text(' 条 · 第 ') +
                          (report.meta.page || 1) +
                          i18n.text(' 页')}
                  </span>
                  <Button
                    disabled={(report.meta.page || 1) <= 1 || isFetching}
                    onClick={() => onPage?.((report.meta.page || 1) - 1)}
                  >
                    {i18n.text('上一页')}
                  </Button>
                  <Button
                    disabled={
                      (typeof report.meta.totalLogs === 'number'
                        ? (report.meta.page || 1) * (report.meta.pageSize || 100) >=
                          report.meta.totalLogs
                        : !report.meta.logHasMore) || isFetching
                    }
                    onClick={() => onPage?.((report.meta.page || 1) + 1)}
                  >
                    {i18n.text('下一页')}
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {!canManage && (
              <div className="notice amber">
                {i18n.text('当前账户可以查看，修改和导入需要网站管理权限。')}
              </div>
            )}
            <div className={'management-input-layout' + (isRules ? ' rules-layout' : '')}>
              <div className="management-input-main">
                {!settingsAction && (
                  <div className="management-grid">
                    <label>
                      {i18n.fragment('文件格式', false, true)}
                      <select
                        value={format}
                        onChange={e => setFormat(e.target.value)}
                        disabled={busy || !canManage}
                      >
                        {isCatalog ? (
                          <>
                            <option value="sitemap">Sitemap XML</option>
                            <option value="csv">{i18n.text('CSV 页面目录')}</option>
                            <option value="json">{i18n.text('JSON 页面目录')}</option>
                          </>
                        ) : (
                          <>
                            <option value="combined">Nginx / Apache Combined</option>
                            <option value="json">{i18n.text('JSON 日志记录')}</option>
                          </>
                        )}
                      </select>
                    </label>
                  </div>
                )}
                {(!isRules ||
                  (!conversionConfirmed &&
                    settings &&
                    ruleEditorConfiguration(settings).mode === 'legacy')) && (
                  <label>
                    {i18n.fragment('选择本地文件', false, true)}
                    <input
                      type="file"
                      accept={
                        isCatalog
                          ? '.xml,.csv,.json'
                          : isRules
                            ? '.json'
                            : settingsAction
                              ? '.txt'
                              : '.txt,.log,.json'
                      }
                      disabled={busy || !canManage}
                      onChange={async e => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        try {
                          if (!settingsAction && file.size > 10 * 1024 * 1024)
                            throw new Error('文件超过 10 MiB，请拆分后导入。');
                          const fileContent = await file.text();
                          setContent(
                            isRules ? `{"mode":"legacy","rules":${fileContent}}` : fileContent,
                          );
                          if (isRules) setConversionConfirmed(false);
                          setDirty(true);
                        } catch (error) {
                          setFailed(true);
                          setStatus(
                            error instanceof Error ? error.message : '无法读取文件，请重新选择。',
                          );
                        }
                      }}
                    />
                  </label>
                )}
                {isRules ? (
                  <>
                    <CrawlerRulesEditor
                      content={content}
                      officialRules={centralCatalog ? catalogBotRules(centralCatalog) : undefined}
                      knownIds={centralCatalog?.identities
                        .filter(item => item.kind !== 'robots_purpose')
                        .map(item => item.id)}
                      onConversionConfirmed={() => setConversionConfirmed(true)}
                      disabled={!canManage || busy || !settings}
                      onChange={value => {
                        setContent(value);
                        setDirty(true);
                      }}
                    />
                    <CrawlerCandidatesPanel websiteId={websiteId} />
                  </>
                ) : (
                  <label>
                    {action === 'robots.txt 编辑'
                      ? i18n.text('robots.txt 内容')
                      : action === '蜘蛛白名单'
                        ? i18n.text('CIDR 白名单')
                        : isCatalog
                          ? i18n.text('页面目录内容')
                          : i18n.text('访问日志内容')}
                    <textarea
                      value={content}
                      onChange={e => setContent(e.target.value)}
                      disabled={!canManage || busy || (settingsAction && !settings)}
                      required={!settingsAction}
                      spellCheck={false}
                      rows={12}
                      placeholder={i18n.system(
                        action === '蜘蛛白名单'
                          ? i18n.text('每行一个 CIDR，如 192.0.2.0/24')
                          : undefined,
                      )}
                    />
                  </label>
                )}
              </div>
              <aside className="management-guide">
                <h3>{settingsAction ? i18n.text('配置说明') : i18n.text('导入说明')}</h3>
                {action === 'robots.txt 编辑' ? (
                  <>
                    <p>{i18n.text('此配置保存到当前网站设置。')}</p>
                    <p>{i18n.text('下载 robots.txt 后，由网站管理员部署到目标网站根目录。')}</p>
                    <p>{i18n.text('最多 50,000 个字符。')}</p>
                  </>
                ) : action === '蜘蛛白名单' ? (
                  <>
                    <p>{i18n.text('每行填写一个合法的 IPv4 或 IPv6 CIDR，最多 100 条。')}</p>
                    <p>
                      {i18n.text(
                        '此名单保存在当前网站设置中，当前日志导入和请求拦截尚未使用该配置。',
                      )}
                    </p>
                  </>
                ) : isRules ? (
                  <>
                    <p>{i18n.text('官方目录随版本维护，规则用于后续日志识别。')}</p>
                    <p>{i18n.text('旧版规则保留顺序与匹配行为，转换需要预览并确认。')}</p>
                    <p>{i18n.text('规则版本：{v0}', [settings?.rulesRevision ?? 0])}</p>
                  </>
                ) : isCatalog ? (
                  <>
                    <p>{i18n.text('导入已发布页面目录，用于页面覆盖率与 AI 盲区分析。')}</p>
                    <p>{i18n.text('Sitemap XML 支持 urlset 页面列表，暂不支持 sitemap 索引。')}</p>
                    <p>{i18n.text('CSV / JSON 使用 url 或 path 字段，可附带已有内容元数据。')}</p>
                    <p>{i18n.text('文件最多 10 MiB、10,000 个页面；导入会新增或更新对应页面。')}</p>
                  </>
                ) : (
                  <>
                    <p>{i18n.text('确认日志属于当前网站，并选择对应格式。')}</p>
                    <p>{i18n.text('JSON 每批最多 1000 条；Combined 最多 10 MiB、10,000 行。')}</p>
                    <p>{i18n.text('原生 CDN 日志需先转换为支持的字段格式。')}</p>
                    <p>{i18n.text('校验后保存脱敏记录，结果分别显示新增、重复和拒绝数量。')}</p>
                  </>
                )}
              </aside>
            </div>
          </>
        )}
        {status && (
          <section
            className={'notice ' + (failed ? 'red' : totalErrors ? 'amber' : 'blue')}
            role={failed ? 'alert' : 'status'}
            aria-live="polite"
          >
            <strong>
              {failed
                ? i18n.text('操作未完成')
                : totalErrors
                  ? i18n.text('部分记录未导入')
                  : i18n.text('操作结果')}
            </strong>
            <p>{i18n.system(status)}</p>
            {importErrors.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{i18n.text('行号')}</th>
                      <th>{i18n.text('拒绝原因')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importErrors.map(error => (
                      <tr key={error.line}>
                        <td>{error.line}</td>
                        <td>{i18n.system(error.reason)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {totalErrors > importErrors.length && (
              <p>
                {i18n.fragment('显示前 ', false, true)}
                {importErrors.length}
                {i18n.unit(' 条错误，共拒绝 ', importErrors.length, true, true)}
                {totalErrors}
                {i18n.unit(' 条。', totalErrors, true, false)}
              </p>
            )}
          </section>
        )}
        <DialogActions>
          {settingsAction && !loadError && (
            <Button disabled={busy || dirty} onClick={() => setLoadVersion(value => value + 1)}>
              {i18n.text('重新读取设置')}
            </Button>
          )}
          {action === 'robots.txt 编辑' && (
            <button
              type="button"
              className="btn dialog-secondary-action"
              disabled={busy || !settings}
              onClick={() => downloadFile(content, 'robots.txt', 'text/plain;charset=utf-8')}
            >
              {i18n.text('下载 robots.txt')}
            </button>
          )}
          <ManagementClose
            label={isComparison ? i18n.text('关闭') : i18n.text('取消')}
            disabled={saving.current}
          />
          {!isComparison && (
            <button
              type="submit"
              form={formId}
              className="btn primary"
              disabled={
                busy || (settingsAction && !settings) || (!canManage && !isQuery && !isRange)
              }
            >
              {busy
                ? i18n.locale === 'en-US'
                  ? i18n.system(submitLabel) + '…'
                  : '正在' + submitLabel + '…'
                : i18n.system(submitLabel)}
            </button>
          )}
        </DialogActions>
      </form>
    </LiekanDialog>
  );
}
function ManagementClose({ label, disabled }: { label: string; disabled: boolean }) {
  const dialog = useDialog();
  return (
    <Button disabled={disabled} onClick={dialog?.requestClose}>
      {label}
    </Button>
  );
}
