// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { UmamiTracker } from './index';

// Exercise the same classic script boundary as the published tracker, with a fresh
// browser for every test so history hooks and window-only state cannot leak.
const trackerScript = buildSync({
  stdin: {
    contents: readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
      .replaceAll('__COLLECT_API_HOST__', '')
      .replaceAll('__COLLECT_API_ENDPOINT__', '/api/send'),
    loader: 'ts',
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
  },
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2022',
}).outputFiles[0].text;
const browsers: { close: () => void }[] = [];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('explicit tracker payloads redact credentials before the network boundary', () => {
  const browser = createBrowser();
  browser.load({ 'website-id': 'website-id', 'auto-track': 'false' });
  browser.window.umami.track({
    website: 'website-id',
    url: '/callback?token=browser-private-value&utm_source=google#access_token=fragment-private-value',
  });
  const payload = browser.requests()[0].payload;
  expect(JSON.stringify(payload)).not.toMatch(/browser-private-value|fragment-private-value/);
  expect(new URL(payload.url, 'https://shop.example.com').searchParams.get('utm_source')).toBe(
    'google',
  );
});

test('case variants of a website UUID share one tracker identity', () => {
  const browser = createBrowser();
  const id = '9ab5f5e4-6ae9-494e-a908-38f2a05d963a';
  browser.load({ 'website-id': id });
  browser.load({ 'website-id': id.toUpperCase() });
  expect(browser.requests()).toHaveLength(1);
});

function createBrowser() {
  const browser = new JSDOM('<!doctype html><title>Shop</title><body></body>', {
    url: 'https://shop.example.com/start',
    referrer: 'https://search.example.com/results',
    runScripts: 'outside-only',
  });
  const window = browser.window as unknown as Window & {
    Event: typeof Event;
    eval: (script: string) => void;
    umami: UmamiTracker;
  };
  browsers.push(browser.window);
  const resolvedEndpoints: string[] = [];
  const fetch = vi.fn().mockImplementation((endpoint: string) => {
    resolvedEndpoints.push(new URL(endpoint, window.document.baseURI).href);
    return Promise.resolve({ json: vi.fn().mockResolvedValue({}) });
  });
  window.fetch = fetch;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  window.setTimeout = ((callback: () => void, delay: number) => {
    timers.set(++timerId, { callback, delay });
    return timerId;
  }) as typeof window.setTimeout;
  window.clearTimeout = (id: number) => {
    timers.delete(id);
  };
  class PerformanceObserver {
    observe() {}
    takeRecords() {
      return [];
    }
  }
  Object.defineProperty(window, 'PerformanceObserver', { value: PerformanceObserver });
  Object.defineProperty(window.document, 'readyState', { configurable: true, value: 'complete' });

  const load = (attributes: Record<string, string> = {}) => {
    const script = window.document.createElement('script');
    script.src = 'https://analytics.example.com/script.js';
    script.dataset.websiteId = 'website-id';
    for (const [name, value] of Object.entries(attributes))
      script.setAttribute(`data-${name}`, value);
    Object.defineProperty(window.document, 'currentScript', { configurable: true, value: script });
    window.eval(trackerScript);
  };
  const requests = () =>
    fetch.mock.calls.map(([endpoint, init]) => ({
      endpoint,
      ...JSON.parse(init.body),
      headers: init.headers,
      credentials: init.credentials,
    }));
  const flushNavigation = async () => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay === 300) {
        timers.delete(id);
        timer.callback();
      }
    }
    await Promise.resolve();
  };
  return { window, fetch, load, requests, resolvedEndpoints, flushNavigation };
}

afterEach(() => {
  for (const browser of browsers.splice(0)) browser.close();
});

test('carries positive browser automation evidence across initial and manual events', async () => {
  const browser = createBrowser();
  Object.defineProperty(browser.window.navigator, 'webdriver', { value: true });
  browser.load();
  await browser.window.umami.track('checkout');
  expect(browser.requests()).toHaveLength(2);
  for (const request of browser.requests()) expect(request.payload.webdriver).toBe(true);
});

test('before-send hooks cannot erase observed browser automation evidence', async () => {
  const browser = createBrowser();
  Object.defineProperty(browser.window.navigator, 'webdriver', { value: true });
  (browser.window as any).customize = (_type: string, payload: any) => ({
    ...payload,
    webdriver: false,
  });
  browser.load({ 'before-send': 'customize', 'auto-track': 'false' });
  await browser.window.umami.track();
  expect(browser.requests()[0].payload.webdriver).toBe(true);
});

test('ordinary browsers retain the existing payload without an automation claim', () => {
  const browser = createBrowser();
  Object.defineProperty(browser.window.navigator, 'webdriver', { value: false });
  browser.load();
  expect(browser.requests()).toHaveLength(1);
  expect(browser.requests()[0].payload.webdriver).toBeUndefined();
});

test('identifies data-distinct-id before the initial page view', async () => {
  const browser = createBrowser();
  browser.load({ 'distinct-id': 'visitor-id' });

  expect(browser.requests()).toMatchObject([
    { type: 'identify', payload: { id: 'visitor-id', website: 'website-id' } },
    { type: 'event', payload: { id: 'visitor-id', website: 'website-id' } },
  ]);
});

test('duplicate scripts for one website and collect URL track each browser action once', async () => {
  const browser = createBrowser();
  browser.load({ 'host-url': 'https://analytics.example.com', performance: 'true' });
  const publicTracker = browser.window.umami;
  browser.load({ 'host-url': 'https://analytics.example.com/', performance: 'true' });

  expect(browser.requests()).toHaveLength(1);
  expect(browser.window.umami).toBe(publicTracker);
  browser.window.history.pushState({}, '', '/next');
  await browser.flushNavigation();
  const button = browser.window.document.createElement('button');
  button.setAttribute('data-umami-event', 'checkout');
  browser.window.document.body.append(button);
  button.click();
  browser.window.dispatchEvent(new browser.window.Event('pagehide'));

  expect(browser.requests().filter(request => request.type === 'event')).toMatchObject([
    { payload: { url: 'https://shop.example.com/start' } },
    { payload: { url: 'https://shop.example.com/next' } },
    { payload: { name: 'checkout' } },
  ]);
  expect(browser.requests().filter(request => request.type === 'performance')).toHaveLength(2);
});

test('relative and absolute representations of the same collect URL share initialization', () => {
  const browser = createBrowser();
  browser.load({ 'host-url': '/collect' });
  browser.load({ 'host-url': 'https://shop.example.com/collect' });

  expect(browser.requests()).toMatchObject([
    { endpoint: 'https://shop.example.com/collect/api/send', payload: { website: 'website-id' } },
  ]);
});

test('collect URL identity follows document baseURI and retains separate actual endpoints', () => {
  const browser = createBrowser();
  const base = browser.window.document.createElement('base');
  base.href = 'https://analytics.example.com/directory/';
  browser.window.document.head.prepend(base);
  browser.load({ 'host-url': '/collect' });
  browser.load({ 'host-url': 'https://analytics.example.com/collect' });
  expect(browser.requests()).toHaveLength(1);

  browser.load({ 'host-url': 'https://shop.example.com/collect' });
  expect(browser.requests()).toMatchObject([
    { endpoint: 'https://analytics.example.com/collect/api/send' },
    { endpoint: 'https://shop.example.com/collect/api/send' },
  ]);
});

test('relative collect URLs remain pinned across SPA paths and equivalent script reinjection', async () => {
  const browser = createBrowser();
  browser.load({ 'host-url': 'collect' });
  expect(browser.resolvedEndpoints).toEqual(['https://shop.example.com/collect/api/send']);
  browser.window.history.pushState({}, '', '/dir/page');
  browser.load({ 'host-url': 'https://shop.example.com/collect' });
  expect(browser.requests()).toHaveLength(1);
  await browser.flushNavigation();
  await browser.window.umami.track();

  expect(browser.requests()).toHaveLength(3);
  expect(browser.resolvedEndpoints).toEqual([
    'https://shop.example.com/collect/api/send',
    'https://shop.example.com/collect/api/send',
    'https://shop.example.com/collect/api/send',
  ]);
});

test('duplicate scripts loaded before page readiness identify and initialize once', () => {
  const browser = createBrowser();
  Object.defineProperty(browser.window.document, 'readyState', { value: 'loading' });
  browser.load({ 'distinct-id': 'visitor-id' });
  browser.load({ 'distinct-id': 'visitor-id' });
  expect(browser.requests()).toMatchObject([{ type: 'identify' }]);

  Object.defineProperty(browser.window.document, 'readyState', { value: 'complete' });
  browser.window.document.dispatchEvent(new browser.window.Event('readystatechange'));
  browser.window.document.dispatchEvent(new browser.window.Event('readystatechange'));
  expect(browser.requests()).toMatchObject([
    { type: 'identify', payload: { id: 'visitor-id' } },
    { type: 'event', payload: { id: 'visitor-id' } },
  ]);
});

test('separate websites and collect endpoints each auto-track page views and navigation', async () => {
  const browser = createBrowser();
  browser.load({ 'host-url': 'https://one.example.com' });
  browser.load({ 'website-id': 'second-website', 'host-url': 'https://one.example.com' });
  browser.load({ 'host-url': 'https://two.example.com' });
  expect(browser.requests()).toMatchObject([
    { endpoint: 'https://one.example.com/api/send', payload: { website: 'website-id' } },
    { endpoint: 'https://one.example.com/api/send', payload: { website: 'second-website' } },
    { endpoint: 'https://two.example.com/api/send', payload: { website: 'website-id' } },
  ]);
  browser.window.history.pushState({}, '', '/next');
  await browser.flushNavigation();
  expect(browser.requests().filter(request => request.payload.url.endsWith('/next'))).toHaveLength(
    3,
  );
  expect(browser.window.umami.getSession().website).toBe('website-id');
});

test('rapid navigation preserves every distinct URL and its trigger-time referrer', async () => {
  const browser = createBrowser();
  browser.load();
  browser.window.history.pushState({}, '', '/one');
  browser.window.history.replaceState({}, '', '/two');
  browser.window.history.replaceState({}, '', '/two');
  browser.window.history.pushState({}, '', '/one');
  await browser.flushNavigation();

  expect(
    browser.requests().map(request => ({
      url: request.payload.url,
      referrer: request.payload.referrer,
    })),
  ).toEqual([
    { url: 'https://shop.example.com/start', referrer: 'https://search.example.com/results' },
    { url: 'https://shop.example.com/one', referrer: '/start' },
    { url: 'https://shop.example.com/two', referrer: '/one' },
    { url: 'https://shop.example.com/one', referrer: '/two' },
  ]);
});

test('relative routes and excluded URL fields preserve normalization and distinct transitions', async () => {
  const browser = createBrowser();
  browser.load({ 'exclude-search': 'true', 'exclude-hash': 'true' });
  browser.window.history.pushState({}, '', '/docs?campaign=one#intro');
  browser.window.history.replaceState({}, '', '/docs?campaign=two#details');
  browser.window.history.pushState({}, '', 'section?campaign=three#next');
  await browser.flushNavigation();

  expect(
    browser.requests().map(request => ({
      url: request.payload.url,
      referrer: request.payload.referrer,
    })),
  ).toEqual([
    { url: 'https://shop.example.com/start', referrer: 'https://search.example.com/results' },
    { url: 'https://shop.example.com/docs', referrer: '/start' },
    { url: 'https://shop.example.com/section', referrer: '/docs' },
  ]);
});

test('queued nested relative routes capture actual browser URLs and subsequent referrers', async () => {
  const browser = createBrowser();
  browser.load({ 'exclude-search': 'true', 'exclude-hash': 'true' });
  browser.window.history.pushState({}, '', '/catalog/start');
  browser.window.history.pushState({}, '', 'section/page?campaign=one#intro');
  browser.window.history.replaceState({}, '', '../summary?campaign=two#details');
  browser.window.history.pushState({}, '', '/done');
  await browser.flushNavigation();

  expect(
    browser.requests().map(request => ({
      url: request.payload.url,
      referrer: request.payload.referrer,
    })),
  ).toEqual([
    { url: 'https://shop.example.com/start', referrer: 'https://search.example.com/results' },
    { url: 'https://shop.example.com/catalog/start', referrer: '/start' },
    { url: 'https://shop.example.com/catalog/section/page', referrer: '/catalog/start' },
    { url: 'https://shop.example.com/catalog/summary', referrer: '/catalog/section/page' },
    { url: 'https://shop.example.com/done', referrer: '/catalog/summary' },
  ]);
});

test('manual identical page views keep their counts and receive separate event IDs without storage', async () => {
  const browser = createBrowser();
  const cookieSetter = vi.spyOn(browser.window.document, 'cookie', 'set');
  const storageWrites = vi.spyOn(Object.getPrototypeOf(browser.window.localStorage), 'setItem');
  browser.window.document.cookie = 'probe=1';
  browser.window.localStorage.setItem('probe', '1');
  expect(cookieSetter).toHaveBeenCalled();
  expect(storageWrites).toHaveBeenCalled();
  browser.window.document.cookie = 'probe=; Max-Age=0';
  browser.window.localStorage.clear();
  cookieSetter.mockClear();
  storageWrites.mockClear();
  browser.load();
  await browser.window.umami.track();
  await browser.window.umami.track();
  const ids = browser.requests().map(request => request.payload.eventId);

  expect(ids).toHaveLength(3);
  for (const id of ids) expect(id).toMatch(uuidPattern);
  expect(new Set(ids).size).toBe(3);
  expect(cookieSetter).not.toHaveBeenCalled();
  expect(storageWrites).not.toHaveBeenCalled();
  expect(browser.window.document.cookie).toBe('');
  expect(browser.window.localStorage.length).toBe(0);
});

test('legacy browsers without crypto still collect the page view', () => {
  const browser = createBrowser();
  Object.defineProperty(browser.window, 'crypto', { value: undefined });
  browser.load();

  expect(browser.requests()).toHaveLength(1);
  expect(browser.requests()[0].payload.url).toBe('https://shop.example.com/start');
  expect(browser.requests()[0].payload.eventId).toBeUndefined();
});

test('getRandomValues provides UUIDs when randomUUID is unavailable', () => {
  const browser = createBrowser();
  Object.defineProperty(browser.window.crypto, 'randomUUID', { value: undefined });
  browser.load();

  expect(browser.requests()[0].payload.eventId).toMatch(uuidPattern);
});

test('crypto methods that throw leave collection available without an event ID', () => {
  const browser = createBrowser();
  const unavailable = () => {
    throw new Error('Crypto unavailable');
  };
  Object.defineProperties(browser.window.crypto, {
    randomUUID: { value: unavailable },
    getRandomValues: { value: unavailable },
  });
  browser.load();

  expect(browser.requests()).toHaveLength(1);
  expect(browser.requests()[0].payload.eventId).toBeUndefined();
});

test('before-send replacements retain a logical event ID and can supply a valid ID', async () => {
  const browser = createBrowser();
  const suppliedId = '12345678-1234-4234-8234-123456789abc';
  const beforeSend = vi
    .fn()
    .mockImplementationOnce(async (_type, payload) => ({
      website: payload.website,
      url: '/custom',
    }))
    .mockImplementationOnce(async (_type, payload) => ({ ...payload, eventId: 'invalid' }))
    .mockImplementationOnce(async (_type, payload) => ({ ...payload, eventId: suppliedId }));
  Object.assign(browser.window, { beforeSend });
  browser.load({ 'before-send': 'beforeSend', 'auto-track': 'false' });
  await browser.window.umami.track();
  await browser.window.umami.track();
  await browser.window.umami.track();

  const requests = browser.requests();
  expect(requests[0].payload.url).toBe('/custom');
  expect(requests[0].payload.eventId).toMatch(uuidPattern);
  expect(requests[1].payload.eventId).toMatch(uuidPattern);
  expect(requests[0].payload.eventId).not.toBe(requests[1].payload.eventId);
  expect(requests[2].payload.eventId).toBe(suppliedId);
});

test.each([
  '11111111-1111-0111-8111-111111111111',
  '11111111-1111-9111-8111-111111111111',
  '11111111-1111-4111-7111-111111111111',
  '11111111-1111-4111-c111-111111111111',
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-8111-b111-111111111111',
  '11111111-1111-4111-A111-111111111111',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
])('manual and before-send IDs remain acceptable to the server: %s', async eventId => {
  const browser = createBrowser();
  Object.assign(browser.window, {
    beforeSend: (_type: string, payload: Record<string, unknown>) => payload,
  });
  browser.load({ 'before-send': 'beforeSend', 'auto-track': 'false' });
  await browser.window.umami.track({ website: 'website-id', eventId });
  Object.assign(browser.window, {
    beforeSend: (_type: string, payload: Record<string, unknown>) => ({ ...payload, eventId }),
  });
  await browser.window.umami.track();
  for (const request of browser.requests()) {
    expect(z.uuid().safeParse(request.payload.eventId).success).toBe(true);
    if (z.uuid().safeParse(eventId).success) expect(request.payload.eventId).toBe(eventId);
    else expect(request.payload.eventId).not.toBe(eventId);
  }
  expect(browser.requests()).toHaveLength(2);
});

test('a logical send generates its ID once before an asynchronous before-send callback', async () => {
  const browser = createBrowser();
  const generatedId = '12345678-1234-4234-8234-123456789abc';
  const randomUUID = vi.fn().mockReturnValue(generatedId);
  Object.defineProperty(browser.window.crypto, 'randomUUID', { value: randomUUID });
  let finish: ((payload: Record<string, unknown>) => void) | undefined;
  Object.assign(browser.window, {
    beforeSend: (_type: string, payload: Record<string, unknown>) =>
      new Promise(resolve => {
        finish = replacement => resolve({ ...payload, ...replacement });
      }),
  });
  browser.load({ 'auto-track': 'false', 'before-send': 'beforeSend' });
  const pending = browser.window.umami.track();
  expect(randomUUID).toHaveBeenCalledTimes(1);
  expect(browser.requests()).toHaveLength(0);
  finish?.({ url: '/custom' });
  await pending;

  expect(randomUUID).toHaveBeenCalledTimes(1);
  expect(browser.requests()).toMatchObject([
    {
      type: 'event',
      payload: { eventId: generatedId, url: '/custom' },
      headers: { 'Content-Type': 'application/json', 'x-umami-website-id': 'website-id' },
      credentials: 'omit',
    },
  ]);
});

test('before-send cancellation suppresses collection', async () => {
  const browser = createBrowser();
  Object.assign(browser.window, {
    beforeSend: (_type: string, payload: Record<string, unknown>) => payload,
  });
  browser.load({ 'auto-track': 'false', 'before-send': 'beforeSend' });
  await browser.window.umami.track();
  expect(browser.requests()).toHaveLength(1);
  browser.fetch.mockClear();
  Object.assign(browser.window, { beforeSend: () => null });
  await browser.window.umami.track();

  expect(browser.requests()).toHaveLength(0);
});

test('tracker controls and domain restrictions preserve manual and auto tracking behavior', async () => {
  const manual = createBrowser();
  manual.load({ 'auto-track': 'false' });
  expect(manual.requests()).toHaveLength(0);
  await manual.window.umami.track('manual');
  expect(manual.requests()).toHaveLength(1);
  manual.window.history.pushState({}, '', '/untracked');
  await manual.flushNavigation();
  expect(manual.requests()).toHaveLength(1);

  const noPageview = createBrowser();
  noPageview.load({ 'auto-pageview': 'false' });
  noPageview.window.history.pushState({}, '', '/next');
  await noPageview.flushNavigation();
  await noPageview.window.umami.track();
  expect(noPageview.requests()).toMatchObject([
    { payload: { url: 'https://shop.example.com/next' } },
  ]);

  const blocked = createBrowser();
  blocked.load({ domains: 'another.example.com' });
  await blocked.window.umami.track();
  expect(blocked.requests()).toHaveLength(0);
  const allowed = createBrowser();
  allowed.load({ domains: 'shop.example.com' });
  expect(allowed.requests()).toHaveLength(1);

  // A script excluded by its domain list never initializes the browser hooks.
  blocked.load({ domains: 'shop.example.com' });
  expect(blocked.requests()).toHaveLength(1);
});

test('prerendered pages wait for activation and send exactly one initial pageview', async () => {
  const browser = createBrowser();
  Object.defineProperty(browser.window.document, 'prerendering', {
    configurable: true,
    value: true,
  });
  browser.load();
  expect(browser.requests()).toHaveLength(0);
  await browser.window.umami.track('not-visible');
  expect(browser.requests()).toHaveLength(0);
  Object.defineProperty(browser.window.document, 'prerendering', {
    configurable: true,
    value: false,
  });
  browser.window.document.dispatchEvent(new browser.window.Event('prerenderingchange'));
  browser.window.document.dispatchEvent(new browser.window.Event('readystatechange'));
  expect(browser.requests()).toHaveLength(1);
  expect(browser.requests()[0].payload.name).toBeUndefined();
});

test('activation records the final prerender route once', async () => {
  const browser = createBrowser();
  Object.defineProperty(browser.window.document, 'prerendering', {
    configurable: true,
    value: true,
  });
  browser.load();
  browser.window.history.replaceState({}, '', '/activated-route');
  Object.defineProperty(browser.window.document, 'prerendering', {
    configurable: true,
    value: false,
  });
  browser.window.document.dispatchEvent(new browser.window.Event('prerenderingchange'));
  expect(browser.requests()).toHaveLength(1);
  expect(browser.requests()[0].payload.url).toBe('https://shop.example.com/activated-route');
});
