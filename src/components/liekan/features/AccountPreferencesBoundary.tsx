'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import {
  loadAccountPreferences,
  saveAccountPreferences,
  useAccountPreferences,
} from '@/lib/liekan/upstream/account-preferences-client';
import { AccountTimezoneFields } from './AccountTimezoneFields';
import { Body, Button, Form, Notice, Panel } from './ui';
import { LanguageSelector } from '../LanguageSelector';
import '@/styles/liekan/Features.module.css';

/** Mount analytics only after the authenticated account's calendar is known. */
export function AccountPreferencesBoundary({ children }: { children: ReactNode }) {
  const i18n = useLiekanI18n();
  const preferences = useAccountPreferences();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setError('');
    loadAccountPreferences(controller.signal)
      .then(() => setLoaded(true))
      .catch(error => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [attempt]);
  if (loaded && preferences?.configured) return <>{children}</>;
  return (
    <div data-liekan-features lang={i18n.locale} className="identity-flow account-timezone-setup">
      <main className="content account-timezone-content">
        <div className="account-timezone-toolbar">
          <LanguageSelector toolbar />
        </div>
        <Panel
          title={i18n.text('确认分析时区')}
          subtitle={i18n.text('选择国家和时区后，所有统计页面会按当地日期定义今天。')}
        >
          <Body>
            {error ? (
              <>
                <Notice tone="red">{i18n.system(error)}</Notice>
                <Button onClick={() => setAttempt(value => value + 1)}>{i18n.text('重试')}</Button>
              </>
            ) : !loaded || !preferences ? (
              <Notice>{i18n.text('正在读取偏好设置。')}</Notice>
            ) : (
              <Form
                submitLabel={i18n.text('确认并继续')}
                onSubmit={async values => {
                  await saveAccountPreferences({
                    countryCode: values.countryCode,
                    timezone: values.timezone,
                    range: preferences.range,
                  });
                }}
              >
                <div className="form-grid">
                  <AccountTimezoneFields
                    countryCode={preferences.countryCode}
                    timezone={preferences.timezone}
                  />
                </div>
              </Form>
            )}
          </Body>
        </Panel>
      </main>
    </div>
  );
}
