'use client';

/**
 * ActionsBar — Pro-mode "讲解脚本" bottom bar.
 *
 * Renders the active scene's playback `actions` as an editorial screenplay:
 * each speech is a typeset paragraph with a faint margin index; non-speech
 * cues (spotlight / laser / board) appear as quiet round icon-glyphs at their
 * exact position in the sequence — annotations, not chrome. Hovering a glyph
 * shows a portaled tooltip and plays the REAL playback spotlight on the bound
 * canvas element (useCanvasStore.setSpotlight → the same SpotlightOverlay the
 * player uses, mounted in the edit canvas). Collapsible; height-resizable from
 * the top edge; reactive to the stage store so regeneration updates it live.
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
  Shapes,
  Sigma,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils/cn';
import { useStageStore } from '@/lib/store/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import type { Action } from '@/lib/types/action';

const EMPTY: Action[] = [];
const MIN_H = 96;
const MAX_H = 560;
const DEFAULT_H = 200;

interface TypeMeta {
  icon: LucideIcon;
  label: string;
  /** glyph tint: icon color + soft disc */
  glyph: string;
}

const META: Record<string, TypeMeta> = {
  spotlight: { icon: Focus, label: '聚光', glyph: 'text-amber-600 bg-amber-500/10 hover:bg-amber-500/20 dark:text-amber-400' },
  laser: { icon: Crosshair, label: '激光', glyph: 'text-rose-600 bg-rose-500/10 hover:bg-rose-500/20 dark:text-rose-400' },
  wb_open: { icon: Presentation, label: '画板', glyph: 'text-sky-600 bg-sky-500/10 hover:bg-sky-500/20 dark:text-sky-400' },
  wb_draw_text: { icon: PenLine, label: '板书', glyph: 'text-sky-600 bg-sky-500/10 hover:bg-sky-500/20 dark:text-sky-400' },
  wb_draw_shape: { icon: Shapes, label: '图形', glyph: 'text-sky-600 bg-sky-500/10 hover:bg-sky-500/20 dark:text-sky-400' },
  wb_draw_latex: { icon: Sigma, label: '公式', glyph: 'text-sky-600 bg-sky-500/10 hover:bg-sky-500/20 dark:text-sky-400' },
  wb_draw_table: { icon: Table2, label: '表格', glyph: 'text-sky-600 bg-sky-500/10 hover:bg-sky-500/20 dark:text-sky-400' },
};

function metaFor(type: string): TypeMeta {
  return META[type] ?? { icon: Circle, label: type, glyph: 'text-muted-foreground bg-muted hover:bg-muted/80' };
}

function propsOf(a: Action): Array<[string, string]> {
  const m = metaFor(a.type);
  const rows: Array<[string, string]> = [['动作', m.label]];
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

/** Group the action sequence into screenplay paragraphs: leading cues + one speech. */
interface Para {
  cues: Action[];
  speech: Action | null;
}
function groupScript(actions: Action[]): Para[] {
  const paras: Para[] = [];
  let cues: Action[] = [];
  for (const a of actions) {
    if (a.type === 'speech') {
      paras.push({ cues, speech: a });
      cues = [];
    } else {
      cues.push(a);
    }
  }
  if (cues.length > 0) paras.push({ cues, speech: null });
  return paras;
}

interface TooltipState {
  action: Action;
  anchor: DOMRect;
}

function CueTooltip({ tip }: { tip: TooltipState }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: Math.max(8, tip.anchor.left + tip.anchor.width / 2),
        top: tip.anchor.top - 8,
        transform: 'translate(-50%, -100%)',
        maxWidth: 280,
        zIndex: 60,
      }}
      className="pointer-events-none rounded-lg border border-border/80 bg-popover px-2.5 py-1.5 text-popover-foreground shadow-lg shadow-black/5"
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

function CueGlyph({ action, onTip }: { action: Action; onTip: (t: TooltipState | null) => void }) {
  const m = metaFor(action.type);
  const Icon = m.icon;
  const elementId = (action as { elementId?: string }).elementId;

  return (
    <span
      onMouseEnter={(e) => {
        onTip({ action, anchor: e.currentTarget.getBoundingClientRect() });
        if (elementId) useCanvasStore.getState().setSpotlight(elementId);
      }}
      onMouseLeave={() => {
        onTip(null);
        useCanvasStore.getState().setSpotlight('');
      }}
      className={cn(
        'mr-1.5 inline-flex size-[18px] -translate-y-px cursor-default select-none items-center justify-center rounded-full align-middle transition-colors',
        m.glyph,
      )}
      aria-label={m.label}
    >
      <Icon className="size-3" />
    </span>
  );
}

export function ActionsBar({ sceneId }: { sceneId: string }) {
  const actions = useStageStore((s) => s.scenes.find((x) => x.id === sceneId)?.actions ?? EMPTY);
  const [open, setOpen] = useState(true);
  const [tip, setTip] = useState<TooltipState | null>(null);
  const reduce = useReducedMotion();

  // Height drag-resize (top edge) — pointer capture, direct DOM write, commit on release.
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

  const paras = groupScript(actions);
  const speechCount = actions.filter((a) => a.type === 'speech').length;
  const cueCount = actions.length - speechCount;

  return (
    <section
      ref={sectionRef}
      style={open ? { height } : undefined}
      // Same chrome family as SlideNavRail / AgentPanel: white glass surface,
      // gray-100 hairline, violet hover on the resize handle.
      className="relative flex flex-col border-t border-gray-100 bg-white/80 backdrop-blur-xl dark:border-gray-800 dark:bg-slate-900/80"
    >
      {open && (
        <div
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          className="group absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize touch-none transition-colors hover:bg-violet-400/30 active:bg-violet-500/50 dark:hover:bg-violet-500/30"
        >
          <div className="absolute left-1/2 top-[3px] h-0.5 w-9 -translate-x-1/2 rounded-full bg-gray-300 transition-colors group-hover:bg-violet-400 dark:bg-gray-600 dark:group-hover:bg-violet-500" />
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 shrink-0 items-center gap-2.5 px-6 text-left"
      >
        <span className="size-1.5 rounded-full bg-primary" />
        <span className="text-[12px] font-medium tracking-[0.18em] text-foreground/80">讲解脚本</span>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground/60">
          {speechCount} 讲解 · {cueCount} 动作
        </span>
        <ChevronDown
          className={cn('size-4 text-muted-foreground/60 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {actions.length === 0 ? (
            <p className="px-6 pb-5 text-[12px] text-muted-foreground/70">
              暂无动作 — 让 MAIC Agent 为这一页生成讲解。
            </p>
          ) : (
            <div className="mx-auto max-w-[76ch] space-y-3.5 px-6 pb-6 pt-1">
              {paras.map((p, n) => (
                <motion.div
                  key={(p.speech?.id ?? p.cues[0]?.id ?? n) as string}
                  initial={reduce ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22, delay: reduce ? 0 : Math.min(n * 0.03, 0.24), ease: 'easeOut' }}
                  className="relative pl-9"
                >
                  <span className="absolute left-0 top-[4px] select-none font-mono text-[10px] tabular-nums tracking-wide text-muted-foreground/35">
                    {String(n + 1).padStart(2, '0')}
                  </span>
                  <p className="text-[13px] leading-[1.9] text-foreground/85">
                    {p.cues.map((c, i) => (
                      <CueGlyph key={c.id ?? i} action={c} onTip={setTip} />
                    ))}
                    {p.speech ? (p.speech as { text?: string }).text ?? '' : null}
                  </p>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      )}

      {tip && <CueTooltip tip={tip} />}
    </section>
  );
}
