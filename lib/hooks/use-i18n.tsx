'use client';

import { createContext, useContext, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type Locale, defaultLocale } from '@/lib/i18n';
import '@/lib/i18n/config';

type I18nContextType = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();

  const locale = (i18n.language as Locale) || defaultLocale;

  const setLocale = (newLocale: Locale) => {
    i18n.changeLanguage(newLocale);
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
