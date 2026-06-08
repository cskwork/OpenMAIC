'use client';

/**
 * ActionsBar — Pro-mode bottom bar that shows the active scene's playback
 * `actions` (the narration/effect timeline) so editors can see what the agent
 * generated. Reads reactively from the stage store, so regenerating actions
 * (via the MAIC Agent) updates it live. Collapsible to reclaim canvas height.
 */
import { useState } from 'react';
import {
  ChevronDown,
  Circle,
  Crosshair,
  Focus,
  ListMusic,
  MessageSquareText,
  PenLine,
  Presentation,
  Shapes,
  Sigma,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useStageStore } from '@/lib/store/stage';
import type { Action } from '@/lib/types/action';

// Stable empty reference so the zustand selector doesn't churn re-renders.
const EMPTY: Action[] = [];

interface TypeMeta {
  icon: LucideIcon;
  label: string;
  /** text + ring accent classes */
  accent: string;
  preview: (a: Action) => string;
}

const META: Record<string, TypeMeta> = {
  speech: {
    icon: MessageSquareText,
    label: '讲解',
    accent: 'text-violet-600 ring-violet-200 dark:text-violet-400 dark:ring-violet-900',
    preview: (a) => (a as { text?: string }).text ?? '',
  },
  spotlight: {
    icon: Focus,
    label: '聚光',
    accent: 'text-amber-600 ring-amber-200 dark:text-amber-400 dark:ring-amber-900',
    preview: (a) => `#${(a as { elementId?: string }).elementId ?? ''}`,
  },
  laser: {
    icon: Crosshair,
    label: '激光',
    accent: 'text-rose-600 ring-rose-200 dark:text-rose-400 dark:ring-rose-900',
    preview: (a) => `#${(a as { elementId?: string }).elementId ?? ''}`,
  },
  wb_open: {
    icon: Presentation,
    label: '画板',
    accent: 'text-sky-600 ring-sky-200 dark:text-sky-400 dark:ring-sky-900',
    preview: () => '打开画板',
  },
  wb_draw_text: {
    icon: PenLine,
    label: '板书',
    accent: 'text-sky-600 ring-sky-200 dark:text-sky-400 dark:ring-sky-900',
    preview: (a) => (a as { content?: string }).content ?? '',
  },
  wb_draw_shape: {
    icon: Shapes,
    label: '图形',
    accent: 'text-sky-600 ring-sky-200 dark:text-sky-400 dark:ring-sky-900',
    preview: () => '绘制图形',
  },
  wb_draw_latex: {
    icon: Sigma,
    label: '公式',
    accent: 'text-sky-600 ring-sky-200 dark:text-sky-400 dark:ring-sky-900',
    preview: (a) => (a as { latex?: string }).latex ?? '',
  },
  wb_draw_table: {
    icon: Table2,
    label: '表格',
    accent: 'text-sky-600 ring-sky-200 dark:text-sky-400 dark:ring-sky-900',
    preview: () => '绘制表格',
  },
};

const FALLBACK: TypeMeta = {
  icon: Circle,
  label: 'action',
  accent: 'text-muted-foreground ring-border',
  preview: () => '',
};

function metaFor(type: string): TypeMeta {
  return META[type] ?? { ...FALLBACK, label: type };
}

export function ActionsBar({ sceneId }: { sceneId: string }) {
  const actions = useStageStore((s) => s.scenes.find((x) => x.id === sceneId)?.actions ?? EMPTY);
  const [open, setOpen] = useState(true);

  // Per-type counts for the header summary.
  const counts = new Map<string, number>();
  for (const a of actions) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  const summary = [...counts.entries()].map(([t, n]) => `${n} ${metaFor(t).label}`).join(' · ');

  return (
    <section className="flex max-h-[42vh] flex-col border-t border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 shrink-0 items-center gap-2 px-4 text-left transition-colors hover:bg-accent/50"
      >
        <ListMusic className="size-4 text-primary" />
        <span className="text-[13px] font-medium text-foreground">动作时间线</span>
        <span className="rounded-full bg-muted px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
          {actions.length}
        </span>
        {summary && <span className="truncate font-mono text-[11px] text-muted-foreground">{summary}</span>}
        <ChevronDown
          className={cn('ml-auto size-4 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>

      {open &&
        (actions.length === 0 ? (
          <div className="px-4 pb-3 pt-1 text-[12px] text-muted-foreground">
            暂无动作 — 让 MAIC Agent 为这一页生成讲解动作。
          </div>
        ) : (
          <ol className="flex gap-2 overflow-x-auto px-4 pb-3 pt-1">
            {actions.map((a, i) => {
              const m = metaFor(a.type);
              const Icon = m.icon;
              const text = m.preview(a);
              return (
                <li
                  key={a.id ?? i}
                  className="flex min-w-[176px] max-w-[260px] shrink-0 flex-col gap-1 rounded-lg border border-border bg-card px-2.5 py-2"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className={cn('grid size-5 place-items-center rounded ring-1', m.accent)}>
                      <Icon className="size-3" />
                    </span>
                    <span className="text-[11px] font-medium text-foreground">{m.label}</span>
                  </div>
                  {text && (
                    <p
                      className={cn(
                        'line-clamp-2 text-[12px] leading-snug [overflow-wrap:anywhere]',
                        a.type === 'speech' ? 'text-foreground' : 'font-mono text-muted-foreground',
                      )}
                    >
                      {text}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        ))}
    </section>
  );
}
