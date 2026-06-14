'use client';

/**
 * ActionsBar — Pro-mode "讲解脚本" bottom bar, a horizontal film-editing timeline
 * that is also a light editor for the scene's playback `actions`.
 *
 * The scene's `actions` ARE the timeline: walked left→right, each `speech`
 * becomes an editable clip block (one spoken line, numbered) and every non-speech
 * cue (spotlight / laser / board) becomes a compact card pinned at its place in
 * the flow. Hovering a cue replays the REAL playback effect on its bound element
 * (setLaser → LaserPointerOverlay, setSpotlight → SpotlightOverlay).
 *
 * Editing (persisted via useStageStore.updateScene → actions-edit ops):
 * - speech clip text is editable inline (commit on blur);
 * - palette chips drag into the track to add an action at a drop slot;
 * - existing items drag to reorder; each card carries a delete button;
 * - clicking an element-bound cue arms canvas pick mode (useCanvasStore.pickTarget),
 *   so the target is chosen by clicking the element directly on the slide.
 *
 * Collapsible; height-resizable from the top edge; reactive to the stage store.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  Circle,
  Crosshair,
  Focus,
  GripVertical,
  PenLine,
  Play,
  Presentation,
  Quote,
  RefreshCw,
  Shapes,
  Sigma,
  Table2,
  Trash2,
  Volume2,
  type LucideIcon,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils/cn';
import { useStageStore } from '@/lib/store/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import type { Action } from '@/lib/types/action';
import { cuePreviewFor } from './cue-preview';
import { insertAt, makeAction, move, removeAt, setAudioId, setSpeechText, type AddableType } from './actions-edit';
import { audioExists, audioObjectUrl, generateSpeechAudio, speechAudioId } from '@/lib/audio/regenerate-speech-tts';

const EMPTY: Action[] = [];
const MIN_H = 152;
const MAX_H = 520;
const DEFAULT_H = 216;

interface TypeMeta {
  icon: LucideIcon;
  label: string;
  /** glyph tint: icon color + soft disc */
  glyph: string;
  /** top accent bar tint for the cue card */
  accent: string;
}

const META: Record<string, TypeMeta> = {
  spotlight: { icon: Focus, label: '聚光', glyph: 'text-amber-600 bg-amber-500/10 dark:text-amber-400', accent: 'bg-amber-400/70' },
  laser: { icon: Crosshair, label: '激光', glyph: 'text-rose-600 bg-rose-500/10 dark:text-rose-400', accent: 'bg-rose-400/70' },
  wb_open: { icon: Presentation, label: '画板', glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400', accent: 'bg-sky-400/70' },
  wb_draw_text: { icon: PenLine, label: '板书', glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400', accent: 'bg-sky-400/70' },
  wb_draw_shape: { icon: Shapes, label: '图形', glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400', accent: 'bg-sky-400/70' },
  wb_draw_latex: { icon: Sigma, label: '公式', glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400', accent: 'bg-sky-400/70' },
  wb_draw_table: { icon: Table2, label: '表格', glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400', accent: 'bg-sky-400/70' },
};

function metaFor(type: string): TypeMeta {
  return META[type] ?? { icon: Circle, label: type, glyph: 'text-muted-foreground bg-muted', accent: 'bg-muted-foreground/30' };
}

/**
 * Action types offered in the add palette — only the ones that stand alone.
 * Whiteboard cues (板书 etc.) are part of a larger open→draw→close workflow with
 * content/positioning, so they aren't added as bare items here (they still
 * render in the timeline when the agent generates them).
 */
const PALETTE: AddableType[] = ['speech', 'spotlight', 'laser'];
const PALETTE_LABEL: Record<AddableType, string> = {
  speech: '讲解',
  spotlight: '聚光',
  laser: '激光',
  wb_draw_text: '板书',
};

/** Cues that target a canvas element (so canvas pick mode applies). */
const ELEMENT_BOUND = new Set(['spotlight', 'laser', 'play_video']);

type DragPayload = { kind: 'new'; type: AddableType } | { kind: 'move'; from: number };

interface TooltipState {
  action: Action;
  anchor: DOMRect;
}

function propsOf(a: Action): Array<[string, string]> {
  const m = metaFor(a.type);
  const rows: Array<[string, string]> = [['动作', m.label]];
  const el = (a as { elementId?: string }).elementId;
  if (el) rows.push(['元素', el]);
  const content = (a as { content?: string }).content;
  if (content) rows.push(['内容', content.length > 48 ? `${content.slice(0, 48)}…` : content]);
  return rows;
}

function CueTooltip({ tip }: { tip: TooltipState }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: Math.max(8, tip.anchor.left + tip.anchor.width / 2),
        top: tip.anchor.top - 8,
        transform: 'translate(-50%, -100%)',
        maxWidth: 280,
        zIndex: 60,
      }}
      className="pointer-events-none rounded-lg border border-border/80 bg-popover px-2.5 py-1.5 text-popover-foreground shadow-lg shadow-black/5"
    >
      {propsOf(tip.action).map(([k, v]) => (
        <div key={k} className="flex gap-2 text-[11px] leading-relaxed">
          <span className="shrink-0 text-muted-foreground">{k}</span>
          <span className="font-mono [overflow-wrap:anywhere]">{v}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

function previewCue(type: string, elementId: string) {
  const cs = useCanvasStore.getState();
  cs.setSpotlight('');
  cs.clearLaser();
  if (!elementId) return;
  if (type === 'laser') cs.setLaser(elementId);
  else cs.setSpotlight(elementId);
}
function clearPreview() {
  const cs = useCanvasStore.getState();
  cs.setSpotlight('');
  cs.clearLaser();
}

/** Shared delete button — prominent, top-right of a card. */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      className="grid size-5 place-items-center rounded-md text-muted-foreground/55 transition-colors hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-500/15"
      aria-label="删除"
    >
      <Trash2 className="size-3.5" />
    </button>
  );
}

type TtsStatus = 'none' | 'ready' | 'generating' | 'error';

/** Audio status + 试听 / 重新生成 row, shown when managed TTS is on. */
function SpeechTtsBar({
  actionId,
  audioId,
  text,
  audioUrl,
  onGenerated,
}: {
  actionId: string;
  audioId?: string;
  text: string;
  audioUrl?: string;
  onGenerated: () => void;
}) {
  const [status, setStatus] = useState<TtsStatus>('none');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objUrlRef = useRef<string | null>(null);

  // The cached audio's real key is the action's own audioId (set at
  // generation); fall back to the derived id only when it's absent.
  const lookupId = audioId || speechAudioId(actionId);

  const stopPreview = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (objUrlRef.current) {
      URL.revokeObjectURL(objUrlRef.current);
      objUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (audioUrl) {
        if (alive) setStatus('ready');
        return;
      }
      const has = await audioExists(lookupId);
      if (alive) setStatus((s) => (s === 'generating' ? s : has ? 'ready' : 'none'));
    })();
    return () => {
      alive = false;
    };
  }, [lookupId, audioUrl]);

  useEffect(() => () => stopPreview(), [stopPreview]);

  const preview = async () => {
    stopPreview();
    let src = audioUrl ?? null;
    if (!src) {
      src = await audioObjectUrl(lookupId);
      objUrlRef.current = src;
    }
    if (!src) return;
    const a = new Audio(src);
    audioRef.current = a;
    a.addEventListener('ended', stopPreview);
    void a.play().catch(() => stopPreview());
  };

  const regenerate = async () => {
    setStatus('generating');
    try {
      const id = await generateSpeechAudio({ id: actionId, text });
      if (id) {
        onGenerated();
        setStatus('ready');
      } else {
        setStatus('none');
      }
    } catch {
      setStatus('error');
    }
  };

  const STATUS: Record<TtsStatus, { label: string; cls: string }> = {
    ready: { label: '已配音', cls: 'text-emerald-600 dark:text-emerald-400' },
    none: { label: '未配音', cls: 'text-muted-foreground/55' },
    generating: { label: '生成中', cls: 'text-violet-600 dark:text-violet-400' },
    error: { label: '失败', cls: 'text-rose-500' },
  };
  const s = STATUS[status];

  return (
    <div className="flex items-center gap-1 border-t border-gray-100 px-2 py-1 dark:border-gray-700/50">
      <Volume2 className="size-3 shrink-0 text-muted-foreground/40" />
      <span className={cn('text-[10px] font-medium', s.cls)}>{s.label}</span>
      <span className="ml-auto" />
      <button
        type="button"
        onClick={preview}
        disabled={status !== 'ready'}
        className="grid size-5 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label="试听"
        title="试听"
      >
        <Play className="size-3" />
      </button>
      <button
        type="button"
        onClick={regenerate}
        disabled={status === 'generating' || !text.trim()}
        className="grid size-5 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label="重新生成配音"
        title="重新生成配音"
      >
        <RefreshCw className={cn('size-3', status === 'generating' && 'animate-spin')} />
      </button>
    </div>
  );
}

/** One spoken line — a numbered, editable clip block. */
function SpeechClip({
  text,
  index,
  actionId,
  audioId,
  autoFocus,
  ttsActive,
  audioUrl,
  onCommit,
  onGenerated,
  onDelete,
  onDragStart,
  onDragEnd,
  onFocused,
}: {
  text: string;
  index: number;
  actionId: string;
  audioId?: string;
  autoFocus: boolean;
  ttsActive: boolean;
  audioUrl?: string;
  onCommit: (text: string) => void;
  onGenerated: () => void;
  onDelete: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onFocused: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [val, setVal] = useState(text);

  useEffect(() => {
    if (document.activeElement !== ref.current) setVal(text);
  }, [text]);

  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      onFocused();
    }
  }, [autoFocus, onFocused]);

  const commit = () => {
    if (val !== text) onCommit(val);
  };

  return (
    <div className="group/clip relative flex h-full w-[228px] shrink-0 flex-col overflow-hidden rounded-xl border border-gray-200/80 bg-white/70 shadow-sm transition-colors focus-within:border-violet-400 hover:border-violet-300/70 dark:border-gray-700/60 dark:bg-slate-800/50 dark:hover:border-violet-500/40">
      <span className="absolute inset-x-0 top-0 h-[3px] bg-primary/30 transition-colors group-hover/clip:bg-primary/60" />
      <div className="flex items-center gap-1.5 border-b border-gray-100 bg-gray-50/70 px-2 py-1 dark:border-gray-700/50 dark:bg-slate-900/40">
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="cursor-grab text-muted-foreground/40 transition-colors hover:text-muted-foreground active:cursor-grabbing"
          aria-label="拖动重排"
        >
          <GripVertical className="size-3.5" />
        </span>
        <span className="font-mono text-[10px] font-semibold tabular-nums text-muted-foreground/55">
          {String(index).padStart(2, '0')}
        </span>
        <Quote className="size-3 text-primary/45" />
        <span className="ml-auto mr-0.5 text-[8.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/40">讲解</span>
        <DeleteButton onDelete={onDelete} />
      </div>
      <textarea
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        placeholder="输入这一句讲解…"
        className="flex-1 resize-none bg-transparent px-3 py-2 text-[12.5px] leading-[1.7] text-foreground/85 outline-none placeholder:text-muted-foreground/40 [scrollbar-width:thin]"
      />
      {ttsActive && (
        <SpeechTtsBar actionId={actionId} audioId={audioId} text={val} audioUrl={audioUrl} onGenerated={onGenerated} />
      )}
    </div>
  );
}

/**
 * A non-speech cue — its own compact card on the timeline (the action's implicit
 * container, made explicit). Carries a delete button; clicking an element-bound
 * cue arms canvas pick mode so the target is chosen on the slide itself.
 */
function CueMarker({
  action,
  onTip,
  onDelete,
  onPick,
  onDragStart,
  onDragEnd,
}: {
  action: Action;
  onTip: (t: TooltipState | null) => void;
  onDelete: () => void;
  onPick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const m = metaFor(action.type);
  const Icon = m.icon;
  const preview = cuePreviewFor(action);
  const bound = ELEMENT_BOUND.has(action.type);
  const elementId = (action as { elementId?: string }).elementId ?? '';
  const needsTarget = bound && !elementId;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseEnter={(e) => {
        onTip({ action, anchor: e.currentTarget.getBoundingClientRect() });
        if (preview.kind === 'laser') previewCue('laser', preview.elementId);
        else if (preview.kind === 'spotlight') previewCue('spotlight', preview.elementId);
      }}
      onMouseLeave={() => {
        onTip(null);
        clearPreview();
      }}
      onClick={() => {
        if (bound) onPick();
      }}
      className={cn(
        'group/cue relative flex h-full w-[84px] shrink-0 flex-col overflow-hidden rounded-xl border bg-white/65 shadow-sm transition-colors dark:bg-slate-800/40',
        bound ? 'cursor-pointer hover:border-violet-300/70 dark:hover:border-violet-500/40' : 'cursor-grab active:cursor-grabbing',
        needsTarget ? 'border-dashed border-amber-400/70' : 'border-gray-200/80 dark:border-gray-700/60',
      )}
      aria-label={m.label}
    >
      <span className={cn('absolute inset-x-0 top-0 h-[3px]', m.accent)} />
      <div className="flex items-center gap-1 px-1.5 pt-1">
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClick={(e) => e.stopPropagation()}
          className="cursor-grab text-muted-foreground/35 transition-colors hover:text-muted-foreground active:cursor-grabbing"
          aria-label="拖动重排"
        >
          <GripVertical className="size-3.5" />
        </span>
        <span className="ml-auto">
          <DeleteButton onDelete={onDelete} />
        </span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-1 pb-1">
        <span className={cn('flex size-8 items-center justify-center rounded-full', m.glyph)}>
          <Icon className="size-4" />
        </span>
        <span className="text-[10px] font-medium text-foreground/70">{m.label}</span>
        {bound && (
          <span className={cn('text-[9px]', needsTarget ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground/45')}>
            {needsTarget ? '选元素' : '已绑定'}
          </span>
        )}
      </div>
    </div>
  );
}

/** Slim insertion slot between items; widens + glows while a drag hovers it. */
function DropZone({
  active,
  onEnter,
  onDrop,
  flex,
}: {
  active: boolean;
  onEnter: () => void;
  onDrop: () => void;
  flex?: boolean;
}) {
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        onEnter();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      className={cn('relative h-full shrink-0 transition-all', flex ? 'flex-1' : active ? 'w-10' : 'w-2.5')}
    >
      <span
        className={cn(
          'absolute inset-y-3 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors',
          active ? 'bg-violet-500' : 'bg-transparent',
        )}
      />
    </div>
  );
}

export function ActionsBar({ sceneId }: { sceneId: string }) {
  const scene = useStageStore((s) => s.scenes.find((x) => x.id === sceneId));
  const actions = scene?.actions ?? EMPTY;
  // Managed TTS on → speech clips show audio status + 试听 / 重新生成.
  const ttsActive = useSettingsStore((s) => s.ttsEnabled && s.ttsProviderId !== 'browser-native-tts');

  const [open, setOpen] = useState(true);
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const reduce = useReducedMotion();
  const dragRef = useRef<DragPayload | null>(null);

  const commit = useCallback(
    (next: Action[]) => useStageStore.getState().updateScene(sceneId, { actions: next }),
    [sceneId],
  );

  // Height drag-resize (top edge).
  const sectionRef = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(DEFAULT_H);
  const resizeRef = useRef<{ startY: number; startH: number; lastH: number; pointerId: number } | null>(null);
  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const startH = sectionRef.current?.getBoundingClientRect().height ?? height;
      resizeRef.current = { startY: e.clientY, startH, lastH: startH, pointerId: e.pointerId };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* best effort */
      }
      document.body.style.cursor = 'row-resize';
    },
    [height],
  );
  const onResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = resizeRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const next = Math.min(MAX_H, Math.max(MIN_H, d.startH + (d.startY - e.clientY)));
    d.lastH = next;
    if (sectionRef.current) sectionRef.current.style.height = `${next}px`;
  }, []);
  const onResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = resizeRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* may already be released */
    }
    setHeight(d.lastH);
    resizeRef.current = null;
    document.body.style.cursor = '';
  }, []);

  const handleDrop = useCallback(
    (slot: number) => {
      const p = dragRef.current;
      dragRef.current = null;
      setDragOver(null);
      if (!p) return;
      if (p.kind === 'new') {
        const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `a-${Date.now()}`;
        const action = makeAction(p.type, id);
        commit(insertAt(actions, slot, action));
        if (p.type === 'speech') setFocusId(id);
      } else {
        commit(move(actions, p.from, slot));
      }
    },
    [actions, commit],
  );

  const speechCount = actions.filter((a) => a.type === 'speech').length;
  const cueCount = actions.length - speechCount;

  let speechIndex = 0;
  const items = actions.map((action, index) => {
    if (action.type === 'speech') speechIndex += 1;
    return { action, index, key: (action.id ?? `a-${index}`) as string, speechIndex };
  });

  return (
    <section
      ref={sectionRef}
      style={open ? { height } : undefined}
      className="relative flex flex-col border-t border-gray-100 bg-white/80 backdrop-blur-xl dark:border-gray-800 dark:bg-slate-900/80"
    >
      {open && (
        <div
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          className="group absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize touch-none transition-colors hover:bg-violet-400/30 active:bg-violet-500/50 dark:hover:bg-violet-500/30"
        >
          <div className="absolute left-1/2 top-[3px] h-0.5 w-9 -translate-x-1/2 rounded-full bg-gray-300 transition-colors group-hover:bg-violet-400 dark:bg-gray-600 dark:group-hover:bg-violet-500" />
        </div>
      )}

      <div className="flex h-10 shrink-0 items-center gap-2.5 px-6">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-2.5">
          <span className="size-1.5 rounded-full bg-primary" />
          <span className="text-[12px] font-medium tracking-[0.18em] text-foreground/80">讲解脚本</span>
        </button>

        {open && (
          <div className="ml-3 flex items-center gap-1.5 border-l border-gray-200/70 pl-3 dark:border-gray-700/60">
            <span className="text-[10px] text-muted-foreground/45">拖入添加</span>
            {PALETTE.map((t) => {
              const Icon = t === 'speech' ? Quote : metaFor(t).icon;
              return (
                <span
                  key={t}
                  draggable
                  onDragStart={() => {
                    dragRef.current = { kind: 'new', type: t };
                  }}
                  onDragEnd={() => {
                    dragRef.current = null;
                    setDragOver(null);
                  }}
                  className="inline-flex cursor-grab items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground active:cursor-grabbing"
                >
                  <Icon className="size-3" />
                  {PALETTE_LABEL[t]}
                </span>
              );
            })}
          </div>
        )}

        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground/60">
          {speechCount} 讲解 · {cueCount} 动作
        </span>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-label={open ? '收起' : '展开'}>
          <ChevronDown
            className={cn('size-4 text-muted-foreground/60 transition-transform duration-200', open && 'rotate-180')}
          />
        </button>
      </div>

      {open && (
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
          <div className="relative flex h-full min-w-max items-stretch px-3.5 py-4">
            <DropZone
              active={dragOver === 0}
              flex={actions.length === 0}
              onEnter={() => setDragOver(0)}
              onDrop={() => handleDrop(0)}
            />
            {actions.length === 0 && (
              <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[12px] text-muted-foreground/60">
                把上方的动作拖到这里开始编排，或让 MAIC Agent 生成讲解。
              </span>
            )}
            {items.map(({ action, index, key, speechIndex: si }) => (
              <div key={key} className="relative flex h-full items-stretch">
                <motion.div
                  initial={reduce ? false : { opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.22, delay: reduce ? 0 : Math.min(index * 0.02, 0.24), ease: 'easeOut' }}
                  className="relative h-full"
                >
                  {action.type === 'speech' ? (
                    <SpeechClip
                      text={(action as { text?: string }).text ?? ''}
                      index={si}
                      actionId={key}
                      audioId={(action as { audioId?: string }).audioId}
                      ttsActive={ttsActive}
                      audioUrl={(action as { audioUrl?: string }).audioUrl}
                      autoFocus={key === focusId}
                      onFocused={() => setFocusId(null)}
                      onCommit={(text) => commit(setSpeechText(actions, index, text))}
                      onGenerated={() => commit(setAudioId(actions, index, speechAudioId(key)))}
                      onDelete={() => commit(removeAt(actions, index))}
                      onDragStart={() => {
                        dragRef.current = { kind: 'move', from: index };
                      }}
                      onDragEnd={() => {
                        dragRef.current = null;
                        setDragOver(null);
                      }}
                    />
                  ) : (
                    <CueMarker
                      action={action}
                      onTip={setTip}
                      onDelete={() => commit(removeAt(actions, index))}
                      onPick={() =>
                        useCanvasStore.getState().setPickTarget({ sceneId, actionIndex: index, cueType: action.type })
                      }
                      onDragStart={() => {
                        dragRef.current = { kind: 'move', from: index };
                      }}
                      onDragEnd={() => {
                        dragRef.current = null;
                        setDragOver(null);
                      }}
                    />
                  )}
                </motion.div>
                <DropZone
                  active={dragOver === index + 1}
                  onEnter={() => setDragOver(index + 1)}
                  onDrop={() => handleDrop(index + 1)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {tip && <CueTooltip tip={tip} />}
    </section>
  );
}
