import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { acceptanceSeedFile, isolatedAcceptanceTarget } from './liekan-acceptance-target.mjs';

const base = process.env.LIEKAN_URL || 'http://127.0.0.1:3302';
const target = isolatedAcceptanceTarget(base);
const baseline = JSON.parse(fs.readFileSync('config/liekan/navigation-ui.json', 'utf8')).productInformation;
const seed = acceptanceSeedFile(target);
const credentials = fs.existsSync(seed) ? JSON.parse(fs.readFileSync(seed, 'utf8')).admin : { username: 'admin', password: 'liekan' };
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials),
});
assert.equal(login.status, 200, 'Complete local validation session required; credentials withheld');
const { token } = await login.json();
assert(token);
const response = await fetch(`${base}/api/me/websites`, { headers: { Authorization: `Bearer ${token}` } });
assert.equal(response.status, 200);
const websites = await response.json();
const demo = (Array.isArray(websites) ? websites : websites.data || []).find(site => site.demo || site.name?.includes('示例数据'));
assert(demo, 'Use an explicitly named demo website');
const out = 'test-results/liekan-product-about';
fs.mkdirSync(out, { recursive: true });
const report = { checks: [], errors: [], githubRequests: [], passed: false };
const browser = await chromium.launch({ headless: true, ...(!process.env.CI ? { channel: 'chrome' } : {}) });
try {
  for (const [width, height] of [[1600, 1000], [1280, 800], [780, 900], [375, 812], [320, 640]]) {
    for (const locale of ['zh-CN', 'en-US']) {
      const context = await browser.newContext({ viewport: { width, height }, locale, reducedMotion: 'reduce' });
      await context.addCookies([{ name: 'liekan.locale', value: locale, url: base }]);
      await context.addInitScript(value => localStorage.setItem('umami.auth', JSON.stringify(value)), token);
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      page.on('request', request => { if (new URL(request.url()).hostname === 'api.github.com') report.githubRequests.push(request.url()); });
      page.setDefaultTimeout(30000);
      for (const [kind, path] of [['website', `/websites/${demo.siteNumber || demo.id}/geo?date=range%3A1790265600000%3A1792857599999&dateMode=default`], ['global', '/websites'], ['admin', '/admin/users']]) {
        await page.goto(base + path, { waitUntil: 'domcontentloaded' });
        const sidebar = page.locator('#liekan-navigation');
        const trigger = sidebar.locator('button[aria-haspopup="dialog"]');
        await trigger.waitFor({ state: 'attached' });
        if (width <= 900) await page.locator('button[aria-controls="liekan-navigation"]').click();
        await trigger.waitFor({ state: 'visible' });
        const before = page.url();
        await trigger.click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        const contributors = dialog.getByRole('region', { name: locale === 'zh-CN' ? '开源贡献者' : 'Open-source contributors' });
        await contributors.getByRole('listitem').first().waitFor();
        assert.equal(await contributors.getByRole('link', { name: 'GitHub', exact: true }).getAttribute('href'), baseline.repository);
        for (const link of await contributors.getByRole('listitem').getByRole('link').all()) {
          assert.match(await link.getAttribute('href'), /^https:\/\/github\.com\/(?:apps\/)?[a-z\d%\[\]-]+$/i);
          assert.equal(await link.getAttribute('target'), '_blank');
          assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
          assert.match(await link.locator('img').getAttribute('src'), /^https:\/\/avatars\.githubusercontent\.com\/(?:u|in)\/\d+/);
        }
        assert.equal(page.url(), before, 'Project information preserves the current page');
        assert.equal(await dialog.getByText('v1.2', { exact: true }).count(), 1);
        assert.equal(await dialog.getByText('姚金刚', { exact: true }).count(), 1);
        assert.equal(await dialog.getByText('向阳乔木', { exact: true }).count(), 1);
        assert.equal(await dialog.getByText(/贡献者 \d|Contributor \d|排版示意|设计预览/).count(), 0);
        for (const [name, href] of [['猎看科技', baseline.publishers[0]], ['北京日报社智源GEO', baseline.publishers[1]]]) {
          const link = dialog.getByRole('link', { name, exact: true });
          assert.equal(await link.getAttribute('href'), href);
          assert.equal(await link.getAttribute('target'), '_blank');
          assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
          const url = new URL(href);
          assert(url.searchParams.has('GEOInflow'));
          assert.equal(url.searchParams.get('GEOInflow'), '');
        }
        await page.evaluate(() => document.fonts.ready);
        const geometry = await dialog.locator('[data-dialog-size="wide"]').evaluate(panel => {
          const rect = panel.getBoundingClientRect();
          return { width: rect.width, height: rect.height, x: rect.x, y: rect.y,
            centerX: Math.abs(rect.x + rect.width / 2 - innerWidth / 2), centerY: Math.abs(rect.y + rect.height / 2 - innerHeight / 2),
            overflow: panel.scrollWidth > panel.clientWidth,
            closeVisible: (() => { const r = panel.querySelector('.dialog-close').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })(),
          };
        });
        assert(geometry.centerX <= 2 && geometry.centerY <= 2, JSON.stringify({ width, height, locale, kind, geometry }));
        assert(!geometry.overflow && geometry.x >= 0 && geometry.y >= 0 && geometry.closeVisible);
        if (width >= 1280) assert.equal(geometry.width, baseline.width);
        for (let i = 0; i < 13; i++) {
          await page.keyboard.press('Tab');
          await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement), null, { timeout: 2000 });
        }
        if (kind === 'website' && [1600, 375].includes(width)) {
          await dialog.locator('.dialog-body').evaluate(el => el.scrollTop = 0);
          await page.screenshot({ path: `${out}/${width}-${locale}.png` });
        }
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert(await trigger.evaluate(el => el === document.activeElement), 'Close restores the exact sidebar trigger');
        if (width <= 900) assert(await sidebar.isVisible(), 'Closing project information keeps mobile navigation open');
        report.checks.push({ width, height, locale, kind, geometry });
      }
      // Verify each publisher opens the attributed destination without making an external request.
      await context.route('https://www.liekan.com/**', route => route.fulfill({ status: 200, body: 'Attribution destination verified' }));
      await context.route('https://geo.takefoto.cn/**', route => route.fulfill({ status: 200, body: 'Attribution destination verified' }));
      await page.locator('#liekan-navigation button[aria-haspopup="dialog"]').click();
      for (const [name, href] of [['猎看科技', baseline.publishers[0]], ['北京日报社智源GEO', baseline.publishers[1]]]) {
        const popupPromise = page.waitForEvent('popup');
        await page.getByRole('dialog').getByRole('link', { name, exact: true }).click();
        const popup = await popupPromise;
        await popup.waitForLoadState('domcontentloaded');
        assert.equal(popup.url(), href);
        await popup.close();
      }
      await page.getByRole('dialog').locator('.dialog-close').click();
      await context.close();
    }
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.githubRequests, [], 'Contributor API requests stay on the application server');
  report.passed = true;
  console.log(`Project information: ${report.checks.length} viewport, locale and navigation contexts passed; attributed links, focus, close and GitHub contributors verified.`);
} finally {
  fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
