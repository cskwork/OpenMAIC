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
import { AlertCircle, AtSign, Check, ChevronDown, Loader2, Wrench } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { cn } from '@/lib/utils/cn';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import { cueLabel } from '@/components/edit/ActionsBar/cue-meta';

type TFn = (key: string, options?: Record<string, unknown>) => string;

interface RegenerateResult {
  content?: { type: string; text?: string }[];
  details?: { sceneId?: string; actions?: { type?: string }[] };
}

function summarize(actions: { type?: string }[], t: TFn): string {
  const counts = new Map<string, number>();
  for (const a of actions) {
    const type = a?.type ?? 'action';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, n]) => `${n} ${cueLabel(type, t)}`).join(' · ');
}

/**
 * The page (scene) this regenerate acted on, shown as an `@title` chip — the
 * chat is a single global thread (Cursor-style), so each tool card carries its
 * own scene reference instead of splitting history per page.
 */
function ScenePill({ sceneId }: { sceneId?: string }) {
  const title = useStageStore((s) =>
    sceneId ? (s.scenes.find((x) => x.id === sceneId)?.title ?? null) : null,
  );
  if (!title) return null;
  return (
    <span className="inline-flex min-w-0 max-w-[50%] shrink-0 items-center gap-0.5 rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10.5px] font-medium text-[#5b1fa8] dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300">
      <AtSign className="size-2.5 shrink-0 text-violet-500" />
      <span className="truncate">{title}</span>
    </span>
  );
}

function ToolRow({
  running,
  failed,
  result,
  sceneId,
}: {
  running: boolean;
  failed: boolean;
  result?: RegenerateResult;
  sceneId?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const actions = result?.details?.actions ?? [];
  const failText = result?.content?.[0]?.text;
  // Diff/details only after the run completes (design: "diff 仅完成后可展开").
  const expandable = !running && (actions.length > 0 || !!failText || !!result?.details?.sceneId);

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
        {/* Title yields first (truncates) so the @scene pill stays readable on a
            narrow rail; the pill is capped + truncates rather than collapsing. */}
        <span className="min-w-0 shrink truncate text-[12.5px] font-semibold text-foreground">
          {t('edit.regen.title')}
        </span>
        <ScenePill sceneId={sceneId} />

        {running ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[10.5px] font-semibold text-[#5b1fa8] dark:bg-violet-500/10 dark:text-violet-300">
            <Loader2 className="size-3 animate-spin" />
            {t('edit.regen.generating')}
          </span>
        ) : failed ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
            <AlertCircle className="size-3" />
            {t('edit.regen.notGenerated')}
          </span>
        ) : (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
            <Check className="size-3" />
            {t('edit.regen.updated')}
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
          {actions.length > 0 && <p className="font-mono">{summarize(actions, t)}</p>}
        </div>
      )}
    </div>
  );
}

export const RegenerateSceneActionsUI = makeAssistantToolUI<{ sceneId?: string }, RegenerateResult>(
  {
    toolName: 'regenerate_scene_actions',
    render: ({ args, status, result, isError }) => {
      const running = status.type === 'running' || status.type === 'requires-action';
      const failed = !running && (isError || status.type === 'incomplete');
      const sceneId = args?.sceneId ?? result?.details?.sceneId;
      return <ToolRow running={running} failed={failed} result={result} sceneId={sceneId} />;
    },
  },
);
