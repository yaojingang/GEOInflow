// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { expect, test, vi } from 'vitest';
import { restoreReplayEventFragments } from '../lib/replay';
import { sanitizeReplayEvent, sanitizeReplayEvents } from './privacy';

test.each(['url('.repeat(16000), `url(${' '.repeat(64000)}`, `url("${'x'.repeat(64000)}`])(
  'malformed long CSS is handled in bounded time',
  style => {
    const before = performance.now();
    const event = { type: 2, data: { node: { attributes: { style } } } };
    expect(sanitizeReplayEvent(event)).toEqual(event);
    expect(performance.now() - before).toBeLessThan(1000);
  },
);

test.each([
  '/* url(" */ a{background:url(/token/synthetic-secret)}',
  "a{content:'url(\"';background:url(/token/synthetic-secret)}",
  'a{background:url("broken\n);background-image:url(/token/synthetic-secret)}',
])('CSS comments, strings and bad strings do not hide a later URL', style => {
  const result = sanitizeReplayEvent({ type: 2, data: { node: { attributes: { style } } } });
  expect(result.data.node.attributes.style).not.toContain('synthetic-secret');
  expect(result.data.node.attributes.style).toContain('/token/[redacted]');
});

const recorderScript = buildSync({
  stdin: {
    contents: readFileSync(new URL('./index.js', import.meta.url), 'utf8')
      .replace(
        "import { addCustomEvent, record } from 'rrweb';",
        'const record = window.__record; const addCustomEvent = (...args) => window.__customEvent?.(...args);',
      )
      .replaceAll('__COLLECT_API_HOST__', ''),
    loader: 'js',
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
  },
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2022',
}).outputFiles[0].text;

test('URL-bearing DOM and CSS values are cleaned without changing replay structure or assets', () => {
  const input = {
    type: 2,
    timestamp: 1234,
    data: {
      node: {
        type: 2,
        id: 10,
        tagName: 'style',
        attributes: {
          href: '/reset/link-secret',
          action: '/verify/form-secret',
          src: 'data:image/png;base64,fixture',
          srcset: '/images/safe.png 1x, /token/image-secret 2x',
          style: 'color:red; background:url("/token/style-secret")',
          _cssText: '@import "/token/import-secret"; a { background:url(/docs/normal.png); }',
        },
        childNodes: [
          { type: 3, id: 11, textContent: String.raw`a{background:url(/\74 oken/css-secret)}` },
        ],
      },
    },
  };
  const clean = sanitizeReplayEvent(input);
  expect(clean.data.node.attributes).toEqual({
    href: '/reset/[redacted]',
    action: '/verify/[redacted]',
    src: 'data:image/png;base64,fixture',
    srcset: '/images/safe.png 1x, /token/[redacted] 2x',
    style: 'color:red; background:url("/token/[redacted]")',
    _cssText: '@import "/token/[redacted]"; a { background:url(/docs/normal.png); }',
  });
  expect(clean.data.node.childNodes[0]).toEqual({
    type: 3,
    id: 11,
    textContent: 'a{background:url("/token/[redacted]")}',
  });
  expect(clean.type).toBe(2);
  expect(clean.timestamp).toBe(1234);
  expect(input.data.node.attributes.href).toBe('/reset/link-secret');
  expect(sanitizeReplayEvent(clean)).toEqual(clean);
});

test.each([
  { type: 3, data: { source: 8, adds: [{ rule: 'a{background:url(/token/secret)}', index: 2 }] } },
  {
    type: 3,
    data: {
      source: 13,
      set: { property: 'background', value: 'url(/token/secret)', priority: '' },
      id: 2,
    },
  },
  {
    type: 3,
    data: {
      source: 0,
      attributes: [
        { id: 2, attributes: { style: { background: ['url(/token/secret)', 'important'] } } },
      ],
    },
  },
  { type: 3, data: { source: 8, replaceSync: 'a{background:url(/token/secret)}' } },
])('sanitizes incremental stylesheet and style mutations', input => {
  const output = JSON.stringify(sanitizeReplayEvent(input));
  expect(output).toContain('/token/[redacted]');
  expect(output).not.toContain('/token/secret');
  expect(output).toContain('url(\\"/token/[redacted]\\")');
});

test('complete out-of-order fragment groups are cleaned and remain replayable', () => {
  const event = {
    type: 4,
    timestamp: 1000,
    data: { href: '/reset/fragment-secret', width: 1200, height: 800 },
  };
  const serialized = JSON.stringify(event);
  const fragments = [serialized.slice(0, 51), serialized.slice(51)].map((value, index) => ({
    type: 'umami:rrweb-event-fragment',
    timestamp: 1000,
    data: { id: 'group', index, total: 2, value },
  }));
  const clean = sanitizeReplayEvents([fragments[1], fragments[0]]);
  expect(clean.map(e => e.data.index)).toEqual([1, 0]);
  expect(restoreReplayEventFragments(clean)).toEqual([
    { ...event, data: { ...event.data, href: '/reset/[redacted]' } },
  ]);
  expect(JSON.stringify(clean)).not.toContain('fragment-secret');
  expect(fragments.map(e => e.data.value).join('')).toBe(serialized);
  expect(sanitizeReplayEvents([fragments[0]])).toEqual([fragments[0]]);
});

test.each([undefined, 'invalid', 'strict', 'moderate'])(
  'recorder protects text unless moderate was explicitly configured: %s',
  async maskLevel => {
    const browser = new JSDOM('<!doctype html><body><p>Customer details</p></body>', {
      url: 'https://example.com/',
      runScripts: 'outside-only',
    });
    try {
      const { window } = browser;
      const record = vi.fn((_options: Record<string, unknown>) => () => {});
      (window as any).__record = record;
      (window as any).umami = { getSession: () => ({ cache: 'session' }) };
      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true, replayEnabled: true, sampleRate: 1, maskLevel }),
      });
      const script = window.document.createElement('script');
      script.src = 'https://collector.example/recorder.js';
      script.setAttribute('data-website-id', 'website');
      Object.defineProperty(window.document, 'currentScript', { value: script });
      Object.defineProperty(window.document, 'readyState', { value: 'complete' });
      window.eval(recorderScript);
      await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
      expect(record.mock.calls[0][0]).toMatchObject({ maskAllInputs: true });
      expect((record.mock.calls[0][0] as any).maskTextSelector).toBe(
        maskLevel === 'moderate' ? undefined : '*',
      );
    } finally {
      browser.window.close();
    }
  },
);

test('recorder redacts metadata, DOM URLs, navigation and heatmap URLs before sending', async () => {
  const browser = new JSDOM('<!doctype html><body><a>Link</a></body>', {
    url: 'https://example.com/reset/first-secret?token=query-secret',
    runScripts: 'outside-only',
  });
  try {
    const { window } = browser;
    let emit!: (event: any) => void;
    (window as any).__record = (options: any) => {
      emit = options.emit;
      return () => {};
    };
    (window as any).__customEvent = (tag: string, payload: any) =>
      emit({ type: 5, timestamp: 1000, data: { tag, payload } });
    (window as any).umami = { getSession: () => ({ cache: 'fixture-session' }) };
    const requests: any[] = [];
    window.fetch = vi.fn(async (_url, options) => {
      if (options?.body) requests.push(JSON.parse(String(options.body)));
      return {
        ok: true,
        json: async () => ({
          enabled: true,
          replayEnabled: true,
          heatmapEnabled: true,
          sampleRate: 1,
          heatmapSampleRate: 1,
          maskLevel: 'strict',
        }),
      } as Response;
    });
    const listeners = vi.spyOn(window.document, 'addEventListener');
    const script = window.document.createElement('script');
    script.src = 'https://collector.example/recorder.js';
    script.setAttribute('data-website-id', 'website');
    Object.defineProperty(window.document, 'currentScript', { value: script });
    Object.defineProperty(window.document, 'readyState', { value: 'complete' });
    window.eval(recorderScript);
    await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    emit({
      type: 4,
      timestamp: 1000,
      data: { href: window.location.href, width: 1200, height: 800 },
    });
    const snapshot = {
      type: 2,
      timestamp: 1001,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'a',
              attributes: { href: '/verify/dom-secret', class: 'normal-link' },
              childNodes: [],
            },
          ],
        },
        initialOffset: { left: 0, top: 0 },
      },
    };
    emit(snapshot);
    // Exercise the trusted-click handler directly: jsdom synthetic clicks are untrusted.
    const click = listeners.mock.calls.find(([name]) => name === 'click')?.[1] as (
      event: Record<string, unknown>,
    ) => void;
    click({
      isTrusted: true,
      button: 0,
      clientX: 12,
      clientY: 20,
      pageX: 12,
      pageY: 20,
      target: window.document.querySelector('a'),
    });
    window.history.pushState({}, '', '/reset/second-secret');
    window.history.pushState({}, '', '/reset/third-secret');
    // A large snapshot must be cleaned before it becomes opaque transport fragments.
    emit({
      ...snapshot,
      timestamp: 1002,
      data: { ...snapshot.data, node: { ...snapshot.data.node, padding: 'x'.repeat(600_000) } },
    });
    window.dispatchEvent(new window.Event('pagehide'));
    window.dispatchEvent(new window.Event('beforeunload'));
    const replay = restoreReplayEventFragments(
      requests.filter(r => r.type === 'record').flatMap(r => r.payload.events),
    );
    expect(replay.find(e => e.type === 4).data).toEqual({
      href: 'https://example.com/reset/[redacted]?token=%5Bredacted%5D',
      width: 1200,
      height: 800,
    });
    expect(replay.filter(e => e.type === 2)).toHaveLength(2);
    expect(replay.find(e => e.type === 2).data.node.childNodes[0].attributes).toEqual({
      href: '/verify/[redacted]',
      class: 'normal-link',
    });
    expect(replay.filter(e => e.type === 5).map(e => e.data.payload.url)).toEqual([
      'https://example.com/reset/[redacted]',
      'https://example.com/reset/[redacted]',
    ]);
    const heatmap = requests.filter(r => r.type === 'heatmap').flatMap(r => r.payload.events);
    expect(heatmap.find(e => e.type === 'click')).toMatchObject({
      url: 'https://example.com/reset/[redacted]?token=%5Bredacted%5D',
      x: 12,
      y: 20,
    });
    expect(heatmap.some(e => e.type === 'scroll')).toBe(true);
    expect(JSON.stringify(requests)).not.toMatch(
      /first-secret|second-secret|third-secret|query-secret|dom-secret/,
    );
    expect(snapshot.data.node.childNodes[0].attributes.href).toBe('/verify/dom-secret');
  } finally {
    browser.window.close();
  }
});
