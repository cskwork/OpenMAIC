'use client';

import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import type { Slide } from '@/lib/types/slides';
// Type-only import: stripped at compile time, never reaches the bundler.
// pdfjs-dist (transitively pulled by `pptxtojson-pro/src`) uses dynamic
// `require()` patterns Turbopack refuses to bundle, so values flow through
// the URL-loaded dist instead. The workspace package only contributes types.
import type * as PptxtojsonPro from 'pptxtojson-pro';

const log = createLogger('ImportPptx');

export type PptxUpload = NonNullable<PptxtojsonPro.ImportPptxOptions['upload']>;

export interface UseImportPptxOptions {
  /**
   * Optional OSS uploader. When provided, every media blob (image, audio,
   * video) is uploaded and the resulting URL is written back into the slide.
   * When omitted, images stay as inline base64 and media falls back to a
   * temporary `blob:` URL (current tab only).
   */
  upload?: PptxUpload;
  /**
   * Called with the fully-converted canvas `Slide[]` after upload settles.
   * Until a caller wires this, the hook just logs the slides for inspection.
   */
  onImported?: (slides: Slide[]) => void;
}

/**
 * PPTX import flow: parse + convert + (optionally) upload media, all inside
 * the bundled `pptxtojson-pro` dist that we load by URL to bypass
 * Turbopack's hard rejection of pdfjs-dist's dynamic require.
 */
export function useImportPptx(options: UseImportPptxOptions = {}) {
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useI18n();
  const { upload, onImported } = options;

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
        // Static URL → bundler never sees the import target.
        // `scripts/sync-pptxtojson-pro.mjs` copies the prebuilt dist into
        // `public/vendor/` after every `pnpm install`.
        const url = '/vendor/pptxtojson-pro/index.js';
        const mod = (await import(
          /* webpackIgnore: true */
          /* turbopackIgnore: true */
          /* @vite-ignore */
          url
        )) as typeof PptxtojsonPro;

        const slides = (await mod.importPptx(file, { upload })) as Slide[];

        log.info('pptx imported', { slideCount: slides.length });
        // eslint-disable-next-line no-console
        console.log('[importPptx] slides:', slides);

        onImported?.(slides);

        toast.success(
          t('import.pptxSuccess', { count: slides.length }),
          { id: toastId },
        );
      } catch (error) {
        log.error('PPTX import failed:', error);
        toast.error(t('import.error.invalidPptx'), { id: toastId });
      } finally {
        setImporting(false);
      }
    },
    [t, upload, onImported],
  );

  return {
    importing,
    fileInputRef,
    triggerFileSelect,
    handleFileChange,
  };
}
