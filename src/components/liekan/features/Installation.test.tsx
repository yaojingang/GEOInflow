import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';
import type { InstallationIdentityObservation } from '@/lib/liekan/contracts/installation';
import { IdentityObservation } from './Installation';

const base: InstallationIdentityObservation = {
  version: 'received-browser-identity-v1',
  timeBasis: 'received_at',
  population: 'raw_public_pv',
  range: {
    startAt: Date.parse('2026-10-27T09:00Z'),
    endAt: Date.parse('2026-10-27T09:30Z'),
    timezone: 'UTC',
    endExclusive: true,
  },
  status: 'empty',
  sampleCount: 0,
  availableIdentityCount: 0,
  unknownIdentityCount: 0,
  coverage: null,
  lastReceivedAt: null,
  smallSample: false,
  reasons: ['no_received_samples'],
};
const show = (
  observation: Partial<InstallationIdentityObservation>,
  locale: 'zh-CN' | 'en-US',
  deferred = false,
) =>
  render(
    <LiekanLocaleContext.Provider value={locale}>
      <IdentityObservation
        observation={{ ...base, ...observation }}
        deferred={deferred}
        browserReceived
        configured
        timezone="Asia/Shanghai"
      />
    </LiekanLocaleContext.Provider>,
  );

describe.each(['zh-CN', 'en-US'] as const)('installation observation copy in %s', locale => {
  it('keeps empty coverage unknown and explains the narrower window', () => {
    const { container } = show({}, locale);
    expect(container.textContent).toContain(
      locale === 'zh-CN' ? '覆盖率 未知' : 'Coverage Unknown',
    );
    expect(container.textContent).not.toContain('0%');
    expect(container.textContent).toContain(
      locale === 'zh-CN' ? '已有浏览记录' : 'Browser records exist',
    );
    expect(container.textContent).toContain(
      locale === 'zh-CN'
        ? '正式统计资格单独计算'
        : 'Reporting eligibility is calculated separately',
    );
  });
  it('shows observed zero coverage only for known unavailable identities', () => {
    const { container } = show(
      { status: 'unavailable', sampleCount: 20, availableIdentityCount: 0, coverage: 0 },
      locale,
    );
    expect(container.textContent).toContain('0%');
    expect(container.textContent).toContain(
      locale === 'zh-CN' ? '身份输入不足' : 'Identity input is insufficient',
    );
  });
  it('shows the actual small sample and keeps the deferred state independent', () => {
    const { container } = show(
      {
        status: 'complete',
        sampleCount: 3,
        availableIdentityCount: 3,
        coverage: 1,
        smallSample: true,
      },
      locale,
      true,
    );
    expect(
      screen.getByText(locale === 'zh-CN' ? '检查已延后' : 'Inspection postponed'),
    ).toBeVisible();
    expect(container.textContent).toContain('100%');
    expect(container.textContent).toContain(
      locale === 'zh-CN' ? '少于 20 条样本' : 'Fewer than 20 samples',
    );
    expect(container.textContent).toContain(
      locale === 'zh-CN' ? '仍需部署侧核验' : 'still require deployment verification',
    );
  });
  it.each(['demo', 'unsupported', 'temporarily_unavailable', 'unknown'] as const)(
    'does not render unknown %s data as a zero or a success',
    status => {
      const { container } = show(
        {
          status,
          sampleCount: null,
          availableIdentityCount: null,
          unknownIdentityCount: null,
          coverage: null,
        },
        locale,
      );
      expect(container.textContent).not.toContain('0%');
      expect(container.textContent).not.toContain('100%');
      if (locale === 'en-US') expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/);
    },
  );
  it('renders missing evidence and legacy receipt fallback explicitly', () => {
    const { container } = show(
      {
        status: 'unknown',
        sampleCount: 20,
        availableIdentityCount: 8,
        unknownIdentityCount: 12,
        reasons: ['identity_evidence_missing', 'reception_fallback'],
      },
      locale,
    );
    expect(container.textContent).toContain(
      locale === 'zh-CN'
        ? '12 条样本缺少身份资格证据'
        : '12 samples lack identity qualification evidence',
    );
    expect(container.textContent).toContain(
      locale === 'zh-CN'
        ? '原始采集判定的接收时间回退'
        : 'original collection verdict receipt-time fallback',
    );
    expect(container.textContent).not.toContain('40%');
  });
});
