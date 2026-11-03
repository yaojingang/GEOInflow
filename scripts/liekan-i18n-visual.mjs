import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import QRCode from 'qrcode';
import { execFileSync } from 'node:child_process';
import { isolatedAcceptanceTarget } from './liekan-acceptance-target.mjs';
import { checkDialog } from './liekan-dialog-contract.mjs';

const normalize = text => text.trim().replace(/\s+/g, ' ');
const english = new Map();
for (const directory of ['messages', 'help-messages']) {
  const zh = JSON.parse(fs.readFileSync(`src/lib/liekan/i18n/${directory}/zh-CN.json`, 'utf8'));
  const en = JSON.parse(fs.readFileSync(`src/lib/liekan/i18n/${directory}/en-US.json`, 'utf8'));
  for (const [key, source] of Object.entries(zh)) english.set(normalize(source), en[key]);
}
const label = source => english.get(normalize(source)) || source;

export function languageHeaderGeometry() {
  const surface =
    [
      ...document.querySelectorAll(
        '[role="dialog"][data-slot="modal"],[role="dialog"][aria-modal="true"]',
      ),
    ].find(element => {
      const rect = element.getBoundingClientRect();
      return !element.closest('[aria-hidden="true"]') && rect.width > 0 && rect.height > 0;
    }) || document;
  const surfaceRect = surface === document ? null : surface.getBoundingClientRect();
  const entries = [...surface.querySelectorAll('[data-language-placement="header"]')];
  const entry = entries[0];
  const control = entry?.querySelector('select');
  const rect = control?.getBoundingClientRect();
  const controlStyle = control ? document.defaultView.getComputedStyle(control) : null;
  let languageTextWidth = 0;
  if (control) {
    const selectedText = document.createElement('span');
    selectedText.setAttribute('aria-hidden', 'true');
    selectedText.style.cssText =
      'position:absolute;visibility:hidden;white-space:pre;padding:0;margin:0';
    selectedText.style.font = controlStyle.font;
    selectedText.style.letterSpacing = controlStyle.letterSpacing;
    selectedText.textContent = control.options[control.selectedIndex]?.text || '';
    document.body.appendChild(selectedText);
    try {
      languageTextWidth = selectedText.getBoundingClientRect().width;
    } finally {
      selectedText.remove();
    }
  }
  const group = entry?.closest('[data-website-toolbar],.header-inner,[data-public-language]');
  const groupRect = group?.getBoundingClientRect();
  const websiteToolbar = entry?.closest('[data-website-toolbar]');
  const picker = websiteToolbar?.querySelector('.site-switch')?.getBoundingClientRect();
  const pickerName = websiteToolbar?.querySelector('.site-switch strong');
  const controls = websiteToolbar
    ? [...websiteToolbar.querySelectorAll('[data-website-toolbar-actions] button')]
        .map(element => ({
          label: element.textContent.trim(),
          rect: element.getBoundingClientRect(),
          rail: element.closest('[data-toolbar-action-rail]'),
        }))
        .filter(control => control.rect.width > 0 && control.rect.height > 0)
    : [];
  const scrollBounds = control => {
    const rail = control.rail;
    if (!rail || !groupRect || !['auto', 'scroll'].includes(getComputedStyle(rail).overflowX))
      return null;
    const rect = rail.getBoundingClientRect();
    const left = control.rect.left - rect.left + rail.scrollLeft;
    const right = control.rect.right - rect.left + rail.scrollLeft;
    return rect.left >= groupRect.left - 1 &&
      rect.right <= groupRect.right + 1 &&
      left >= -1 &&
      right <= rail.scrollWidth + 1
      ? rect
      : null;
  };
  return {
    count: entries.length,
    visible: !!rect && rect.width > 0 && rect.height > 0,
    language: control?.value,
    languageTextWidth,
    languageTextSpace: control
      ? control.clientWidth -
        parseFloat(controlStyle.paddingLeft) -
        parseFloat(controlStyle.paddingRight)
      : undefined,
    left: rect?.left,
    right: rect?.right,
    top: rect
      ? rect.top - (surface === document ? 0 : surface.getBoundingClientRect().top)
      : undefined,
    height: rect?.height,
    width: innerWidth,
    pickerWidth: picker?.width,
    pickerNameWidth: pickerName?.clientWidth,
    pickerNameScroll: pickerName?.scrollWidth,
    overlappingControls: picker
      ? controls
          .filter(control => {
            const rect = control.rect,
              rail = scrollBounds(control);
            const left = rail ? Math.max(rect.left, rail.left) : rect.left;
            const right = rail ? Math.min(rect.right, rail.right) : rect.right;
            return (
              right > left &&
              left < picker.right &&
              right > picker.left &&
              rect.top < picker.bottom &&
              rect.bottom > picker.top
            );
          })
          .map(control => control.label)
      : [],
    clippedControls: groupRect
      ? controls
          .filter(
            control =>
              !scrollBounds(control) &&
              (control.rect.left < groupRect.left - 1 || control.rect.right > groupRect.right + 1),
          )
          .map(control => control.label)
      : [],
    clippedModalContent: surfaceRect
      ? [...surface.querySelectorAll('code,input,select,button,img')]
          .filter(element => {
            const box = element.getBoundingClientRect();
            return (
              box.width > 0 &&
              box.height > 0 &&
              (box.left < surfaceRect.left - 1 || box.right > surfaceRect.right + 1)
            );
          })
          .map(element => element.tagName)
      : [],
    groupRight: groupRect
      ? groupRect.right - parseFloat(getComputedStyle(group).paddingRight || '0')
      : undefined,
  };
}

export function assertLanguageHeader(state, locale = 'en-US') {
  assert.equal(state.count, 1, 'Every page has one upper-right language entry');
  assert(state.visible, 'Header language selector must be visible');
  assert.deepEqual(
    state.overlappingControls || [],
    [],
    'Toolbar actions do not overlap the website picker',
  );
  assert.deepEqual(state.clippedControls || [], [], 'Toolbar actions stay inside their frame');
  assert.deepEqual(state.clippedModalContent || [], [], 'Modal content fits inside the dialog');
  if (state.width > 900 && state.pickerWidth !== undefined)
    assert(state.pickerWidth >= 80, 'Website picker retains usable space');
  if (state.pickerNameScroll > 0)
    assert(
      state.pickerNameWidth >= Math.min(48, state.pickerNameScroll) - 1,
      'Website name retains readable space beside its demo badge',
    );
  if (state.languageTextWidth > 0)
    assert(
      state.languageTextWidth <= state.languageTextSpace + 1,
      'Selected language text fits beside the select arrow',
    );
  assert.equal(state.language, locale, 'Header follows the selected language');
  assert(state.left >= 0 && state.right <= state.width + 1, 'Language selector fits the viewport');
  assert(
    state.right > state.width / 2 && state.top < 230,
    'Language selector stays at the upper right',
  );
  assert(
    state.height >= (state.width <= 900 ? 44 : 36),
    'Language selector retains its touch target',
  );
  if (state.groupRight !== undefined)
    assert(Math.abs(state.groupRight - state.right) <= 2, 'Language is the last header control');
}

export function englishPageGeometry() {
  return {
    overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    width: innerWidth,
    title: document.title,
    clippedNavigation: [...document.querySelectorAll('[data-navigation-primary] a > span')]
      .filter(
        element =>
          element.textContent.trim() &&
          element.clientWidth > 0 &&
          element.scrollWidth > element.clientWidth + 1,
      )
      .map(element => element.textContent.trim()),
    empty: !document.body.textContent.trim(),
    contentLength: (
      document.querySelector('#main-content,main,article,.identity-flow')?.textContent || ''
    ).trim().length,
    readFailureHeads: [...document.querySelectorAll('.state-box h3')].map(el =>
      el.textContent.trim(),
    ),
    analyticsCards: document.querySelectorAll('main .metric-label,main [data-liekan-metric-label]')
      .length,
    analyticsTables: [...document.querySelectorAll('main table')].filter(
      el => el.querySelector('thead') && el.querySelector('tbody')?.textContent.trim(),
    ).length,
    untranslatedOwned: [
      ...document.querySelectorAll(
        '[data-liekan-page-title],[data-liekan-owned-actions] button,[data-liekan-product-footer] nav a,[data-navigation-section],[data-ai-suggested-question],[data-ai-platform-note],[data-liekan-metric-label],[data-liekan-auth-copy],.auth-form .field > span',
      ),
    ]
      .map(el => el.textContent.trim())
      .filter(text => /[\u3400-\u9fff]/.test(text)),
    untranslatedTitles: [...document.querySelectorAll('[data-liekan-page-title]')]
      .map(el => el.textContent.trim())
      .filter(text => /[\u3400-\u9fff]/.test(text)),
    untranslatedTablists: [...document.querySelectorAll('[data-analysis-family] [role="tablist"]')]
      .map(el => el.getAttribute('aria-label') || '')
      .filter(text => /[\u3400-\u9fff]/.test(text)),
    untranslated: [
      ...document.querySelectorAll(
        '.metric-label,[data-liekan-metric-label],.table-sort,.tab,[data-liekan-page-title],[data-liekan-owned-actions] button,[data-liekan-product-footer] nav a,[data-navigation-section],[data-ai-suggested-question],[data-ai-platform-note],[data-liekan-features] header h1,[data-liekan-ui] main h1,.identity-flow h1,[data-help-center] h2,[data-help-center] h3,.dialog-title,.state-box h3',
      ),
    ]
      .map(el => el.textContent.trim())
      .filter(text => /[\u3400-\u9fff]/.test(text)),
  };
}
export function englishChartsReady() {
  return [...document.querySelectorAll('.chart,[data-liekan-chart-state]')].every(el => {
    const state = el.getAttribute('data-liekan-chart-state');
    return (
      state === 'empty' ||
      (state !== 'loading' && state !== 'failed' && !!el.querySelector('canvas,svg'))
    );
  });
}
export const isStatisticsRequest = url =>
  /\/api\/liekan\/websites\/[^/]+\/(?:page-report|report|keywords)(?:\/|$)/.test(
    new URL(url).pathname,
  );
export function assertRenderedEnglishState(state, analytics = false) {
  assert(!state.empty && state.contentLength > 0, 'Rendered page body is required');
  if (analytics === 'table')
    assert(state.analyticsTables > 0, 'Rendered analytics table is required');
  else if (analytics) assert(state.analyticsCards > 0, 'Rendered analytics cards are required');
  const untranslatedOwned = state.untranslatedOwned.filter(text => {
    const source = normalize(text);
    return !english.has(source) || english.get(source) !== source;
  });
  assert.deepEqual(untranslatedOwned, [], 'Owned interface text must be English');
  assert.deepEqual(state.clippedNavigation || [], [], 'Navigation labels fit without clipping');
  assert(
    !state.readFailureHeads.some(text => [label('读取失败'), label('加载失败')].includes(text)),
    'Fixture data read must succeed',
  );
}
export function assertEnglishRouteIdentity(route, url, title) {
  assert.equal(
    new URL(url).pathname,
    new URL(route.path, url).pathname,
    `${route.id}: correct page route`,
  );
  assert.equal(
    title,
    label(route.documentTitle) + ' | GEOInflow',
    `${route.id}: correct English document title`,
  );
}
export function assertNumericSnapshot(values) {
  assert(
    values.length > 0 && values.some(row => row.length > 0),
    'Snapshot checks include actual numeric statistics',
  );
}

/** Uses new Playwright contexts; it never resizes a user's browser window. */
export async function checkEnglishExperience({ browser, base, seed, token, partial, routes }) {
  isolatedAcceptanceTarget(base);
  const fixtureQrCode = await QRCode.toDataURL('LOCAL_BROWSER_LAYOUT_FIXTURE');
  const featureIds = JSON.parse(
    fs.readFileSync('src/lib/liekan/contracts/feature-pages.json', 'utf8'),
  ).pages.map(page => page.id);
  assert.deepEqual(
    routes.map(route => route.id),
    [...featureIds, ...Array.from({ length: 13 }, (_, index) => `geo-${index}`), 'help'],
    'Every approved feature, GEO and help view must run',
  );
  const widths = [1440, 390];
  const out = 'test-results/liekan-i18n';
  fs.mkdirSync(out, { recursive: true });
  const report = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    passed: false,
    pages: [],
    checks: [],
    errors: [],
  };
  const contexts = [];
  let loggingOut = false;
  const watchPage = page => {
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('response', response => {
      const url = new URL(response.url());
      if (
        url.origin === new URL(base).origin &&
        url.pathname.startsWith('/api/') &&
        response.status() >= 400 &&
        !(loggingOut && url.pathname === '/api/auth/verify' && response.status() === 401)
      )
        report.errors.push(`Unexpected API response ${response.status()}: ${url.pathname}`);
    });
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      if (
        url.origin === new URL(base).origin &&
        url.pathname.startsWith('/api/') &&
        !request.failure()?.errorText.includes('ERR_ABORTED')
      )
        report.errors.push(`API request failed: ${url.pathname}`);
    });
  };
  const context = async (width, authToken) => {
    const value = await browser.newContext({
      viewport: { width, height: 1000 },
      locale: 'en-US',
      reducedMotion: 'reduce',
    });
    contexts.push(value);
    value.on('page', watchPage);
    await value.addCookies([{ name: 'liekan.locale', value: 'en-US', url: base }]);
    if (authToken)
      await value.addInitScript(
        ({ value, origin }) => {
          if (location.origin !== origin) return;
          if (!sessionStorage.getItem('liekan.i18n.seeded')) {
            localStorage.setItem('umami.auth', JSON.stringify(value));
            sessionStorage.setItem('liekan.i18n.seeded', 'true');
          }
        },
        { value: authToken, origin: new URL(base).origin },
      );
    return value;
  };
  const settled = async (page, locale = 'en-US') => {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(value => document.documentElement.lang === value, locale);
    await page.waitForSelector('[data-liekan-features], [data-help-center], main, article');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
      () => !document.querySelector('[aria-busy="true"]'),
      {},
      { timeout: 30000 },
    );
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(englishChartsReady, {}, { timeout: 15000 });
    await page.evaluate(
      () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  const geometry = page => page.evaluate(englishPageGeometry);
  const assertShareLayout = async page => {
    await page.locator('.public-shell[data-share-theme="light"]').waitFor();
    const languageBounds = await page.locator('[data-public-language]').boundingBox();
    const headerBounds = await page.locator('.public-head').boundingBox();
    assert(
      languageBounds && headerBounds && languageBounds.y + languageBounds.height <= headerBounds.y,
      'Public language selector stays above the share header',
    );
  };
  try {
    const rendered = await Promise.all(
      ['en-US', 'zh-CN', 'en-US'].map(async locale => {
        const response = await fetch(base + '/login', {
          headers: { cookie: `liekan.locale=${locale}` },
        });
        assert.equal(response.status, 200);
        return { locale, html: await response.text() };
      }),
    );
    for (const { locale, html } of rendered) {
      assert.match(
        html,
        new RegExp(`<html[^>]*lang="${locale}"`),
        'Server language stays isolated by request cookie',
      );
      const body = new JSDOM(html).window.document;
      assert.equal(
        body.querySelector('main h1')?.textContent.trim(),
        locale === 'en-US' ? label('欢迎回来') : '欢迎回来',
        'Server response renders the requested language body',
      );
    }
    report.checks.push({ name: 'server-cookie-request-isolation', passed: true });
    for (const width of widths) {
      const authenticated = await context(width, token),
        auth = await context(width),
        publicContext = await context(width);
      await auth.addInitScript(
        ({ value, origin }) => {
          if (location.origin === origin) sessionStorage.setItem('umami.partial-token', value);
        },
        { value: partial, origin: new URL(base).origin },
      );
      const actual = await authenticated.newPage(),
        login = await auth.newPage(),
        shared = await publicContext.newPage();
      for (const route of routes) {
        const page =
          route.id === 'share-preview'
            ? shared
            : ['login', 'login-2fa', 'sso'].includes(route.id)
              ? login
              : actual;
        try {
          await page.goto(base + route.path);
          await settled(page);
          assertEnglishRouteIdentity(route, page.url(), await page.title());
          assertLanguageHeader(await page.evaluate(languageHeaderGeometry));
          if (route.id === 'share-preview') {
            await assertShareLayout(page);
            assert(
              (await page.locator('.public-brand small').innerText()).includes(route.shareName),
              'Anonymous share retains its resource name',
            );
            assert.equal(
              await page.evaluate(() => localStorage.getItem('umami.auth')),
              null,
              'Public share is anonymous',
            );
            assert.equal(
              await page.getByRole('combobox', { name: 'Language / 语言' }).inputValue(),
              'en-US',
            );
          } else {
            assert(route.heading, `${route.id}: approved heading is required`);
            await page
              .getByRole('heading', { name: label(route.heading), exact: true, level: 1 })
              .waitFor();
          }
          if (['login', 'login-2fa', 'sso'].includes(route.id)) {
            const languageBounds = await page.locator('[data-language-selector]').boundingBox();
            const brandBounds = await page.locator('.auth-brand').boundingBox();
            assert(
              languageBounds &&
                brandBounds &&
                (languageBounds.x + languageBounds.width <= brandBounds.x ||
                  brandBounds.x + brandBounds.width <= languageBounds.x ||
                  languageBounds.y + languageBounds.height <= brandBounds.y ||
                  brandBounds.y + brandBounds.height <= languageBounds.y),
              'Authentication language selector stays clear of the brand',
            );
            assert.equal(new URL(page.url()).pathname, new URL(base + route.path).pathname);
            await page
              .getByRole('heading', {
                name: label(
                  route.id === 'login'
                    ? '欢迎回来'
                    : route.id === 'login-2fa'
                      ? '验证登录'
                      : '单点登录',
                ),
                exact: true,
              })
              .waitFor();
          }
          const failureHeads = await page.locator('.state-box h3').allTextContents();
          assert(
            !failureHeads.some(text =>
              [label('读取失败'), label('加载失败')].includes(text.trim()),
            ),
            `${route.id}: fixture data read succeeded`,
          );
          const state = await geometry(page);
          assertRenderedEnglishState(
            state,
            route.id === 'geo-2' ? 'table' : route.id.startsWith('geo-'),
          );
          assert(!state.empty, `${route.id}: empty page`);
          assert(state.contentLength > 0, `${route.id}: missing page body`);
          if (route.id.startsWith('geo-') && route.id !== 'geo-2')
            assert(state.analyticsCards > 0, `${route.id}: missing analytics cards`);
          assert.equal(state.overflow, 0, `${route.id} ${width}px page overflow`);
          // User-defined labels remain original; known application labels must localize.
          const leftovers = state.untranslated.filter(
            text => english.has(normalize(text)) && label(text) !== text,
          );
          assert.deepEqual(leftovers, [], `${route.id}: untranslated interface text`);
          assert.deepEqual(
            state.untranslatedTitles,
            [],
            `${route.id}: untranslated application title`,
          );
          assert.deepEqual(
            state.untranslatedTablists,
            [],
            `${route.id}: untranslated analysis accessible name`,
          );
          assert.equal(state.title.includes('undefined'), false, `${route.id}: invalid title`);
          await page.screenshot({
            path: `${out}/${route.id}-${width}.png`,
            fullPage: true,
            animations: 'disabled',
          });
          report.pages.push({ id: route.id, width, passed: true });
        } catch (error) {
          report.pages.push({ id: route.id, width, passed: false, error: error.message });
          await page
            .screenshot({ path: `${out}/${route.id}-${width}-failed.png`, fullPage: true })
            .catch(() => {});
        }
      }
      const shareRoute = routes.find(route => route.id === 'share-preview');
      assert(shareRoute.previewPath, 'Management share preview route is required');
      await actual.goto(base + shareRoute.previewPath);
      await settled(actual);
      assertEnglishRouteIdentity(
        { ...shareRoute, path: shareRoute.previewPath },
        actual.url(),
        await actual.title(),
      );
      await assertShareLayout(actual);
      report.checks.push({ name: 'management-share-preview-no-overlap', width, passed: true });
      await shared.goto(base + '/unknown-language-acceptance-page');
      await shared.waitForLoadState('networkidle');
      assertLanguageHeader(await shared.evaluate(languageHeaderGeometry));
      assert(
        !/[\u3400-\u9fff]/.test(await shared.locator('h1').innerText()),
        'Unknown-route heading is English',
      );
      report.checks.push({ name: 'unknown-route-language-entry', width, passed: true });
      const dialogs = [
        ['teams', '创建团队', '创建团队'],
        ['admin-users', '创建用户', '创建系统用户'],
        ['admin-websites', '按空间筛选', '按所属空间筛选'],
        ['sharing', '创建分享链接', '创建分享链接'],
        ['account', '修改用户名', '修改用户名'],
        ['account', '修改密码', '修改密码'],
        ['api-keys', '创建密钥', '创建 API 密钥'],
        ['website-settings', '导入网站日志', '导入访问日志', { section: 'collection' }, 'wide'],
        ['website-settings', '管理内容目录', '管理内容目录', { section: 'collection' }, 'wide'],
        [
          'website-settings',
          '编辑 robots.txt',
          '编辑 robots.txt',
          { section: 'collection' },
          'wide',
        ],
        ['website-settings', '管理蜘蛛', '管理蜘蛛', { section: 'collection' }],
        ['website-settings', '浏览流量质量', '浏览流量质量', { section: 'collection' }, 'wide'],
        ['website-settings', '转移网站', '转移网站所属空间', { section: 'danger' }],
        ['website-settings', '清空访问数据', '清空访问数据', { section: 'danger' }],
        ['website-settings', '删除网站', '删除网站', { section: 'danger' }],
      ];
      for (const [id, trigger, title, params, size = 'standard'] of dialogs) {
        const route = routes.find(route => route.id === id);
        const url = new URL(base + route.path);
        for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
        await actual.goto(url.toString());
        await settled(actual);
        await actual.getByRole('button', { name: label(trigger), exact: true }).click();
        const dialog = actual.getByRole('dialog', { name: label(title), exact: true });
        await dialog.waitFor();
        await actual.waitForLoadState('networkidle');
        const geometry = await checkDialog(actual, size);
        const texts = await dialog.evaluate(element => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const values = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.parentElement.closest('pre,code,textarea,script'))
              values.push(node.textContent);
          }
          for (const control of element.querySelectorAll('[aria-label],[placeholder]'))
            values.push(
              control.getAttribute('aria-label') || '',
              control.getAttribute('placeholder') || '',
            );
          return values;
        });
        assert.deepEqual(
          texts.map(normalize).filter(text => english.has(text) && label(text) !== text),
          [],
          `${title}: English dialog copy`,
        );
        await actual.screenshot({
          path: `${out}/dialog-${id}-${normalize(trigger)}-${width}.png`,
          animations: 'disabled',
        });
        await actual.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        report.checks.push({ name: 'english-dialog', id, title, width, geometry, passed: true });
      }
      const forced = await context(width, token);
      let setupRequests = 0;
      await forced.route(base + '/api/2fa/status*', route =>
        route.fulfill({
          json: {
            isEnabled: false,
            isRequired: true,
            isConfigured: true,
            globalRequired: true,
            requiredReason: 'global',
          },
        }),
      );
      await forced.route(base + '/api/2fa/setup/initiate', route => {
        setupRequests++;
        return route.fulfill({
          json: {
            manualKey: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
            qrCodeDataUrl: fixtureQrCode,
          },
        });
      });
      await forced.route(base + '/api/2fa/setup/confirm', route =>
        route.fulfill({ json: { backupCodes: ['LOCAL-BROWSER-FIXTURE-CODE'] } }),
      );
      const requiredPage = await forced.newPage();
      await requiredPage.goto(base + routes.find(route => route.id === 'geo-0').path);
      const setup = requiredPage.getByRole('dialog');
      const setupLanguage = setup.getByRole('combobox', { name: 'Language / 语言' });
      await setupLanguage.waitFor();
      await setup.getByAltText('QR code').evaluate(image => image.decode());
      assertLanguageHeader(await requiredPage.evaluate(languageHeaderGeometry));
      await setup.getByRole('textbox', { name: 'Digit 1', exact: true }).fill('1');
      await setupLanguage.selectOption('zh-CN');
      await requiredPage.waitForFunction(() => document.documentElement.lang === 'zh-CN');
      await setupLanguage.selectOption('en-US');
      await requiredPage.waitForFunction(() => document.documentElement.lang === 'en-US');
      assert.equal(
        await setup.getByRole('textbox', { name: 'Digit 1', exact: true }).inputValue(),
        '1',
      );
      assert.equal(setupRequests, 1, 'Changing language does not restart required setup');
      for (let digit = 2; digit <= 6; digit++)
        await setup
          .getByRole('textbox', { name: `Digit ${digit}`, exact: true })
          .fill(String(digit));
      await setup.getByText('LOCAL-BROWSER-FIXTURE-CODE', { exact: true }).waitFor();
      const saved = setup.getByRole('checkbox');
      await saved.check();
      await setupLanguage.selectOption('zh-CN');
      await requiredPage.waitForFunction(() => document.documentElement.lang === 'zh-CN');
      await setupLanguage.selectOption('en-US');
      await requiredPage.waitForFunction(() => document.documentElement.lang === 'en-US');
      assert(await saved.isChecked(), 'Recovery-code acknowledgement survives language switching');
      assert(await setup.getByText('LOCAL-BROWSER-FIXTURE-CODE', { exact: true }).isVisible());
      assertLanguageHeader(await requiredPage.evaluate(languageHeaderGeometry));
      await requiredPage.screenshot({
        path: `${out}/required-two-factor-${width}.png`,
        animations: 'disabled',
      });
      report.checks.push({
        name: 'required-two-factor-and-recovery-language',
        width,
        fixture: 'browser-only-two-factor-responses',
        passed: true,
      });
      await forced.close();
      await authenticated.close();
      await auth.close();
    }
    assert.equal(report.pages.length, routes.length * widths.length);
    assert(
      report.pages.every(page => page.passed),
      report.pages
        .filter(page => !page.passed)
        .map(page => `${page.id} ${page.width}: ${page.error}`)
        .join('\n'),
    );

    const live = await context(1440, token),
      page = await live.newPage();
    await page.goto(base + '/liekan/preferences');
    await settled(page);
    const range = page.locator('select[name="range"]');
    const preferenceLanguage = page
      .locator('#main-content')
      .getByRole('combobox', { name: 'Language / 语言' });
    const language = page.locator('[data-language-placement="header"] select');
    const menuLanguage = page
      .locator('#account-navigation')
      .getByRole('combobox', { name: 'Language / 语言' });
    if (!(await menuLanguage.isVisible()))
      await page
        .locator('#liekan-navigation footer button[aria-controls="account-navigation"]')
        .click();
    await range.selectOption('7day');
    const draft = await range.inputValue();
    await language.selectOption('zh-CN');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    assert.equal(
      await menuLanguage.inputValue(),
      'zh-CN',
      'Account selector follows preferences selector',
    );
    assert.equal(await preferenceLanguage.inputValue(), 'zh-CN', 'Preferences follow the header');
    await menuLanguage.selectOption('en-US');
    await page.waitForFunction(() => document.documentElement.lang === 'en-US');
    assert.equal(
      await language.inputValue(),
      'en-US',
      'Preferences selector follows account selector',
    );
    assert.equal(await range.inputValue(), draft, 'Language switches preserve preference drafts');
    await language.selectOption('zh-CN');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await language.focus();
    await page.keyboard.press('e');
    await page.waitForFunction(() => document.documentElement.lang === 'en-US');
    assert.equal(await menuLanguage.inputValue(), 'en-US');
    assert.equal(
      await range.inputValue(),
      draft,
      'Keyboard language switching preserves the draft',
    );
    report.checks.push({
      name: 'keyboard-language-selection-and-two-selector-synchronization',
      passed: true,
    });
    await language.selectOption('zh-CN');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    assert.equal(
      (await live.cookies(base)).find(cookie => cookie.name === 'liekan.locale')?.value,
      'zh-CN',
      'Changed cookie differs from the initial English cookie',
    );
    assert.equal(
      await page.evaluate(() => JSON.parse(localStorage.getItem('umami.locale'))),
      'zh-CN',
    );
    await page.reload();
    await settled(page, 'zh-CN');
    assert.equal(await language.inputValue(), 'zh-CN', 'Reload retains the changed language');
    const reopened = await live.newPage();
    await reopened.goto(base + '/liekan/preferences');
    await settled(reopened, 'zh-CN');
    assert.equal(
      await reopened
        .locator('#main-content')
        .getByRole('combobox', { name: 'Language / 语言' })
        .inputValue(),
      'zh-CN',
    );
    await reopened.close();
    await language.selectOption('en-US');
    await settled(page);
    assert.equal(
      (await live.cookies(base)).find(cookie => cookie.name === 'liekan.locale')?.value,
      'en-US',
    );
    report.checks.push({
      name: 'changed-language-cookie-reload-and-reopen-persistence',
      passed: true,
    });

    const date = `range:${seed.range.startAt}:${seed.range.endAt}:day`;
    await page.goto(base + `/websites/${seed.website.id}/geo?date=${date}&unit=day`);
    await settled(page);
    const before = {
      url: page.url(),
      values: (await page.locator('.num').allTextContents()).map(
        text => text.match(/[0-9]+(?:[.,][0-9]+)*/g) || [],
      ),
    };
    assertNumericSnapshot(before.values);
    const analyticsRequests = [];
    const track = request => {
      if (isStatisticsRequest(request.url())) analyticsRequests.push(request.url());
    };
    page.on('request', track);
    await page
      .locator('#liekan-navigation footer button[aria-controls="account-navigation"]')
      .click();
    await page.locator('[data-language-placement="header"] select').selectOption('zh-CN');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await page.locator('[data-language-placement="header"] select').selectOption('en-US');
    await page.waitForFunction(() => document.documentElement.lang === 'en-US');
    await page.waitForLoadState('networkidle');
    assert.equal(page.url(), before.url, 'Language switch preserves resource and date/filter URL');
    assert.deepEqual(
      (await page.locator('.num').allTextContents()).map(
        text => text.match(/[0-9]+(?:[.,][0-9]+)*/g) || [],
      ),
      before.values,
      'Statistics values remain unchanged',
    );
    assert.equal(
      analyticsRequests.length,
      0,
      'Language switch does not request a new statistics snapshot',
    );
    const refreshedSnapshot = page.waitForRequest(request =>
      new URL(request.url()).pathname.endsWith('/page-report'),
    );
    await page.locator('[data-manual-refresh]').click();
    await refreshedSnapshot;
    await page.waitForFunction(() => !document.querySelector('[data-manual-refresh]')?.disabled);
    await page.waitForLoadState('networkidle');
    assert(
      analyticsRequests.some(url => new URL(url).pathname.endsWith('/page-report')),
      'Explicit refresh proves the snapshot listener observes actual page-report requests',
    );
    page.off('request', track);
    report.checks.push({ name: 'snapshot-and-route-preservation', passed: true });

    await page.goto(base + '/liekan/help');
    await settled(page);
    await page.getByRole('searchbox').fill('Automated crawling');
    const results = page.getByRole('region', { name: label('蜘蛛结果'), exact: true });
    await results.locator('a[href*="crawler=gptbot"]').waitFor();
    assert(
      (await results.locator('li a').count()) > 0,
      'English help search has matching crawler results',
    );
    await page.goto(base + '/liekan/help?section=crawlers');
    await settled(page);
    const purpose = page.getByRole('combobox', { name: label('用途') });
    const crawlerIds = () =>
      page
        .getByRole('region', { name: label('蜘蛛结果'), exact: true })
        .locator('li a')
        .evaluateAll(links => links.map(link => new URL(link.href).searchParams.get('crawler')));
    await page.getByRole('combobox', { name: label('运营方') }).selectOption('OpenAI');
    const unfilteredIds = await crawlerIds();
    assert(
      unfilteredIds.includes('gptbot') && unfilteredIds.includes('oai-searchbot'),
      'Purpose check starts with training and search crawlers',
    );
    await purpose.selectOption({ label: label('训练') });
    assert.equal(
      await purpose.inputValue(),
      '训练',
      'English purpose labels preserve raw filter IDs',
    );
    const filteredIds = await crawlerIds();
    assert(
      filteredIds.includes('gptbot') && !filteredIds.includes('oai-searchbot'),
      'Training filter changes the result population',
    );
    assert.notDeepEqual(filteredIds, unfilteredIds);
    await page
      .locator('#liekan-navigation footer button[aria-controls="account-navigation"]')
      .click();
    await page.locator('[data-language-placement="header"] select').selectOption('zh-CN');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    assert.equal(
      await page.getByRole('combobox', { name: '用途', exact: true }).inputValue(),
      '训练',
    );
    const chineseIds = await page
      .getByRole('region', { name: '蜘蛛结果', exact: true })
      .locator('li a')
      .evaluateAll(links => links.map(link => new URL(link.href).searchParams.get('crawler')));
    assert.deepEqual(
      chineseIds,
      filteredIds,
      'Language switch retains purpose selection and results',
    );
    await page.locator('[data-language-placement="header"] select').selectOption('en-US');
    await settled(page);
    report.checks.push({ name: 'english-help-search-and-purpose-filter', passed: true });

    await page.goto(base + '/liekan/websites');
    await settled(page);
    await page
      .locator('#liekan-navigation footer button[aria-controls="account-navigation"]')
      .click();
    loggingOut = true;
    await page.getByRole('button', { name: label('退出登录'), exact: true }).click();
    await page.waitForURL(url => url.pathname === '/login');
    await settled(page);
    assert.equal(
      await page.evaluate(() => localStorage.getItem('umami.auth')),
      null,
      'Logout removes the authentication token',
    );
    assert.equal(
      await page.getByRole('combobox', { name: 'Language / 语言' }).inputValue(),
      'en-US',
    );
    await page.reload();
    await settled(page);
    assert.equal(
      await page.getByRole('combobox', { name: 'Language / 语言' }).inputValue(),
      'en-US',
    );
    assert.equal(
      (await live.cookies(base)).find(cookie => cookie.name === 'liekan.locale')?.value,
      'en-US',
      'Logout keeps the changed language cookie',
    );
    assert.equal(
      await page.evaluate(() => JSON.parse(localStorage.getItem('umami.locale'))),
      'en-US',
    );
    report.checks.push({ name: 'logout-language-persistence', passed: true });
    assert.deepEqual(report.errors, []);
    report.passed = true;
    return report;
  } finally {
    fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
    await Promise.allSettled(contexts.map(context => context.close()));
  }
}
