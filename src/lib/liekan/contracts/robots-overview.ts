import type { CrawlerAnalysisResponse } from './crawler-analysis';
import type { RobotsManagement } from './robots-management';
import { checkRobotsAccess, parseRobots } from '../crawlers/robots';

export interface RobotsOverviewRange {
  startAt: number;
  endAt: number;
  timezone: string;
}
export interface RobotsAdvice {
  id: string;
  tone: 'info' | 'amber';
  title: string;
  detail: string;
  values?: (string | number)[];
}
export interface RobotsRuleSample {
  bot: string;
  path: string;
  allowed: boolean;
  requests: number;
  denied: number;
}
export function robotsPublicUrl(host: string) {
  const url = new URL(`https://${host}/robots.txt`);
  if (
    url.hostname !== host ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/robots.txt'
  )
    throw new Error('Invalid robots hostname');
  return url.href;
}
export function robotsOverviewRange(
  input?: RobotsOverviewRange,
  now = Date.now(),
): RobotsOverviewRange {
  const endAt = Math.min(input?.endAt ?? now, now);
  const startAt = Math.max(0, input?.startAt ?? endAt - 7 * 86400000, endAt - 90 * 86400000);
  return Number.isSafeInteger(startAt) && Number.isSafeInteger(endAt) && startAt < endAt
    ? { startAt, endAt, timezone: input?.timezone || 'Asia/Shanghai' }
    : { startAt: now - 7 * 86400000, endAt: now, timezone: 'Asia/Shanghai' };
}
export function robotsOverview(data: RobotsManagement, analysis?: CrawlerAnalysisResponse | null) {
  const advice: RobotsAdvice[] = [],
    samples: RobotsRuleSample[] = [];
  const sameHost = data.observedHostname === data.hostname;
  let document: ReturnType<typeof parseRobots> | null = null;
  if (sameHost && data.observedStatus === 200 && data.observedContent !== null) {
    try {
      document = parseRobots(data.observedContent);
    } catch {
      /* The file remains available for manual inspection. */
    }
  }
  const fileState =
    !sameHost || data.observedStatus === null
      ? 'not_checked'
      : data.observedStatus === 404
        ? 'missing'
        : document
          ? 'available'
          : 'unsupported';
  if (fileState === 'not_checked')
    advice.push({
      id: 'read',
      tone: 'info',
      title: '先读取当前网站的线上文件',
      detail: '完成域名 TXT 验证后读取公开地址，建议将依据实际文件快照生成。',
    });
  else if (fileState === 'missing')
    advice.push({
      id: 'missing',
      tone: 'info',
      title: '按网站需要建立抓取规则',
      detail: '公开地址返回 404。可在管理页为指定蜘蛛和目录生成草稿，核对后发布。',
    });
  else if (!document || document.issues.length)
    advice.push({
      id: 'syntax',
      tone: 'amber',
      title: '核对文件语法与解析范围',
      detail: '当前文件存在无法可靠解析的内容，请在管理页检查原文后再调整策略。',
    });
  if (data.lastError)
    advice.push({
      id: 'stale',
      tone: 'amber',
      title: '更新线上检查结果',
      detail: '最近一次检查失败。文件概览保留上次成功快照，请重新读取后确认建议。',
    });
  const requests = analysis?.bots.reduce((sum, bot) => sum + bot.requests, 0) ?? null;
  if (analysis?.quality.state === 'missing')
    advice.push({
      id: 'input',
      tone: 'info',
      title: '先补充爬虫日志数据',
      detail: '所选期间缺少爬虫日志，当前无法判断实际抓取量、响应和规则影响。',
    });
  else if (analysis && analysis.quality.state !== 'complete')
    advice.push({
      id: 'quality',
      tone: 'info',
      title: '结合数据覆盖范围评估建议',
      detail: '采集连续性尚未完整确认。下面的请求数和冲突线索仅来自已接收日志。',
    });
  if (analysis && requests === 0 && analysis.quality.state === 'complete')
    advice.push({
      id: 'zero',
      tone: 'info',
      title: '当前期间没有已识别的蜘蛛请求',
      detail: '已确认的日志范围内未观察到蜘蛛访问，可结合网站发布计划继续观察。',
    });
  let deniedAllowed = 0,
    successfulBlocked = 0;
  if (document && !document.issues.length && analysis) {
    const directory = new Map(analysis.directory.map(bot => [bot.id, bot]));
    for (const page of analysis.pages.slice(0, 100)) {
      const bot = directory.get(page.botId);
      if (!bot?.robotsToken) continue;
      try {
        const result = checkRobotsAccess(document, bot.robotsToken, page.path);
        if (
          result.issues.length ||
          result.caveat ||
          bot.robotsApplicability === 'user_triggered_caveat'
        )
          continue;
        if (result.allowed) deniedAllowed += page.denied403429;
        else successfulBlocked += page.successfulGets;
        if (samples.length < 8)
          samples.push({
            bot: bot.name,
            path: page.path,
            allowed: result.allowed,
            requests: page.requests,
            denied: page.denied403429,
          });
      } catch {
        /* Unknown tokens remain outside the evaluated sample. */
      }
    }
    if (deniedAllowed)
      advice.push({
        id: 'http',
        tone: 'amber',
        title: '核对允许路径的 403 / 429 响应',
        detail:
          '抽样路径的当前规则允许访问，所选期间记录到 {v0} 次 403 / 429。请核对源站、WAF、限流及蜘蛛身份。',
        values: [deniedAllowed],
      });
    if (successfulBlocked)
      advice.push({
        id: 'history',
        tone: 'amber',
        title: '核对当前禁止规则与历史成功抓取',
        detail:
          '当前规则禁止的抽样路径，在所选期间有 {v0} 次成功 GET。请核对规则发布时间、缓存及蜘蛛遵守情况。',
        values: [successfulBlocked],
      });
    const critical = analysis.criticalPaths.slice(0, 20);
    const observed = new Set(analysis.bots.filter(bot => bot.requests > 0).map(bot => bot.botId));
    let blockedCritical = 0;
    for (const bot of analysis.directory.filter(
      bot => observed.has(bot.id) && ['search', 'traditional_search'].includes(bot.type),
    )) {
      if (!bot.robotsToken || bot.robotsApplicability === 'user_triggered_caveat') continue;
      for (const path of critical)
        try {
          if (!checkRobotsAccess(document, bot.robotsToken, path).allowed) blockedCritical++;
        } catch {
          /* Keep unrecognized tokens unknown. */
        }
    }
    if (blockedCritical)
      advice.push({
        id: 'critical',
        tone: 'amber',
        title: '检查关键公开路径的搜索抓取规则',
        detail:
          '已配置的关键公开路径中，有 {v0} 组搜索蜘蛛规则显示禁止。如页面期望被搜索发现，可在管理页核对允许范围。',
        values: [blockedCritical],
      });
    if (samples.length && !deniedAllowed && !successfulBlocked && !blockedCritical)
      advice.push({
        id: 'sample',
        tone: 'info',
        title: '抽样路径暂未发现直接规则冲突',
        detail:
          '已对照当前文件检查 {v0} 组蜘蛛与路径样本。全站覆盖和蜘蛛实际执行情况仍需结合日志核对。',
        values: [samples.length],
      });
  }
  return {
    fileState,
    groups: document?.groups.length ?? null,
    allowRules:
      document?.groups.reduce(
        (sum, group) => sum + group.rules.filter(rule => rule.directive === 'allow').length,
        0,
      ) ?? null,
    disallowRules:
      document?.groups.reduce(
        (sum, group) => sum + group.rules.filter(rule => rule.directive === 'disallow').length,
        0,
      ) ?? null,
    issues: document?.issues ?? [],
    advice,
    samples,
    requests:
      analysis && (analysis.quality.state === 'complete' || analysis.bots.length > 0)
        ? requests
        : null,
    denied:
      analysis && (analysis.quality.state === 'complete' || analysis.bots.length > 0)
        ? analysis.bots.reduce((sum, bot) => sum + bot.denied403429, 0)
        : null,
  };
}
