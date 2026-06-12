'use client';

/**
 * Tool-call UI for `regenerate_scene_actions` — a slim, single-line tool row
 * in the style of mainstream agent GUIs: status icon + name + result summary,
 * expandable for details. Sits inline in the assistant's content at its
 * chronological position (the runtime preserves turn order).
 */
import { useState } from 'react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { AlertCircle, Check, ChevronRight, Loader2, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface RegenerateResult {
  content?: { type: string; text?: string }[];
  details?: { sceneId?: string; actions?: { type?: string }[] };
}

const TYPE_LABEL: Record<string, string> = {
  speech: '讲解',
  spotlight: '聚光',
  laser: '激光',
  wb_open: '画板',
  wb_draw_text: '板书',
  wb_draw_shape: '图形',
  wb_draw_latex: '公式',
  wb_draw_table: '表格',
};

function summarize(actions: { type?: string }[]): string {
  const counts = new Map<string, number>();
  for (const a of actions) {
    const t = a?.type ?? 'action';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([t, n]) => `${n} ${TYPE_LABEL[t] ?? t}`).join(' · ');
}

function ToolRow({
  running,
  failed,
  result,
}: {
  running: boolean;
  failed: boolean;
  result?: RegenerateResult;
}) {
  const [open, setOpen] = useState(false);
  const actions = result?.details?.actions ?? [];
  const failText = result?.content?.[0]?.text;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/70 bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-muted/60"
      >
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : failed ? (
          <AlertCircle className="size-3.5 shrink-0 text-amber-500" />
        ) : (
          <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />
        )}
        <Wand2 className="size-3 shrink-0 text-muted-foreground/70" />
        <span className="font-medium text-foreground/90">重新生成讲解</span>
        <span className="truncate text-muted-foreground">
          {running ? '正在生成…' : failed ? '未生成动作' : `${actions.length} 个动作`}
        </span>
        <ChevronRight
          className={cn('ml-auto size-3.5 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')}
        />
      </button>

      {open && (
        <div className="space-y-1 border-t border-border/60 px-2.5 py-2 text-[11px] text-muted-foreground">
          {failed && failText ? <p className="text-amber-600 dark:text-amber-500">{failText}</p> : null}
          {actions.length > 0 && <p>{summarize(actions)}</p>}
          {result?.details?.sceneId && (
            <p className="font-mono text-muted-foreground/70">scene {result.details.sceneId}</p>
          )}
          {running && <p>正在根据页面内容重新生成讲解旁白…</p>}
        </div>
      )}
    </div>
  );
}

export const RegenerateSceneActionsUI = makeAssistantToolUI<{ sceneId?: string }, RegenerateResult>({
  toolName: 'regenerate_scene_actions',
  render: ({ status, result, isError }) => {
    const running = status.type === 'running' || status.type === 'requires-action';
    const failed = !running && (isError || status.type === 'incomplete');
    return <ToolRow running={running} failed={failed} result={result} />;
  },
});
