'use client';

import { useState } from 'react';
import { Settings, Sun, Moon, Monitor } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { LanguageSwitcher } from '../language-switcher';
import { SettingsDialog } from '../settings';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { StageMode } from '@/lib/types/stage';

interface HeaderControlsProps {
  readonly mode?: StageMode;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  /**
   * `default` — the chunky h-9 pill used in the playback Stage Header.
   * `compact` — slightly tighter padding for embedding in CommandBar's
   * right slot (Pro mode chrome already eats height, so the pill backs
   * off ring weight / blur to keep the CommandBar quiet).
   */
  readonly variant?: 'default' | 'compact';
}

/**
 * Stage-level global controls: language picker, theme picker, settings
 * modal trigger, and the Pro Switch. Extracted out of `Header` so the
 * Pro mode CommandBar can absorb the same affordances and the playback
 * Header doesn't need to stay mounted just to host them — Pro mode
 * therefore lands on a single top-chrome bar instead of stacking the
 * Stage Header above the EditShell CommandBar.
 *
 * Only one instance is ever mounted at a time (Stage renders Header
 * for playback and EditShell.CommandBar's trailing slot for edit, but
 * never both), so dropdown / dialog state and refs stay co-located
 * here without cross-instance leakage.
 */
export function HeaderControls({
  mode,
  canEdit,
  onToggleEditMode,
  variant = 'default',
}: HeaderControlsProps) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const compact = variant === 'compact';

  return (
    <>
      <div
        className={cn(
          'shrink-0 flex items-center gap-1 backdrop-blur-md shadow-sm rounded-full',
          compact
            ? 'bg-zinc-100/70 dark:bg-zinc-800/70 border border-zinc-200/60 dark:border-zinc-700/60 px-1.5 py-1'
            : 'bg-white/60 dark:bg-gray-800/60 border border-gray-100/50 dark:border-gray-700/50 px-2 py-1.5',
        )}
      >
        {/* Language — Radix DropdownMenu so its menu portals to body
            and never gets clipped by an ancestor's overflow-hidden. */}
        <LanguageSwitcher />

        {/* Theme — same Portal-backed DropdownMenu pattern. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all group"
              aria-label={t('settings.theme')}
            >
              {theme === 'light' && <Sun className="w-4 h-4" />}
              {theme === 'dark' && <Moon className="w-4 h-4" />}
              {theme === 'system' && <Monitor className="w-4 h-4" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="min-w-[140px]">
            <DropdownMenuItem
              onSelect={() => setTheme('light')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'light' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Sun className="w-4 h-4" />
              {t('settings.themeOptions.light')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme('dark')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'dark' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Moon className="w-4 h-4" />
              {t('settings.themeOptions.dark')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme('system')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'system' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Monitor className="w-4 h-4" />
              {t('settings.themeOptions.system')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Settings */}
        <button
          onClick={() => setSettingsOpen(true)}
          className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all group"
          aria-label={t('settings.title')}
        >
          <Settings className="w-4 h-4 group-hover:rotate-90 transition-transform duration-500" />
        </button>
      </div>

      {/* Pro Switch — toggle property: on/off both clickable, not a
          one-way "Done" button. Disabled only when the current scene
          can't be entered (pending/generating/etc.). */}
      {onToggleEditMode && (
        <label
          className={cn(
            'shrink-0 inline-flex items-center gap-2.5 rounded-full border shadow-sm transition-colors duration-200',
            'bg-white/60 dark:bg-gray-800/60 backdrop-blur-md',
            compact ? 'h-8 px-2.5' : 'h-9 px-3',
            mode === 'edit'
              ? 'border-violet-500/60 dark:border-violet-400/60'
              : 'border-gray-100/50 dark:border-gray-700/50',
            !canEdit && mode !== 'edit'
              ? 'opacity-60 cursor-not-allowed'
              : 'cursor-pointer hover:border-violet-400/60 dark:hover:border-violet-500/50',
          )}
          title={mode === 'edit' ? t('stage.doneEditing') : t('stage.editCourse')}
        >
          <span
            className={cn(
              'text-[11px] font-bold uppercase tracking-[0.14em] tabular-nums select-none transition-colors duration-200',
              mode === 'edit'
                ? 'text-violet-600 dark:text-violet-300'
                : 'text-gray-500 dark:text-gray-400',
            )}
          >
            {t('edit.proMode')}
          </span>
          <Switch
            checked={mode === 'edit'}
            onCheckedChange={onToggleEditMode}
            disabled={!canEdit && mode !== 'edit'}
            aria-label={mode === 'edit' ? t('stage.doneEditing') : t('stage.editCourse')}
            className="data-[state=checked]:bg-violet-600 dark:data-[state=checked]:bg-violet-500"
          />
        </label>
      )}

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}
