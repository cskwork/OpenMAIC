'use client';

import { Play } from 'lucide-react';
import type { Slide, PPTVideoElement } from '@/lib/types/slides';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import { SlideCanvas } from '@maic/renderer';

interface SlideThumbnailProps {
  /** Slide data */
  readonly slide: Slide;
  /**
   * Thumbnail width in px. When omitted, the thumbnail fills its parent
   * (`w-full h-full`) — use auto-size in any container that already constrains
   * width via CSS (e.g. `aspect-video w-full`).
   */
  readonly size?: number;
  /** Viewport width base (default 1000px). Kept for call-site API parity with
   * the legacy `ThumbnailSlide`; the actual fit is driven by `slide.viewportSize`. */
  readonly viewportSize?: number;
  /** Viewport aspect ratio (default 0.5625 i.e. 16:9). Used to size the explicit box. */
  readonly viewportRatio: number;
  /** Whether visible (for lazy loading optimization) */
  readonly visible?: boolean;
}

/**
 * Read-only thumbnail rendering for a video element. Replaces `@maic/renderer`'s
 * default `<video controls>` with a muted, play-badged treatment suited to
 * thumbnails. `BaseVideoElement` already supplies the absolutely-positioned,
 * rotated wrapper, so this only paints the inner content.
 *
 * The play-badge (`thumbnail-video-indicator`) always shows; the `<video>` only
 * renders for a real (non-placeholder) src so failed/placeholder media falls
 * through to the badge-only frame instead of an empty `<video>`.
 */
function renderThumbnailVideo(element: PPTVideoElement) {
  const src = element.src && !isMediaPlaceholder(element.src) ? element.src : undefined;
  return (
    <>
      {src ? (
        <video
          className="w-full h-full"
          style={{ objectFit: 'contain' }}
          src={src}
          poster={element.poster}
          preload="metadata"
          muted
          playsInline
        />
      ) : (
        <div className="w-full h-full bg-black/10 rounded" />
      )}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        data-testid="thumbnail-video-indicator"
      >
        <div className="flex size-28 items-center justify-center rounded-full bg-black/45 shadow-lg ring-2 ring-white/85">
          <Play className="ml-1 size-14 fill-white text-white" />
        </div>
      </div>
    </>
  );
}

/**
 * Read-only slide thumbnail rendered via the extracted `@maic/renderer`
 * package (`SlideCanvas`) instead of the in-app `ThumbnailSlide`/element
 * renderers. `SlideCanvas` fills its parent and auto-fits the slide, so this
 * wrapper only owns the outer box sizing (explicit `size` vs parent-filling),
 * the lazy-load placeholder, and the thumbnail video treatment (via the
 * renderer's `renderVideo` slot).
 *
 * Scope note: this covers all read-only slide-thumbnail surfaces — the playback
 * scene sidebar, the home-page recent-course cards, and the editor nav rail
 * (which renders through `SceneThumbnailContent`). The full-size editing canvas
 * is intentionally untouched (`@maic/renderer` v1 is read-only; editing is v2).
 */
export function SlideThumbnail({
  slide,
  size,
  viewportRatio,
  visible = true,
}: SlideThumbnailProps) {
  const autoSize = size === undefined;

  const containerClass = autoSize
    ? 'thumbnail-slide relative bg-white overflow-hidden select-none pointer-events-none w-full h-full'
    : 'thumbnail-slide relative bg-white overflow-hidden select-none pointer-events-none';
  const containerStyle: React.CSSProperties | undefined = autoSize
    ? undefined
    : { width: `${size}px`, height: `${size * viewportRatio}px` };

  if (!visible) {
    return (
      <div className={containerClass} style={containerStyle}>
        <div className="placeholder w-full h-full flex justify-center items-center text-gray-400 text-sm">
          加载中 ...
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass} style={containerStyle}>
      <SlideCanvas slide={slide} chrome={false} renderVideo={renderThumbnailVideo} />
    </div>
  );
}
