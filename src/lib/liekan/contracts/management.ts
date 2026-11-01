import ipaddr from 'ipaddr.js';

export const managementLabels: Record<string, string> = {
  导入日志: '导入网站日志',
  'sitemap 管理': '管理内容目录',
  'robots.txt 编辑': '编辑 robots.txt',
  蜘蛛白名单: '管理蜘蛛',
  特征库管理: '蜘蛛识别规则',
  解析规则: '蜘蛛识别规则',
  日志查询: '查询访问日志',
  统计范围: '选择日期范围',
  对比上周: '与上周对比',
};

export function parseEditableAllowlist(content: string): string[] {
  const lines = content
    .split('\n')
    .map((value, index) => ({ value: value.trim(), line: index + 1 }))
    .filter(({ value }) => value);
  if (lines.length > 100) throw new Error('白名单最多 100 条，请减少条目后保存。');
  for (const { value, line } of lines) {
    try {
      if (value.length > 80) throw new Error();
      ipaddr.parseCIDR(value);
    } catch {
      throw new Error(`第 ${line} 行 CIDR 无效，请填写合法的 IPv4 或 IPv6 网段。`);
    }
  }
  return lines.map(({ value }) => value);
}

export const botRuleTypes = ['训练', '搜索', '用户触发', '传统搜索', '其他'] as const;
export type EditableBotRule = Record<string, unknown> & {
  name: string;
  vendor: string;
  type: string;
  pattern: string;
};

export function parseEditableRules(content: string): EditableBotRule[] {
  let rules: unknown;
  try {
    rules = JSON.parse(content);
  } catch {
    throw new Error('JSON 格式无效，请检查引号、逗号和括号。');
  }
  if (!Array.isArray(rules) || rules.length > 100)
    throw new Error('规则须为 JSON 数组，最多 100 条。');
  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule))
      throw new Error(`第 ${index + 1} 条规则格式无效。`);
    for (const [key, label] of [
      ['name', '蜘蛛名称'],
      ['vendor', '厂商'],
      ['type', '类型'],
      ['pattern', 'UA 匹配词'],
    ]) {
      if (typeof rule[key] !== 'string' || !rule[key].length || rule[key].length > 80)
        throw new Error(`第 ${index + 1} 条规则的${label}须为 1 至 80 个字符。`);
    }
    if (!botRuleTypes.includes(rule.type)) throw new Error(`第 ${index + 1} 条规则类型无效。`);
  }
  return rules;
}
