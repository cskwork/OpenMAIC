'use client';

import type { ReactNode } from 'react';
import type { PPTImageElement } from '../../types/slides';
import { useElementShadow } from '../shared/useElementShadow';
import { useElementFlip } from '../shared/useElementFlip';
import { useClipImage } from './useClipImage';
import { useFilter } from './useFilter';
import { ImageOutline } from './ImageOutline';

export interface BaseImageElementProps {
  elementInfo: PPTImageElement;
  /**
   * Optional render slot: replace the default <img> with custom content.
   * The slot receives `(element, resolvedSrc)` and is responsible for rendering
   * placeholders, retry UI, business-specific resolvers (e.g. AI media generation),
   * etc. The package itself does not interpret `src` beyond passing it through.
   */
  renderImage?: (element: PPTImageElement, resolvedSrc: string) => ReactNode;
}

export function BaseImageElement({ elementInfo, renderImage }: BaseImageElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { flipStyle } = useElementFlip(elementInfo.flipH, elementInfo.flipV);
  const { clipShape, imgPosition } = useClipImage(elementInfo);
  const { filter } = useFilter(elementInfo.filters);

  const src = elementInfo.src;

  return (
    <div
      className="element-content"
      style={{
        position: 'absolute',
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          transform: `rotate(${elementInfo.rotate}deg)`,
        }}
      >
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            filter: shadowStyle ? `drop-shadow(${shadowStyle})` : '',
            transform: flipStyle,
          }}
        >
          <ImageOutline elementInfo={elementInfo} />

          <div
            style={{
              position: 'relative',
              width: '100%',
              height: '100%',
              overflow: 'hidden',
              clipPath: clipShape.style,
            }}
          >
            {renderImage ? (
              renderImage(elementInfo, src)
            ) : src ? (
              <>
                <img
                  src={src}
                  draggable={false}
                  style={{
                    position: 'absolute',
                    top: imgPosition.top,
                    left: imgPosition.left,
                    width: imgPosition.width,
                    height: imgPosition.height,
                    maxWidth: 'none',
                    maxHeight: 'none',
                    filter,
                  }}
                  alt=""
                  onDragStart={(e) => e.preventDefault()}
                />
                {elementInfo.colorMask && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      backgroundColor: elementInfo.colorMask,
                    }}
                  />
                )}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
