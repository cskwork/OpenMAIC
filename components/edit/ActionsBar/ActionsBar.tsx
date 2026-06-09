'use client';

/**
 * ActionsBar — Pro-mode "narration script" of the active scene's playback
 * `actions`, so an editor can read at a glance what the agent will say + do on
 * this page. Speech reads as flowing read-only text; non-speech cues
 * (spotlight / laser / whiteboard) sit inline as badges. Hovering a badge shows
 * its properties and spotlights the bound element on the canvas (reusing the
 * editor's SpotlightOverlay via the canvas store). Reads reactively from the
 * stage store, so regenerating actions updates it live. Collapsible.
 */
import { useState } from 'react';
import {
  ChevronDown,
  Circle,
  Crosshair,
  Focus,
  PenLine,
  Presentation,
  ScrollText,
  Shapes,
  Sigma,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useStageStore } from '@/lib/store/stage';
import type { Action } from '@/lib/types/action';

/**
 * Transiently highlight the bound element on the edit canvas. Edit-mode elements
 * render as `#editable-element-<id>`; we paint a brand-colored ring directly
 * (with `!important` so React's inline position styles don't clobber it) and
 * clear it on leave. Self-contained — no dependency on the playback overlays.
 */
function highlightElement(elementId: string | undefined, on: boolean) {
  if (!elementId) return;
  const el = document.getElementById(`editable-element-${elementId}`);
  if (!el) return;
  if (on) {
    el.style.setProperty('outline', '2px solid var(--primary, #722ed1)', 'important');
    el.style.setProperty('outline-offset', '2px', 'important');
    el.style.setProperty('box-shadow', '0 0 0 6px rgba(114,46,209,0.16)', 'important');
    el.style.setProperty('border-radius', '3px', 'important');
    el.style.setProperty('transition', 'box-shadow 120ms ease, outline-color 120ms ease', 'important');
  } else {
    el.style.removeProperty('outline');
    el.style.removeProperty('outline-offset');
    el.style.removeProperty('box-shadow');
    el.style.removeProperty('transition');
  }
}

const EMPTY: Action[] = [];

interface TypeMeta {
  icon: LucideIcon;
  label: string;
  /** chip surface classes (bg + text + ring) */
  chip: string;
}

const META: Record<string, TypeMeta> = {
  spotlight: { icon: Focus, label: '聚光', chip: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:ring-amber-900' },
  laser: { icon: Crosshair, label: '激光', chip: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:ring-rose-900' },
  wb_open: { icon: Presentation, label: '画板', chip: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:ring-sky-900' },
  wb_draw_text: { icon: PenLine, label: '板书', chip: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:ring-sky-900' },
  wb_draw_shape: { icon: Shapes, label: '图形', chip: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:ring-sky-900' },
  wb_draw_latex: { icon: Sigma, label: '公式', chip: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:ring-sky-900' },
  wb_draw_table: { icon: Table2, label: '表格', chip: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:ring-sky-900' },
};

function metaFor(type: string): TypeMeta {
  return META[type] ?? { icon: Circle, label: type, chip: 'bg-muted text-muted-foreground ring-border' };
}

/** Human-readable property rows for a cue's hover tooltip. */
function propsOf(a: Action): Array<[string, string]> {
  const rows: Array<[string, string]> = [['类型', a.type]];
  const el = (a as { elementId?: string }).elementId;
  if (el) rows.push(['元素', el]);
  const color = (a as { color?: string }).color;
  if (color) rows.push(['颜色', color]);
  const content = (a as { content?: string }).content;
  if (content) rows.push(['内容', content.length > 40 ? `${content.slice(0, 40)}…` : content]);
  const latex = (a as { latex?: string }).latex;
  if (latex) rows.push(['公式', latex]);
  if (a.title) rows.push(['标题', a.title]);
  return rows;
}

function CueBadge({ action }: { action: Action }) {
  const m = metaFor(action.type);
  const Icon = m.icon;
  const elementId = (action as { elementId?: string }).elementId;

  return (
    <span
      className="group/badge relative mx-0.5 inline-flex translate-y-px cursor-default select-none items-center"
      onMouseEnter={() => highlightElement(elementId, true)}
      onMouseLeave={() => highlightElement(elementId, false)}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 align-middle text-[11px] font-medium ring-1 transition-shadow',
          m.chip,
          elementId && 'group-hover/badge:shadow-sm',
        )}
      >
        <Icon className="size-3" />
        {m.label}
      </span>

      {/* hover tooltip — properties (opens upward; bar sits at screen bottom) */}
      <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 hidden w-max max-w-[260px] -translate-x-1/2 group-hover/badge:block">
        <span className="block rounded-lg border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md">
          {propsOf(action).map(([k, v]) => (
            <span key={k} className="flex gap-2 text-[11px] leading-relaxed">
              <span className="shrink-0 text-muted-foreground">{k}</span>
              <span className="font-mono [overflow-wrap:anywhere]">{v}</span>
            </span>
          ))}
          {elementId && <span className="mt-0.5 block text-[10px] text-muted-foreground">悬停高亮画布元素</span>}
        </span>
      </span>
    </span>
  );
}

export function ActionsBar({ sceneId }: { sceneId: string }) {
  const actions = useStageStore((s) => s.scenes.find((x) => x.id === sceneId)?.actions ?? EMPTY);
  const [open, setOpen] = useState(true);

  const counts = new Map<string, number>();
  for (const a of actions) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  const speechCount = counts.get('speech') ?? 0;
  const cueCount = actions.length - speechCount;

  return (
    <section className="flex max-h-[36vh] flex-col border-t border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 shrink-0 items-center gap-2 px-4 text-left transition-colors hover:bg-accent/50"
      >
        <ScrollText className="size-4 text-primary" />
        <span className="text-[13px] font-medium text-foreground">讲解脚本</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {speechCount} 段讲解 · {cueCount} 个提示
        </span>
        <ChevronDown
          className={cn('ml-auto size-4 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="px-4 pb-3">
          {actions.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">暂无动作 — 让 MAIC Agent 为这一页生成讲解动作。</p>
          ) : (
            <div className="max-h-[26vh] overflow-y-auto rounded-lg border border-border bg-muted/30 px-3.5 py-3 text-sm leading-7 text-foreground">
              {actions.map((a, i) =>
                a.type === 'speech' ? (
                  <span key={a.id ?? i}>{(a as { text?: string }).text ?? ''} </span>
                ) : (
                  <CueBadge key={a.id ?? i} action={a} />
                ),
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
