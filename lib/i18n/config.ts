import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';

const isServer = typeof window === 'undefined';

const instance = i18n.use(initReactI18next);

if (!isServer) {
  instance.use(LanguageDetector);
}

instance.init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false,
  },
  ...(isServer
    ? {}
    : {
        detection: {
          order: ['localStorage', 'navigator'],
          caches: ['localStorage'],
          lookupLocalStorage: 'locale',
        },
      }),
});

export default i18n;
