/**
 * Single source of truth for the timeline's cue/element taxonomy: per action
 * type, the icon + Chinese label + glyph tint + card accent; the set of
 * element-bound cue types; and element-type labels. Previously these maps were
 * duplicated across ActionsBar, regenerate-tool-ui and ElementPickLayer.
 */
import {
  Circle,
  Crosshair,
  Focus,
  PenLine,
  Presentation,
  Quote,
  Shapes,
  Sigma,
  Table2,
  type LucideIcon,
} from 'lucide-react';

export interface CueMeta {
  icon: LucideIcon;
  label: string;
  /** glyph tint: icon color + soft disc background */
  glyph: string;
  /** top accent bar tint for the cue card */
  accent: string;
}

const META: Record<string, CueMeta> = {
  speech: { icon: Quote, label: '讲解', glyph: 'text-primary bg-primary/10 dark:text-primary', accent: 'bg-primary/40' },
  spotlight: { icon: Focus, label: '聚光', glyph: 'text-amber-600 bg-amber-500/10 dark:text-amber-400', accent: 'bg-amber-400/70' },
  laser: { icon: Crosshair, label: '激光', glyph: 'text-rose-600 bg-rose-500/10 dark:text-rose-400', accent: 'bg-rose-400/70' },
  wb_open: { icon: Presentation, label: '画板', glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400', accent: 'bg-sky-400/70' },
  wb_draw_text: { icon: PenLine, label: '板书', glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400', accent: 'bg-sky-400/70' },
  wb_draw_shape: { icon: Shapes, label: '图形', glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400', accent: 'bg-sky-400/70' },
  wb_draw_latex: { icon: Sigma, label: '公式', glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400', accent: 'bg-sky-400/70' },
  wb_draw_table: { icon: Table2, label: '表格', glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400', accent: 'bg-sky-400/70' },
};

const FALLBACK: CueMeta = { icon: Circle, label: '动作', glyph: 'text-muted-foreground bg-muted', accent: 'bg-muted-foreground/30' };

export function cueMeta(type: string): CueMeta {
  return META[type] ?? { ...FALLBACK, label: type };
}

export function cueLabel(type: string): string {
  return cueMeta(type).label;
}

/** Cue types that target a canvas element (so canvas pick mode applies). */
export const ELEMENT_BOUND = new Set(['spotlight', 'laser', 'play_video']);

const EL_TYPE_ZH: Record<string, string> = {
  text: '文本',
  image: '图片',
  shape: '形状',
  line: '线条',
  chart: '图表',
  table: '表格',
  latex: '公式',
  video: '视频',
  audio: '音频',
  code: '代码',
};

/** Human label for a slide element (type + a short content snippet). */
export function elementLabel(el: { type: string; content?: string }): string {
  const zh = EL_TYPE_ZH[el.type] ?? el.type;
  const raw = (el.content ?? '').replace(/<[^>]+>/g, '').trim();
  const snip = raw ? ` · ${raw.slice(0, 16)}${raw.length > 16 ? '…' : ''}` : '';
  return `${zh}${snip}`;
}
