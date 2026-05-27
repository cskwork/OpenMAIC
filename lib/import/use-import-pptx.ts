'use client';

import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
// Type-only import: stripped at compile time, never reaches the bundler.
import type * as PptxtojsonPro from 'pptxtojson-pro';

const log = createLogger('ImportPptx');

/**
 * Stage-1 PPTX import: parse with pptxtojson-pro and log the result.
 * No persistence yet — output is meant for inspection in DevTools while we
 * design the Output → Slide adapter.
 */
export function useImportPptx() {
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useI18n();

  const triggerFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      e.target.value = '';

      setImporting(true);
      const toastId = toast.loading(t('import.parsingPptx'));

      try {
        // The bundle contains dynamic require() patterns (pdfjs-dist) that
        // Turbopack rejects at build time. We bypass the bundler entirely by
        // loading the prebuilt ESM dist via a runtime URL (synced to public/
        // by `scripts/sync-pptxtojson-pro.mjs` after each `pnpm install`).
        // Type import still flows through the workspace package for IntelliSense.
        const url = '/vendor/pptxtojson-pro/index.js';
        const mod = (await import(
          /* webpackIgnore: true */
          /* turbopackIgnore: true */
          /* @vite-ignore */
          url
        )) as typeof PptxtojsonPro;
        const buffer = await file.arrayBuffer();
        const result = await mod.parse(buffer, { mediaMode: 'base64' });

        log.info('pptxtojson-pro parse result', {
          slideCount: result.slides?.length,
          themeColors: result.themeColors,
          size: result.size,
        });
        // Full payload to console so the user can inspect structure.
        // eslint-disable-next-line no-console
        console.log('[pptxtojson-pro] output:', result);

        toast.success(
          t('import.pptxSuccess', { count: result.slides?.length ?? 0 }),
          { id: toastId },
        );
      } catch (error) {
        log.error('PPTX parse failed:', error);
        toast.error(t('import.error.invalidPptx'), { id: toastId });
      } finally {
        setImporting(false);
      }
    },
    [t],
  );

  return {
    importing,
    fileInputRef,
    triggerFileSelect,
    handleFileChange,
  };
}
