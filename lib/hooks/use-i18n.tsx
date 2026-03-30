'use client';

import { createContext, useContext, useEffect, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type Locale, defaultLocale } from '@/lib/i18n';
import '@/lib/i18n/config';

const LOCALE_STORAGE_KEY = 'locale';

type I18nContextType = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();

  const locale = i18n.language || defaultLocale;

  // Detect language after hydration to avoid SSR mismatch.
  // i18next handles fallback automatically: if the detected language
  // has no matching JSON file, it falls back to fallbackLng.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      const target = stored || navigator.language || defaultLocale;
      if (target !== i18n.language) i18n.changeLanguage(target);
    } catch {
      // localStorage unavailable, keep default
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setLocale = (newLocale: Locale) => {
    i18n.changeLanguage(newLocale);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
    } catch {
      // localStorage unavailable
    }
  };

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}
