'use client';

import type { CSSProperties } from 'react';
import type { PPTTextElement } from '../../types/slides';
import { useElementShadow } from '../shared/useElementShadow';
import { ElementOutline } from '../shared/ElementOutline';

export interface BaseTextElementProps {
  elementInfo: PPTTextElement;
  target?: string;
}

export function BaseTextElement({ elementInfo, target }: BaseTextElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);

  return (
    <div
      className="base-element-text"
      style={{
        position: 'absolute',
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper"
        style={{
          width: '100%',
          height: '100%',
          transform: `rotate(${elementInfo.rotate}deg)`,
        }}
      >
        <div
          className="element-content slide-renderer-prose"
          style={{
            position: 'relative',
            width: elementInfo.vertical ? 'auto' : `${elementInfo.width}px`,
            height: elementInfo.vertical ? `${elementInfo.height}px` : 'auto',
            backgroundColor: elementInfo.fill,
            opacity: elementInfo.opacity,
            textShadow: shadowStyle,
            lineHeight: elementInfo.lineHeight,
            letterSpacing: elementInfo.wordSpace !== undefined ? `${elementInfo.wordSpace}px` : undefined,
            color: elementInfo.defaultColor,
            fontFamily: elementInfo.defaultFontName,
            writingMode: elementInfo.vertical ? 'vertical-rl' : 'horizontal-tb',
            ...(elementInfo.paragraphSpace !== undefined
              ? ({ '--paragraphSpace': `${elementInfo.paragraphSpace}px` } as CSSProperties)
              : null),
          }}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />
          <div
            className="text ProseMirror-static"
            style={{
              position: 'relative',
              pointerEvents: target === 'thumbnail' ? 'none' : undefined,
            }}
            dangerouslySetInnerHTML={{ __html: elementInfo.content }}
          />
        </div>
      </div>
    </div>
  );
}
