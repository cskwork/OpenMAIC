import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import resourcesToBackend from 'i18next-resources-to-backend';

i18n
  .use(initReactI18next)
  .use(resourcesToBackend((language: string) => import(`./locales/${language}.json`)))
  .init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
