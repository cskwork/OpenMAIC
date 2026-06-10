'use client';

/**
 * ActionsBar — Pro-mode "narration script" of the active scene's playback
 * `actions`, rendered as one continuous inline flow: speech as softly tinted
 * runs of text, non-speech cues (spotlight / laser / board) as small inline
 * pills at their exact position in the sequence. Hovering a cue pill:
 *  - shows a properties tooltip (portaled — the container can't clip it),
 *  - plays the REAL playback spotlight effect on the bound canvas element
 *    (drives useCanvasStore.setSpotlight → the same SpotlightOverlay the
 *    player uses, mounted in the edit canvas with the editor id prefix).
 * Collapsible; height drag-resizable from the top edge. Reads reactively from
 * the stage store, so regenerating actions updates it live.
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
import { useCanvasStore } from '@/lib/store/canvas';
import type { Action } from '@/lib/types/action';

const EMPTY: Action[] = [];
const MIN_H = 96;
const MAX_H = 560;
const DEFAULT_H = 188;

interface TypeMeta {
  icon: LucideIcon;
  label: string;
  /** dot color */
  dot: string;
}

const META: Record<string, TypeMeta> = {
  spotlight: { icon: Focus, label: '聚光', dot: 'bg-amber-500' },
  laser: { icon: Crosshair, label: '激光', dot: 'bg-rose-500' },
  wb_open: { icon: Presentation, label: '画板', dot: 'bg-sky-500' },
  wb_draw_text: { icon: PenLine, label: '板书', dot: 'bg-sky-500' },
  wb_draw_shape: { icon: Shapes, label: '图形', dot: 'bg-sky-500' },
  wb_draw_latex: { icon: Sigma, label: '公式', dot: 'bg-sky-500' },
  wb_draw_table: { icon: Table2, label: '表格', dot: 'bg-sky-500' },
};

function metaFor(type: string): TypeMeta {
  return META[type] ?? { icon: Circle, label: type, dot: 'bg-muted-foreground' };
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

interface TooltipState {
  action: Action;
  badge: DOMRect;
}

/** Portaled properties tooltip (above the pill; never clipped by the bar). */
function CueTooltip({ tip }: { tip: TooltipState }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: Math.max(8, tip.badge.left + tip.badge.width / 2),
        top: tip.badge.top - 8,
        transform: 'translate(-50%, -100%)',
        maxWidth: 280,
        zIndex: 60,
      }}
      className="pointer-events-none rounded-lg border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md"
    >
      {propsOf(tip.action).map(([k, v]) => (
        <div key={k} className="flex gap-2 text-[11px] leading-relaxed">
          <span className="shrink-0 text-muted-foreground">{k}</span>
          <span className="font-mono [overflow-wrap:anywhere]">{v}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

function CuePill({ action, onTip }: { action: Action; onTip: (t: TooltipState | null) => void }) {
  const m = metaFor(action.type);
  const Icon = m.icon;
  const elementId = (action as { elementId?: string }).elementId;

  const enter = (e: React.MouseEvent<HTMLSpanElement>) => {
    onTip({ action, badge: e.currentTarget.getBoundingClientRect() });
    // Play the real playback spotlight on the canvas element.
    if (elementId) useCanvasStore.getState().setSpotlight(elementId);
  };
  const leave = () => {
    onTip(null);
    useCanvasStore.getState().setSpotlight('');
  };

  return (
    <span
      onMouseEnter={enter}
      onMouseLeave={leave}
      className="mx-1 inline-flex -translate-y-px cursor-default select-none items-center gap-1.5 rounded-full border border-border bg-background px-2 py-[2px] align-middle text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
    >
      <span className={cn('size-1.5 rounded-full', m.dot)} />
      <Icon className="size-3" />
      {m.label}
    </span>
  );
}

export function ActionsBar({ sceneId }: { sceneId: string }) {
  const actions = useStageStore((s) => s.scenes.find((x) => x.id === sceneId)?.actions ?? EMPTY);
  const [open, setOpen] = useState(true);
  const [tip, setTip] = useState<TooltipState | null>(null);

  // height drag-resize (top edge), same pointer-capture pattern as the rails
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
    const next = Math.min(MAX_H, Math.max(MIN_H, d.startH + (d.startY - e.clientY)));
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

  const speechCount = actions.filter((a) => a.type === 'speech').length;
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
        className="flex h-9 shrink-0 items-center gap-2.5 px-5 text-left transition-colors hover:bg-accent/40"
      >
        <ScrollText className="size-3.5 text-primary" />
        <span className="text-[12px] font-semibold tracking-wide text-foreground">讲解脚本</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground/80">
          {speechCount} 讲解 · {cueCount} 动作
        </span>
        <ChevronDown className={cn('ml-auto size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          {actions.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">暂无动作 — 让 MAIC Agent 为这一页生成讲解动作。</p>
          ) : (
            <p className="max-w-[88ch] text-[13px] leading-[2.1] text-foreground/90">
              {actions.map((a, i) =>
                a.type === 'speech' ? (
                  <span
                    key={a.id ?? i}
                    className="rounded-[4px] bg-secondary/60 px-1 py-[2px] [box-decoration-break:clone] dark:bg-secondary/30"
                  >
                    {(a as { text?: string }).text ?? ''}
                  </span>
                ) : (
                  <CuePill key={a.id ?? i} action={a} onTip={setTip} />
                ),
              )}
            </p>
          )}
        </div>
      )}

      {tip && <CueTooltip tip={tip} />}
    </section>
  );
}
