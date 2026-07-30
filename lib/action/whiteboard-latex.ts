import katex from 'katex';
import type { PPTLatexElement } from '@openmaic/dsl';
import type { WbDrawLatexAction } from '@/lib/types/action';

export type WhiteboardLatexElementInput = Pick<
  WbDrawLatexAction,
  'latex' | 'x' | 'y' | 'width' | 'height' | 'color'
> & {
  id: string;
  html: string;
};

export function renderLegacyWhiteboardLatexHtml(latex: string): string {
  return katex.renderToString(latex, {
    throwOnError: false,
    displayMode: true,
    output: 'html',
  });
}

export function renderNativeWhiteboardLatexHtmlV1(latex: string): string {
  try {
    return katex.renderToString(latex, {
      throwOnError: true,
      strict: 'error',
      trust: false,
      displayMode: true,
      output: 'html',
    });
  } catch (error) {
    throw new Error('CLIENT_EFFECT_LATEX_RENDER_INVALID', { cause: error });
  }
}

export function createWhiteboardLatexElement(input: WhiteboardLatexElementInput): PPTLatexElement {
  return {
    id: input.id,
    type: 'latex',
    left: input.x,
    top: input.y,
    width: input.width ?? 400,
    height: input.height ?? 80,
    rotate: 0,
    latex: input.latex,
    html: input.html,
    color: input.color ?? '#000000',
    fixedRatio: true,
  };
}
