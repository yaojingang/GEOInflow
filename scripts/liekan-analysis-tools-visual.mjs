import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { acceptanceSeedFile, isolatedAcceptanceTarget } from './liekan-acceptance-target.mjs';

const base = process.env.LIEKAN_URL || 'http://127.0.0.1:3302';
const target = isolatedAcceptanceTarget(base);
const seed = JSON.parse(fs.readFileSync(acceptanceSeedFile(target), 'utf8'));
const paths = [
  ...fs.readFileSync('src/components/liekan/data.ts', 'utf8').matchAll(/^\s+path: '([^']*)',/gm),
].map(match => match[1]);
assert(paths.length >= 10, 'The shared analytics pages must be covered');
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(seed.admin),
});
assert.equal(login.status, 200, 'An isolated acceptance login is required');
const { token } = await login.json();
assert(token, 'A full session token is required');
const output = 'test-results/liekan-analysis-tools';
fs.mkdirSync(output, { recursive: true });
const report = { passed: false, checks: [], errors: [] };
const browser = await chromium.launch({
  headless: true,
  ...(!process.env.CI ? { channel: 'chrome' } : {}),
});
try {
  for (const locale of ['zh-CN', 'en-US']) {
    // This browser belongs to the test; viewport changes never touch shared user windows.
    const context = await browser.newContext({ locale, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'liekan.locale', value: locale, url: base }]);
    await context.addInitScript(
      token => localStorage.setItem('umami.auth', JSON.stringify(token)),
      token,
    );
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    for (const width of [1920, 1440, 900, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const path of paths) {
        await page.goto(`${base}/websites/${seed.website.id}/geo${path}`, {
          waitUntil: 'domcontentloaded',
        });
        await page.locator('[data-liekan-page-title]').waitFor();
        await page.locator('[class*="analysisTools"]').waitFor();
        await page.locator('main').first().waitFor();
        if (path === '' && width === 1920)
          await page.locator('[class*="analysisTools"] > span').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        const geometry = await page.evaluate(() => {
          const title = document.querySelector('[data-liekan-page-title]').getBoundingClientRect();
          const tools = document.querySelector('[class*="analysisTools"]');
          const first = tools.firstElementChild.getBoundingClientRect();
          const main = document.querySelector('main');
          return {
            titleX: title.x,
            toolsX: first.x,
            contentX:
              main.getBoundingClientRect().x + parseFloat(getComputedStyle(main).paddingLeft),
            overflow: tools.scrollWidth - tools.clientWidth,
            viewport: innerWidth,
          };
        });
        report.checks.push({ locale, width, path, ...geometry });
        const name = `${locale}-${width}-${path.replaceAll('/', '-') || 'overview'}`;
        try {
          if (width > 900) {
            assert(
              Math.abs(geometry.titleX - geometry.toolsX) <= 1,
              `${name}: toolbar/title misalignment ${JSON.stringify(geometry)}`,
            );
            assert(
              Math.abs(geometry.contentX - geometry.toolsX) <= 1,
              `${name}: toolbar/content misalignment`,
            );
          } else {
            // Preserve the existing compact toolbar gutter while checking wrapping.
            assert.equal(geometry.toolsX, 20, `${name}: preserve the compact toolbar gutter`);
          }
          assert(geometry.overflow <= 1, `${name}: toolbar must wrap within the available width`);
          assert.equal(geometry.viewport, width);
        } catch (error) {
          await page.screenshot({ path: `${output}/${name}-failed.png`, fullPage: true });
          throw error;
        }
        if (path === '' || (path === '/ai/bots' && width === 1920))
          await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
      }
    }
    await context.close();
  }
  assert.deepEqual(report.errors, [], 'No browser runtime errors');
  report.passed = true;
  console.log(`Analysis toolbar layout: ${report.checks.length} checks passed`);
} finally {
  fs.writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
