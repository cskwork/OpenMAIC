import type { CodeLine, PPTCodeElement } from '@openmaic/dsl';

export interface WhiteboardCodeElementInput {
  id: string;
  language: string;
  code: string;
  lineIds?: string[];
  x: number;
  y: number;
  width?: number;
  height?: number;
  fileName?: string;
}

export function createWhiteboardCodeLines(code: string, lineIds?: string[]): CodeLine[] {
  const lines = code.split('\n').map((content, index) => ({
    id: `L${index + 1}`,
    content,
  }));
  if (lineIds?.length === lines.length) {
    lines.forEach((line, index) => {
      line.id = lineIds[index];
    });
  }
  return lines;
}

export function createWhiteboardCodeElement(input: WhiteboardCodeElementInput): PPTCodeElement {
  return {
    id: input.id,
    type: 'code',
    language: input.language,
    lines: createWhiteboardCodeLines(input.code, input.lineIds),
    fileName: input.fileName,
    showLineNumbers: true,
    fontSize: 14,
    left: input.x,
    top: input.y,
    width: input.width ?? 500,
    height: input.height ?? 300,
    rotate: 0,
  };
}
