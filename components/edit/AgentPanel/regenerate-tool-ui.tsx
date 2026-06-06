'use client';

/**
 * Tool-call UI for `regenerate_scene_actions`.
 *
 * Renders the tool call as a compact "generation receipt" card — a running
 * state while the model/pipeline works, then a success card summarising the
 * regenerated actions by type (speech / spotlight / laser …) — instead of
 * dumping raw JSON into a box.
 */
import { makeAssistantToolUI } from '@assistant-ui/react';
import { AlertTriangle, CheckCircle2, Loader2, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface RegenerateResult {
  content?: { type: string; text?: string }[];
  details?: { sceneId?: string; actions?: { type?: string }[] };
}

const TYPE_LABEL: Record<string, string> = {
  speech: 'speech',
  spotlight: 'spotlight',
  laser: 'laser',
  highlight: 'highlight',
  wb_write: 'write',
  wb_draw: 'draw',
};

function summarise(actions: { type?: string }[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of actions) {
    const t = a?.type ?? 'action';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([t, count]) => ({ label: TYPE_LABEL[t] ?? t, count }));
}

export const RegenerateSceneActionsUI = makeAssistantToolUI<{ sceneId?: string }, RegenerateResult>({
  toolName: 'regenerate_scene_actions',
  render: ({ status, result, isError }) => {
    const running = status.type === 'running' || status.type === 'requires-action';
    const failed = isError || status.type === 'incomplete';
    const actions = result?.details?.actions ?? [];
    const breakdown = summarise(actions);
    const total = actions.length;

    const accent = failed
      ? 'text-amber-600 dark:text-amber-500'
      : running
        ? 'text-primary'
        : 'text-emerald-600 dark:text-emerald-500';

    return (
      <div
        className={cn(
          'my-1.5 min-w-0 overflow-hidden rounded-xl border bg-card/60 shadow-sm',
          failed ? 'border-amber-300/60' : running ? 'border-primary/30' : 'border-emerald-300/50',
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <span className={cn('flex size-5 shrink-0 items-center justify-center', accent)}>
            {running ? (
              <Loader2 className="size-4 animate-spin" />
            ) : failed ? (
              <AlertTriangle className="size-4" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Wand2 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-[13px] font-medium text-foreground">Regenerate narration</span>
          </div>
          {!running && !failed && (
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-emerald-600 dark:text-emerald-500">
              {total} action{total === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <div className="border-t bg-muted/30 px-3 py-2">
          {running ? (
            <p className="text-[12px] text-muted-foreground">Re-syncing this scene’s actions to its content…</p>
          ) : failed ? (
            <p className="text-[12px] text-amber-700 dark:text-amber-500">
              {result?.content?.[0]?.text ?? 'No actions were generated for this scene.'}
            </p>
          ) : total === 0 ? (
            <p className="text-[12px] text-muted-foreground">No actions produced.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {breakdown.map(({ label, count }) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1 rounded-md bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-border"
                >
                  <span className="tabular-nums text-foreground">{count}</span>
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  },
});
