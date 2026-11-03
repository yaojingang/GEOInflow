import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { chromium, expect } from '@playwright/test';

export async function verifyAnalyticsEngineUI({ root, env, folder }) {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '',
    browser;
  server.stdout.on('data', chunk => {
    output += chunk;
  });
  server.stderr.on('data', chunk => {
    output += chunk;
  });
  try {
    for (let attempt = 0; ; attempt++) {
      if (
        await fetch(`${base}/login`)
          .then(r => r.ok)
          .catch(() => false)
      )
        break;
      if (attempt >= 120 || server.exitCode !== null)
        throw new Error('Isolated UI server did not become ready');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const unauthorized = await fetch(`${base}/api/liekan/admin/analytics-engine`);
    assert.equal(unauthorized.status, 401);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'liekan' }),
    });
    assert.equal(login.status, 200, 'Owned database default administrator must authenticate');
    const { token } = await login.json();
    assert(token, 'Use a real complete session token');
    const preferences = await fetch(`${base}/api/liekan/account/preferences`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({ countryCode: 'CN', timezone: 'Asia/Shanghai', range: '0day' }),
    });
    assert.equal(preferences.status, 200, 'Confirm timezone for the owned test administrator');
    browser = await chromium.launch({ headless: true });
    const checks = [];
    for (const locale of ['zh-CN', 'en-US']) {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
        await context.addCookies([{ name: 'liekan.locale', value: locale, url: base }]);
        await context.addInitScript(
          token => localStorage.setItem('umami.auth', JSON.stringify(token)),
          token,
        );
        const page = await context.newPage();
        const errors = [];
        const responses = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => {
          if (response.url().includes('/api/'))
            responses.push({ url: new URL(response.url()).pathname, status: response.status() });
        });
        await page.goto(`${base}/admin/analytics-engine`);
        try {
          await page.getByText('PostgreSQL + ClickHouse', { exact: true }).waitFor();
        } catch (error) {
          await page.screenshot({ path: `${folder}/ui-failure.png`, fullPage: true });
          await writeFile(
            `${folder}/ui-failure.json`,
            JSON.stringify(
              { url: page.url(), body: await page.locator('body').innerText(), errors, responses },
              null,
              2,
            ),
          );
          throw error;
        }
        await page
          .getByRole('button', {
            name: locale === 'zh-CN' ? '检查连接' : 'Check connection',
            exact: true,
          })
          .waitFor();
        await expect(
          page.getByRole('button', {
            name: locale === 'zh-CN' ? '启用 ClickHouse 分析' : 'Enable ClickHouse analytics',
            exact: true,
          }),
        ).toBeEnabled({ timeout: 90000 });
        await expect
          .poll(
            async () => {
              const response = await page.request.get(`${base}/api/liekan/admin/analytics-engine`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              assert.equal(response.status(), 200);
              const state = await response.json();
              return state.sites.some(site => Number(site.completed) > 0);
            },
            { timeout: 90000 },
          )
          .toBe(true);
        assert.equal(
          (await page.locator('table tbody tr').count()) > 0,
          true,
          'Render real coverage rows',
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          'Page root must fit its viewport',
        );
        assert.deepEqual(errors, [], 'No client runtime errors');
        await page.screenshot({
          path: `${folder}/analytics-engine-${locale}-${width}.png`,
          fullPage: true,
        });
        checks.push({
          locale,
          width,
          rows: await page.locator('table tbody tr').count(),
          runtimeErrors: errors.length,
        });
        if (locale === 'zh-CN' && width === 1440) {
          await page.getByRole('button', { name: '切回 PostgreSQL', exact: true }).click();
          await page.getByText('PostgreSQL', { exact: true }).waitFor();
          await page.getByRole('button', { name: '启用 ClickHouse 分析', exact: true }).click();
          await page.getByText('PostgreSQL + ClickHouse', { exact: true }).waitFor();
        }
        await context.close();
      }
    }
    await writeFile(
      `${folder}/visual.json`,
      JSON.stringify(
        { passed: true, realAuthentication: true, unauthorizedStatus: unauthorized.status, checks },
        null,
        2,
      ),
    );
    console.log(
      'Isolated browser verification passed: zh-CN/en-US, desktop/mobile, real authentication and switching',
    );
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise(resolve => server.once('close', resolve));
    await writeFile(`${folder}/ui-server.log`, output, { mode: 0o600 });
  }
}
