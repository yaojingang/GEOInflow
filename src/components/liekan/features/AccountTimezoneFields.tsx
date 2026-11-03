'use client';
import { useState } from 'react';
import {
  accountCountryCodes,
  accountTimezoneForCountry,
  countryTimezoneChoices,
} from '@/lib/liekan/contracts/account-preferences';
import { countryName } from '@/lib/liekan/contracts/geography';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { Select } from './ui';

export function AccountTimezoneFields({
  countryCode,
  timezone,
}: {
  countryCode?: string | null;
  timezone: string;
}) {
  const i18n = useLiekanI18n();
  const [country, setCountry] = useState(countryCode || '');
  const [zone, setZone] = useState(
    accountTimezoneForCountry(countryCode || '', timezone) || timezone,
  );
  const choices = countryTimezoneChoices(country);
  return (
    <>
      <Select
        name="countryCode"
        label={i18n.text('国家或地区')}
        aria-label={i18n.text('国家或地区')}
        className="account-timezone-select"
        required
        value={country}
        options={[
          ['', i18n.text('请选择国家或地区')],
          ...accountCountryCodes.map(
            code => [code, countryName(code, i18n.locale)] as [string, string],
          ),
        ]}
        onChange={event => {
          const next = event.target.value;
          const available = countryTimezoneChoices(next);
          const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
          setCountry(next);
          setZone(
            accountTimezoneForCountry(next, zone) ||
              (next === 'CN' ? 'Asia/Shanghai' : accountTimezoneForCountry(next, browser)) ||
              (available.length === 1 ? available[0] : ''),
          );
        }}
      />
      <Select
        name="timezone"
        label={i18n.text('分析时区')}
        aria-label={i18n.text('分析时区')}
        className="account-timezone-select"
        required
        value={zone}
        options={[
          ['', i18n.text('请选择所在城市的时区')],
          ...choices.map(value => [value, value.replaceAll('_', ' ')] as [string, string]),
          ...(!choices.includes(zone) && zone
            ? [{ value: zone, label: zone, disabled: true }]
            : []),
        ]}
        onChange={event => setZone(event.target.value)}
        help={i18n.text('今天按此时区的零点开始。国家包含多个时区时，请确认所在城市。')}
      />
    </>
  );
}
