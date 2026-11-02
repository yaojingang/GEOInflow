// @vitest-environment node
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, test, vi } from 'vitest';

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
      window.fetch = vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ enabled: true, replayEnabled: true, sampleRate: 1, maskLevel }),
        });
      const script = window.document.createElement('script');
      script.src = 'https://collector.example/recorder.js';
      script.setAttribute('data-website-id', 'website');
      Object.defineProperty(window.document, 'currentScript', { value: script });
      Object.defineProperty(window.document, 'readyState', { value: 'complete' });
      const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
        .replace(
          "import { addCustomEvent, record } from 'rrweb';",
          'const record = window.__record; const addCustomEvent = () => {};',
        )
        .replaceAll('__COLLECT_API_HOST__', '');
      window.eval(source);
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
