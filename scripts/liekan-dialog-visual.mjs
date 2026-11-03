import { isolatedAcceptanceTarget, acceptanceSeedFile } from './liekan-acceptance-target.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { generateSync } from 'otplib';
import { checkDialog, assertDialogContract, dialogBaseline } from './liekan-dialog-contract.mjs';
import { verifyDialogChecker } from './liekan-dialog-contract-fixtures.mjs';
const base = process.env.LIEKAN_URL || 'http://127.0.0.1:3302';
const target = isolatedAcceptanceTarget(base);
assertDialogContract();
const seed = JSON.parse(fs.readFileSync(acceptanceSeedFile(target), 'utf8'));
const out = 'test-results/liekan-dialogs';
fs.mkdirSync(out, { recursive: true });
let token;
const created = [];
const keyName = '弹窗验收密钥 ' + Date.now();
async function api(method, path, body, credential = token) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(credential ? { authorization: 'Bearer ' + credential } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, 200, method + ' ' + path + ' HTTP ' + response.status);
  return response.json();
}
token = (await api('POST', '/auth/login', seed.admin, '')).token;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CI ? {} : { channel: 'chrome' }),
});
const result = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  passed: false,
  checks: [],
  duplicates: [],
  responsive: [],
  supplementalResponsive: [],
  websiteDeletionSuccess: [],
  errors: [],
  cleanup: { passed: false, checks: [], errors: [] },
  fixtures: ['断开日志连接使用浏览器内的连接状态测试夹具；取消操作不会写入服务。'],
};
const date = `range:${seed.range.startAt}:${Date.now()}:day`;
const fixturePassword = randomBytes(32).toString('hex');
let own, ownToken, team, switchWebsite, goal, funnel, segment, annotation, board, share;
let replayOriginal;
try {
  result.checkerRegression = await verifyDialogChecker(browser);
  own = await api('POST', '/users', {
    username: 'modal-' + Date.now(),
    password: fixturePassword,
    role: 'user',
  });
  created.push('/users/' + own.id);
  const ownCredentials = { username: own.username, password: fixturePassword };
  ownToken = (await api('POST', '/auth/login', ownCredentials, '')).token;
  await api('PATCH', '/liekan/account/preferences', {
    countryCode: 'CN', timezone: 'Asia/Shanghai', range: '0day',
  }, ownToken);
  team = (await api('POST', '/teams', { name: '弹窗验收团队' }))[0];
  created.push('/teams/' + team.id);
  await api('POST', `/teams/${team.id}/users`, { userId: own.id, role: 'team-member' });
  switchWebsite = await api('POST', '/websites', {
    name: '弹窗验收切换网站',
    domain: 'dialog-switch.invalid',
  });
  created.push('/websites/' + switchWebsite.id);
  goal = await api('POST', `/websites/${seed.website.id}/goals`, {
    name: '弹窗验收目标',
    parameters: { type: 'event', value: seed.data.eventNames[0] },
  });
  created.push(`/websites/${seed.website.id}/goals/${goal.id}`);
  funnel = await api('POST', `/websites/${seed.website.id}/funnels`, {
    name: '弹窗验收漏斗',
    parameters: {
      window: 30,
      steps: [
        { type: 'path', value: '/' },
        { type: 'event', value: seed.data.eventNames[0] },
      ],
    },
  });
  created.push(`/websites/${seed.website.id}/funnels/${funnel.id}`);
  segment = await api('POST', `/websites/${seed.website.id}/segments`, {
    name: '弹窗验收分群',
    type: 'segment',
    parameters: { filters: [], match: 'all' },
  });
  created.push(`/websites/${seed.website.id}/segments/${segment.id}`);
  annotation = await api('POST', `/websites/${seed.website.id}/annotations`, {
    date: new Date(seed.range.startAt).toISOString(),
    note: '弹窗验收注释',
    allDay: true,
  });
  created.push(`/websites/${seed.website.id}/annotations/${annotation.id}`);
  board = await api('POST', '/boards', {
    name: '弹窗验收看板',
    type: 'website',
    parameters: {
      websiteId: seed.website.id,
      rows: [
        {
          id: 'modal-row',
          columns: [
            {
              id: 'modal-column',
              size: 100,
              component: {
                title: '访客趋势',
                type: 'WebsiteChart',
                entityType: 'website',
                entityId: seed.website.id,
              },
            },
          ],
        },
      ],
    },
  });
  created.push('/boards/' + board.id);
  share = await api('POST', '/share', {
    name: '弹窗验收分享',
    entityId: seed.website.id,
    shareType: 1,
    parameters: { overview: true, events: true },
  });
  created.push('/share/id/' + share.id);
  async function at(feature, params = {}, credential = token, width = 1440, height = 1000, setup) {
    const context = await browser.newContext({
      viewport: { width, height },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    await context.addInitScript(
      t => localStorage.setItem('umami.auth', JSON.stringify(t)),
      credential,
    );
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', e => result.errors.push(e.message));
    if (setup) await setup(page);
    await page.goto(
      base +
        `/liekan/${feature}?` +
        new URLSearchParams({ websiteId: seed.website.id, date, ...params }),
    );
    await page.waitForLoadState('networkidle');
    return { page, context };
  }
  async function geo(name, width = 1440, height = 1000) {
    const context = await browser.newContext({
      viewport: { width, height },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    await context.addInitScript(t => localStorage.setItem('umami.auth', JSON.stringify(t)), token);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', e => result.errors.push(e.message));
    await page.goto(
      base + `/websites/${seed.website.id}/geo/${name}?` + new URLSearchParams({ date }),
    );
    await page.waitForLoadState('networkidle');
    return { page, context };
  }
  const entryPages = new WeakMap();
  async function openDialog(page, button) {
    const entry = page.url();
    await page.getByRole('button', { name: button, exact: true }).click();
    if (button === '蜘蛛识别规则') {
      await page.waitForURL(url => url.pathname === '/crawlers/manage');
      await expect(page.getByLabel(/^选择网站/)).toHaveValue(seed.website.id);
      await page.getByRole('button', { name: '编辑网站识别规则', exact: true }).click();
      entryPages.set(page, entry);
    }
  }
  async function record(page, id, title, duplicate = false) {
    await page.getByRole('dialog', { name: title, exact: true }).waitFor();
    if (id === 44) await page.getByRole('img', { name: '链接二维码', exact: true }).waitFor();
    const scenario = dialogBaseline.scenes.find(s => s.id === id);
    const geometry = await checkDialog(page, scenario.width === 1120 ? 'wide' : 'standard');
    const close = page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true });
    await close.focus();
    await page.keyboard.press('Shift+Tab');
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog]')?.contains(document.activeElement),
    );
    await page.keyboard.press('Tab');
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog]')?.contains(document.activeElement),
    );
    (duplicate ? result.duplicates : result.checks).push({
      id,
      title,
      path: new URL(page.url()).pathname,
      geometry,
    });
    await page.screenshot({
      path: `${out}/${String(id).padStart(2, '0')}${duplicate ? '-duplicate' : ''}.png`,
      mask: id === 16 ? [page.locator('.code-block')] : [],
      animations: 'disabled',
    });
  }
  async function dismiss(page) {
    await page.keyboard.press('Escape');
    if (await page.getByRole('button', { name: '放弃修改并关闭', exact: true }).count())
      await page.getByRole('button', { name: '放弃修改并关闭', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(
      () =>
        getComputedStyle(document.body).overflowY !== 'hidden' &&
        getComputedStyle(document.documentElement).overflowY !== 'hidden',
    );
    assert(
      await page.evaluate(() => document.activeElement !== document.body),
      'Dialog did not restore focus to its entry',
    );
    if (entryPages.has(page)) {
      const entry = entryPages.get(page);
      entryPages.delete(page);
      await page.goto(entry);
      await page.waitForLoadState('networkidle');
    }
  }
  async function buttons(feature, cases, params = {}, credential = token) {
    const { page, context } = await at(feature, params, credential);
    try {
      for (const [id, button, title] of cases) {
        await openDialog(page, button);
        await record(page, id, title);
        await dismiss(page);
      }
    } finally {
      await context.close();
    }
  }
  await buttons(
    'website-settings',
    [
      [1, '导入网站日志', '导入访问日志'],
      [2, '管理内容目录', '管理内容目录'],
      [3, '编辑 robots.txt', '编辑 robots.txt'],
      [4, '管理蜘蛛', '管理蜘蛛'],
      [5, '蜘蛛识别规则', '蜘蛛识别规则'],
    ],
    { section: 'collection' },
  );
  result.trafficQuality = [];
  for (const width of [1440, 390]) {
    const { page, context } = await at(
      'website-settings',
      { section: 'collection' },
      token,
      width,
      1000,
    );
    try {
      await page.getByRole('button', { name: '浏览流量质量', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '浏览流量质量', exact: true });
      await dialog.getByLabel('统计模式').waitFor();
      const geometry = await checkDialog(page, 'wide');
      await expect(dialog.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled();
      await dialog.getByRole('button', { name: '预览影响', exact: true }).click();
      await expect(dialog.getByRole('button', { name: '确认保存', exact: true })).toBeEnabled();
      await dialog.getByLabel('统计模式').selectOption('strict');
      await expect(dialog.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled();
      await page.screenshot({
        path: `${out}/traffic-quality-${width}.png`,
        animations: 'disabled',
      });
      result.trafficQuality.push({ width, geometry, previewInvalidation: true });
    } finally {
      await context.close();
    }
  }
  await buttons(
    'website-settings',
    [
      [10, '转移网站', '转移网站所属空间'],
      [11, '清空访问数据', '清空访问数据'],
      [12, '删除网站', '删除网站'],
    ],
    { section: 'danger' },
  );
  for (const [name, cases] of [
    [
      'ai',
      [
        [3, '编辑 robots.txt', '编辑 robots.txt'],
        [4, '管理蜘蛛', '管理蜘蛛'],
      ],
    ],
    ['ai/bots', [[5, '蜘蛛识别规则', '蜘蛛识别规则']]],
    ['ai/pages', [[2, '管理内容目录', '管理内容目录']]],
    [
      'logs',
      [
        [6, '蜘蛛识别规则', '蜘蛛识别规则'],
        [7, '查询访问日志', '查询访问日志'],
      ],
    ],
    ['human', [[9, '与上周对比', '与上周对比']]],
  ]) {
    const { page, context } = await geo(name);
    try {
      for (const [id, button, title] of cases) {
        await openDialog(page, button);
        await record(page, id, title, [2, 3, 4, 5].includes(id));
        if (id === 7) {
          const query = 'unapplied dialog query';
          await page.getByLabel('查询关键词').fill(query);
          await page.getByRole('tab', { name: '导入日志', exact: true }).click();
          await page.getByLabel('访问日志内容').fill('unapplied import draft');
          await record(page, 1, '导入访问日志', true);
          await page.getByRole('tab', { name: '查询记录', exact: true }).click();
          assert.equal(await page.getByLabel('查询关键词').inputValue(), query);
          await page.getByRole('tab', { name: '导入日志', exact: true }).click();
          assert.equal(
            await page.getByLabel('访问日志内容').inputValue(),
            'unapplied import draft',
          );
        }
        await dismiss(page);
      }
      if (name === 'human') {
        await page.locator('button[title^="统计时区"]').click();
        await record(page, 8, '选择日期范围');
        await dismiss(page);
      }
    } finally {
      await context.close();
    }
  }
  await buttons('account', [
    [13, '修改用户名', '修改用户名'],
    [14, '修改密码', '修改密码'],
  ]);
  {
    const { page, context } = await at('website-settings', {
      section: 'install',
      step: 'logs',
      method: 'manual',
    });
    try {
      await page.getByRole('button', { name: '导入网站日志', exact: true }).click();
      await record(page, 1, '导入访问日志', true);
      await dismiss(page);
    } finally {
      await context.close();
    }
  }
  const twofactor = await api('POST', '/2fa/setup/initiate', {}, ownToken);
  await api(
    'POST',
    '/2fa/setup/confirm',
    { token: generateSync({ secret: twofactor.manualKey }) },
    ownToken,
  );
  await buttons('security', [[15, '关闭双重验证', '关闭双重验证']], {}, ownToken);
  {
    const { page, context } = await at('api-keys');
    try {
      await page.getByRole('button', { name: '创建密钥', exact: true }).click();
      await record(page, 16, '创建 API 密钥');
      await page.getByLabel('密钥名称').fill(keyName);
      await page
        .getByRole('dialog')
        .getByRole('button', { name: '创建 API 密钥', exact: true })
        .click();
      await page.getByRole('button', { name: '已保存，关闭', exact: true }).waitFor();
      const key = (await api('GET', '/me/api-keys')).find(k => k.name === keyName);
      assert(key);
      created.push('/me/api-keys/' + key.id);
      await record(page, 16, '创建 API 密钥', true);
      await page.getByRole('button', { name: '已保存，关闭', exact: true }).click();
      await page
        .getByRole('row')
        .filter({ hasText: keyName })
        .getByRole('button', { name: '撤销', exact: true })
        .click();
      await record(page, 17, '撤销 API 密钥');
      await dismiss(page);
    } finally {
      await context.close();
    }
  }
  {
    const { page, context } = await at('retention');
    try {
      await page
        .locator('[data-website-toolbar-actions]')
        .getByRole('button', { name: / 至 / })
        .click();
      await record(page, 18, '选择日期范围');
      await dismiss(page);
      await page.getByRole('button', { name: '口径说明', exact: true }).click();
      await record(page, 20, '留存计算说明');
      await dismiss(page);
      await page.locator('.heat-cell[aria-label]').first().click();
      await record(page, 21, '留存详情');
      await dismiss(page);
      await page.getByRole('button', { name: '已保存分群', exact: true }).click();
      await record(page, 19, '已保存分群');
      await dismiss(page);
    } finally {
      await context.close();
    }
  }
  {
    const { page, context } = await at('breakdown');
    try {
      await page.getByRole('button', { name: '选择维度', exact: true }).click();
      await record(page, 22, '选择拆分维度');
      await page.getByText('已选择 2 / 3 个维度', { exact: true }).waitFor();
      await page.getByRole('checkbox', { name: '浏览器', exact: true }).check();
      await page.getByText('已选择 3 / 3 个维度', { exact: true }).waitFor();
      assert(await page.getByRole('checkbox', { name: '设备', exact: true }).isDisabled());
      await dismiss(page);
    } finally {
      await context.close();
    }
  }
  {
    const { page, context } = await at('compare');
    try {
      await page.getByRole('button', { name: '调整对照期间', exact: true }).click();
      await record(page, 23, '调整对照日期');
      await page.getByRole('dialog').getByText('当前期间', { exact: true }).waitFor();
      await page.getByRole('dialog').getByText('统计时区', { exact: true }).waitFor();
      await dismiss(page);
    } finally {
      await context.close();
    }
  }
  {
    const { page, context } = await at('annotations');
    try {
      await page.getByRole('button', { name: '添加注释', exact: true }).click();
      await record(page, 24, '添加注释');
      await dismiss(page);
      await page
        .getByRole('row')
        .filter({ hasText: '弹窗验收注释' })
        .getByRole('button', { name: '编辑注释', exact: true })
        .click();
      await record(page, 25, '编辑注释');
      await dismiss(page);
    } finally {
      await context.close();
    }
  }
  for (const [feature, name, id, title] of [
    ['goals', goal.name, 26, '删除目标'],
    ['funnels', funnel.name, 27, '删除漏斗'],
  ]) {
    const { page, context } = await at(feature);
    try {
      await page
        .getByRole('row')
        .filter({ hasText: name })
        .getByRole('button', { name: '删除', exact: true })
        .click();
      await record(page, id, title);
      await dismiss(page);
    } finally {
      await context.close();
    }
  }
  {
    const { page, context } = await at('exports');
    try {
      await page.getByLabel('文件格式').selectOption('json');
      await page.getByRole('button', { name: '生成导出文件', exact: true }).click();
      await page.getByRole('button', { name: '查看字段清单', exact: true }).click();
      await record(page, 28, '导出字段清单');
      await dismiss(page);
    } finally {
      await context.close();
    }
  }
  await buttons('teams', [[29, '创建团队', '创建团队']]);
  {
    const { page, context } = await at('team-detail', { id: team.id, teamId: team.id });
    try {
      await page.getByRole('button', { name: '添加已有用户', exact: true }).click();
      await record(page, 30, '添加团队成员');
      await dismiss(page);
      await page
        .getByRole('row')
        .filter({ hasText: own.username })
        .getByRole('button', { name: '编辑角色', exact: true })
        .click();
      await record(page, 31, '编辑成员角色');
      await page.getByRole('dialog').getByRole('button', { name: '移除成员', exact: true }).click();
      await record(page, 32, '移除成员');
      await dismiss(page);
      await page.getByRole('tab', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '删除团队', exact: true }).click();
      await record(page, 34, '删除团队');
      await dismiss(page);
    } finally {
      await context.close();
    }
  }
  {
    const { page, context } = await at('team-detail', { id: team.id, teamId: team.id }, ownToken);
    try {
      await page.getByRole('tab', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '退出团队', exact: true }).click();
      await record(page, 33, '退出团队');
      await dismiss(page);
    } finally {
      await context.close();
    }
  }
  await buttons('admin-users', [[35, '创建用户', '创建系统用户']]);
  await buttons(
    'admin-user',
    [
      [36, '重置双重验证', '重置用户双重验证'],
      [37, '删除用户', '删除用户'],
    ],
    { id: own.id },
  );
  await buttons('admin-websites', [[38, '按空间筛选', '按所属空间筛选']]);
  {
    const { page, context } = await at('board-design', { id: board.id });
    try {
      await page.getByRole('button', { name: '添加组件', exact: true }).click();
      await record(page, 39, '添加看板组件');
      await dismiss(page);
      await page
        .locator('.widget-tools')
        .getByRole('button', { name: '编辑', exact: true })
        .first()
        .click();
      await record(page, 40, '编辑看板组件');
      await dismiss(page);
    } finally {
      await context.close();
    }
  }
  await buttons('board-view', [[41, '删除', '删除看板']], { id: board.id });
  await buttons('link-editor', [[42, '删除链接', '删除链接']], { id: seed.link.id });
  await buttons('pixel-editor', [[43, '删除追踪图片', '删除追踪图片']], { id: seed.pixel.id });
  await buttons('link-detail', [[44, '查看链接二维码', '链接二维码']], { id: seed.link.id });
  const replayStatus = await api(
    'GET',
    `/websites/${seed.website.id}/replays/saved/${seed.data.replayVisitId}`,
  );
  if (typeof replayStatus.isSaved !== 'boolean')
    throw new Error('Cannot capture saved replay state before changing its fixture');
  let originalRecord;
  if (replayStatus.isSaved) {
    for (let page = 1; !originalRecord; page++) {
      const savedReplays = await api(
        'GET',
        `/websites/${seed.website.id}/replays/saved?pageSize=200&page=${page}`,
      );
      if (
        !Array.isArray(savedReplays.data) ||
        !Number.isSafeInteger(savedReplays.count) ||
        savedReplays.count < 0
      )
        throw new Error('Cannot capture saved replay record from an invalid page');
      originalRecord = savedReplays.data.find(record => record.visitId === seed.data.replayVisitId);
      if (originalRecord) {
        if (typeof originalRecord.name !== 'string')
          throw new Error('Cannot capture saved replay name before changing its fixture');
      } else if (!savedReplays.data.length || page * 200 >= savedReplays.count) {
        throw new Error('Cannot capture saved replay record before changing its fixture');
      }
    }
  }
  replayOriginal = { record: originalRecord };
  await api('POST', `/websites/${seed.website.id}/replays/saved/${seed.data.replayVisitId}`, {
    isSaved: false,
  });
  await buttons('replay-player', [[45, '保存会话回放', '保存会话回放']], {
    id: seed.data.replayVisitId,
  });
  await api('POST', `/websites/${seed.website.id}/replays/saved/${seed.data.replayVisitId}`, {
    isSaved: true,
    name: '弹窗验收回放',
  });
  await buttons('replay-player', [[46, '已保存', '管理已保存回放']], {
    id: seed.data.replayVisitId,
  });
  {
    const { page, context } = await at('funnel-editor', { id: funnel.id });
    try {
      await page.getByLabel('漏斗名称').fill('修改未保存');
      await page.getByRole('button', { name: /切换网站，当前/ }).click();
      await page
        .getByRole('button', { name: '选择网站 ' + switchWebsite.name, exact: true })
        .click();
      await record(page, 47, '放弃未保存的修改？');
      await page.getByRole('button', { name: '继续编辑', exact: true }).click();
      assert.equal(await page.getByLabel('漏斗名称').inputValue(), '修改未保存');
    } finally {
      await context.close();
    }
  }
  {
    const sourceId = randomUUID();
    const { page, context } = await at(
      'website-settings',
      { section: 'install', step: 'logs', method: 'server' },
      token,
      1440,
      1000,
      async page => {
        await page.route(
          '**/api/liekan/websites/' + seed.website.id + '/installation',
          async route => {
            const response = await route.fetch();
            const data = await response.json();
            data.sources = [
              ...(data.sources || []),
              {
                id: sourceId,
                kind: 'server',
                domain: seed.website.domain,
                state: 'paused',
                primary: false,
                lastHeartbeatAt: null,
                lastReceivedAt: null,
                lastProcessedAt: null,
                backlog: 0,
                errorCode: null,
                health: {},
              },
            ];
            await route.fulfill({ response, json: data });
          },
        );
      },
    );
    try {
      await page.getByRole('button', { name: '断开连接', exact: true }).first().click();
      await record(page, 48, '断开日志连接');
      await page.getByRole('button', { name: '保留连接', exact: true }).click();
    } finally {
      await context.close();
    }
  }
  {
    const { page, context } = await at('sharing');
    try {
      await page.getByRole('button', { name: '创建分享链接', exact: true }).click();
      await record(page, 49, '创建分享链接');
      await dismiss(page);
      await page
        .getByRole('row')
        .filter({ hasText: '弹窗验收分享' })
        .getByRole('button', { name: '编辑', exact: true })
        .click();
      await record(page, 50, '编辑分享链接');
      await dismiss(page);
    } finally {
      await context.close();
    }
  }
  for (const [width, height] of [
    [1920, 1080],
    [2560, 1440],
    [1024, 768],
    [768, 900],
    [375, 812],
  ]) {
    const { page, context } = await at(
      'website-settings',
      { section: 'collection' },
      token,
      width,
      height,
    );
    try {
      for (const [button, size] of [
        ['导入网站日志', 'wide'],
        ['管理蜘蛛', 'standard'],
        ['蜘蛛识别规则', 'wide'],
      ]) {
        await openDialog(page, button);
        const longDomainStress = width === 375 && button === '导入网站日志';
        if (longDomainStress)
          await page.locator('.dialog-subtitle').evaluate(element => {
            element.textContent =
              '长域名测试网站 · ' + [63, 63, 63, 61].map(length => 'a'.repeat(length)).join('.');
          });
        const geometry = await checkDialog(page, size);
        result.responsive.push({ width, height, button, geometry, longDomainStress });
        await page.screenshot({
          path: `${out}/responsive-${width}-${size}-${button}.png`,
          animations: 'disabled',
        });
        await dismiss(page);
      }
    } finally {
      await context.close();
    }
  }
  for (const width of [375, 768]) {
    for (const [feature, params, button, title] of [
      ['link-detail', { id: seed.link.id }, '查看链接二维码', '链接二维码'],
      ['sharing', {}, '创建分享链接', '创建分享链接'],
      ['annotations', {}, '添加注释', '添加注释'],
      ['breakdown', {}, '选择维度', '选择拆分维度'],
    ]) {
      const { page, context } = await at(feature, params, token, width, 900);
      try {
        await openDialog(page, button);
        await page.getByRole('dialog', { name: title, exact: true }).waitFor();
        if (feature === 'link-detail')
          await page.getByRole('img', { name: '链接二维码', exact: true }).waitFor();
        const geometry = await checkDialog(page);
        assert(
          await page
            .locator('.liekan-dialog .dialog-body')
            .evaluate(element => element.scrollWidth <= element.clientWidth + 1),
          `${title} body overflows at ${width}px`,
        );
        result.supplementalResponsive.push({ feature, width, geometry });
        await page.screenshot({
          path: `${out}/responsive-${width}-${feature}.png`,
          animations: 'disabled',
        });
        await dismiss(page);
      } finally {
        await context.close();
      }
    }
  }
  for (const [width, height] of [
    [1440, 1000],
    [1920, 1080],
    [768, 900],
    [767, 900],
    [390, 844],
    [320, 480],
  ]) {
    const longContent = width === 320;
    const credential = width === 1440 ? token : ownToken;
    const website = await api(
      'POST',
      '/websites',
      {
        name: longContent ? '删除结果长名称验证'.repeat(10) : `删除结果验证网站 ${width}`,
        domain: longContent
          ? [63, 63, 63, 61].map(length => 'a'.repeat(length)).join('.')
          : 'delete-result.invalid',
      },
      credential,
    );
    const cleanupPath = '/websites/' + website.id;
    created.push(cleanupPath);
    const { page, context } = await at(
      'website-settings',
      { websiteId: website.id, section: 'danger', returnTo: '/websites?scope=all' },
      credential,
      width,
      height,
    );
    try {
      let deleted = false;
      const oldReads = [];
      page.on('response', response => {
        if (
          response.request().method() === 'DELETE' &&
          new URL(response.url()).pathname === '/api/websites/' + website.id &&
          response.status() === 200
        )
          deleted = true;
      });
      page.on('request', request => {
        if (
          deleted &&
          request.method() === 'GET' &&
          new URL(request.url()).pathname.startsWith('/api/websites/' + website.id)
        )
          oldReads.push(new URL(request.url()).pathname);
      });
      await page.getByRole('button', { name: '删除网站', exact: true }).click();
      const confirmation = page.getByRole('dialog', { name: '删除网站', exact: true });
      await confirmation
        .getByLabel(`输入 ${website.name} 确认`, { exact: false })
        .fill(website.name);
      await confirmation.getByRole('button', { name: '删除网站', exact: true }).click();
      await expect(page).toHaveURL(/\/websites\?scope=all$/);
      await expect(page.getByRole('dialog', { name: '网站删除成功', exact: true })).toBeVisible();
      assert(deleted, 'Deletion result requires a successful DELETE response');
      created.splice(created.indexOf(cleanupPath), 1);
      await page.waitForLoadState('networkidle');
      const success = page.getByRole('dialog', { name: '网站删除成功', exact: true });
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await expect(success.getByText(website.name, { exact: true })).toBeVisible();
      await expect(success.getByText(website.domain, { exact: true })).toBeVisible();
      await expect(page.locator('.toast')).toHaveCount(0);
      await expect(page.locator('main')).not.toContainText(website.name);
      const geometry = await checkDialog(page, 'wide');
      assert(
        await page
          .locator('.dialog-body')
          .evaluate(element => element.scrollWidth <= element.clientWidth + 1),
        'Deletion result body must contain long website names and domains',
      );
      await page.screenshot({
        path: `${out}/website-delete-success-${width}.png`,
        animations: 'disabled',
      });
      if (width === 1440) {
        await page.waitForTimeout(4000);
        await expect(success).toBeVisible();
      }
      if (width === 767) await page.keyboard.press('Escape');
      else if (width === 768)
        await success.getByRole('button', { name: '关闭弹窗', exact: true }).click();
      else await success.getByRole('button', { name: '知道了', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('main')).toBeFocused();
      assert.deepEqual(oldReads, [], 'Deleted website must receive no further reads');
      if (credential === ownToken) {
        const remaining = await api('GET', '/websites', undefined, ownToken);
        assert.equal(remaining.count, 0, 'Last website returns to the empty website list');
      }
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      result.websiteDeletionSuccess.push({ width, height, geometry, longContent, passed: true });
    } finally {
      await context.close();
    }
  }
  assert.equal(result.websiteDeletionSuccess.length, 6);
  assert.deepEqual(
    result.checks.map(check => check.id).sort((a, b) => a - b),
    Array.from({ length: 50 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    result.duplicates.map(check => check.id).sort((a, b) => a - b),
    [1, 1, 2, 3, 4, 5, 16],
    'Dialog duplicate entry acceptance incomplete',
  );
  assert.equal(result.errors.length, 0);
  result.passed = true;
} catch (error) {
  result.failure = error.message;
  throw error;
} finally {
  try {
    await browser.close();
  } catch {
    result.errors.push('Test browser cleanup failed');
    result.passed = false;
  }
  if (replayOriginal) {
    try {
      await api('POST', `/websites/${seed.website.id}/replays/saved/${seed.data.replayVisitId}`, {
        isSaved: false,
      });
      if (replayOriginal.record)
        await api('POST', `/websites/${seed.website.id}/replays/saved/${seed.data.replayVisitId}`, {
          isSaved: true,
          name: replayOriginal.record.name,
        });
      result.cleanup.checks.push('seed replay state restored');
    } catch (error) {
      result.cleanup.errors.push({ resource: 'seed replay', message: error.message });
    }
  }
  for (const path of created.reverse()) {
    try {
      await api('DELETE', path);
      result.cleanup.checks.push(path);
    } catch (error) {
      result.cleanup.errors.push({ resource: path, message: error.message });
    }
  }
  result.cleanup.passed = result.cleanup.errors.length === 0;
  result.passed &&= result.cleanup.passed;
  fs.writeFileSync(out + '/report.json', JSON.stringify(result, null, 2));
  if (!result.cleanup.passed)
    throw new Error('Dialog fixture cleanup incomplete; see report cleanup errors');
}
console.log(
  JSON.stringify({
    passed: result.passed,
    scenes: result.checks.length,
    responsive: result.responsive.length,
  }),
);
