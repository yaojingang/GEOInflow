import { translateText, translateSystemText } from '@/lib/liekan/i18n/text';
import type { LiekanLocale } from '@/lib/liekan/i18n/locale';
import { searchPlatforms } from '@/lib/liekan/contracts/search-engines';
import type { ChartData } from './types';

const INK = '#16181D',
  SUB = '#697386',
  FAINT = '#9AA3B2',
  LINE = '#E9ECF1';
const B = '#0F62FE',
  B2 = '#4589FF',
  TEAL = '#009D9A',
  PUR = '#7C5CFC',
  AMBER = '#B7791F',
  RED = '#F04452',
  GREEN = '#0E9F6E',
  GRAY = '#9AA3B2';
const TT = {
  trigger: 'axis',
  backgroundColor: '#fff',
  borderColor: LINE,
  textStyle: { color: INK, fontSize: 12 },
};
const TTi = {
  trigger: 'item',
  backgroundColor: '#fff',
  borderColor: LINE,
  textStyle: { color: INK, fontSize: 12 },
};
function escapeChart(value: unknown) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value],
  );
}
function referenceChartOptions(id: string, chart: ChartData, locale: LiekanLocale = 'zh-CN'): any {
  switch (id) {
    case 'b1':
      return {
        tooltip: Object.assign({}, TTi, {
          formatter: translateText('{b}<br>{c} 次（{d}%）', locale),
        }),
        legend: {
          bottom: 4,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 11, color: SUB },
        },
        series: [
          {
            type: 'pie',
            radius: ['50%', '72%'],
            center: ['50%', '44%'],
            label: { show: false },
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
            data: chart.labels.map((name, index) => ({
              name,
              value: chart.series[0]?.values[index],
              itemStyle: [{ color: PUR }, { color: B }, { color: TEAL }, { color: RED }][index % 4],
            })),
          },
        ],
      };
    case 'ap1':
      return {
        tooltip: TT,
        grid: { left: 110, right: 40, top: 20, bottom: 26 },
        xAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 10.5 },
        },
        yAxis: {
          type: 'category',
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: SUB, fontSize: 11 },
        },
        series: [
          {
            name: chart.series[0]?.name || translateText('抓取次数', locale),
            type: 'bar',
            barWidth: 14,
            itemStyle: { color: PUR, borderRadius: [0, 4, 4, 0] },
            label: { show: true, position: 'right', fontSize: 10, color: SUB },
            data: chart.series[0]?.values || [],
          },
        ],
      };
    case 'pf1':
      return {
        tooltip: TT,
        legend: {
          top: 2,
          right: 8,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 11, color: SUB },
        },
        grid: { left: 44, right: 20, top: 34, bottom: 26 },
        xAxis: {
          type: 'category',
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: FAINT, fontSize: 10, rotate: 18 },
        },
        yAxis: {
          type: 'value',
          name: translateText('占比%', locale),
          nameTextStyle: { color: FAINT, fontSize: 10 },
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 10.5 },
        },
        series: [
          {
            name: chart.series[0]?.name || translateText('AI 蜘蛛', locale),
            type: 'bar',
            barWidth: 14,
            itemStyle: { color: PUR, borderRadius: [4, 4, 0, 0] },
            data: chart.series[0]?.values || [],
          },
          {
            name: chart.series[1]?.name || translateText('访客', locale),
            type: 'bar',
            barWidth: 14,
            itemStyle: { color: '#C7DBFF', borderRadius: [4, 4, 0, 0] },
            data: chart.series[1]?.values || [],
          },
        ],
      };
    case 'pf2':
      return {
        tooltip: Object.assign({}, TTi, {
          formatter: (p: any) =>
            escapeChart(p.data[3]) +
            translateText('<br>字数 ', locale) +
            p.data[0] +
            translateText(' · 结构化 ', locale) +
            p.data[1] +
            translateText(' 分<br>抓取 ', locale) +
            p.data[2] +
            translateText(' 次', locale),
        }),
        grid: { left: 48, right: 24, top: 26, bottom: 40 },
        xAxis: {
          type: 'value',
          name: translateText('字数', locale),
          nameTextStyle: { color: FAINT, fontSize: 10 },
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 10 },
        },
        yAxis: {
          type: 'value',
          name: translateText('结构化评分', locale),
          nameTextStyle: { color: FAINT, fontSize: 10 },
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 10 },
        },
        series: [
          {
            type: 'scatter',
            symbolSize: d => Math.sqrt(d[2]) / 2.2,
            itemStyle: { color: 'rgba(124,92,252,0.55)', borderColor: PUR, borderWidth: 1 },
            data: (chart.rows || []).map(row => [
              row.words,
              row.structureScore,
              row.requests,
              row.path,
            ]),
          },
        ],
      };
    case 'a1':
      return {
        tooltip: TT,
        legend: {
          top: 2,
          right: 8,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 11, color: SUB },
        },
        grid: { left: 44, right: 20, top: 34, bottom: 26 },
        xAxis: {
          type: 'category',
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: FAINT, fontSize: 10, interval: 4 },
        },
        yAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 11 },
        },
        series: [
          {
            name: chart.series[0]?.name || 'GPTBot',
            type: 'line',
            smooth: true,
            symbol: 'none',
            lineStyle: { width: 2.5, color: B },
            itemStyle: { color: B },
            data: chart.series[0]?.values || [],
          },
          {
            name: chart.series[1]?.name || 'Bytespider',
            type: 'line',
            smooth: true,
            symbol: 'none',
            lineStyle: { width: 2.5, color: TEAL },
            itemStyle: { color: TEAL },
            data: chart.series[1]?.values || [],
          },
          {
            name: chart.series[2]?.name || 'ClaudeBot',
            type: 'line',
            smooth: true,
            symbol: 'none',
            lineStyle: { width: 2, color: PUR },
            itemStyle: { color: PUR },
            data: chart.series[2]?.values || [],
          },
          {
            name: chart.series[3]?.name || 'Baiduspider',
            type: 'line',
            smooth: true,
            symbol: 'none',
            lineStyle: { width: 2, color: AMBER },
            itemStyle: { color: AMBER },
            data: chart.series[3]?.values || [],
          },
          {
            name: chart.series[4]?.name || 'PerplexityBot',
            type: 'line',
            smooth: true,
            symbol: 'none',
            lineStyle: { width: 2, color: B2 },
            itemStyle: { color: B2 },
            data: chart.series[4]?.values || [],
          },
        ],
      };
    case 'a2':
      return {
        tooltip: Object.assign({}, TT, { valueFormatter: v => `${v}%` }),
        grid: { left: 40, right: 16, top: 30, bottom: 26 },
        xAxis: {
          type: 'category',
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: FAINT, fontSize: 10.5 },
        },
        yAxis: {
          type: 'value',
          max: 40,
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 10.5 },
        },
        series: [
          {
            name: chart.series[0]?.name || translateText('AI 占比', locale),
            type: 'bar',
            barWidth: 22,
            itemStyle: { color: B, borderRadius: [4, 4, 0, 0] },
            label: { show: true, position: 'top', fontSize: 10, color: SUB, formatter: '{c}%' },
            data: chart.series[0]?.values || [],
          },
        ],
      };
    case 'a3':
      return {
        tooltip: TT,
        grid: { left: 44, right: 16, top: 26, bottom: 26 },
        xAxis: {
          type: 'category',
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: FAINT, fontSize: 9, interval: 2 },
        },
        yAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 10.5 },
        },
        series: [
          {
            name: chart.series[0]?.name || translateText('抓取次数', locale),
            type: 'bar',
            barWidth: 9,
            itemStyle: {
              color: p => (p.dataIndex >= 2 && p.dataIndex <= 6 ? PUR : B2),
              borderRadius: [3, 3, 0, 0],
            },
            data: chart.series[0]?.values || [],
          },
        ],
      };
    case 'a4':
      return {
        tooltip: Object.assign({}, TTi, {
          formatter: translateText('{b}<br>{c} 次（{d}%）', locale),
        }),
        legend: {
          bottom: 4,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 11, color: SUB },
        },
        series: [
          {
            type: 'pie',
            radius: ['50%', '72%'],
            center: ['50%', '44%'],
            label: { show: false },
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
            data: chart.labels.map((name, index) => ({
              name,
              value: chart.series[0]?.values[index],
              itemStyle: [{ color: GREEN }, { color: B2 }, { color: AMBER }, { color: RED }][
                index % 4
              ],
            })),
          },
        ],
      };
    case 'c1':
      return {
        tooltip: TT,
        grid: { left: 44, right: 20, top: 30, bottom: 26 },
        xAxis: {
          type: 'category',
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: FAINT, fontSize: 10 },
        },
        yAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 10.5 },
        },
        series: [
          {
            name: chart.series[0]?.name || translateText('发布内容 PV（7天）', locale),
            type: 'bar',
            barWidth: 18,
            itemStyle: { color: B, borderRadius: [4, 4, 0, 0] },
            data: chart.series[0]?.values || [],
          },
          {
            name: chart.series[1]?.name || translateText('AI 抓取增量', locale),
            type: 'line',
            smooth: true,
            symbol: 'circle',
            symbolSize: 5,
            lineStyle: { width: 2.5, color: PUR },
            itemStyle: { color: PUR },
            data: chart.series[1]?.values || [],
          },
        ],
      };
    case 'f1':
      return {
        tooltip: Object.assign({}, TTi, { formatter: translateText('{b}<br>{c} 会话', locale) }),
        series: [
          {
            type: 'funnel',
            left: '6%',
            right: '6%',
            top: 12,
            bottom: 8,
            minSize: '22%',
            maxSize: '96%',
            gap: 4,
            label: {
              show: true,
              position: 'inside',
              fontSize: 11,
              color: '#fff',
              formatter: '{b}\n{c}',
            },
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
            data: chart.labels.map((name, index) => ({
              name,
              value: chart.series[0]?.values[index],
              itemStyle: [
                { color: '#C7DBFF' },
                { color: '#7FA8FF' },
                { color: '#4589FF' },
                { color: '#0F62FE' },
                { color: '#0B4BC4' },
              ][index % 5],
            })),
          },
        ],
      };
    case 'f2':
      return {
        tooltip: Object.assign({}, TT, { valueFormatter: v => `${v}%` }),
        grid: { left: 44, right: 20, top: 26, bottom: 26 },
        xAxis: {
          type: 'category',
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: FAINT, fontSize: 10, rotate: 14 },
        },
        yAxis: {
          type: 'value',
          max: 5,
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 10.5, formatter: '{value}%' },
        },
        series: [
          {
            name: chart.series[0]?.name || translateText('转化率', locale),
            type: 'bar',
            barWidth: 24,
            itemStyle: { color: p => (p.dataIndex === 0 ? PUR : B), borderRadius: [4, 4, 0, 0] },
            label: { show: true, position: 'top', fontSize: 10.5, color: SUB, formatter: '{c}%' },
            data: chart.series[0]?.values || [],
          },
        ],
      };
    case 'f3':
      return {
        tooltip: TT,
        grid: { left: 40, right: 16, top: 26, bottom: 26 },
        xAxis: {
          type: 'category',
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: FAINT, fontSize: 10, interval: 4 },
        },
        yAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 10.5 },
        },
        series: [
          {
            name: chart.series[0]?.name || translateText('转化数', locale),
            type: 'line',
            smooth: true,
            symbol: 'none',
            lineStyle: { width: 2.5, color: GREEN },
            itemStyle: { color: GREEN },
            areaStyle: { color: 'rgba(14,159,110,0.08)' },
            data: chart.series[0]?.values || [],
          },
        ],
      };
    case 'g1':
      return {
        tooltip: Object.assign({}, TT, {
          formatter: (ps: any) => {
            const p = ps[0];
            const rate = chart.rows?.[p.dataIndex]?.conversionRate;
            return (
              escapeChart(p.name) +
              translateText('<br>会话 ', locale) +
              p.value +
              translateText('<br>转化率 ', locale) +
              (rate == null ? translateText('待配置目标', locale) : `${rate}%`)
            );
          },
        }),
        grid: { left: 64, right: 56, top: 20, bottom: 26 },
        xAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 10.5 },
        },
        yAxis: {
          type: 'category',
          inverse: true,
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: SUB, fontSize: 11 },
        },
        series: [
          {
            name: chart.series[0]?.name || translateText('会话', locale),
            type: 'bar',
            barWidth: 13,
            itemStyle: {
              color: p =>
                [
                  '#0F62FE',
                  '#4589FF',
                  '#7FA8FF',
                  '#A6C2FF',
                  '#C7DBFF',
                  '#C7DBFF',
                  '#C7DBFF',
                  '#C7DBFF',
                  '#C7DBFF',
                  '#C7DBFF',
                ][p.dataIndex],
              borderRadius: [0, 4, 4, 0],
            },
            label: { show: true, position: 'right', fontSize: 10, color: SUB },
            data: chart.series[0]?.values || [],
          },
        ],
      };
    case 'g2':
      return {
        tooltip: Object.assign({}, TTi, {
          formatter: translateText('{b}<br>{c} 会话（{d}%）', locale),
        }),
        legend: {
          bottom: 4,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 10.5, color: SUB },
        },
        series: [
          {
            type: 'pie',
            radius: ['48%', '70%'],
            center: ['50%', '42%'],
            label: { show: false },
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
            data: chart.labels.map((name, index) => ({
              name,
              value: chart.series[0]?.values[index],
              itemStyle: [
                { color: B },
                { color: TEAL },
                { color: PUR },
                { color: AMBER },
                { color: B2 },
                { color: GREEN },
                { color: GRAY },
                { color: '#D9DEE7' },
              ][index % 8],
            })),
          },
        ],
      };
    case 's1':
      return {
        tooltip: TT,
        legend: {
          top: 2,
          right: 8,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 11, color: SUB },
        },
        grid: { left: 44, right: 20, top: 34, bottom: 26 },
        xAxis: {
          type: 'category',
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: FAINT, fontSize: 10, interval: 4 },
        },
        yAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 11 },
        },
        series: [
          {
            name: chart.series[0]?.name || translateText('直接访问', locale),
            type: 'bar',
            stack: 's',
            barWidth: 8,
            itemStyle: { color: '#C7DBFF' },
            data: chart.series[0]?.values || [],
          },
          {
            name: chart.series[1]?.name || translateText('传统搜索', locale),
            type: 'bar',
            stack: 's',
            itemStyle: { color: B2 },
            data: chart.series[1]?.values || [],
          },
          {
            name: chart.series[2]?.name || translateText('外部链接/社交', locale),
            type: 'bar',
            stack: 's',
            itemStyle: { color: TEAL },
            data: chart.series[2]?.values || [],
          },
          {
            name: chart.series[3]?.name || translateText('AI 搜索引荐', locale),
            type: 'bar',
            stack: 's',
            itemStyle: { color: PUR, borderRadius: [3, 3, 0, 0] },
            data: chart.series[3]?.values || [],
          },
        ],
      };
    case 'se1':
    case 'se2': {
      const total =
        chart.series[0]?.values.reduce<number>((sum, value) => sum + (value ?? 0), 0) || 0;
      const share = (value: number) => (total ? Math.round((value / total) * 10000) / 100 : 0);
      const platforms = searchPlatforms.filter(
        platform => platform.channel === (id === 'se1' ? '传统搜索' : 'AI 搜索引荐'),
      );
      const palette = [B, PUR, TEAL, AMBER, B2, GREEN, RED, GRAY, '#7FA8FF'];
      return {
        tooltip: {
          ...TTi,
          formatter: (item: any) =>
            translateText('{v0}<br>{v1} 会话（{v2}%）', locale, [
              escapeChart(item.name),
              item.value,
              share(item.value),
            ]),
        },
        legend: {
          type: 'scroll',
          selectedMode: false,
          left: 16,
          right: 16,
          bottom: 4,
          pageIconSize: 10,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 10.5, color: SUB },
          formatter: (name: string) =>
            `${name} ${share(chart.series[0]?.values[chart.labels.indexOf(name)] || 0)}%`,
        },
        series: [
          {
            type: 'pie',
            radius: ['48%', '70%'],
            center: ['50%', '42%'],
            label: { show: false },
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
            data: chart.labels.map((name, index) => ({
              name,
              value: chart.series[0]?.values[index],
              itemStyle: {
                color: palette[platforms.findIndex(platform => platform.name === name)] || GRAY,
              },
            })),
          },
        ],
      };
    }
    case 's2':
      return {
        tooltip: Object.assign({}, TTi, {
          formatter: translateText('{b}<br>{c} 会话（{d}%）', locale),
        }),
        legend: {
          type: 'scroll',
          orient: 'horizontal',
          left: 16,
          right: 16,
          bottom: 4,
          pageIconSize: 10,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 10.5, color: SUB },
        },
        series: [
          {
            type: 'pie',
            radius: ['48%', '70%'],
            center: ['50%', '42%'],
            label: { show: false },
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
            data: chart.labels.map((name, index) => ({
              name,
              value: chart.series[0]?.values[index],
              itemStyle: [
                { color: B },
                { color: PUR },
                { color: TEAL },
                { color: AMBER },
                { color: B2 },
                { color: GRAY },
              ][index % 6],
            })),
          },
        ],
      };
    case 'h1':
      return {
        tooltip: TT,
        legend: {
          top: 2,
          right: 8,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 11, color: SUB },
        },
        grid: { left: 48, right: 48, top: 34, bottom: 26 },
        xAxis: {
          type: 'category',
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: FAINT, fontSize: 10, interval: 4 },
        },
        yAxis: [
          {
            type: 'value',
            splitLine: { lineStyle: { color: LINE } },
            axisLabel: { color: FAINT, fontSize: 10.5 },
          },
          {
            type: 'value',
            min: 30,
            max: 50,
            splitLine: { show: false },
            axisLabel: { color: FAINT, fontSize: 10.5, formatter: '{value}%' },
          },
        ],
        series: [
          {
            name: chart.series[0]?.name || 'PV',
            type: 'bar',
            barWidth: 8,
            itemStyle: { color: '#C7DBFF', borderRadius: [3, 3, 0, 0] },
            data: chart.series[0]?.values || [],
          },
          {
            name: chart.series[1]?.name || 'UV',
            type: 'line',
            smooth: true,
            symbol: 'none',
            lineStyle: { width: 2.5, color: B },
            itemStyle: { color: B },
            data: chart.series[1]?.values || [],
          },
          {
            name: chart.series[2]?.name || translateText('跳出率', locale),
            type: 'line',
            yAxisIndex: 1,
            smooth: true,
            symbol: 'none',
            lineStyle: { width: 2, color: AMBER, type: 'dashed' },
            itemStyle: { color: AMBER },
            data: chart.series[2]?.values || [],
          },
        ],
      };
    case 'h2':
      return {
        tooltip: TT,
        grid: { left: 44, right: 16, top: 26, bottom: 26 },
        xAxis: {
          type: 'category',
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: FAINT, fontSize: 9, interval: 2 },
        },
        yAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 10.5 },
        },
        series: [
          {
            name: chart.series[0]?.name || translateText('会话数', locale),
            type: 'bar',
            barWidth: 9,
            itemStyle: { color: B2, borderRadius: [3, 3, 0, 0] },
            data: chart.series[0]?.values || [],
          },
        ],
      };
    case 'h3':
      return {
        tooltip: Object.assign({}, TTi, {
          formatter: translateText('{b}<br>{c} 会话（{d}%）', locale),
        }),
        legend: {
          bottom: 4,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 11, color: SUB },
        },
        series: [
          {
            type: 'pie',
            radius: ['50%', '72%'],
            center: ['50%', '44%'],
            label: { show: false },
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
            data: chart.labels.map((name, index) => ({
              name,
              value: chart.series[0]?.values[index],
              itemStyle: [{ color: B }, { color: TEAL }, { color: GRAY }][index % 3],
            })),
          },
        ],
      };
    case 'd1':
      return {
        tooltip: TT,
        legend: {
          top: 2,
          right: 8,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 11, color: SUB },
        },
        grid: { left: 52, right: 20, top: 34, bottom: 26 },
        xAxis: {
          type: 'category',
          data: chart.labels,
          axisLine: { lineStyle: { color: LINE } },
          axisTick: { show: false },
          axisLabel: { color: FAINT, fontSize: 10, interval: 4 },
        },
        yAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: LINE } },
          axisLabel: { color: FAINT, fontSize: 11 },
        },
        series: [
          {
            name: chart.series[0]?.name || translateText('浏览 PV', locale),
            type: 'bar',
            stack: 'a',
            barWidth: 8,
            itemStyle: { color: '#C7DBFF' },
            data: chart.series[0]?.values || [],
          },
          {
            name: chart.series[1]?.name || translateText('AI 蜘蛛请求', locale),
            type: 'bar',
            stack: 'a',
            itemStyle: { color: B, borderRadius: [3, 3, 0, 0] },
            data: chart.series[1]?.values || [],
          },
        ],
      };
    case 'd2':
      return {
        tooltip: Object.assign({}, TTi, {
          formatter: translateText('{b}<br>{c} 次（{d}%）', locale),
        }),
        legend: {
          type: 'scroll',
          left: 16,
          right: 16,
          bottom: 4,
          pageIconSize: 10,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 11, color: SUB },
          data: chart.labels
            .map((name, index) => ({ name, value: chart.series[0]?.values[index] ?? 0 }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 5)
            .map(row => row.name),
        },
        series: [
          {
            type: 'pie',
            radius: ['50%', '72%'],
            center: ['50%', '44%'],
            label: { show: false },
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
            data: chart.labels.map((name, index) => ({
              name,
              value: chart.series[0]?.values[index],
              itemStyle: [
                { color: B },
                { color: TEAL },
                { color: PUR },
                { color: AMBER },
                { color: B2 },
                { color: GRAY },
              ][index % 6],
            })),
          },
        ],
      };
    case 'd3':
      return {
        tooltip: Object.assign({}, TTi, {
          formatter: translateText('{b}<br>{c} 会话（{d}%）', locale),
        }),
        legend: {
          bottom: 4,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { fontSize: 11, color: SUB },
        },
        series: [
          {
            type: 'pie',
            radius: ['50%', '72%'],
            center: ['50%', '44%'],
            label: { show: false },
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
            data: chart.labels.map((name, index) => ({
              name,
              value: chart.series[0]?.values[index],
              itemStyle: [
                { color: B },
                { color: TEAL },
                { color: PUR },
                { color: AMBER },
                { color: GRAY },
              ][index % 5],
            })),
          },
        ],
      };
    default:
      return {};
  }
}

/** Retain approved v5 geometry while using the patched chart runtime. */
export function legacyChartOptions(option: any) {
  const result = { richInheritPlainLabel: false, ...option };
  for (const field of ['grid', 'xAxis', 'yAxis']) {
    if (!option[field]) continue;
    const defaults = field === 'grid' ? { outerBoundsMode: 'none' } : { nameMoveOverlap: false };
    result[field] = Array.isArray(option[field])
      ? option[field].map(entry => ({ ...defaults, ...entry }))
      : { ...defaults, ...option[field] };
  }
  return result;
}

export function chartOptions(id: string, chart: ChartData, locale: LiekanLocale = 'zh-CN'): any {
  const crawlerLabel = (name: string, index: number) => {
    if (
      !['d2', 'a1'].includes(id) ||
      !chart.rows ||
      chart.rows.filter(row => row.name === name).length < 2
    )
      return name;
    const identity = chart.rows[index];
    return translateText('{v0}（{v1} · {v2}）', locale, [
      name,
      identity.vendor || '—',
      translateText(identity.botId ? '官方身份' : '自定义／历史未映射', locale),
    ]);
  };
  const displayChart = {
    ...chart,
    labels: ['b1', 'h2', 's1', 'd3', 'f2'].includes(id)
      ? chart.labels.map(value => translateSystemText(value, locale))
      : chart.labels.map(crawlerLabel),
    series: chart.series.map((series, index) => ({
      ...series,
      name:
        id === 'a1' ? crawlerLabel(series.name, index) : translateSystemText(series.name, locale),
    })),
  };
  const option = referenceChartOptions(id, displayChart, locale);
  if (id === 'a1') option.series = option.series.slice(0, chart.series.length);
  return legacyChartOptions(option);
}
