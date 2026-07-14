import type { StatelessChatRequest } from '@/lib/types/chat';
import type { WhiteboardActionRecord } from '../types';

interface VirtualWhiteboardElement {
  agentName: string;
  summary: string;
  elementId?: string;
  codeLines?: Array<{ id: string; content: string }>;
  codeLanguage?: string;
  codeFileName?: string;
}

function getRecordElementId(record: WhiteboardActionRecord): string | undefined {
  const elementId = record.params.elementId;
  return typeof elementId === 'string' && elementId ? elementId : undefined;
}

function summarizeCodeElement(element: VirtualWhiteboardElement): string {
  const lines = element.codeLines ?? [];
  const fileName = element.codeFileName ? ` "${element.codeFileName}"` : '';
  const preview = lines
    .slice(0, 3)
    .map((line) => `${line.id}: ${line.content}`)
    .join(' | ');
  return `code block${fileName} (${element.codeLanguage || 'text'}, ${lines.length} lines)${preview ? `: ${preview}` : ''}`;
}

function getInitialWhiteboardElements(
  storeState: StatelessChatRequest['storeState'],
): VirtualWhiteboardElement[] {
  const whiteboards = storeState.stage?.whiteboard;
  const latestWhiteboard = Array.isArray(whiteboards) ? whiteboards.at(-1) : null;
  const source = latestWhiteboard?.elements;
  if (!Array.isArray(source)) return [];

  return source.flatMap((element) => {
    if (!element || typeof element !== 'object') return [];
    const candidate = element as {
      id?: unknown;
      type?: unknown;
      language?: unknown;
      fileName?: unknown;
      lines?: unknown;
    };
    if (typeof candidate.id !== 'string' || !candidate.id) return [];
    if (candidate.type !== 'code') {
      return [
        {
          agentName: 'Before this round',
          elementId: candidate.id,
          summary: `existing ${String(candidate.type || 'element')} [id:${candidate.id}]`,
        },
      ];
    }

    const virtual: VirtualWhiteboardElement = {
      agentName: 'Before this round',
      elementId: candidate.id,
      summary: '',
      codeLines: Array.isArray(candidate.lines)
        ? candidate.lines.flatMap((line) => {
            if (!line || typeof line !== 'object') return [];
            const value = line as { id?: unknown; content?: unknown };
            return typeof value.id === 'string'
              ? [{ id: value.id, content: String(value.content ?? '') }]
              : [];
          })
        : [],
      codeLanguage: typeof candidate.language === 'string' ? candidate.language : 'text',
      codeFileName: typeof candidate.fileName === 'string' ? candidate.fileName : undefined,
    };
    virtual.summary = summarizeCodeElement(virtual);
    return [virtual];
  });
}

function applyCodeEdit(target: VirtualWhiteboardElement, record: WhiteboardActionRecord): void {
  if (!target.codeLines) return;
  const operation = record.params.operation;
  const contentLines = String(record.params.content ?? '').split('\n');
  const targetIds = Array.isArray(record.params.lineIds) ? record.params.lineIds.map(String) : [];
  const newLineIds = Array.isArray(record.params.newLineIds)
    ? record.params.newLineIds.map(String)
    : [];

  if (operation === 'insert_after' || operation === 'insert_before') {
    const lineId = String(record.params.lineId || '');
    const index = target.codeLines.findIndex((line) => line.id === lineId);
    if (index >= 0) {
      target.codeLines.splice(
        operation === 'insert_after' ? index + 1 : index,
        0,
        ...contentLines.map((content, offset) => ({
          id: newLineIds[offset] ?? `${lineId}-${operation}-${offset + 1}`,
          content,
        })),
      );
    }
  } else if (operation === 'delete_lines') {
    const deleteIds = new Set(targetIds);
    target.codeLines = target.codeLines.filter((line) => !deleteIds.has(line.id));
  } else if (operation === 'replace_lines') {
    const firstIndex = target.codeLines.findIndex((line) => line.id === targetIds[0]);
    if (firstIndex >= 0) {
      const replaceIds = new Set(targetIds);
      target.codeLines = target.codeLines.filter((line) => !replaceIds.has(line.id));
      target.codeLines.splice(
        firstIndex,
        0,
        ...contentLines.map((content, index) => ({
          id: newLineIds[index] ?? targetIds[index] ?? `${targetIds[0]}-replacement-${index + 1}`,
          content,
        })),
      );
    }
  }

  target.agentName = record.agentName;
  target.summary = `${summarizeCodeElement(target)}; edited (${String(operation || 'edit')})`;
}

/** Replay this round's ledger on top of the request-start whiteboard snapshot. */
export function buildVirtualWhiteboardContext(
  storeState: StatelessChatRequest['storeState'],
  ledger?: WhiteboardActionRecord[],
): string {
  if (!ledger || ledger.length === 0) return '';

  const elements = getInitialWhiteboardElements(storeState);
  let hasContentMutation = false;

  for (const record of ledger) {
    const elementId = getRecordElementId(record);
    switch (record.actionName) {
      case 'wb_clear':
        hasContentMutation = true;
        elements.length = 0;
        break;
      case 'wb_delete':
        hasContentMutation = true;
        for (let index = elements.length - 1; index >= 0; index -= 1) {
          if (elements[index].elementId === elementId) elements.splice(index, 1);
        }
        break;
      case 'wb_draw_text': {
        hasContentMutation = true;
        const content = String(record.params.content || '').slice(0, 40);
        elements.push({
          agentName: record.agentName,
          elementId,
          summary: `text: "${content}${content.length >= 40 ? '...' : ''}" at (${record.params.x ?? '?'},${record.params.y ?? '?'}), size ~${record.params.width ?? 400}x${record.params.height ?? 100}`,
        });
        break;
      }
      case 'wb_draw_shape':
        hasContentMutation = true;
        elements.push({
          agentName: record.agentName,
          elementId,
          summary: `shape(${record.params.type || record.params.shape || 'rectangle'}) at (${record.params.x ?? '?'},${record.params.y ?? '?'}), size ${record.params.width ?? 100}x${record.params.height ?? 100}`,
        });
        break;
      case 'wb_draw_chart': {
        hasContentMutation = true;
        const labels = Array.isArray(record.params.labels)
          ? record.params.labels
          : (record.params.data as Record<string, unknown>)?.labels;
        elements.push({
          agentName: record.agentName,
          elementId,
          summary: `chart(${record.params.chartType || record.params.type || 'bar'})${labels ? `: labels=[${(labels as string[]).slice(0, 4).join(',')}]` : ''} at (${record.params.x ?? '?'},${record.params.y ?? '?'}), size ${record.params.width ?? 350}x${record.params.height ?? 250}`,
        });
        break;
      }
      case 'wb_draw_latex': {
        hasContentMutation = true;
        const latex = String(record.params.latex || '').slice(0, 40);
        elements.push({
          agentName: record.agentName,
          elementId,
          summary: `latex: "${latex}${latex.length >= 40 ? '...' : ''}" at (${record.params.x ?? '?'},${record.params.y ?? '?'}), size ~${record.params.width ?? 400}x${record.params.height ?? 80}`,
        });
        break;
      }
      case 'wb_draw_table': {
        hasContentMutation = true;
        const data = record.params.data as unknown[][] | undefined;
        const rows = data?.length || 0;
        const cols = data?.[0]?.length || 0;
        elements.push({
          agentName: record.agentName,
          elementId,
          summary: `table(${rows}×${cols}) at (${record.params.x ?? '?'},${record.params.y ?? '?'}), size ${record.params.width ?? 400}x${record.params.height ?? rows * 40 + 20}`,
        });
        break;
      }
      case 'wb_draw_line':
        hasContentMutation = true;
        elements.push({
          agentName: record.agentName,
          elementId,
          summary: `line${(record.params.points as string[] | undefined)?.includes('arrow') ? ' (arrow)' : ''}: (${record.params.startX ?? '?'},${record.params.startY ?? '?'}) → (${record.params.endX ?? '?'},${record.params.endY ?? '?'})`,
        });
        break;
      case 'wb_draw_code': {
        hasContentMutation = true;
        const code = String(record.params.code || '');
        const suppliedIds = Array.isArray(record.params.lineIds)
          ? record.params.lineIds.map(String)
          : [];
        const virtual: VirtualWhiteboardElement = {
          agentName: record.agentName,
          elementId,
          summary: '',
          codeLines: code
            .split('\n')
            .map((content, index) => ({ id: suppliedIds[index] ?? `L${index + 1}`, content })),
          codeLanguage: String(record.params.language || 'text'),
          codeFileName: record.params.fileName ? String(record.params.fileName) : undefined,
        };
        virtual.summary = `${summarizeCodeElement(virtual)} at (${record.params.x ?? '?'},${record.params.y ?? '?'}), size ${record.params.width ?? 500}x${record.params.height ?? 300}`;
        elements.push(virtual);
        break;
      }
      case 'wb_edit_code': {
        hasContentMutation = true;
        const target = elements.find((element) => element.elementId === elementId);
        if (target) applyCodeEdit(target, record);
        break;
      }
      default:
        break;
    }
  }

  if (!hasContentMutation) return '';
  if (elements.length === 0) {
    return `
## Whiteboard Changes This Round (IMPORTANT)
The whiteboard is now empty after changes made during this discussion round.
`;
  }

  const elementLines = elements
    .map((element, index) => `  ${index + 1}. [by ${element.agentName}] ${element.summary}`)
    .join('\n');
  return `
## Whiteboard Changes This Round (IMPORTANT)
Other agents have modified the whiteboard during this discussion round.
Current whiteboard elements (${elements.length}):
${elementLines}

DO NOT redraw content that already exists. Check positions above before adding new elements.
`;
}
