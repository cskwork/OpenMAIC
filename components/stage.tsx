'use client';

import { useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useStageStore } from '@/lib/store';
import { isCurrentSceneEditable } from '@/lib/edit/stage-mode';
import { isMaicEditorEnabled } from '@/lib/config/feature-flags';
import { CHROME_EASE } from '@/lib/edit/transitions';
import { EditChromeRoot } from '@/components/edit/EditChromeRoot';
import {
  PlaybackChromeRoot,
  type PlaybackChromeRootHandle,
} from '@/components/edit/PlaybackChromeRoot';
import { useEditModeLock } from '@/components/edit/use-edit-mode-lock';
import { MultiTabEditConflictPrompt } from '@/components/edit/MultiTabEditConflictPrompt';
// Side-effect: registers the slide SceneEditorSurface so EditShell can
// resolve it the moment Pro mode is entered (the shell never imports
// surfaces directly).
import '@/components/edit/surfaces/slide';

/**
 * Stage — top-level classroom container. Dispatches between the two
 * chrome roots based on `useStageStore.mode`:
 *
 *   mode === 'edit'                → EditChromeRoot
 *   mode === 'playback' / 'autonomous' → PlaybackChromeRoot
 *
 * The two roots are wholly independent. Stage's only responsibilities
 * are: mode dispatch, edit-lock coordination (cross-tab), Pro Switch
 * toggle wiring (calls into PlaybackChromeRoot.teardown via ref before
 * flipping mode), and rendering the cross-tab conflict prompt (which
 * needs to be mountable from playback mode too, since the lock-conflict
 * dialog can surface when Pro Switch is clicked but acquire fails).
 */
export function Stage({
  onRetryOutline,
}: {
  onRetryOutline?: (outlineId: string) => Promise<void>;
}) {
  const { mode, setMode, scenes, currentSceneId, generatingOutlines, stage } = useStageStore();
  const currentScene = useStageStore((s) => s.getCurrentScene());

  // Predicate for "can the user enter Pro mode for the current scene?".
  // Single source of truth feeds the Header's Pro Switch state and the
  // auto-exit effect below; keeping them in lock-step prevents an
  // edit-mode entry that would immediately auto-exit.
  const isEditable = isCurrentSceneEditable({
    currentSceneId,
    sceneCount: scenes.length,
    generatingOutlineCount: generatingOutlines.length,
    hasCurrentScene: !!currentScene,
  });

  // Cross-tab edit lock (#571). Lives at this layer because entry must
  // be refused BEFORE the live session is torn down; PlaybackChromeRoot
  // can't own this since it can't refuse its own unmount path.
  const editLock = useEditModeLock(stage?.id);

  const playbackRef = useRef<PlaybackChromeRootHandle>(null);

  // Pro Switch handler. Edit→playback is a plain flip (PlaybackChromeRoot
  // will mount fresh; its engine effect re-inits). Playback→edit must
  // (1) refuse on lock conflict, (2) await SSE / engine / TTS teardown
  // so PlaybackChromeRoot is quiescent before it unmounts.
  const handleToggleEditMode = useCallback(async () => {
    if (mode === 'edit') {
      setMode('playback');
      return;
    }
    if (!editLock.acquire()) return;
    await playbackRef.current?.teardown();
    setMode('edit');
  }, [editLock, mode, setMode]);

  // Auto-exit edit mode when the current scene becomes uneditable
  // (pending generation, no scenes, currently generating).
  useEffect(() => {
    if (mode === 'edit' && !isEditable) {
      setMode('playback');
    }
  }, [mode, isEditable, setMode]);

  // Release the lock whenever we're not in edit mode (covers manual
  // exit, auto-exit, scene becomes uneditable). The hook also self-
  // releases on unmount / tab close.
  const releaseEditLock = editLock.release;
  useEffect(() => {
    if (mode !== 'edit') releaseEditLock();
  }, [mode, releaseEditLock]);

  const toggleHandler = isMaicEditorEnabled() ? handleToggleEditMode : undefined;

  // Mode swap is wrapped in `AnimatePresence mode="wait"` so the outgoing
  // chrome root fully exits (fades out) before the incoming one mounts.
  // `mode="wait"` keeps the single-canvasStore-writer guarantee — the two
  // canvas implementations (ScreenCanvas in playback, Editor/Canvas in
  // edit) never coexist, so their `useViewportSize` writes don't compete.
  // `initial={false}` skips the entry fade on the first render so the page
  // loads instantly in playback mode.
  //
  // The outer div carries a stable background so neither side reveals the
  // raw page background while it fades through opacity 0.
  return (
    <div className="flex-1 flex overflow-hidden bg-gray-50 dark:bg-gray-900">
      <AnimatePresence mode="wait" initial={false}>
        {mode === 'edit' && currentScene ? (
          <motion.div
            key="edit-chrome"
            className="flex-1 flex overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: CHROME_EASE }}
          >
            <EditChromeRoot
              scene={currentScene}
              isEditable={isEditable}
              onToggleEditMode={toggleHandler}
            />
          </motion.div>
        ) : (
          <motion.div
            key="playback-chrome"
            className="flex-1 flex overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: CHROME_EASE }}
          >
            <PlaybackChromeRoot
              ref={playbackRef}
              onRetryOutline={onRetryOutline}
              canEnterProMode={isEditable}
              onEnterProMode={toggleHandler}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <MultiTabEditConflictPrompt
        open={editLock.conflictOpen}
        onDismiss={editLock.dismissConflict}
      />
    </div>
  );
}
