import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from '@playwright/test';

test('website actions share one row across page shells, locales and available widths', async () => {
  const css = readFileSync('src/styles/liekan/WebsiteToolbar.module.css', 'utf8').replace(
    /:global\(([^)]+)\)/g,
    '$1',
  );
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of [1512, 1280, 390]) {
      for (const locale of ['zh-CN', 'en-US']) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          const labels =
            locale === 'zh-CN'
              ? ['今天', '7 天', '30 天', '10/01 至 10/31', '刷新', '管理蜘蛛']
              : ['Today', '7 days', '30 days', '10/01 to 10/31', 'Refresh', 'Manage crawlers'];
          await page.setContent(`<style>
            * { box-sizing:border-box; }
            body { margin:0; font:12.5px Arial,sans-serif; }
            .frame { margin-left:${width > 900 ? 228 : 0}px; }
            .site-switch { display:block; min-width:160px; }
            .headerActions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
            .chip { flex-shrink:0; padding:0 12px; border:1px solid #e5e9f0; border-radius:8px; background:white; white-space:nowrap; font:inherit; }
            [data-language-selector] { width:124px; height:36px; }
            ${css}
          </style>
          <div class="frame"><div class="toolbar" data-website-toolbar>
            <div class="context"><button class="site-switch">${locale === 'zh-CN' ? '当前网站' : 'Current website'}</button></div>
            <div class="actions" data-website-toolbar-actions data-toolbar-action-rail>
              <div class="headerActions" data-liekan-owned-actions>${labels.map(label => `<button class="chip">${label}</button>`).join('')}</div>
              <button class="robotsButton" data-toolbar-robots>${locale === 'zh-CN' ? 'robots 管理' : 'Robots management'}</button>
            </div><select data-language-selector><option>${locale === 'zh-CN' ? '简体中文' : 'English'}</option></select>
          </div></div>`);
          const geometry = await page.locator('[data-website-toolbar]').evaluate(toolbar => {
            const buttons = [...toolbar.querySelectorAll('[data-website-toolbar-actions] button')];
            const rail = toolbar.querySelector('[data-toolbar-action-rail]');
            return {
              count: buttons.length,
              rows: new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top)))
                .size,
              height: toolbar.getBoundingClientRect().height,
              railWidth: rail.clientWidth,
              railScrollWidth: rail.scrollWidth,
              overflow: document.documentElement.scrollWidth - innerWidth,
            };
          });
          assert.equal(geometry.count, 7, `${locale}/${width}: nonempty actions`);
          assert.equal(geometry.rows, 1, `${locale}/${width}: one action row`);
          assert(geometry.railWidth > 100, `${locale}/${width}: usable action rail`);
          assert(geometry.overflow <= 1, `${locale}/${width}: no page overflow`);
          if (width > 900) assert.equal(geometry.height, 60, `${locale}/${width}: compact header`);
          if (width === 1512)
            assert(
              geometry.railScrollWidth <= geometry.railWidth + 1,
              `${locale}/${width}: all desktop actions fit without clipping`,
            );
          await page.locator('.chip').first().focus();
          for (let step = 0; step < 6; step++) await page.keyboard.press('Tab');
          assert(
            await page
              .locator('[data-toolbar-robots]')
              .evaluate(button => button === document.activeElement),
          );
          const reachable = await page.locator('[data-toolbar-robots]').evaluate(button => {
            const box = button.getBoundingClientRect();
            const element = button.closest('[data-toolbar-action-rail]');
            const rail = element.getBoundingClientRect();
            return {
              left: box.left,
              right: box.right,
              railLeft: rail.left,
              railRight: rail.right,
              scrollLeft: element.scrollLeft,
              scrollWidth: element.scrollWidth,
            };
          });
          assert(
            reachable.right > reachable.railLeft && reachable.left < reachable.railRight,
            `${locale}/${width}: focused action remains visible ${JSON.stringify(reachable)}`,
          );
          await page.locator('[data-toolbar-action-rail]').hover();
          await page.mouse.wheel(2000, 0);
          await page.waitForFunction(() => {
            const button = document.querySelector('[data-toolbar-robots]').getBoundingClientRect();
            const rail = document
              .querySelector('[data-toolbar-action-rail]')
              .getBoundingClientRect();
            return button.left >= rail.left - 1 && button.right <= rail.right + 1;
          });
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
});
