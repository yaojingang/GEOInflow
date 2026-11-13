// @vitest-environment node
import { expect, it, vi } from 'vitest';

it('preserves cache-miss control flow across independent server module graphs', async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic:synthetic@127.0.0.1:1/module_only');
  try {
    const first = await import('./report-fragments');
    const miss = new first.ReportFragmentMiss();
    vi.resetModules();
    const second = await import('./report-fragments');
    expect(miss).toBeInstanceOf(second.ReportFragmentMiss);
  } finally {
    vi.unstubAllEnvs();
  }
});
