'use client';

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { ConnectedTextFormatBar } from './text-format-bar';
import { useTrackedRect } from './use-tracked-rect';

interface AnchoredTextBarProps {
  /** The text element being edited, or "" when no text element is being edited. */
  readonly editingElementId: string;
}

/**
 * The selection-anchored text-format bar. Replaces the top-center FloatingToolbar
 * popover: it hugs the text element being edited (Figma/Pitch feel) and tracks it
 * live. A virtual Radix PopoverAnchor — an invisible fixed-positioned box at the
 * element's screen rect — is what the bar positions against; the rect comes from
 * useTrackedRect. PopoverContent is portaled, so the canvas's overflow-hidden
 * never clips it, and Radix flips it below / clamps it horizontally on its own.
 */
export function AnchoredTextBar({ editingElementId }: AnchoredTextBarProps) {
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
          // consecutive formatting clicks. Escape / a true outside click still
          // change the selection, which closes it via the controlled `open`.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
          className="w-auto max-w-[92vw] p-2"
        >
          <ConnectedTextFormatBar elementId={editingElementId} />
        </PopoverContent>
      )}
    </Popover>
  );
}
