import {
  referenceColumns,
  approveCrawlerPagesReference,
  assertGeoWeightCardAppearance,
} from './liekan-visual-baseline.mjs';
import { checkNavigation } from './liekan-navigation-visual.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { columns, pages as allPages } from '../src/components/liekan/data.ts';

const pages = allPages.filter(
  page => !['human/keywords', 'human/search-engines'].includes(page.resource),
);
const base = process.env.LIEKAN_URL || 'http://127.0.0.1:3002';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  throw new Error('Use an isolated local candidate');
const navigationBaseline = JSON.parse(fs.readFileSync('config/liekan/navigation-ui.json', 'utf8'));
const crawlerRecognitionBaseline = JSON.parse(
  fs.readFileSync('config/liekan/crawler-recognition-ui.json', 'utf8'),
);
assert.equal(crawlerRecognitionBaseline.baselineVersion, 'liekan-crawler-recognition-v1');
assert.equal(
  navigationBaseline.baselineVersion,
  'liekan-navigation-v0.2.3',
  'Explicit approved navigation baseline required',
);
const referenceHashes = JSON.parse(
  fs.readFileSync('design/reference/geo-stats-v3/manifest.json', 'utf8'),
);
for (const [file, hash] of Object.entries(referenceHashes))
  assert.equal(
    createHash('sha256')
      .update(fs.readFileSync(`design/reference/geo-stats-v3/${file}`))
      .digest('hex'),
    hash,
    `Original GEO reference changed: ${file}`,
  );
const tailwind = fs.readFileSync('design/reference/vendor/tailwind-3.4.17.js', 'utf8');
const echarts = fs.readFileSync('design/reference/vendor/echarts-5.5.0.min.js', 'utf8');
assert.equal(createHash('sha256').update(echarts).digest('hex'), '42f8329d989b6f6539dd2b15bbdf0d82025762ac112fbb60dc57b27d7bcf3946', 'Preserve the original chart reference runtime');
const fonts = fs.readFileSync('public/liekan/fonts/inter-latin.woff2');
const credentialFile = process.env.LIEKAN_TEST_CREDENTIAL_FILE || '.local/ui-test.env';
const credentials = Object.fromEntries(
  fs
    .readFileSync(credentialFile, 'utf8')
    .split('\n')
    .filter(line => line.includes('=') && !line.startsWith('#'))
    .map(line => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, '')];
    }),
);
const browser = await chromium.launch({
  headless: true,
  ...(!process.env.CI ? { channel: 'chrome' } : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
  reducedMotion: 'reduce',
});
const reference = await context.newPage(),
  actual = await context.newPage();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const out = 'test-results/liekan-visual';
fs.mkdirSync(out, { recursive: true });
const names = [
  'index',
  'ai',
  'ai-bots',
  'ai-pages',
  'ai-preference',
  'human',
  'human-geo',
  'human-source',
  'content',
  'funnel',
  'logs',
];
const expectedMetricCounts = {
  index: 4,
  ai: 4,
  'ai-bots': 0,
  'ai-pages': 4,
  'ai-preference': 4,
  human: 5,
  'human-geo': 4,
  'human-source': 4,
  content: 4,
  funnel: 4,
  logs: 4,
};
const results = [];
const screenshotStyle = 'nextjs-portal{display:none!important}';
async function navigationAcceptance(page, expected, width) {
  return checkNavigation(page, expected, width, navigationBaseline);
}

async function pixelDiff(first, second, masks = [], verticalOffset = 0) {
  return actual.evaluate(
    async ([a, b, masks, verticalOffset]) => {
      const load = src =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
      const [left, right] = await Promise.all([load(a), load(b)]);
      const width = Math.max(left.width, right.width),
        height = Math.max(left.height, right.height - verticalOffset);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      const paint = (img, offset) => {
        ctx.fillStyle = '#F5F7FA';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, -offset);
        ctx.fillStyle = '#F5F7FA';
        for (const r of masks)
          ctx.fillRect(
            Math.floor(r.x) - 1,
            Math.floor(r.y) - 1,
            Math.ceil(r.width) + 2,
            Math.ceil(r.height) + 2,
          );
        return ctx.getImageData(0, 0, width, height);
      };
      const l = paint(left, 0),
        r = paint(right, verticalOffset);
      let changed = 0,
        compared = 0;
      const excluded = new Uint8Array(width * height);
      for (const m of masks) {
        const x = Math.max(0, Math.floor(m.x) - 1),
          right = Math.min(width, Math.floor(m.x) + Math.ceil(m.width) + 1);
        const y = Math.max(0, Math.floor(m.y) - 1),
          bottom = Math.min(height, Math.floor(m.y) + Math.ceil(m.height) + 1);
        if (right <= x || bottom <= y) continue;
        for (let row = y; row < bottom; row++)
          excluded.fill(1, row * width + x, row * width + right);
      }
      for (let i = 0; i < l.data.length; i += 4) {
        if (excluded[i / 4]) continue;
        compared++;
        const differs =
          Math.max(...[0, 1, 2].map(k => Math.abs(l.data[i + k] - r.data[i + k]))) > 16;
        if (differs) changed++;
        r.data[i] = differs ? 240 : 255;
        r.data[i + 1] = differs ? 68 : 255;
        r.data[i + 2] = differs ? 82 : 255;
      }
      ctx.putImageData(r, 0, 0);
      return {
        ratio: compared ? changed / compared : 1,
        comparedPixels: compared,
        verticalOffset,
        dimensions: [
          [left.width, left.height],
          [right.width, right.height],
        ],
        diff: canvas.toDataURL('image/png').split(',')[1],
      };
    },
    [
      ...[first, second].map(p => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')),
      masks,
      verticalOffset,
    ],
  );
}
const exemptions = page =>
  page.evaluate(() => {
    const definitions = [
      [
        'data-values',
        'main tbody td, #prefList, #pathList, #journeyList, #blindList, #envGrid, #robotsList, #pipeList, main pre',
      ],
      [
        'metric-value-and-evidence',
        'main>section:first-child .card>p:nth-child(2),main>section:first-child .card>p:nth-child(3)',
      ],
      [
        'identity-and-time',
        'header p,aside [class*="brandText"],aside .leading-tight>span:first-child,aside [class*="siteName"],aside [class*="avatar"]',
      ],
      [
        'truthful-captions',
        'main .card>div>p,main>section:last-child>p,main>section:last-child>[class*="leading-relaxed"],main .card [class*="space-y-2.5"]',
      ],
    ];
    const result = [];
    const seen = new Set();
    for (const [reason, selector] of definitions)
      for (const root of document.querySelectorAll(selector)) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent.trim() || seen.has(node)) continue;
          seen.add(node);
          const range = document.createRange();
          range.selectNodeContents(node);
          const clip = node.parentElement
            .closest('td,[class*="truncate"],aside')
            ?.getBoundingClientRect();
          for (const r of range.getClientRects()) {
            const x = Math.max(r.x, clip?.x ?? r.x),
              right = Math.min(r.right, clip?.right ?? r.right);
            if (right > x)
              result.push({
                reason,
                text: node.textContent.trim(),
                x,
                y: r.y + scrollY,
                width: right - x,
                height: r.height,
              });
          }
        }
      }
    // Prototype headers precede <main> in a div; their metadata is dynamic too.
    const main = document.querySelector('main');
    for (const p of main.parentElement.querySelectorAll(':scope>div:first-child p')) {
      const range = document.createRange();
      range.selectNodeContents(p);
      for (const r of range.getClientRects())
        result.push({
          reason: 'identity-and-time',
          text: p.textContent,
          x: r.x,
          y: r.y + scrollY,
          width: r.width,
          height: r.height,
        });
    }
    return result;
  });
const errors = [];
actual.on('pageerror', error => errors.push(error.message));
actual.on('response', response => {
  if (response.url().includes('/api/') && response.status() >= 500)
    errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
});
try {
  await actual.goto(base + '/login?legacy=1');
  await actual.locator('[data-test="input-username"] input').fill(credentials.LIEKAN_TEST_USERNAME);
  await actual.locator('[data-test="input-password"] input').fill(credentials.LIEKAN_TEST_PASSWORD);
  await actual.locator('[data-test="button-submit"]').click();
  await actual.waitForURL(url => !url.pathname.includes('/login'));
  const token = await actual.evaluate(() => JSON.parse(localStorage.getItem('umami.auth')));
  const available = await context.request.get(`${base}/api/me/websites`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(available.status(), 200, 'Accessible visual fixture websites required');
  const websites = await available.json();
  const visualWebsiteId = websites.data?.[0]?.id;
  assert.match(visualWebsiteId || '', /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i);
  const identity = await context.request.get(`${base}/api/websites/${visualWebsiteId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(identity.status(), 200, 'Visual fixture website permission required');
  assert.equal((await identity.json()).id, visualWebsiteId);

  await context.route('https://cdn.tailwindcss.com/**', route =>
    route.fulfill({ contentType: 'application/javascript', body: tailwind }),
  );
  await context.route('https://cdn.jsdelivr.net/**', route =>
    route.fulfill({ contentType: 'application/javascript', body: echarts }),
  );
  await context.route('https://fonts.googleapis.com/**', route =>
    route.fulfill({
      contentType: 'text/css',
      body: `@font-face{font-family:Inter;src:url('${base}/__visual_font');font-style:normal;font-weight:100 900;font-display:block}`,
    }),
  );
  await context.route('**/__visual_font', route =>
    route.fulfill({ contentType: 'font/woff2', body: fonts }),
  );
  await context.addInitScript(() => {
    let n = 123456;
    Math.random = () => {
      n = (1664525 * n + 1013904223) >>> 0;
      return n / 4294967296;
    };
  });
  for (let i = 0; i < names.length; i++) {
    const name = names[i],
      path = pages[i].path;
    await context.route(`${base}/__visual_reference/${name}`, route =>
      route.fulfill({
        contentType: 'text/html',
        body: fs.readFileSync(`design/reference/geo-stats-v3/${name}.html`, 'utf8'),
      }),
    );
    await reference.goto(`${base}/__visual_reference/${name}`);
    await reference.evaluate(async () => {
      await document.fonts.ready;
    });
    await reference.waitForTimeout(800);
    const payload = await reference.evaluate(
      ({ columns, websiteId, copyApproval }) => {
        const charts = {};
        document.querySelectorAll('main [id]').forEach(el => {
          const instance = window.echarts?.getInstanceByDom(el);
          if (!instance) return;
          const o = instance.getOption(),
            first = o.series[0];
          const cat = [...(o.xAxis || []), ...(o.yAxis || [])].find(
            axis => axis.type === 'category',
          );
          let labels = cat?.data || [];
          if (['pie', 'funnel'].includes(first?.type)) labels = first.data.map(row => row.name);
          const series = o.series.map(row => ({
            name: row.name || '',
            values: row.data.map(d => (typeof d === 'object' && !Array.isArray(d) ? d.value : d)),
          }));
          let rows;
          if (first?.type === 'scatter') {
            rows = first.data.map(d => ({
              words: d[0],
              structureScore: d[1],
              requests: d[2],
              path: d[3],
            }));
            series.length = 0;
          }
          charts[el.id] = { labels, series, rows, state: 'available' };
        });
        const cards = [...document.querySelectorAll('main>section:first-child .card')].map(el => {
          const p = el.querySelectorAll('p');
          return {
            key: p[0].textContent,
            label: copyApproval[p[0].textContent] || p[0].textContent,
            value: p[1].textContent,
            detail: p[2]?.textContent || '',
            state: 'available',
          };
        });
        const numeric = new Set([
          'pv',
          'uv',
          'humanPv',
          'aiRequests',
          'requests',
          'dailyAverage',
          'pages',
          'bots',
          'heat',
          'repeatRate',
          'failureRate',
          'share',
          'sessions',
          'conversionRate',
          'entries',
          'bounceRate',
          'count',
          'rate',
          'trend',
          'ratio',
        ]);
        const tables = {};
        for (const [id, fields] of Object.entries(columns)) {
          tables[id] = [...document.querySelectorAll(`#${id}>tr`)].map(tr => {
            const row = Object.fromEntries(
              fields.map(([key], index) => {
                let value = tr.children[index]?.textContent.trim() || null;
                if (value && numeric.has(key)) {
                  const n = Number.parseFloat(value.replaceAll(',', ''));
                  if (Number.isFinite(n)) value = n;
                }
                if (key === 'duration' && typeof value === 'string') {
                  const m = value.match(/(?:(\d+)分)?(?:(\d+)秒)?/);
                  if (m?.[1] || m?.[2]) value = Number(m[1] || 0) * 60 + Number(m[2] || 0);
                }
                return [key, value];
              }),
            );
            if (id === 'botBody') {
              row.name = tr.children[0]?.children[0]?.textContent;
              row.vendor = tr.children[0]?.children[1]?.textContent || '';
            }
            if (id === 'logBody') {
              const match = String(row.path).match(/^(\w+)\s+(.+)$/);
              if (match) {
                row.method = match[1];
                row.path = match[2];
              }
            }
            return row;
          });
        }
        const list = (id, keys) =>
          [...document.querySelectorAll(`#${id}>div`)].map(el =>
            Object.fromEntries(
              keys.map((key, index) => [key, el.children[index]?.textContent.trim() || null]),
            ),
          );
        tables.pathList = list('pathList', ['index', 'time', 'path', 'status']);
        tables.robotsList = list('robotsList', ['bot', 'policy']);
        tables.pipeList = list('pipeList', ['name', 'detail']);
        tables.prefList = list('prefList', ['bot', 'preference']);
        tables.blindList = list('blindList', ['path', 'reason', 'suggestion']).map(row => ({
          ...row,
          path: row.path.replace(/\s*（[^）]+）$/, ''),
        }));
        tables.recoList = [];
        tables.journeyList = [...document.querySelectorAll('#journeyList>div')].map(el => {
          const detail = el.querySelector('p')?.textContent || '';
          return {
            path: el.querySelector('.flex-1')?.textContent,
            count: Number.parseFloat(detail),
            conversionRate: Number.parseFloat(detail.split('转化 ')[1]),
          };
        });
        tables.envGrid = [...document.querySelectorAll('#envGrid>div')].flatMap(el =>
          [...el.querySelectorAll(':scope>div')].map(row => ({
            category: el.querySelector('p').textContent === '浏览器' ? 'browser' : 'os',
            name: row.children[0].textContent,
            share: Number.parseFloat(row.children[1].textContent),
          })),
        );
        const insightCard = [...document.querySelectorAll('main .card')].find(
          el => el.querySelector('h2')?.textContent === 'GEO 关键发现',
        );
        const insights = insightCard
          ? [...insightCard.querySelectorAll('p')].map(el => el.textContent)
          : [...document.querySelectorAll('main>section:last-child>p')].map(el =>
              el.textContent.replace(/^GEO 洞察：/, ''),
            );
        // Fixture values exist only inside this isolated browser's intercepted API.
        return {
          contractVersion: 1,
          website: {
            id: websiteId,
            name: '视觉验收夹具',
            domain: 'www.liekan.com',
          },
          range: { startAt: 0, endAt: 86400000, timezone: 'Asia/Shanghai' },
          states: {
            human: 'available',
            logs: 'available',
            catalog: 'available',
            goals: 'available',
          },
          cards,
          charts,
          tables,
          insights,
          meta: {
            demo: false,
            canManage: true,
            latestImportAt: '2026-10-02T00:00:00Z',
            ruleCount: 18,
            totalLogs: tables.logBody.length,
            page: 1,
            pageSize: 100,
          },
        };
      },
      {
        columns: referenceColumns(columns),
        websiteId: visualWebsiteId,
        copyApproval: navigationBaseline.geoCopyApproval?.[name] || {},
      },
    );
    let fixtureRequests = 0;
    await actual.route('**/api/liekan/**/page-report?*', route => {
      fixtureRequests++;
      const query = new URL(route.request().url()).searchParams;
      const now = Date.now();
      return route.fulfill({
        contentType: 'application/json',
        headers: { 'X-Liekan-Server-Time': String(now) },
        body: JSON.stringify({
          ...payload,
          resource: pages[i].resource,
          range: {
            startAt: Number(query.get('startAt')),
            endAt: Number(query.get('endAt')),
            timezone: query.get('timezone'),
          },
          meta: { ...payload.meta, generatedAt: now, expiresAt: now + 30000 },
        }),
      });
    });
    await actual.goto(`${base}/websites/${payload.website.id}/geo${path}`);
    await actual.waitForFunction(() =>
      [...document.querySelectorAll('main')].some(el => el.querySelector(':scope > section .card')),
    );
    await actual.evaluate(async () => {
      await document.fonts.ready;
    });
    await actual.waitForTimeout(800);
    assert(fixtureRequests > 0, `${name} current page report fixture was never requested`);
    // Validate the approved addition separately, then retain the original body/pixel oracle.
    // Full score states, the shared detail and both locales are checked by geo-weight-ui.mjs.
    const geoSummary = actual.locator('[data-geo-weight]');
    assert.equal(await geoSummary.count(), ['index', 'ai'].includes(name) ? 1 : 0);
    if (await geoSummary.count()) {
      const box = await geoSummary.boundingBox();
      assert(box.height >= 80 && box.height <= 220, `${name} GEO summary must remain compact`);
      assert(
        box.x >= 220 && box.x + box.width <= 1440,
        `${name} GEO summary must stay within the content`,
      );
      await geoSummary.evaluate(assertGeoWeightCardAppearance);
      await geoSummary.screenshot({ path: `${out}/${name}-geo-weight-summary.png` });
      // Validate the approved replacement, then restore only that reference cell in
      // this test browser to retain the original body, table and chart pixel oracle.
      const position = name === 'index' ? 3 : 2;
      assert.equal(
        await geoSummary.evaluate(el => [...el.parentElement.children].indexOf(el)),
        position,
      );
      assert.equal(await geoSummary.evaluate(el => el.parentElement.children.length), 4);
      const originalMetric = await reference
        .locator('main > section.grid > .card')
        .nth(position)
        .evaluate(el => el.outerHTML);
      await geoSummary.evaluate((element, html) => {
        element.outerHTML = html;
      }, originalMetric);
    }
    const measure = (page, surface) =>
      page.evaluate(
        ({ name, surface }) => {
          const body = [...document.querySelectorAll('main')].find(el =>
            el.querySelector(':scope > section .card'),
          );
          if (!body) throw new Error(`${name} ${surface}: Original GEO content body is missing`);
          return {
            body: body.getBoundingClientRect().toJSON(),
            cards: [...body.querySelectorAll('.card')].map(el => {
              const r = el.getBoundingClientRect(),
                s = getComputedStyle(el);
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                radius: s.borderRadius,
                border: s.borderColor,
                background: s.backgroundColor,
              };
            }),
            columns: [...body.querySelectorAll('table thead')].map(el =>
              [...el.querySelectorAll('th')].map(th => th.textContent.trim()),
            ),
            charts: [...body.querySelectorAll('[id]')]
              .filter(el =>
                /^(d[123]|a[1234]|b1|ap1|pf[12]|h[123]|g[12]|s[12]|c1|f[123])$/.test(el.id),
              )
              .map(el => ({ id: el.id, ...el.getBoundingClientRect().toJSON() })),
          };
        },
        { name, surface },
      );
    const [refGeometry, geometry] = await Promise.all([
      measure(reference, 'reference'),
      measure(actual, 'actual'),
    ]);
    const approval = navigationBaseline.geoPixelApproval;
    const languageHeaderAllowance =
      navigationBaseline.languageSwitchApproval.maxAdditionalHeaderHeight;
    const verticalOffset = geometry.body.y - refGeometry.body.y;
    assert(
      Math.abs(verticalOffset) <= approval.maxVerticalOffset + languageHeaderAllowance,
      `${name} header offset exceeds approved bounds`,
    );
    assert(
      refGeometry.body.y <= approval.maxHeaderHeight &&
        geometry.body.y <= approval.maxHeaderHeight + languageHeaderAllowance,
      `${name} approved header extends into content body`,
    );
    for (const key of ['x', 'width'])
      assert(
        Math.abs(geometry.body[key] - refGeometry.body[key]) <= approval.geometryTolerance,
        `${name} content ${key} changed`,
      );
    assert.equal(
      geometry.cards.length,
      refGeometry.cards.length,
      `${name} original panel count changed`,
    );
    const crawlerUiApproval = crawlerRecognitionBaseline.pages[name];
    const columnRenames = {
      ...crawlerUiApproval?.columnRenames,
      ...navigationBaseline.geoColumnCopyApproval?.[name],
    };
    for (const oldLabel of Object.keys(columnRenames))
      assert.equal(
        refGeometry.columns.flat().filter(label => label === oldLabel).length,
        1,
        `${name} approved column must occur once in the original reference`,
      );
    assert.deepEqual(
      geometry.columns,
      refGeometry.columns.map(row =>
        row.flatMap(label =>
          name === 'ai-pages' && label === '页面'
            ? [label, navigationBaseline.crawlerPagesApproval.addedColumn.label]
            : [columnRenames[label] || label],
        ),
      ),
      `${name} original columns with bounded approved updates`,
    );
    if (crawlerUiApproval) {
      assert.deepEqual(
        await reference.locator('main .chip').allTextContents(),
        crawlerUiApproval.originalFilters,
        `${name} original crawler filters`,
      );
      assert.deepEqual(
        await actual.locator('main .chip').allTextContents(),
        crawlerUiApproval.filters,
        `${name} approved crawler filters`,
      );
      assert.deepEqual(
        await actual.locator('main .chip.on').allTextContents(),
        [crawlerUiApproval.filters[0]],
        `${name} default crawler filter`,
      );
    }
    assert.deepEqual(
      geometry.charts.map(c => c.id),
      refGeometry.charts.map(c => c.id),
      `${name} original chart set changed`,
    );
    for (const [index, panel] of geometry.cards.entries())
      for (const key of ['radius', 'border', 'background'])
        assert.equal(
          panel[key],
          refGeometry.cards[index][key],
          `${name} panel ${index} ${key} VI changed`,
        );
    const navigation = await navigationAcceptance(actual, navigationBaseline.geo[name], 1440);
    assert.equal(
      await actual.locator('h1').textContent(),
      navigationBaseline.geo[name].title,
      `${name} approved header title`,
    );
    // Keep toolbar placement and the approved account-owned natural-day default.
    const toolbarButtons = await actual
      .locator('[data-website-toolbar-actions] button')
      .allTextContents();
    assert.deepEqual(
      toolbarButtons.slice(0, 3),
      navigationBaseline.todayCalendarApproval.shortcuts,
      `${name} quick range buttons must lead the website toolbar`,
    );
    assert(
      toolbarButtons.length > 3,
      `${name} custom range chip missing after the quick range buttons`,
    );
    assert.equal(
      await actual
        .locator('[data-website-toolbar-actions] button')
        .filter({ hasText: navigationBaseline.todayCalendarApproval.shortcuts[0] })
        .first()
        .getAttribute('aria-pressed'),
      'true',
      `${name} approved natural-day quick range must be active`,
    );
    assert.deepEqual(
      await actual.locator('[class*="analysisTools"] a').allTextContents(),
      navigationBaseline.geoAnalysisTools,
      `${name} analysis tools`,
    );
    const metrics = payload.cards.length;
    assert.equal(metrics, expectedMetricCounts[name], `${name} original metric count changed`);
    if (name === 'ai-bots')
      assert(payload.tables.botBody.length > 0, 'AI crawler reference ledger has no rows');
    const differences = geometry.cards.slice(0, metrics).map((r, index) => ({
      type: 'metric',
      index,
      max: Math.max(
        ...['x', 'y', 'width', 'height'].map(key =>
          Math.abs(r[key] - (key === 'y' ? verticalOffset : 0) - refGeometry.cards[index][key]),
        ),
      ),
    }));
    const chartSizes = geometry.charts.map(r => {
      const ref = refGeometry.charts.find(c => c.id === r.id);
      return {
        id: r.id,
        max: Math.max(
          ...(name === 'ai-pages' || crawlerUiApproval?.wrapFilters
            ? ['x', 'width', 'height']
            : ['x', 'y', 'width', 'height']
          ).map(key => Math.abs(r[key] - (key === 'y' ? verticalOffset : 0) - ref[key])),
        ),
      };
    });
    const chartPixels = [];
    for (const chart of geometry.charts) {
      const approvedChart = navigationBaseline.geoChartApproval?.[chart.id];
      if (approvedChart) {
        await reference.evaluate(
          ({ id, legend, limit }) => {
            const instance = window.echarts.getInstanceByDom(document.getElementById(id));
            const option = instance.getOption();
            const data = option.series[0].data;
            instance.setOption({
              legend: {
                ...option.legend[0],
                ...legend,
                data: (limit == null
                  ? data
                  : [...data].sort((a, b) => b.value - a.value).slice(0, limit)
                ).map(row => row.name),
              },
            });
          },
          { id: chart.id, legend: approvedChart.legend, limit: approvedChart.legendLimit },
        );
      }
      const ref = reference.locator('#' + chart.id),
        live = actual.locator('#' + chart.id);
      const refPath = `${out}/${name}-${chart.id}-reference.png`,
        livePath = `${out}/${name}-${chart.id}-actual.png`;
      // Read the renderer pixels directly: fractional page positions can shift a
      // locator screenshot by one pixel after adding the approved filter row.
      for (const [locator, destination] of [
        [ref, refPath],
        [live, livePath],
      ]) {
        const png = await locator.evaluate(el => {
          const canvases = el.querySelectorAll('canvas');
          if (canvases.length !== 1) throw new Error('Expected one chart canvas');
          return canvases[0].toDataURL('image/png').split(',')[1];
        });
        fs.writeFileSync(destination, Buffer.from(png, 'base64'));
      }
      const { diff, ...comparison } = await pixelDiff(refPath, livePath);
      fs.writeFileSync(`${out}/${name}-${chart.id}-diff.png`, Buffer.from(diff, 'base64'));
      chartPixels.push({
        id: chart.id,
        capture: 'canvas-renderer-pixels',
        reference: refPath,
        actual: livePath,
        ...comparison,
      });
    }
    for (const page of [reference, actual]) {
      // 图表元素截图会滚动页面；粘性页头/侧栏会随残留滚动位置印进整页截图。
      await page.evaluate(
        () =>
          new Promise(resolve => {
            scrollTo(0, 0);
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
    }
    await reference.screenshot({
      path: `${out}/${name}-reference.png`,
      fullPage: true,
      style: screenshotStyle,
    });
    await actual.screenshot({
      path: `${out}/${name}-actual.png`,
      fullPage: true,
      style: screenshotStyle,
    });
    const originalTextExemptions = [
      ...(await exemptions(reference)),
      ...(await exemptions(actual)).map(rect => ({ ...rect, y: rect.y - verticalOffset })),
    ];
    const screenshotHeight = Math.max(
      refGeometry.body.bottom,
      geometry.body.bottom - verticalOffset,
      1000,
    );
    const approvedNavigationRegions = [
      {
        reason: 'approved-v0.2.2-sidebar',
        x: 0,
        y: 0,
        width: approval.sidebarWidth,
        height: screenshotHeight,
      },
      {
        reason: 'approved-v0.2.2-header-and-analysis-toolbar',
        x: approval.sidebarWidth,
        y: 0,
        width: 1440 - approval.sidebarWidth,
        height: refGeometry.body.y,
      },
    ];
    const { diff: originalDiff, ...originalFullPagePixels } = await pixelDiff(
      `${out}/${name}-reference.png`,
      `${out}/${name}-actual.png`,
      [...originalTextExemptions, ...approvedNavigationRegions],
      verticalOffset,
    );
    fs.writeFileSync(`${out}/${name}-original-diff.png`, Buffer.from(originalDiff, 'base64'));
    // User-approved URL completion (2026-10-11): account for longer table values.
    // Original hashes, geometry, charts and the original pixel comparison stay above.
    const pageUrlChecks = [];
    for (const [table, fields] of Object.entries(referenceColumns(columns))) {
      const pathIndex = fields.findIndex(([field]) => field === 'path');
      if (pathIndex < 0) continue;
      for (const [rowIndex, row] of (payload.tables[table] || []).entries()) {
        if (typeof row.path !== 'string' || !row.path.startsWith('/') || row.path.startsWith('//'))
          continue;
        const href = new URL(row.path, `https://${payload.website.domain}`).href;
        const cell = actual.locator(`#${table}>tr`).nth(rowIndex).locator('td').nth(pathIndex);
        const link = cell.locator('a');
        assert.equal(await link.count(), 1, `${name} ${table} page link missing`);
        assert.equal(await link.textContent(), href, `${name} ${table} page URL text`);
        assert.equal(
          await link.getAttribute('href'),
          href,
          `${name} ${table} page URL destination`,
        );
        assert.equal(await link.getAttribute('target'), '_blank');
        assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
        await reference
          .locator(`#${table}>tr`)
          .nth(rowIndex)
          .locator('td')
          .nth(pathIndex)
          .evaluate(
            (el, { href, method }) => {
              el.textContent = method ? `${method} ${href}` : href;
            },
            { href, method: table === 'logBody' ? row.method : undefined },
          );
        pageUrlChecks.push({ table, rowIndex, href });
      }
    }
    // Preserve original evidence, then apply the enumerated, previously approved copy.
    const copySelector = 'main h2, main>section:first-child .card>p:first-child';
    for (const [original, approved] of Object.entries(
      navigationBaseline.geoCopyApproval?.[name] || {},
    )) {
      const referenceCopy = reference.locator(copySelector).filter({
        hasText: new RegExp('^' + original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
      });
      assert.equal(
        await referenceCopy.count(),
        1,
        `${name} original copy must occur once: ${original}`,
      );
      assert(
        (await actual.locator(copySelector).allTextContents()).includes(approved),
        `${name} approved copy missing: ${approved}`,
      );
      await referenceCopy.evaluate((el, value) => {
        el.textContent = value;
      }, approved);
    }
    // Apply the enumerated crawler columns and chips to the separate reference.
    if (Object.keys(columnRenames).length || crawlerUiApproval)
      await reference.evaluate(
        approval => {
          for (const header of document.querySelectorAll('main table th')) {
            const replacement = approval.columnRenames[header.textContent.trim()];
            if (replacement) header.textContent = replacement;
          }
          if (!approval.filters) return;
          const original = [...document.querySelectorAll('main .chip')];
          if (approval.wrapFilters) {
            for (const container of [
              original[0].parentElement,
              original[0].parentElement.parentElement,
            ]) {
              container.style.flexWrap = 'wrap';
              container.style.maxWidth = '100%';
            }
          }
          for (const [index, label] of approval.filters.entries()) {
            const chip = original[0].cloneNode(true);
            chip.textContent = label;
            chip.classList.toggle('on', index === 0);
            original[0].before(chip);
          }
          for (const chip of original) chip.remove();
        },
        { ...crawlerUiApproval, columnRenames },
      );
    if (crawlerUiApproval?.wrapFilters) {
      const approvedGeometry = await measure(reference, 'approved-reference');
      for (const [index, panel] of approvedGeometry.cards.entries()) {
        assert(
          ['x', 'y', 'width', 'height'].every(
            key =>
              Math.abs(
                geometry.cards[index][key] - (key === 'y' ? verticalOffset : 0) - panel[key],
              ) <= 2,
          ),
          `${name} approved filter layout changed panel ${index}`,
        );
      }
      for (const expected of approvedGeometry.charts) {
        const chart = geometry.charts.find(chart => chart.id === expected.id);
        assert(
          ['x', 'y', 'width', 'height'].every(
            key => Math.abs(chart[key] - (key === 'y' ? verticalOffset : 0) - expected[key]) <= 2,
          ),
          `${name} chart geometry after approved filter wrapping`,
        );
      }
    }
    let crawlerPagesChecks = null;
    if (name === 'ai-pages') {
      const approved = navigationBaseline.crawlerPagesApproval;
      assert.deepEqual(
        await actual.getByRole('group', { name: '爬虫类型' }).getByRole('button').allTextContents(),
        approved.typeFilters,
      );
      assert.deepEqual(
        await actual
          .getByRole('group', { name: '爬虫类型' })
          .locator('[aria-pressed="true"]')
          .allTextContents(),
        [approved.typeFilters[0]],
      );
      assert.equal(
        await actual.getByRole('combobox', { name: approved.crawlerSelector }).inputValue(),
        '',
      );
      assert.equal(
        await actual
          .getByRole('combobox', { name: approved.crawlerSelector })
          .locator('option:checked')
          .textContent(),
        approved.defaultCrawler,
      );
      for (const [index, row] of payload.tables.blindList.entries()) {
        const href = new URL(row.path, `https://${payload.website.domain}`).href;
        const link = actual.locator('#blindList > div').nth(index).locator('p:first-child a');
        assert.equal(await link.textContent(), href, 'Blind-page full URL text');
        assert.equal(await link.getAttribute('href'), href, 'Blind-page URL destination');
        await reference
          .locator('#blindList > div')
          .nth(index)
          .locator('p:first-child')
          .evaluate((el, href) => {
            el.textContent = href;
            el.classList.remove('truncate');
            el.style.overflowWrap = 'anywhere';
          }, href);
      }
      await reference.evaluate(approveCrawlerPagesReference, approved);
      const approvedGeometry = await measure(reference, 'approved-reference');
      crawlerPagesChecks = approvedGeometry.cards.slice(0, metrics + 1).map((panel, index) => ({
        index,
        max: Math.max(
          ...['x', 'y', 'width', 'height'].map(key =>
            Math.abs(geometry.cards[index][key] - (key === 'y' ? verticalOffset : 0) - panel[key]),
          ),
        ),
      }));
      const tableGrowth =
        approvedGeometry.cards[metrics].height - refGeometry.cards[metrics].height;
      assert(
        tableGrowth >= 0 && tableGrowth <= approved.maxTableHeightIncrease,
        'AI page table exceeds bounded approved growth',
      );
      assert(
        crawlerPagesChecks.every(check => check.max <= 2),
        'AI page approved panel geometry changed',
      );
      for (const expected of approvedGeometry.charts) {
        const chart = geometry.charts.find(chart => chart.id === expected.id);
        assert(
          ['x', 'y', 'width', 'height'].every(
            key => Math.abs(chart[key] - (key === 'y' ? verticalOffset : 0) - expected[key]) <= 2,
          ),
          'AI page chart geometry after approved table changes',
        );
      }
    }
    // The approved product footer has its own content and bounds checks.
    const footer = actual.locator('[data-liekan-product-footer]');
    const branding = navigationBaseline.productBranding;
    assert.equal(await footer.count(), 1, `${name} product footer count`);
    assert.equal(
      await footer
        .getByRole('link', { name: `${branding.name} ${branding.version}`, exact: true })
        .count(),
      1,
    );
    assert.deepEqual(await footer.locator('[data-product-publishers] > *').allTextContents(), [
      '联合发布：',
      ...branding.publishers,
    ]);
    assert.equal(await footer.getByRole('link', { name: 'MIT', exact: true }).count(), 1);
    const footerBounds = await footer.evaluate(el => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y + scrollY, width: box.width, height: box.height };
    });
    assert(footerBounds.height > 0 && footerBounds.height <= branding.maxDesktopFooterHeight);
    assert(footerBounds.x >= approval.sidebarWidth && footerBounds.x + footerBounds.width <= 1440);
    const approvedBrandingRegions = [
      { ...footerBounds, y: footerBounds.y - verticalOffset, reason: 'approved-product-footer' },
    ];
    const expectedReference = `${out}/${name}-approved-reference.png`;
    await reference.screenshot({ path: expectedReference, fullPage: true, style: screenshotStyle });
    const textExemptions = [
      ...(await exemptions(reference)),
      ...(await exemptions(actual)).map(rect => ({ ...rect, y: rect.y - verticalOffset })),
    ];
    const { diff, ...fullPagePixels } = await pixelDiff(
      expectedReference,
      `${out}/${name}-actual.png`,
      [...textExemptions, ...approvedNavigationRegions, ...approvedBrandingRegions],
      verticalOffset,
    );
    fs.writeFileSync(`${out}/${name}-diff.png`, Buffer.from(diff, 'base64'));
    const mobileChecks = [];
    for (const width of [375, 320]) {
      await actual.setViewportSize({ width, height: 1000 });
      await actual.evaluate(
        () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const mobileNavigation = await navigationAcceptance(
        actual,
        navigationBaseline.geo[name],
        width,
      );
      const overflow = await actual.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      );
      assert.equal(overflow, 0, `${name} ${width}px overflow`);
      assert.equal(
        await actual.locator('h1').textContent(),
        navigationBaseline.geo[name].title,
        `${name} ${width}px title`,
      );
      await actual.screenshot({
        path: `${out}/${name}-${width}-actual.png`,
        fullPage: true,
        style: screenshotStyle,
      });
      mobileChecks.push({ width, overflow, navigation: mobileNavigation });
    }
    await actual.setViewportSize({ width: 1440, height: 1000 });
    results.push({
      name,
      mobileChecks,
      metricGeometry: differences,
      chartGeometry: chartSizes,
      chartPixels,
      pageUrlChecks,
      originalFullPagePixels,
      fullPagePixels,
      textExemptions,
      approvedNavigationRegions,
      approvedBrandingRegions,
      crawlerUiApproval: crawlerUiApproval || null,
      columnRenames,
      crawlerPagesChecks,
      navigation,
      verticalOffset,
      refGeometry,
      geometry,
    });
    await actual.unroute('**/api/liekan/**/page-report?*');
  }
  fs.writeFileSync(
    `${out}/geometry.json`,
    JSON.stringify(
      {
        head,
        viewport: 1440,
        navigationBaseline: navigationBaseline.baselineVersion,
        crawlerRecognitionBaseline: crawlerRecognitionBaseline.baselineVersion,
        originalReferenceHashesVerified: Object.keys(referenceHashes).length,
        errors,
        fixture: 'frozen prototype data intercepted in isolated browser; no writes to analytics',
        visualWebsiteId,
        results,
        passed:
          errors.length === 0 &&
          results.length === 11 &&
          results.flatMap(r => r.chartPixels).length === 22 &&
          results.every(
            r =>
              [...r.metricGeometry, ...r.chartGeometry].every(d => d.max <= 2) &&
              r.mobileChecks.length === 2 &&
              r.fullPagePixels.comparedPixels > 0 &&
              r.fullPagePixels.ratio <= 0.01 &&
              r.chartPixels.every(c => c.ratio <= 0.01),
          ),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      pages: results.length,
      charts: results.flatMap(r => r.chartPixels).length,
      maxMetricDelta: Math.max(...results.flatMap(r => r.metricGeometry).map(r => r.max)),
      maxChartDelta: Math.max(...results.flatMap(r => r.chartGeometry).map(r => r.max)),
    }),
  );
  if (
    errors.length > 0 ||
    results.length !== 11 ||
    results.flatMap(r => r.chartPixels).length !== 22 ||
    results.some(
      r =>
        [...r.metricGeometry, ...r.chartGeometry].some(d => d.max > 2) ||
        r.mobileChecks.length !== 2 ||
        r.fullPagePixels.comparedPixels === 0 ||
        r.fullPagePixels.ratio > 0.01 ||
        r.chartPixels.some(c => c.ratio > 0.01),
    )
  )
    throw new Error('Prototype page, chart or metric geometry acceptance failed');
} finally {
  await browser.close();
}
