'use client';

import { useEffect, useState } from 'react';

/**
 * Curated text-color palette + hex input. Replaces `<input type=color>`'s OS
 * dialog — which looked off-brand and varied per platform. The palette covers
 * the common slide-text needs (neutrals + a few saturated accents); the hex
 * field is the escape hatch for anything else.
 */
const PALETTE: readonly string[] = [
  '#000000',
  '#525252',
  '#a3a3a3',
  '#ffffff',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

export function ColorPicker({
  value,
  onPick,
}: {
  readonly value: string;
  readonly onPick: (color: string) => void;
}) {
  const [hex, setHex] = useState(value);
  // Re-sync from the outside when a swatch click changes value, or the bar
  // remounts on a new element. Doesn't clobber mid-type because `value`
  // doesn't change until we commit.
  useEffect(() => {
    setHex(value);
  }, [value]);

  const commitHex = () => {
    if (!HEX_RE.test(hex)) {
      setHex(value);
      return;
    }
    const normalized = (hex.startsWith('#') ? hex : `#${hex}`).toLowerCase();
    onPick(normalized);
  };

  const currentLower = value.toLowerCase();

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-1.5">
        {PALETTE.map((c) => {
          const isSelected = c === currentLower;
          return (
            <button
              key={c}
              type="button"
              aria-label={c}
              // preventDefault on mousedown so picking a swatch doesn't steal
              // focus from the ProseMirror editor (matches the bar's pattern).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(c)}
              className={`h-7 w-7 rounded-md ring-1 ring-inset ring-black/10 transition-transform hover:scale-110 dark:ring-white/20 ${
                isSelected ? 'outline outline-2 outline-offset-1 outline-violet-500' : ''
              }`}
              style={{ backgroundColor: c }}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium tracking-wider text-zinc-400 uppercase">Hex</span>
        <input
          type="text"
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              setHex(value);
              e.currentTarget.blur();
            }
          }}
          spellCheck={false}
          placeholder="#000000"
          className="w-24 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs tabular-nums text-zinc-700 outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:focus:border-violet-500 dark:focus:ring-violet-900"
        />
      </div>
    </div>
  );
}
