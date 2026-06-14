'use client';

/**
 * Tool-call UI for `regenerate_scene_actions`, in the AgentSidebar design
 * board's `.ae-tool` language: a bordered card with a wrench glyph, title,
 * mono target, and a right-aligned status badge (done = green, running =
 * violet spinner). The card expands to a details body once complete. The
 * board's red/green line diff isn't rendered — this tool regenerates a scene's
 * actions wholesale rather than producing a text diff — so the body shows the
 * resulting action breakdown instead.
 */
import { useState } from 'react';
import { AlertCircle, Check, ChevronDown, Loader2, Wrench } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { cn } from '@/lib/utils/cn';
import { cueLabel } from '@/components/edit/ActionsBar/cue-meta';

interface RegenerateResult {
  content?: { type: string; text?: string }[];
  details?: { sceneId?: string; actions?: { type?: string }[] };
}

function summarize(actions: { type?: string }[]): string {
  const counts = new Map<string, number>();
  for (const a of actions) {
    const t = a?.type ?? 'action';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([t, n]) => `${n} ${cueLabel(t)}`).join(' · ');
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
  // Diff/details only after the run completes (design: "diff 仅完成后可展开").
  const expandable = !running && (actions.length > 0 || !!failText || !!result?.details?.sceneId);

  const target = running ? '正在生成…' : failed ? '未生成动作' : `${actions.length} 个动作`;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-[9px] border',
        running ? 'border-violet-300 dark:border-violet-500/40' : 'border-border',
      )}
    >
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 bg-muted/50 px-2.5 py-2 text-left',
          expandable ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 whitespace-nowrap text-[12.5px] font-semibold text-foreground">
          重新生成讲解
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
          {target}
        </span>

        {running ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[10.5px] font-semibold text-[#5b1fa8] dark:bg-violet-500/10 dark:text-violet-300">
            <Loader2 className="size-3 animate-spin" />
            生成中
          </span>
        ) : failed ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
            <AlertCircle className="size-3" />
            未生成
          </span>
        ) : (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
            <Check className="size-3" />
            已更新
          </span>
        )}

        {expandable && (
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-neutral-400 transition-transform',
              open && 'rotate-180',
            )}
          />
        )}
      </button>

      {open && expandable && (
        <div className="space-y-1 border-t border-border px-2.5 py-2 text-[11px] text-muted-foreground">
          {failed && failText ? (
            <p className="text-amber-600 dark:text-amber-500">{failText}</p>
          ) : null}
          {actions.length > 0 && <p className="font-mono">{summarize(actions)}</p>}
          {result?.details?.sceneId && (
            <p className="font-mono text-muted-foreground/70">scene {result.details.sceneId}</p>
          )}
        </div>
      )}
    </div>
  );
}

export const RegenerateSceneActionsUI = makeAssistantToolUI<{ sceneId?: string }, RegenerateResult>(
  {
    toolName: 'regenerate_scene_actions',
    render: ({ status, result, isError }) => {
      const running = status.type === 'running' || status.type === 'requires-action';
      const failed = !running && (isError || status.type === 'incomplete');
      return <ToolRow running={running} failed={failed} result={result} />;
    },
  },
);
