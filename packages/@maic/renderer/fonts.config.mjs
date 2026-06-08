/**
 * Single source of truth for the self-hosted font CDN and the whitelist of
 * font families. `fonts.css` is GENERATED from this file by
 * `scripts/generate-fonts-css.mjs` — edit the config here, then run
 * `pnpm run genfonts` (the build does this automatically).
 *
 * The 22 families are the target whitelist that the import pipeline maps
 * unknown PPT fonts onto (see @maic/importer's openmaic/configs/font.ts).
 */

/** Object-storage origin that serves the woff2 files. */
export const FONT_CDN_BASE_URL = 'https://file.maic.chat';

/** Path segment under the origin where the woff2 files live. */
export const FONT_DIR = 'fonts';

/** Ordered whitelist of font-family names (each backed by one Regular woff2). */
export const FONT_FAMILIES = [
  'SourceHanSans',
  'SourceHanSerif',
  'FangZhengHeiTi',
  'FangZhengKaiTi',
  'FangZhengShuSong',
  'FangZhengFangSong',
  'AlibabaPuHuiTi',
  'ZhuQueFangSong',
  'LXGWWenKai',
  'WenDingPLKaiTi',
  'DeYiHei',
  'MiSans',
  'CangerXiaowanzi',
  'YousheTitleBlack',
  'FengguangMingrui',
  'ShetuModernSquare',
  'ZcoolHappy',
  'ZizhiQuXiMai',
  'SucaiJishiKangkang',
  'SucaiJishiCoolSquare',
  'TuniuRounded',
  'RuiziZhenyan',
];

/** Build the woff2 URL for a given family. */
export const fontUrl = (family) => `${FONT_CDN_BASE_URL}/${FONT_DIR}/${family}.woff2`;
