'use client';

import type { PPTShapeElement, ShapeText } from '../../types/slides';
import { useElementOutline } from '../shared/useElementOutline';
import { useElementShadow } from '../shared/useElementShadow';
import { useElementFlip } from '../shared/useElementFlip';
import { useElementFill } from '../shared/useElementFill';
import { GradientDefs } from './GradientDefs';
import { PatternDefs } from './PatternDefs';

export interface BaseShapeElementProps {
  elementInfo: PPTShapeElement;
}

export function BaseShapeElement({ elementInfo }: BaseShapeElementProps) {
  const { fill } = useElementFill(elementInfo, 'base');
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(elementInfo.outline);
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { flipStyle } = useElementFlip(elementInfo.flipH, elementInfo.flipV);

  const text: ShapeText = elementInfo.text || {
    content: '',
    align: 'middle',
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#333333',
  };

  const justifyContent =
    text.align === 'top' ? 'flex-start' : text.align === 'bottom' ? 'flex-end' : 'center';

  return (
    <div
      className="base-element-shape"
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
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            opacity: elementInfo.opacity,
            filter: shadowStyle ? `drop-shadow(${shadowStyle})` : '',
            transform: flipStyle,
            color: text.defaultColor,
            fontFamily: text.defaultFontName,
          }}
        >
          <svg
            overflow="visible"
            width={elementInfo.width}
            height={elementInfo.height}
            style={{ transformOrigin: '0 0', overflow: 'visible', display: 'block' }}
          >
            <defs>
              {elementInfo.pattern && (
                <PatternDefs id={`base-pattern-${elementInfo.id}`} src={elementInfo.pattern} />
              )}
              {elementInfo.gradient && (
                <GradientDefs
                  id={`base-gradient-${elementInfo.id}`}
                  type={elementInfo.gradient.type}
                  colors={elementInfo.gradient.colors}
                  rotate={elementInfo.gradient.rotate}
                />
              )}
            </defs>
            <g
              transform={`scale(${elementInfo.width / elementInfo.viewBox[0]}, ${
                elementInfo.height / elementInfo.viewBox[1]
              }) translate(0,0) matrix(1,0,0,1,0,0)`}
            >
              <path
                vectorEffect="non-scaling-stroke"
                strokeLinecap="butt"
                strokeMiterlimit="8"
                d={elementInfo.path}
                fill={fill}
                stroke={outlineColor}
                strokeWidth={outlineWidth}
                strokeDasharray={strokeDashArray}
              />
            </g>
          </svg>

          <div
            className="shape-text"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent,
              overflowWrap: 'break-word',
              lineHeight: text.lineHeight,
              letterSpacing: `${text.wordSpace || 0}px`,
            }}
          >
            <div
              className="ProseMirror-static slide-renderer-prose"
              style={{
                // @ts-expect-error CSS custom properties
                '--paragraphSpace': `${text.paragraphSpace === undefined ? 5 : text.paragraphSpace}px`,
              }}
              dangerouslySetInnerHTML={{ __html: text.content }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
