'use client';

import type { ReactNode } from 'react';
import type { PPTVideoElement } from '../../types/slides';

export interface BaseVideoElementProps {
  elementInfo: PPTVideoElement;
  /**
   * Optional render slot: replace the default <video> with custom content.
   * Lets consumers inject placeholders, retry UI, lazy media resolvers, or
   * controlled playback bound to their own orchestration state.
   * When omitted, the package renders a plain <video src controls preload="metadata">.
   */
  renderVideo?: (element: PPTVideoElement) => ReactNode;
}

export function BaseVideoElement({ elementInfo, renderVideo }: BaseVideoElementProps) {
  return (
    <div
      className="element-content absolute"
      data-video-element
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        {renderVideo ? (
          renderVideo(elementInfo)
        ) : elementInfo.src ? (
          <video
            className="w-full h-full"
            style={{ objectFit: 'contain' }}
            src={elementInfo.src}
            poster={elementInfo.poster}
            preload="metadata"
            controls
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-black/10 rounded">
            <svg
              className="w-12 h-12 text-gray-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
