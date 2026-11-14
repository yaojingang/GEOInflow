import packageJson from '../../../../package.json';
import { HELP_REVIEWED_AT, type HelpArticle } from '../help/types';

const { author, license, version } = packageJson;

export const liekanProduct = {
  name: 'GEOInflow',
  displayName: 'GEOInflow',
  version,
  displayVersion: version.replace(/\.0$/, ''),
  caption: 'GEO STATS',
  publishers: ['猎看科技', '北京日报社智源GEO'],
  copyright: `© 2026 ${author}`,
  license,
  links: {
    about: '/liekan/help?article=project-about',
    changelog: '/liekan/help?article=project-changelog',
    license: 'https://opensource.org/license/mit',
    upstream: 'https://github.com/umami-software/umami',
    help: '/liekan/help',
    author: 'https://x.com/yaojingang',
    coauthor: 'https://x.com/vista8',
    github: 'https://github.com/yaojingang/GEOInflow',
  },
} as const;

export type LiekanContributor = {
  login: string;
  avatarUrl: string;
  profileUrl: string;
};

export const liekanPublisherLinks = [
  { label: liekanProduct.publishers[0], href: 'https://www.liekan.com/?GEOInflow' },
  { label: liekanProduct.publishers[1], href: 'https://geo.takefoto.cn/?GEOInflow' },
] as const;

export const liekanProjectInitiators: readonly {
  name: string;
  initial: string;
  description: string;
  descriptionValues?: readonly string[];
  handle?: string;
  href?: string;
}[] = [
  {
    name: '姚金刚',
    initial: '姚',
    description: '{v0}创始人，《{v1}》作者，{v2}发起人',
    descriptionValues: ['猎看科技', 'AI营销：从SEO到GEO', '中国GEO大会'],
    handle: '@yaojingang',
    href: liekanProduct.links.author,
  },
  {
    name: '向阳乔木',
    initial: '木',
    description: '知名AI自媒体，《{v0}》作者，{v1}发起人',
    descriptionValues: ['AI营销：从SEO到GEO', '中国GEO大会'],
    handle: '@vista8',
    href: 'https://x.com/vista8',
  },
  {
    name: '任强',
    initial: '任',
    description: '{v0}负责人，{v1}副总经理',
    descriptionValues: ['北京日报智源GEO', '北京日报京报移动'],
  },
];

export const liekanFooterLinks = [
  { label: '更新日志', href: liekanProduct.links.changelog },
  { label: '姚金刚', href: liekanProduct.links.author },
  { label: '向阳乔木', href: liekanProduct.links.coauthor },
  { label: '帮助文档', href: liekanProduct.links.help },
  { label: '项目说明', href: liekanProduct.links.about },
  { label: 'IP Geolocation by DB-IP', href: 'https://db-ip.com' },
  {
    label: '地名数据：GeoNames（已整理）',
    href: 'https://www.geonames.org/',
  },
  { label: '地名数据许可：CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
] as const;

export const projectArticles: HelpArticle[] = [
  {
    id: 'project-about',
    section: 'start',
    title: '关于 GEOInflow',
    summary: '面向 GEO 增长的 AI 与搜索流量分析系统。',
    keywords: ['GEOInflow', '项目说明', '开源'],
    blocks: [
      {
        title: '项目与版本',
        paragraphs: [
          `${liekanProduct.name} 当前版本为 v${liekanProduct.displayVersion}。系统提供浏览器采集、账号权限、网站与团队、目标和漏斗，AI 抓取行为通过独立日志接入分析，搜索引荐通过浏览器来源数据分析。`,
        ],
      },
      {
        title: '数据与使用范围',
        paragraphs: [
          '浏览统计来自网站实际收到的采集数据，AI 抓取分析来自接入的服务器日志。缺少输入、当前期间无数据、估算和未支持的字段分别展示。演示站使用独立的示例数据标识。',
        ],
      },
      {
        title: '开源许可',
        paragraphs: [
          'GEOInflow 使用 MIT 许可。第三方图表、字体、组件与地理数据适用各自的许可。',
          liekanProduct.copyright,
          '本版提供站内帮助和更新日志；项目公开仓库链接将在发布后补充。',
        ],
      },
    ],
    sources: [{ label: '作者 X 主页', url: liekanProduct.links.author }],
    related: ['project-changelog', 'connect-website', 'reading-data'],
    reviewedAt: HELP_REVIEWED_AT,
  },
  {
    id: 'project-changelog',
    section: 'start',
    title: 'GEOInflow 更新日志',
    summary: '查阅已发布版本的主要变化。',
    keywords: ['更新', '版本', 'changelog', 'release'],
    blocks: [
      {
        title: 'v1.2',
        paragraphs: [
          '系统名称统一为 GEOInflow，页脚增加联合发布署名。登录、分享、帮助及中英文界面同步更新品牌展示。',
          '工程版本为 1.2.0，构建与镜像版本同步更新。已有账号、统计数据、采集接口和部署配置继续兼容。',
        ],
      },
      {
        title: '0.2.4',
        paragraphs: [
          '完整登录状态保留 90 天，同一浏览器再次打开后台自动恢复登录。主动退出和密码变更后需要重新登录。',
          '临时网络或服务故障保留已保存的登录凭据，双重验证完成后进入后台。',
        ],
      },
      {
        title: '0.2.3',
        paragraphs: [
          '创建链接、像素和看板可选择有权限的所属空间，创建及看板编辑等待空间和来源加载完成。详情进入分析工具后保留原模块的返回入口。',
          '切换网站保留日期与网站列表条件，修复重复退出影响新会话和后退时保留过期网站切换确认的问题。',
        ],
      },
      {
        title: '0.2.2',
        paragraphs: [
          '统一全局管理、网站分析、个人账户和系统管理的导航层级。网站信息与切换入口集中展示，跨网站切换清除原网站条件。',
          '网站设置按基本信息、安装接入、采集设置、分享设置和危险操作组织，统一数据缺失状态、操作文案和移动端导航。',
        ],
      },
      {
        title: '0.2.0',
        paragraphs: [
          '接入 GEO 统计和补充 UI，统一身份安全、访客分析、目标漏斗、工作台、协作和分享。新增完整导出、路径明细、精确滚动与来源地域统计。',
          '分享密码使用哈希保存，分享请求实时校验权限、资源归属和可见范围。',
        ],
      },
    ],
    sources: [],
    related: ['project-about'],
    reviewedAt: HELP_REVIEWED_AT,
  },
];
