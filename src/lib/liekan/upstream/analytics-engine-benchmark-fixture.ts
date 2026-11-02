/** Independent expected values for the explicitly synthetic scale-test generator. */
export function expectedEngineBenchmark(rows: number, days: number) {
  const start = Date.parse('2025-10-01T00:00:00Z');
  const names = ['GPTBot', 'ClaudeBot', 'PerplexityBot'];
  const bots = names.map(name => ({
    name,
    vendor: 'Synthetic fixture',
    type: '训练',
    botId: null,
    requests: 0,
    aiRequests: 0,
    pages: 0,
    lastVisit: '',
  }));
  const botPaths = names.map(() => new Set<number>());
  const paths = new Set<number>();
  const daily = new Map<
    string,
    { day: string; bot: string; vendor: string; botId: null; count: number; aiRequests: number }
  >();
  const summary = {
    requests: 0,
    ai: 0,
    pages: 0,
    abnormal: 0,
    classificationVersions: 0,
    legacyRequests: 0,
    unclassifiedRequests: 0,
  };
  const last = [0, 0, 0];
  let abnormalAi = 0;
  for (let g = 1; g <= rows; g++) {
    const day = (g - 1) % 365;
    if (day < 365 - days) continue;
    summary.requests++;
    const abnormal = g % 17 === 0;
    if (abnormal) summary.abnormal++;
    const bot = g % 4;
    if (bot === 3) {
      summary.legacyRequests++;
      summary.unclassifiedRequests++;
      continue;
    }
    summary.ai++;
    if (abnormal) abnormalAi++;
    const path = g % 50000;
    paths.add(path);
    botPaths[bot].add(path);
    bots[bot].requests++;
    bots[bot].aiRequests++;
    last[bot] = Math.max(last[bot], start + day * 86400000 + 12 * 3600000 + (g % 3600) * 1000);
    const key = `${day}:${bot}`;
    let entry = daily.get(key);
    if (!entry) {
      entry = {
        day: new Date(start + day * 86400000).toISOString().slice(0, 10),
        bot: names[bot],
        vendor: 'Synthetic fixture',
        botId: null,
        count: 0,
        aiRequests: 0,
      };
      daily.set(key, entry);
    }
    entry.count++;
    entry.aiRequests++;
  }
  summary.pages = paths.size;
  summary.classificationVersions = summary.requests ? 1 : 0;
  bots.forEach((bot, index) => {
    bot.pages = botPaths[index].size;
    bot.lastVisit = new Date(last[index]).toISOString();
  });
  return {
    summary,
    bots: bots.filter(bot => bot.requests),
    daily: [...daily.values()],
    statuses: [
      { status: 200, count: summary.ai - abnormalAi },
      { status: 400, count: abnormalAi },
    ].filter(row => row.count),
    hours: summary.ai ? [{ hour: 12, count: summary.ai }] : [],
  };
}
