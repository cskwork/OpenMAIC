'use client';

import { Trash2 } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ConnectedTextFormatBar } from './text-format-bar';
import { deleteSlideElement } from './use-slide-surface';
import { useTrackedRect } from './use-tracked-rect';

interface AnchoredTextBarProps {
  /** The text element being edited, or "" when no text element is being edited. */
  readonly editingElementId: string;
}

/**
 * The selection-anchored contextual bar for a text element. Replaces the
 * top-center FloatingToolbar: it hugs the text element being edited (Figma/Pitch
 * feel), tracks it live, and carries the element's whole action cluster — the
 * format controls plus delete. A virtual Radix PopoverAnchor — an invisible
 * fixed-positioned box at the element's screen rect — is what the bar positions
 * against; the rect comes from useTrackedRect. PopoverContent is portaled, so
 * the canvas's overflow-hidden never clips it, and Radix flips it below /
 * clamps it horizontally on its own.
 */
export function AnchoredTextBar({ editingElementId }: AnchoredTextBarProps) {
  const { t } = useI18n();
  const rect = useTrackedRect(editingElementId);
  const open = editingElementId !== '' && rect !== null;

  return (
    <Popover open={open}>
      {rect && (
        <PopoverAnchor asChild>
          <div
            aria-hidden
            style={{
              position: 'fixed',
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              pointerEvents: 'none',
            }}
          />
        </PopoverAnchor>
      )}
      {open && (
        <PopoverContent
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          // Mirrors the FloatingToolbar popover hardening: opening the bar must
          // not pull focus off the canvas selection, and format commands that
          // refocus the editor must not dismiss it — so it stays up across
          // consecutive formatting clicks. Visibility is fully selection-driven
          // (controlled `open`, no `onOpenChange`): the bar closes when the
          // canvas selection clears or changes — e.g. a click elsewhere on the
          // canvas — not via Radix's own dismiss events.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
          className="w-auto max-w-[92vw] p-2"
        >
          <div className="flex items-center gap-1">
            <ConnectedTextFormatBar elementId={editingElementId} />
            <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
            {/* preventDefault on mousedown keeps the canvas selection alive
                until the click fires; the op then deletes the element. */}
            <button
              type="button"
              aria-label={t('edit.delete')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => deleteSlideElement(editingElementId)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:text-zinc-400 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
