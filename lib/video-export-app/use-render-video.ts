'use client';

/**
 * `useRenderVideo` — thin React facade over the global {@link useVideoRenderStore}.
 *
 * The render lifecycle (build ZIP → upload → poll → download) lives in the store
 * so it survives the export menu unmounting (scene switches, menu close) and can
 * be observed from anywhere — e.g. the persistent ring on the export button.
 * This hook just binds `t` and re-exports the reactive slice the menu needs.
 */
import { useCallback } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useVideoRenderStore, type RenderOptions } from '@/lib/store/video-render';

export function useRenderVideo() {
  const { t } = useI18n();
  const status = useVideoRenderStore((s) => s.status);
  const percent = useVideoRenderStore((s) => s.percent);
  const etaMs = useVideoRenderStore((s) => s.etaMs);
  const startRender = useVideoRenderStore((s) => s.startRender);

  const renderVideo = useCallback(
    (options: RenderOptions = {}) => startRender(options, t),
    [startRender, t],
  );

  return {
    rendering: status === 'compiling' || status === 'rendering',
    percent,
    etaMs,
    renderVideo,
  };
}
