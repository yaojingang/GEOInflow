'use client';
import { liekanProduct } from '@/lib/liekan/contracts/product';
import { createContext, useContext, useEffect } from 'react';
import type { LiekanLocale } from './locale';
import {
  translateText,
  translateSystemText,
  metricLabel,
  countUnit,
  fillMessage,
  type LiekanTranslator,
} from './text';

export const LiekanLocaleContext = createContext<LiekanLocale>('zh-CN');
export const LiekanMessageContext = createContext<LiekanTranslator | null>(null);

export function useLiekanI18n() {
  const locale = useContext(LiekanLocaleContext);
  const messages = useContext(LiekanMessageContext);
  const text = messages?.text || translateText;
  const system = messages?.system || translateSystemText;
  const formatter = (language: LiekanLocale) => ({
    locale: language,
    source: fillMessage,
    text: (source: string, values?: readonly unknown[]) => text(source, language, values),
    label: (source: string, context: Parameters<typeof metricLabel>[1]) =>
      metricLabel(source, context, language),
    unit: (source: string, count: unknown, leading = true, trailing = false) =>
      `${language === 'en-US' && leading ? ' ' : ''}${countUnit(source, count, language)}${language === 'en-US' && trailing ? ' ' : ''}`,
    system: <T>(value: T): T => (typeof value === 'string' ? system(value, language) : value) as T,
    fragment: (source: string, leading = false, trailing = false) =>
      `${language === 'en-US' && leading && !/^[\s,.;:!?%\])}]/.test(text(language === 'en-US' ? source.trim() : source, language)) ? ' ' : ''}${text(language === 'en-US' ? source.trim() : source, language)}${language === 'en-US' && trailing && !/[\s([{/]$/.test(text(language === 'en-US' ? source.trim() : source, language)) ? ' ' : ''}`,
  });
  return { ...formatter(locale), english: formatter('en-US') };
}

export function useLiekanPageTitle(title: string) {
  const { locale, system } = useLiekanI18n();
  useEffect(() => {
    const value = `${system(title)} | ${liekanProduct.name}`;
    const apply = () => {
      if (document.title !== value) document.title = value;
    };
    apply();
    // Next.js inserts the route's static English metadata <title> after client navigation commits.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [title, locale]);
}
