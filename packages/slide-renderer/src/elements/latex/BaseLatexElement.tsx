'use client';

import { useRef, useState, useLayoutEffect } from 'react';
import type { PPTLatexElement } from '../../types/slides';

export interface BaseLatexElementProps {
  elementInfo: PPTLatexElement;
}

export function BaseLatexElement({ elementInfo }: BaseLatexElementProps) {
  return (
    <div
      className="base-element-latex"
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
          className="element-content"
          style={{ position: 'relative', width: '100%', height: '100%' }}
        >
          {elementInfo.html ? (
            <KatexContent
              html={elementInfo.html}
              width={elementInfo.width}
              height={elementInfo.height}
              align={elementInfo.align}
            />
          ) : elementInfo.path && elementInfo.viewBox ? (
            <svg
              overflow="visible"
              width={elementInfo.width}
              height={elementInfo.height}
              stroke={elementInfo.color}
              strokeWidth={elementInfo.strokeWidth}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transformOrigin: '0 0', overflow: 'visible' }}
            >
              <g
                transform={`scale(${elementInfo.width / elementInfo.viewBox[0]}, ${
                  elementInfo.height / elementInfo.viewBox[1]
                }) translate(0,0) matrix(1,0,0,1,0,0)`}
              >
                <path d={elementInfo.path} />
              </g>
            </svg>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const ALIGN_MAP = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
} as const;

function KatexContent({
  html,
  width,
  height,
  align = 'center',
}: {
  html: string;
  width: number;
  height: number;
  align?: 'left' | 'center' | 'right';
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    if (!innerRef.current) return;
    const naturalW = innerRef.current.scrollWidth;
    const naturalH = innerRef.current.scrollHeight;
    if (naturalW > 0 && naturalH > 0) {
      setScale(Math.min(width / naturalW, height / naturalH));
    }
  }, [html, width, height]);

  const justify = ALIGN_MAP[align];
  const origin =
    align === 'left' ? 'left center' : align === 'right' ? 'right center' : 'center center';

  return (
    <div
      style={{
        width,
        height,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: justify,
      }}
    >
      <div
        ref={innerRef}
        className="slide-renderer-prose"
        style={{
          transformOrigin: origin,
          transform: `scale(${scale})`,
          whiteSpace: 'nowrap',
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
