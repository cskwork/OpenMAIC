'use client';

/**
 * Off-screen Slide → PNG renderer.
 *
 * Mounts the given `Slide` into an off-screen container at its native pixel
 * size, waits for fonts + images to settle, then snapshots the DOM via
 * `html2canvas-pro`. Returns the rendered output as a Blob (default) or a
 * `data:image/png;base64,...` string.
 *
 * Why html2canvas-pro and not html-to-image: the latter uses an SVG
 * `<foreignObject>` + Image decode path. Fonts inside the foreignObject
 * load asynchronously and the snapshot fires before woff2 decode finishes,
 * so text is laid out in the fallback font (visible as different word-wrap
 * positions vs the on-screen canvas). html2canvas-pro walks the DOM and
 * draws to a canvas directly, inheriting the parent document's font
 * registry, so text wraps identically.
 *
 * Use cases: visual regression baselines (compare with the source PPT's
 * own PNG export), user-triggered "export slide as image", CI snapshot
 * jobs. Caller does not need a live `<SlideCanvas>` mounted in the UI.
 */

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import html2canvas from 'html2canvas-pro';
import { SlideCanvas } from '../SlideCanvas';
import type { Slide } from '../types/slides';

export interface SlideToPngOptions {
  /**
   * Output pixel width. Defaults to the slide's native `viewportSize`
   * (e.g. 1280 for a 16:9 widescreen deck). Height is derived from
   * `viewportRatio`.
   */
  width?: number;
  /**
   * Multiplier on output resolution. Default tracks `window.devicePixelRatio`
   * (typically 2 on retina displays) so the exported PNG is as sharp as
   * the on-screen canvas. Pass 1 for a lighter file at the cost of
   * sub-pixel clarity.
   */
  pixelRatio?: number;
  /**
   * Background color filled behind the slide. Defaults to white. Pass
   * 'transparent' to keep the slide's own background only.
   */
  backgroundColor?: string;
  /**
   * Output format. 'blob' yields a `Blob` suitable for `URL.createObjectURL`
   * + download; 'dataUrl' yields a `data:image/png;base64,...` string.
   */
  format?: 'blob' | 'dataUrl';
  /**
   * Settle timeout in milliseconds. The snapshot waits for `document.fonts.ready`
   * and every `<img>` inside the container to load (or error) before
   * capturing — but won't wait longer than this. Defaults to 5000.
   */
  timeoutMs?: number;
  /**
   * Debug only — render the off-screen container on-screen for the given
   * number of milliseconds after snapshot so you can visually confirm what
   * was captured. Do not use in production.
   */
  debugVisibleMs?: number;
}

const DEFAULT_VIEWPORT_RATIO = 0.5625;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Render a `Slide` to a PNG image.
 *
 * Throws if called outside a browser (no `document` / `window`), if React
 * fails to mount, or if html2canvas-pro hits a CORS-tainted canvas (cross-
 * origin `<img>` without permissive headers will block the snapshot).
 */
export async function slideToPng(
  slide: Slide,
  options: SlideToPngOptions = {},
): Promise<Blob | string> {
  if (typeof document === 'undefined') {
    throw new Error('slideToPng requires a browser environment');
  }

  const width = options.width ?? slide.viewportSize ?? 1280;
  const viewportRatio = slide.viewportRatio ?? DEFAULT_VIEWPORT_RATIO;
  const height = Math.round(width * viewportRatio);
  const backgroundColor = options.backgroundColor ?? '#ffffff';
  const pixelRatio = options.pixelRatio ?? window.devicePixelRatio ?? 1;
  const format = options.format ?? 'blob';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const debugVisibleMs = options.debugVisibleMs ?? 0;

  // Off-screen container sized exactly to the slide so SlideCanvas's
  // fit-to-container math collapses to a 1:1 native render (no scale, no
  // centering offset). `position: absolute` (not fixed) + far-left offset
  // keeps the element in layout but out of the viewport; some browsers
  // skip paint for `position: fixed` elements outside the viewport, which
  // breaks the snapshot.
  const container = document.createElement('div');
  container.style.cssText = [
    'position: absolute',
    'left: -99999px',
    'top: 0',
    `width: ${width}px`,
    `height: ${height}px`,
    'pointer-events: none',
    `background-color: ${backgroundColor}`,
  ].join('; ');
  document.body.appendChild(container);

  let root: Root | null = null;
  try {
    root = createRoot(container);
    // flushSync forces the initial commit to happen synchronously instead of
    // being deferred by React 18's scheduler. Without it, the next RAFs can
    // fire before the first render lands and the snapshot captures an empty
    // container.
    flushSync(() => {
      root!.render(createElement(SlideCanvas, { slide }));
    });

    // Give the SlideCanvas's ResizeObserver-driven `useViewportSize` a few
    // frames to fire and write `fitScale`. Default state already paints at
    // 1:1, but waiting avoids a flash of unscaled content when the slide
    // viewportSize differs from the container.
    await nextFrame();
    await nextFrame();

    await Promise.race([
      Promise.all([
        document.fonts ? document.fonts.ready : Promise.resolve(),
        ...Array.from(container.querySelectorAll('img')).map((img) => {
          if (img.complete && img.naturalWidth > 0) return Promise.resolve();
          return new Promise<void>((resolve) => {
            const done = () => resolve();
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          });
        }),
      ]),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.debug('[slideToPng] container ready', {
        innerHTMLLength: container.innerHTML.length,
        imgCount: container.querySelectorAll('img').length,
        size: `${width}x${height}`,
      });
    }

    // Target the inner SlideCanvas root so html2canvas-pro's bounding-box
    // calculation matches the slide exactly (otherwise the outer container's
    // padding/margin assumptions can leave white edges).
    const target =
      (container.firstElementChild as HTMLElement | null) ?? container;

    const canvas = await html2canvas(target, {
      backgroundColor,
      width,
      height,
      scale: pixelRatio,
      useCORS: true,
      // Skip walking the page's stylesheets; the cloned DOM already inherits
      // computed styles. This also avoids CORS errors when the document has
      // cross-origin stylesheets.
      foreignObjectRendering: false,
      logging: false,
      // html2canvas-pro's CJK text measurement can mis-position full-width
      // punctuation (e.g. `（`/`）` get pushed past the cell boundary and
      // appear clipped). Force neutral kerning + feature settings on the
      // cloned tree so each glyph advances at its natural width.
      onclone: (clonedDoc) => {
        const style = clonedDoc.createElement('style');
        style.textContent = `
          .slide-renderer-cell-text,
          .slide-renderer-cell-text *,
          .slide-renderer-prose,
          .slide-renderer-prose * {
            font-kerning: none !important;
            font-feature-settings: normal !important;
            font-variant-east-asian: normal !important;
            text-rendering: geometricPrecision !important;
          }
        `;
        clonedDoc.head.appendChild(style);
      },
    });

    if (format === 'blob') {
      return await canvasToBlob(canvas);
    }
    return canvas.toDataURL('image/png');
  } finally {
    if (debugVisibleMs > 0) {
      // Temporarily show the container on-screen so the caller can compare
      // what was captured vs the on-page render.
      container.style.left = '0';
      container.style.top = '0';
      container.style.zIndex = '99999';
      container.style.border = '4px dashed magenta';
      await new Promise((r) => setTimeout(r, debugVisibleMs));
    }
    // Defer unmount one tick so React doesn't warn about unmounting during
    // a commit phase (the html2canvas promise can still be mid-render in
    // dev mode).
    if (root) {
      const r = root;
      setTimeout(() => r.unmount(), 0);
    }
    setTimeout(() => container.remove(), 0);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('slideToPng: canvas.toBlob returned null'));
    }, 'image/png');
  });
}
