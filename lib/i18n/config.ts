import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';

const isServer = typeof window === 'undefined';

const instance = i18n
  .use(initReactI18next)
  .use(resourcesToBackend((language: string) => import(`./locales/${language}.json`)));

if (!isServer) {
  instance.use(LanguageDetector);
}

instance.init({
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
