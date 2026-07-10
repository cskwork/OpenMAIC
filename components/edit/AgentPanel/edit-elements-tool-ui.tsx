'use client';

/**
 * Tool-call UI for `edit_elements` (natural-language per-element edits).
 * Minimal non-expandable ToolCard — title + @scene pill + status badge, with a
 * muted visible refusal reason when an edit was not applied.
 */
import { Move } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ToolCard, isStoppedResult, type ToolStatus } from './tool-card';

interface EditElementsResult {
  content?: { type: string; text?: string }[];
  details?: {
    sceneId?: string;
    intents?: unknown[] | null;
    updateCount?: number;
    refuseReason?: string;
  };
}

function isEditElementsApplied(result?: EditElementsResult | null): boolean {
  return Array.isArray(result?.details?.intents) && result!.details!.intents!.length > 0;
}

function isEditElementsRefused(result?: EditElementsResult | null): boolean {
  const d = result?.details;
  return !!d && 'intents' in d && d.intents === null;
}

function refuseReasonOf(result?: EditElementsResult | null): string | undefined {
  const fromDetails = result?.details?.refuseReason;
  if (typeof fromDetails === 'string' && fromDetails.trim()) return fromDetails.trim();
  const text = result?.content?.find((c) => c.type === 'text' && c.text)?.text;
  if (!text) return undefined;
  const m = text.match(/Could not apply the edit:\s*(.+?)\.\s*Nothing was changed/i);
  return m?.[1]?.trim();
}

function deriveEditElementsFailed(args: {
  running: boolean;
  stopped: boolean;
  isError: boolean;
  result?: EditElementsResult | null;
}): boolean {
  const { running, stopped, isError, result } = args;
  if (running || stopped) return false;
  if (isEditElementsApplied(result)) return false;
  return isError || isEditElementsRefused(result);
}

function EditElementsCard({
  running,
  stopped,
  failed,
  sceneId,
  refuseReason,
}: {
  running: boolean;
  stopped: boolean;
  failed: boolean;
  sceneId?: string;
  refuseReason?: string;
}) {
  const { t } = useI18n();
  const toolStatus: ToolStatus = running
    ? 'running'
    : stopped
      ? 'stopped'
      : failed
        ? 'failed'
        : 'done';
  const baseLabel = running
    ? t('edit.editElements.editing')
    : stopped
      ? t('edit.agent.stopped')
      : failed
        ? t('edit.editElements.notApplied')
        : t('edit.editElements.applied');
  // ToolCard status is icon-only; keep the refusal reason in the hover tooltip
  // and render it as visible muted body text.
  const statusLabel = failed && refuseReason ? `${baseLabel}: ${refuseReason}` : baseLabel;

  return (
    <ToolCard
      title={t('edit.editElements.title')}
      icon={Move}
      sceneId={sceneId}
      status={toolStatus}
      statusLabel={statusLabel}
    >
      {failed && refuseReason ? <span>{refuseReason}</span> : null}
    </ToolCard>
  );
}

export const EditElementsUI = makeAssistantToolUI<
  { sceneId?: string; instruction?: string },
  EditElementsResult
>({
  toolName: 'edit_elements',
  render: ({ args, status, result, isError }) => {
    const running = status.type === 'running' || status.type === 'requires-action';
    const stopped = !running && isStoppedResult(result);
    const failed = deriveEditElementsFailed({
      running,
      stopped,
      isError: !!isError,
      result,
    });
    return (
      <EditElementsCard
        running={running}
        stopped={stopped}
        failed={failed}
        sceneId={args?.sceneId ?? result?.details?.sceneId}
        refuseReason={refuseReasonOf(result)}
      />
    );
  },
});
