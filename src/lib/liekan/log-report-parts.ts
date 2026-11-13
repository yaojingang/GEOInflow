import { isbot } from 'isbot';
import type { DataState, LiekanReport } from './contracts/report';
import { isUnknownCrawler } from './rules/population';

export function logEntryRows(recent: any[]): LiekanReport['tables']['logBody'] {
  return recent.map(row => ({
    ...row,
    ...(row.identityEvidence != null && typeof row.identityEvidence === 'object'
      ? { identityEvidence: JSON.stringify(row.identityEvidence) }
      : {}),
    time: row.time,
    classification: isUnknownCrawler(row)
      ? isbot(row.userAgent || '')
        ? '自动化特征 · 身份未核验'
        : '未知／未分类'
      : `${row.bot} · ${row.verification === 'verified_range' ? '官方 IP 范围匹配' : row.verification === 'verified_dns' ? '官方 DNS 双向核验' : row.verification === 'verified_edge' ? '可信边缘身份核验' : row.verification === 'range_mismatch' ? '官方范围未匹配' : '身份未核验'}`,
  }));
}

export function logSummaryView(input: {
  latest: unknown;
  catalogCount: number;
  logState: DataState;
  ruleCount: number;
  today: { accepted: number; abnormal: number };
}) {
  const { latest, catalogCount, logState, ruleCount, today } = input;
  return {
    cards: [
      {
        key: '日志处理能力',
        label: '日志处理能力',
        value: null,
        state: 'unsupported' as const,
        unit: '',
        detail: '单批 10 MiB / 10000 行；吞吐量待压测',
      },
      {
        key: '今日已解析',
        label: '今日已解析',
        value: latest ? today.accepted : null,
        state: logState,
        unit: '',
        detail: '今日导入的有效日志行数',
      },
      {
        key: '蜘蛛识别规则',
        label: '蜘蛛识别规则',
        value: ruleCount,
        state: 'available' as const,
        unit: '',
        detail: '所选统计范围',
      },
      {
        key: '异常请求（今日）',
        label: '异常请求（今日）',
        value: latest ? today.abnormal : null,
        state: logState,
        unit: '',
        detail: '已接入日志中状态码 ≥400 的请求',
      },
    ],
    pipeList: [
      {
        name: '日志导入',
        detail: latest ? '导入完成，主动刷新读取' : '支持 combined / JSON 单批导入',
        state: latest ? '已接入' : '待接入',
      },
      { name: '身份验证', detail: '官方 IP 范围核验；历史或过期依据保留未核验', state: '已接入' },
      {
        name: '内容目录',
        detail: `${catalogCount} 条目录记录`,
        state: catalogCount ? '已接入' : '待接入',
      },
    ],
  };
}
