'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, Reorder, motion, useReducedMotion } from 'motion/react';
import { PanelLeftClose, PanelLeftOpen, PlusCircle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useDeletedSceneRecycle } from '@/lib/edit/deleted-scene-recycle';
import { createBlankSlideScene, duplicateSlideScene } from '@/lib/edit/slide-defaults';
import { CHROME_DURATION_MS, CHROME_EASE, CHROME_EASE_CSS } from '@/lib/edit/transitions';
import type { Scene } from '@/lib/types/stage';
import { ThumbItem } from './ThumbItem';
import { InsertionZone } from './InsertionZone';

const RAIL_COLLAPSED_PX = 56;
const RAIL_MIN_PX = 180;
const RAIL_MAX_PX = 360;

/**
 * Pro mode slide-navigation left rail (Studio Editor aesthetic).
 *
 * Layout: a vertical thumbnail strip with monospaced index captions
 * below each tile, inter-thumb "+" insertion zones revealed on hover,
 * and a collapse toggle at the rail head. All scene types are
 * first-class — slides render a live `ThumbnailSlide`, non-slide scenes
 * get a type-icon stub but stay clickable, draggable, and right-clickable
 * so page-level management is uniform across the deck.
 *
 * Visuals: low-chroma zinc surface + single violet brand accent, no
 * per-row chrome (rejected `EditModeSidebar` pattern). Drag uses an
 * explicit grip handle on the thumb so the whole tile remains
 * click-to-switch.
 */
export function SlideNavRail() {
  const { t } = useI18n();
  const scenes = useStageStore.use.scenes();
  const currentSceneId = useStageStore.use.currentSceneId();
  const setCurrentSceneId = useStageStore.use.setCurrentSceneId();
  const setScenes = useStageStore.use.setScenes();
  const insertSceneAfter = useStageStore.use.insertSceneAfter();
  const deleteScene = useStageStore.use.deleteScene();
  const stage = useStageStore.use.stage();
  const collapsed = useSettingsStore((s) => s.editRailCollapsed);
  const setCollapsed = useSettingsStore((s) => s.setEditRailCollapsed);
  const persistedWidth = useSettingsStore((s) => s.editRailWidth);
  const setPersistedWidth = useSettingsStore((s) => s.setEditRailWidth);
  const prefersReducedMotion = useReducedMotion();

  // Drag-to-resize.
  //
  // We mutate the rail's `style.width` directly on the DOM during pointer
  // move (bypassing React entirely) and only commit the final width to the
  // settings store on mouse-up. This is what makes the handle feel glued
  // to the cursor: there's no React render → reconcile → DOM commit
  // latency between mousemove and the visible width change. The thumbnails
  // inside (which depend on the rail's CSS width via ResizeObserver in
  // `ThumbnailSlide`) get notified by the browser's layout engine on the
  // same frame, so they scale in lock-step.
  //
  // `isDragging` is still React state so we can turn off the CSS
  // `transition: width` for the duration of the gesture — otherwise the
  // 280ms tween from the collapse/expand animation would fight every
  // direct width write.
  const railRef = useRef<HTMLElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (collapsed) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = persistedWidth;
      let lastWidth = startWidth;
      setIsDragging(true);
      const onMove = (me: MouseEvent) => {
        const delta = me.clientX - startX;
        const next = Math.min(RAIL_MAX_PX, Math.max(RAIL_MIN_PX, startWidth + delta));
        lastWidth = next;
        if (railRef.current) railRef.current.style.width = `${next}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Commit final width to persisted settings exactly once per gesture.
        // React will re-render with `style.width = persistedWidth`, which
        // matches the DOM value we already wrote — no visual jump.
        setPersistedWidth(lastWidth);
        setIsDragging(false);
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [collapsed, persistedWidth, setPersistedWidth],
  );

  useEffect(
    () => () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    },
    [],
  );

  const slideCount = useMemo(() => scenes.filter((s) => s.type === 'slide').length, [scenes]);
  // For non-slide scenes (no recreate path), only allow delete if there's
  // more than one scene overall — otherwise the deck would become empty.
  const totalScenes = scenes.length;

  const currentScene = useMemo(
    () => scenes.find((s) => s.id === currentSceneId) ?? null,
    [scenes, currentSceneId],
  );

  const onReorderIds = useCallback(
    (newOrder: string[]) => {
      const byId = new Map(scenes.map((s) => [s.id, s] as const));
      const next: Scene[] = newOrder
        .map((id) => byId.get(id))
        .filter((s): s is Scene => Boolean(s));
      if (next.length !== scenes.length) return;
      const rebalanced = next.map((s, i) => (s.order === i + 1 ? s : { ...s, order: i + 1 }));
      setScenes(rebalanced);
    },
    [scenes, setScenes],
  );

  const handleActivate = useCallback(
    (sceneId: string) => {
      if (sceneId === currentSceneId) return;
      // Switching to a non-slide scene is fine — useEditModeLock will
      // auto-exit Pro mode the moment the new scene is uneditable.
      setCurrentSceneId(sceneId);
    },
    [currentSceneId, setCurrentSceneId],
  );

  const handleInsertAt = useCallback(
    (afterSceneId: string | null) => {
      if (!stage) return;
      const anchor = afterSceneId
        ? scenes.find((s) => s.id === afterSceneId)
        : (currentScene ?? scenes[scenes.length - 1]);
      if (!anchor) return;
      const anchorIndex = scenes.findIndex((s) => s.id === anchor.id);
      const newOrder = anchorIndex + 2;
      const blank = createBlankSlideScene(stage.id, t('edit.nav.untitledSlide'), newOrder);
      insertSceneAfter(anchor.id, blank);
      setCurrentSceneId(blank.id);
    },
    [currentScene, insertSceneAfter, scenes, setCurrentSceneId, stage, t],
  );

  const handleDuplicate = useCallback(
    (sceneId: string) => {
      const source = scenes.find((s) => s.id === sceneId);
      if (!source) return;
      const anchorIndex = scenes.findIndex((s) => s.id === sceneId);
      const newOrder = anchorIndex + 2;
      // Slide scenes get a deep clone with reseeded element IDs; non-slide
      // scenes just get a shallow id + title bump.
      const copy: Scene =
        source.type === 'slide'
          ? duplicateSlideScene(source, t('edit.nav.copySuffix'), newOrder)
          : {
              ...source,
              id: crypto.randomUUID(),
              title: `${source.title} ${t('edit.nav.copySuffix')}`,
              order: newOrder,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
      insertSceneAfter(sceneId, copy);
      setCurrentSceneId(copy.id);
    },
    [insertSceneAfter, scenes, setCurrentSceneId, t],
  );

  const handleDelete = useCallback(
    (sceneId: string) => {
      const source = scenes.find((s) => s.id === sceneId);
      if (!source) return;
      // Hold deck-empty guard at the rail layer; the store doesn't enforce.
      if (source.type === 'slide' && slideCount <= 1) return;
      if (totalScenes <= 1) return;
      const index = scenes.findIndex((s) => s.id === sceneId);
      useDeletedSceneRecycle.getState().capture(source, index);
      deleteScene(sceneId);
      toast(t('edit.nav.deleted'), {
        description: source.title,
        duration: 5000,
        action: {
          label: t('edit.nav.undo'),
          onClick: () => {
            const entry = useDeletedSceneRecycle.getState().consume();
            if (!entry) return;
            const live = useStageStore.getState().scenes;
            const anchorIndex = Math.min(Math.max(entry.index - 1, 0), live.length - 1);
            const anchor = live[anchorIndex];
            if (!anchor) {
              useStageStore.getState().setScenes([entry.scene]);
              useStageStore.getState().setCurrentSceneId(entry.scene.id);
              return;
            }
            useStageStore.getState().insertSceneAfter(anchor.id, entry.scene);
            useStageStore.getState().setCurrentSceneId(entry.scene.id);
          },
        },
        onDismiss: () => useDeletedSceneRecycle.getState().clear(),
        onAutoClose: () => useDeletedSceneRecycle.getState().clear(),
      });
    },
    [deleteScene, scenes, slideCount, totalScenes, t],
  );

  const canDeleteAny = totalScenes > 1;
  const canDeleteSlide = slideCount > 1;

  // Plain CSS transition mirrors playback `SceneSidebar` exactly: zero
  // motion.dev overhead, instant width updates while dragging. The earlier
  // `motion.aside animate={false}` still ran motion's element-tracking
  // pipeline per frame even with animation off, which produced the
  // perceptible drag lag the user reported.
  const widthTransitionCss = isDragging
    ? 'none'
    : prefersReducedMotion
      ? 'none'
      : `width ${CHROME_DURATION_MS}ms ${CHROME_EASE_CSS}`;

  return (
    <aside
      ref={railRef}
      data-testid="slide-nav-rail"
      data-collapsed={collapsed}
      // Mirrors playback SceneSidebar: white/translucent surface, soft
      // right border, backdrop blur. `overflow-hidden` clips tiles to
      // the rail's current width — without it, mid-drag widths leak
      // children rightward (the inner scroll body has overflow-x-hidden
      // but it sits inside this aside and only clips its own
      // descendants, not the aside's edge).
      //
      // Width is React-driven only outside drag gestures. During a drag,
      // `handleResizeStart` writes `style.width` directly on this element
      // for instant, cursor-locked tracking; React's render value would
      // arrive too late.
      className={cn(
        'relative flex h-full shrink-0 flex-col overflow-hidden',
        'border-r border-gray-100 dark:border-gray-800',
        'bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl',
        'shadow-[2px_0_24px_rgba(0,0,0,0.02)]',
      )}
      style={{
        width: collapsed ? RAIL_COLLAPSED_PX : persistedWidth,
        transition: widthTransitionCss,
      }}
    >
      {/* Resize handle — right edge, 6px hit zone, only enabled when
          expanded. Matches the playback SceneSidebar drag handle. */}
      {!collapsed && (
        <div
          onMouseDown={handleResizeStart}
          className="group absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-violet-400/30 dark:hover:bg-violet-500/30 active:bg-violet-500/50 transition-colors"
        >
          <div className="absolute right-0.5 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-gray-300 dark:bg-gray-600 group-hover:bg-violet-400 dark:group-hover:bg-violet-500 transition-colors" />
        </div>
      )}
      {/* Header band — height matches playback's logo header (h-10 +
          mt-3 mb-1 — together ~56px) so when Pro mode opens the chrome
          height stays consistent with what was here in playback. */}
      <div
        className={cn(
          'shrink-0 px-3 mt-3 mb-1',
          collapsed ? 'flex flex-col items-center gap-1' : 'flex items-center justify-between',
        )}
      >
        {!collapsed && (
          <span className="text-[10px] uppercase tracking-[0.18em] font-bold text-gray-400 dark:text-gray-500">
            {t('edit.nav.deckLabel')}
          </span>
        )}
        <div className={cn('flex items-center gap-1', collapsed && 'flex-col')}>
          <button
            type="button"
            onClick={() => handleInsertAt(currentSceneId)}
            aria-label={t('edit.nav.addSlide')}
            title={t('edit.nav.addSlide')}
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-lg',
              'text-gray-500 dark:text-gray-400 transition-all duration-150',
              'hover:bg-violet-50 hover:text-violet-600',
              'dark:hover:bg-violet-950/40 dark:hover:text-violet-300',
              'active:scale-90',
            )}
          >
            <PlusCircle className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? t('edit.nav.expand') : t('edit.nav.collapse')}
            title={collapsed ? t('edit.nav.expand') : t('edit.nav.collapse')}
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-lg',
              'bg-gray-100/80 text-gray-500 ring-1 ring-black/[0.04]',
              'dark:bg-gray-800/80 dark:text-gray-400 dark:ring-white/[0.06]',
              'hover:bg-gray-200/90 hover:text-gray-700',
              'dark:hover:bg-gray-700/90 dark:hover:text-gray-200',
              'active:scale-90 transition-all duration-200',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Body — list padding (p-2 space-y-2) matches playback's scene
          list so spacing/density read the same. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide pt-1">
        {collapsed ? (
          <CollapsedList
            scenes={scenes}
            currentSceneId={currentSceneId}
            onActivate={handleActivate}
          />
        ) : (
          <AnimatePresence initial={false}>
            <motion.div
              key="expanded-list"
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18, ease: CHROME_EASE }}
              className="p-2"
            >
              <Reorder.Group
                axis="y"
                values={scenes.map((s) => s.id)}
                onReorder={onReorderIds}
                as="ol"
                className="m-0 list-none p-0"
              >
                {scenes.map((scene, index) => (
                  <Fragment key={scene.id}>
                    <ThumbItem
                      scene={scene}
                      index={index}
                      active={scene.id === currentSceneId}
                      canDelete={scene.type === 'slide' ? canDeleteSlide : canDeleteAny}
                      onActivate={() => handleActivate(scene.id)}
                      onDuplicate={() => handleDuplicate(scene.id)}
                      onDelete={() => handleDelete(scene.id)}
                    />
                    <InsertionZone
                      label={t('edit.nav.addSlide')}
                      onInsert={() => handleInsertAt(scene.id)}
                    />
                  </Fragment>
                ))}
              </Reorder.Group>
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </aside>
  );
}

interface CollapsedListProps {
  readonly scenes: readonly Scene[];
  readonly currentSceneId: string | null;
  readonly onActivate: (sceneId: string) => void;
}

function CollapsedList({ scenes, currentSceneId, onActivate }: CollapsedListProps) {
  return (
    <ol className="m-0 flex flex-col items-stretch gap-0.5 py-2 px-1.5 list-none">
      {scenes.map((scene, index) => {
        const active = scene.id === currentSceneId;
        const isSlide = scene.type === 'slide';
        return (
          <li key={scene.id}>
            <button
              type="button"
              onClick={() => onActivate(scene.id)}
              title={scene.title || `${index + 1}`}
              data-active={active}
              data-scene-type={scene.type}
              className={cn(
                'group/cl flex h-7 w-full items-center justify-center rounded-md',
                'font-mono text-[10px] leading-none tabular-nums tracking-wide transition-colors',
                active
                  ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/40'
                  : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-800 dark:hover:text-zinc-200',
                !isSlide && !active && 'text-zinc-400/80 dark:text-zinc-500/80',
              )}
            >
              {String(index + 1).padStart(2, '0')}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
