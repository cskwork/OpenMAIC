'use client';

import { useCallback } from 'react';
import {
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  List,
  Minus,
  Plus,
} from 'lucide-react';
import { FONTS } from '@/configs/font';
import type { TextAttrs } from '@/lib/prosemirror/utils';
import {
  runActiveTextCommand,
  type TextCommandPayload,
} from '@/lib/prosemirror/active-editor-registry';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCanvasStore } from '@/lib/store/canvas';
import { useI18n } from '@/lib/hooks/use-i18n';

interface TextFormatBarProps {
  readonly elementId: string;
  readonly attrs: TextAttrs;
}

// Radix Select forbids an empty-string item value, but the canonical "default
// font" in the FONTS registry IS the empty string. It rides through the Select
// under this sentinel and is mapped back to '' at the command edge.
const DEFAULT_FONT = '__default__';

interface ToggleButtonProps {
  readonly label: string;
  readonly active: boolean;
  readonly payload: TextCommandPayload;
  readonly run: (payload: TextCommandPayload) => void;
  readonly children: React.ReactNode;
}

// preventDefault on mousedown keeps ProseMirror focused so the command lands on
// the live element. The Select and the color <input> deliberately skip it —
// they own their own focus.
function BarButton({
  label,
  onClick,
  className,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={className}
    >
      {children}
    </button>
  );
}

function ToggleButton({ label, active, payload, run, children }: ToggleButtonProps) {
  return (
    <BarButton
      label={label}
      onClick={() => run(payload)}
      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
        active
          ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
      }`}
    >
      {children}
    </BarButton>
  );
}

function Divider() {
  return <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-800" />;
}

// Subtle raised −/+ button inside the size stepper pill.
const STEP_BUTTON =
  'flex h-7 w-7 items-center justify-center rounded text-zinc-600 transition-colors ' +
  'hover:bg-white hover:text-zinc-900 hover:shadow-sm ' +
  'dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100';

export function TextFormatBar({ elementId, attrs }: TextFormatBarProps) {
  const { t } = useI18n();
  const run = useCallback(
    (payload: TextCommandPayload) => runActiveTextCommand(elementId, payload),
    [elementId],
  );
  const fontSize = parseInt(attrs.fontsize, 10) || 16;

  return (
    // w-max keeps the row at its natural width so the popover (w-auto) sizes to
    // it — one clean line, nothing squished.
    <div className="flex w-max items-center gap-1">
      {/* Font — design-system Select. Fonts come from OpenMAIC's canonical
          FONTS registry (configs/font.ts): the web fonts the renderer loads. */}
      <Select
        value={attrs.fontname || DEFAULT_FONT}
        onValueChange={(v) => run({ command: 'fontname', value: v === DEFAULT_FONT ? '' : v })}
      >
        <SelectTrigger
          size="sm"
          aria-label={t('edit.text.font')}
          className="w-32 border-0 px-2 text-xs font-normal text-zinc-700 shadow-none hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-72">
          {FONTS.map((f) => (
            <SelectItem key={f.value} value={f.value || DEFAULT_FONT} className="text-xs">
              {f.value === '' ? t('edit.text.fontDefault') : f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Font size — one cohesive stepper pill */}
      <div className="flex h-8 items-center rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-800">
        <BarButton
          label={t('edit.text.sizeDown')}
          onClick={() => run({ command: 'fontsize', value: stepFontSize(attrs.fontsize, -2) })}
          className={STEP_BUTTON}
        >
          <Minus className="h-3.5 w-3.5" />
        </BarButton>
        <span className="w-9 text-center text-xs font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
          {fontSize}
        </span>
        <BarButton
          label={t('edit.text.sizeUp')}
          onClick={() => run({ command: 'fontsize', value: stepFontSize(attrs.fontsize, 2) })}
          className={STEP_BUTTON}
        >
          <Plus className="h-3.5 w-3.5" />
        </BarButton>
      </div>

      <Divider />

      <ToggleButton
        label={t('edit.text.bold')}
        active={attrs.bold}
        payload={{ command: 'bold' }}
        run={run}
      >
        <Bold className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton
        label={t('edit.text.italic')}
        active={attrs.em}
        payload={{ command: 'em' }}
        run={run}
      >
        <Italic className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton
        label={t('edit.text.underline')}
        active={attrs.underline}
        payload={{ command: 'underline' }}
        run={run}
      >
        <Underline className="h-4 w-4" />
      </ToggleButton>

      {/* Text color — a swatch reflecting the current color; the native color
          input is visually hidden but still owns the picker interaction. */}
      <label
        aria-label={t('edit.text.color')}
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span
          className="h-4 w-4 rounded ring-1 ring-inset ring-black/15 dark:ring-white/20"
          style={{ backgroundColor: attrs.color }}
        />
        <input
          type="color"
          value={attrs.color}
          className="sr-only"
          onChange={(e) => run({ command: 'forecolor', value: e.target.value })}
        />
      </label>

      <Divider />

      <ToggleButton
        label={t('edit.text.alignLeft')}
        active={attrs.align === 'left'}
        payload={{ command: 'align-left' }}
        run={run}
      >
        <AlignLeft className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton
        label={t('edit.text.alignCenter')}
        active={attrs.align === 'center'}
        payload={{ command: 'align-center' }}
        run={run}
      >
        <AlignCenter className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton
        label={t('edit.text.alignRight')}
        active={attrs.align === 'right'}
        payload={{ command: 'align-right' }}
        run={run}
      >
        <AlignRight className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton
        label={t('edit.text.bullet')}
        active={attrs.bulletList}
        payload={{ command: 'bulletList' }}
        run={run}
      >
        <List className="h-4 w-4" />
      </ToggleButton>
    </div>
  );
}

/**
 * Connected variant — subscribes to live richTextAttrs from the canvas store.
 * Keep separate from TextFormatBar so the pure component stays unit-testable.
 */
export function ConnectedTextFormatBar({ elementId }: { readonly elementId: string }) {
  const attrs = useCanvasStore.use.richTextAttrs();
  return <TextFormatBar elementId={elementId} attrs={attrs} />;
}

export function stepFontSize(current: string, delta: number): string {
  const n = parseInt(current, 10) || 16;
  return `${Math.max(8, Math.min(96, n + delta))}px`;
}
