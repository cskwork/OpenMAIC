/**
 * Fonts offered in the slide editor's text-format picker.
 *
 * Scoped to fonts the app actually loads as web fonts — currently just Inter
 * (via `next/font` in `app/layout.tsx`). The registry previously listed ~28
 * more (Source Han, MiSans, decorative Chinese display faces, Roboto, …), but
 * none had a `@font-face` or a bundled file, so picking them silently fell
 * back with no visible effect. To offer them again, wire up the font loading
 * first (`@font-face` / `@fontsource`), then re-add the entries here.
 */
export const FONTS = [
  { label: '默认字体', value: '' },
  { label: 'Inter', value: 'Inter' },
];
