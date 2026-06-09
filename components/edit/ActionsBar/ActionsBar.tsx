'use client';

/**
 * ActionsBar — Pro-mode "narration script" of the active scene's playback
 * `actions`. Speech renders as soft bubbles; non-speech cues (spotlight / laser
 * / board) render as type-coded badges, interleaved in order. Hovering a cue:
 *  - shows a properties tooltip (portaled, so the script container can't clip it),
 *  - "plays" a spotlight on the bound canvas element — a portaled overlay that
 *    dims the screen and rings the element (works in edit mode, where the
 *    playback SpotlightOverlay isn't mounted).
 * The bar is collapsible and its height is drag-resizable from the top edge.
 * Reads reactively from the stage store so regenerating actions updates it live.
 */
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

const EMPTY: Action[] = [];
const MIN_H = 96;
const MAX_H = 560;
const DEFAULT_H = 196;

interface TypeMeta {
  icon: LucideIcon;
  label: string;
  /** chip surface */
  chip: string;
  /** spotlight ring color */
  ring: string;
}

const META: Record<string, TypeMeta> = {
  spotlight: { icon: Focus, label: '聚光', chip: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:ring-amber-900', ring: '#d97706' },
  laser: { icon: Crosshair, label: '激光', chip: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:ring-rose-900', ring: '#e11d48' },
  wb_open: { icon: Presentation, label: '画板', chip: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:ring-sky-900', ring: '#0284c7' },
  wb_draw_text: { icon: PenLine, label: '板书', chip: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:ring-sky-900', ring: '#0284c7' },
  wb_draw_shape: { icon: Shapes, label: '图形', chip: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:ring-sky-900', ring: '#0284c7' },
  wb_draw_latex: { icon: Sigma, label: '公式', chip: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:ring-sky-900', ring: '#0284c7' },
  wb_draw_table: { icon: Table2, label: '表格', chip: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:ring-sky-900', ring: '#0284c7' },
};

function metaFor(type: string): TypeMeta {
  return META[type] ?? { icon: Circle, label: type, chip: 'bg-muted text-muted-foreground ring-border', ring: '#6b7280' };
}

function propsOf(a: Action): Array<[string, string]> {
  const rows: Array<[string, string]> = [['类型', a.type]];
  const el = (a as { elementId?: string }).elementId;
  if (el) rows.push(['元素', el]);
  const color = (a as { color?: string }).color;
  if (color) rows.push(['颜色', color]);
  const content = (a as { content?: string }).content;
  if (content) rows.push(['内容', content.length > 48 ? `${content.slice(0, 48)}…` : content]);
  const latex = (a as { latex?: string }).latex;
  if (latex) rows.push(['公式', latex]);
  return rows;
}

interface HoverState {
  action: Action;
  badge: DOMRect;
  target: DOMRect | null;
}

/** Portaled spotlight (dim + ring around the element) + properties tooltip. */
function HoverOverlay({ hover }: { hover: HoverState }) {
  if (typeof document === 'undefined') return null;
  const m = metaFor(hover.action.type);
  const t = hover.target;
  const pad = 6;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[60]">
      {t && (
        <div
          style={{
            position: 'fixed',
            left: t.left - pad,
            top: t.top - pad,
            width: t.width + pad * 2,
            height: t.height + pad * 2,
            borderRadius: 6,
            border: `2px solid ${m.ring}`,
            boxShadow: '0 0 0 9999px rgba(15,23,42,0.45)',
            transition: 'opacity 120ms ease',
          }}
        />
      )}
      {/* properties tooltip, above the badge */}
      <div
        style={{
          position: 'fixed',
          left: Math.max(8, hover.badge.left + hover.badge.width / 2),
          top: hover.badge.top - 8,
          transform: 'translate(-50%, -100%)',
          maxWidth: 280,
        }}
        className="rounded-lg border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md"
      >
        {propsOf(hover.action).map(([k, v]) => (
          <div key={k} className="flex gap-2 text-[11px] leading-relaxed">
            <span className="shrink-0 text-muted-foreground">{k}</span>
            <span className="font-mono [overflow-wrap:anywhere]">{v}</span>
          </div>
        ))}
        {t && <div className="mt-0.5 text-[10px] text-muted-foreground">高亮画布元素</div>}
      </div>
    </div>,
    document.body,
  );
}

function CueBadge({ action, onHover }: { action: Action; onHover: (h: HoverState | null) => void }) {
  const m = metaFor(action.type);
  const Icon = m.icon;
  const elementId = (action as { elementId?: string }).elementId;

  const enter = (e: React.MouseEvent<HTMLSpanElement>) => {
    const badge = e.currentTarget.getBoundingClientRect();
    const el = elementId ? document.getElementById(`editable-element-${elementId}`) : null;
    onHover({ action, badge, target: el ? el.getBoundingClientRect() : null });
  };

  return (
    <span
      onMouseEnter={enter}
      onMouseLeave={() => onHover(null)}
      className={cn(
        'inline-flex cursor-default select-none items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 transition-shadow hover:shadow-sm',
        m.chip,
      )}
    >
      <Icon className="size-3" />
      {m.label}
    </span>
  );
}

export function ActionsBar({ sceneId }: { sceneId: string }) {
  const actions = useStageStore((s) => s.scenes.find((x) => x.id === sceneId)?.actions ?? EMPTY);
  const [open, setOpen] = useState(true);
  const [hover, setHover] = useState<HoverState | null>(null);

  // height drag-resize (top edge)
  const sectionRef = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(DEFAULT_H);
  const dragRef = useRef<{ startY: number; startH: number; lastH: number; pointerId: number } | null>(null);

  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const startH = sectionRef.current?.getBoundingClientRect().height ?? height;
      dragRef.current = { startY: e.clientY, startH, lastH: startH, pointerId: e.pointerId };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* best effort */
      }
      document.body.style.cursor = 'row-resize';
    },
    [height],
  );
  const onResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const next = Math.min(MAX_H, Math.max(MIN_H, d.startH + (d.startY - e.clientY))); // drag up → taller
    d.lastH = next;
    if (sectionRef.current) sectionRef.current.style.height = `${next}px`;
  }, []);
  const onResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* may already be released */
    }
    setHeight(d.lastH);
    dragRef.current = null;
    document.body.style.cursor = '';
  }, []);

  const counts = new Map<string, number>();
  for (const a of actions) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  const speechCount = counts.get('speech') ?? 0;
  const cueCount = actions.length - speechCount;

  return (
    <section
      ref={sectionRef}
      style={open ? { height } : undefined}
      className="relative flex flex-col border-t border-border bg-background"
    >
      {open && (
        <div
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          className="group absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize touch-none transition-colors hover:bg-primary/20"
        >
          <div className="absolute left-1/2 top-0.5 h-0.5 w-8 -translate-x-1/2 rounded-full bg-border transition-colors group-hover:bg-primary/60" />
        </div>
      )}

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
        <ChevronDown className={cn('ml-auto size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          {actions.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">暂无动作 — 让 MAIC Agent 为这一页生成讲解动作。</p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
              {actions.map((a, i) =>
                a.type === 'speech' ? (
                  <span
                    key={a.id ?? i}
                    className="rounded-lg bg-muted/60 px-2.5 py-1.5 text-sm leading-relaxed text-foreground"
                  >
                    {(a as { text?: string }).text ?? ''}
                  </span>
                ) : (
                  <CueBadge key={a.id ?? i} action={a} onHover={setHover} />
                ),
              )}
            </div>
          )}
        </div>
      )}

      {hover && <HoverOverlay hover={hover} />}
    </section>
  );
}
