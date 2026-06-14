'use client';

/**
 * ElementPickLayer — canvas-side target picker for the timeline.
 *
 * When the ActionsBar arms "pick" mode (useCanvasStore.pickTarget), this layer
 * covers the slide canvas (it's mounted inside SlideCanvas, not portaled, so it
 * lives in the canvas region) and lets the user bind a cue's target either way:
 * - every selectable element gets a faint outline so it reads as clickable; the
 *   one under the cursor gets a solid violet ring and a live spotlight/laser
 *   preview; click it to bind, or
 * - click a row in the floating element panel (draggable + collapsible).
 * Click empty canvas or press Esc to cancel.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, GripHorizontal, MousePointerClick } from 'lucide-react';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import { setElementId } from '@/components/edit/ActionsBar/actions-edit';

const PREFIX = 'editable-element-';
const PANEL_W = 232;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface ElementLite {
  id: string;
  type: string;
  content?: string;
}

const EL_TYPE_ZH: Record<string, string> = {
  text: '文本',
  image: '图片',
  shape: '形状',
  line: '线条',
  chart: '图表',
  table: '表格',
  latex: '公式',
  video: '视频',
  audio: '音频',
  code: '代码',
};

function elementLabel(el: ElementLite): string {
  const zh = EL_TYPE_ZH[el.type] ?? el.type;
  const raw = (el.content ?? '').replace(/<[^>]+>/g, '').trim();
  const snip = raw ? ` · ${raw.slice(0, 14)}${raw.length > 14 ? '…' : ''}` : '';
  return `${zh}${snip}`;
}

function elementHostAt(x: number, y: number): HTMLElement | null {
  for (const node of document.elementsFromPoint(x, y)) {
    const host = (node as HTMLElement).closest?.(`[id^="${PREFIX}"]`) as HTMLElement | null;
    if (host?.id?.startsWith(PREFIX)) return host;
  }
  return null;
}

export function ElementPickLayer() {
  const pickTarget = useCanvasStore.use.pickTarget();
  const rootRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ id: string; box: Box } | null>(null);
  const [outlines, setOutlines] = useState<Array<{ id: string; box: Box }>>([]);
  const [panel, setPanel] = useState<{ x: number; y: number }>({ x: 0, y: 16 });
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  const cueType = pickTarget?.cueType;

  const preview = useCallback(
    (elementId: string) => {
      const cs = useCanvasStore.getState();
      cs.setSpotlight('');
      cs.clearLaser();
      if (!elementId) return;
      if (cueType === 'laser') cs.setLaser(elementId);
      else cs.setSpotlight(elementId);
    },
    [cueType],
  );

  const finish = useCallback(() => {
    const cs = useCanvasStore.getState();
    cs.setSpotlight('');
    cs.clearLaser();
    cs.setPickTarget(null);
    setHover(null);
  }, []);

  const bind = useCallback(
    (elementId: string) => {
      if (!pickTarget) return;
      const { sceneId, actionIndex } = pickTarget;
      const scene = useStageStore.getState().scenes.find((s) => s.id === sceneId);
      const actions = scene?.actions ?? [];
      useStageStore.getState().updateScene(sceneId, { actions: setElementId(actions, actionIndex, elementId) });
      finish();
    },
    [pickTarget, finish],
  );

  // Local (canvas-relative) box for a viewport rect.
  const toLocal = useCallback((r: DOMRect): Box | null => {
    const cr = rootRef.current?.getBoundingClientRect();
    if (!cr) return null;
    return { left: r.left - cr.left, top: r.top - cr.top, width: r.width, height: r.height };
  }, []);

  const elements: ElementLite[] = pickTarget
    ? ((useStageStore.getState().scenes.find((s) => s.id === pickTarget.sceneId)?.content as
        | { canvas?: { elements?: ElementLite[] } }
        | undefined)?.canvas?.elements ?? [])
    : [];

  // On entering pick mode: outline every selectable element, dock panel top-right.
  useEffect(() => {
    if (!pickTarget) return;
    const cr = rootRef.current?.getBoundingClientRect();
    const boxes: Array<{ id: string; box: Box }> = [];
    for (const el of elements) {
      const host = document.getElementById(`${PREFIX}${el.id}`);
      if (!host) continue;
      const b = toLocal(host.getBoundingClientRect());
      if (b) boxes.push({ id: el.id, box: b });
    }
    setOutlines(boxes);
    if (cr) setPanel({ x: Math.max(8, cr.width - PANEL_W - 16), y: 16 });
    setCollapsed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickTarget?.sceneId, pickTarget?.actionIndex]);

  useEffect(() => {
    if (!pickTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickTarget, finish]);

  if (!pickTarget) return null;

  const current = (useStageStore.getState().scenes.find((s) => s.id === pickTarget.sceneId)?.actions?.[
    pickTarget.actionIndex
  ] as { elementId?: string } | undefined)?.elementId ?? '';
  const typeLabel = cueType === 'laser' ? '激光' : '聚光';

  const onCanvasMove = (e: React.MouseEvent) => {
    const host = elementHostAt(e.clientX, e.clientY);
    if (!host) {
      if (hover) {
        setHover(null);
        preview('');
      }
      return;
    }
    const id = host.id.slice(PREFIX.length);
    if (id !== hover?.id) {
      const box = toLocal(host.getBoundingClientRect());
      setHover(box ? { id, box } : null);
      preview(id);
    }
  };

  const onCanvasClick = () => {
    if (hover) bind(hover.id);
    else finish();
  };

  const highlightById = (id: string) => {
    const host = document.getElementById(`${PREFIX}${id}`);
    const box = host ? toLocal(host.getBoundingClientRect()) : null;
    setHover(box ? { id, box } : { id, box: { left: 0, top: 0, width: 0, height: 0 } });
    preview(id);
  };

  // Panel drag (header).
  const onPanelDown = (e: React.PointerEvent) => {
    dragRef.current = { px: e.clientX, py: e.clientY, ox: panel.x, oy: panel.y };
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* best effort */
    }
  };
  const onPanelMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const cr = rootRef.current?.getBoundingClientRect();
    const maxX = cr ? cr.width - PANEL_W - 8 : 9999;
    const maxY = cr ? cr.height - 40 : 9999;
    setPanel({
      x: Math.min(Math.max(8, d.ox + (e.clientX - d.px)), Math.max(8, maxX)),
      y: Math.min(Math.max(8, d.oy + (e.clientY - d.py)), Math.max(8, maxY)),
    });
  };
  const onPanelUp = () => {
    dragRef.current = null;
  };

  return (
    <div ref={rootRef} className="absolute inset-0 z-[120]">
      {/* click-catcher (sibling of the panel, so panel clicks never reach it) */}
      <div className="absolute inset-0 cursor-crosshair" onMouseMove={onCanvasMove} onClick={onCanvasClick} />

      {/* every selectable element gets a faint outline → "this is clickable" */}
      {outlines.map((o) => (
        <div
          key={o.id}
          className="pointer-events-none absolute rounded-[3px] ring-1 ring-violet-400/40 bg-violet-400/[0.04]"
          style={{ left: o.box.left, top: o.box.top, width: o.box.width, height: o.box.height }}
        />
      ))}

      {/* hovered element — solid ring */}
      {hover && hover.box.width > 0 && (
        <div
          className="pointer-events-none absolute rounded-md ring-2 ring-violet-500 bg-violet-500/[0.06]"
          style={{ left: hover.box.left - 2, top: hover.box.top - 2, width: hover.box.width + 4, height: hover.box.height + 4 }}
        />
      )}

      {/* instruction banner */}
      <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-violet-300/60 bg-popover/95 px-3.5 py-1.5 text-[12px] font-medium text-foreground shadow-lg shadow-black/10 backdrop-blur">
        <span className="text-violet-600 dark:text-violet-400">为「{typeLabel}」选择元素</span> · 点高亮元素或下方列表 · Esc 取消
      </div>

      {/* draggable + collapsible element panel, inside the canvas */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ left: panel.x, top: panel.y, width: PANEL_W }}
        className="absolute flex max-h-[70%] flex-col overflow-hidden rounded-2xl border border-border bg-popover/95 shadow-xl shadow-black/15 backdrop-blur"
      >
        <div
          onPointerDown={onPanelDown}
          onPointerMove={onPanelMove}
          onPointerUp={onPanelUp}
          onPointerCancel={onPanelUp}
          className="flex cursor-grab touch-none items-center gap-1.5 border-b border-border px-2.5 py-2 active:cursor-grabbing"
        >
          <GripHorizontal className="size-3.5 text-muted-foreground/40" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            页面元素 · {elements.length}
          </span>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="ml-auto grid size-5 place-items-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            aria-label={collapsed ? '展开' : '折叠'}
          >
            <ChevronDown className={`size-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
          </button>
        </div>

        {!collapsed && (
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {elements.length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-muted-foreground/70">这一页没有可定位的元素。</p>
            ) : (
              elements.map((el) => (
                <button
                  key={el.id}
                  type="button"
                  onMouseEnter={() => highlightById(el.id)}
                  onMouseLeave={() => {
                    setHover(null);
                    preview('');
                  }}
                  onClick={() => bind(el.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-muted ${
                    el.id === current ? 'bg-violet-50 ring-1 ring-violet-200 dark:bg-violet-500/10 dark:ring-violet-500/30' : ''
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-foreground/90">{elementLabel(el)}</span>
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground/45">{el.id.slice(0, 6)}</span>
                </button>
              ))
            )}
          </div>
        )}

        {collapsed && (
          <div className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] text-muted-foreground/50">
            <MousePointerClick className="size-3" /> 点画布上高亮的元素绑定
          </div>
        )}
      </div>
    </div>
  );
}
