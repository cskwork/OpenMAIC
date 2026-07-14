import { describe, expect, it } from 'vitest';
import { buildVirtualWhiteboardContext } from '@/lib/orchestration/summarizers/whiteboard-ledger';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { WhiteboardActionRecord } from '@/lib/orchestration/types';

const storeState = {
  stage: null,
  scenes: [],
  currentSceneId: null,
  mode: 'autonomous',
  whiteboardOpen: true,
} as StatelessChatRequest['storeState'];

function record(
  actionName: WhiteboardActionRecord['actionName'],
  params: Record<string, unknown>,
): WhiteboardActionRecord {
  return {
    actionName,
    agentId: 'teacher-1',
    agentName: 'Teacher',
    params,
  };
}

describe('buildVirtualWhiteboardContext', () => {
  it('removes an element drawn earlier in the same ledger by its supplied id', () => {
    const context = buildVirtualWhiteboardContext(storeState, [
      record('wb_draw_text', {
        elementId: 'note-1',
        content: 'temporary note',
        x: 10,
        y: 20,
      }),
      record('wb_delete', { elementId: 'note-1' }),
    ]);

    expect(context).toBe('');
  });

  it('keeps other newly drawn elements when one supplied id is deleted', () => {
    const context = buildVirtualWhiteboardContext(storeState, [
      record('wb_draw_text', { elementId: 'note-1', content: 'remove me', x: 10, y: 20 }),
      record('wb_draw_code', {
        elementId: 'code-1',
        language: 'python',
        code: 'print("keep me")',
        x: 30,
        y: 40,
      }),
      record('wb_delete', { elementId: 'note-1' }),
    ]);

    expect(context).toContain('Current whiteboard elements (1)');
    expect(context).toContain('code block (python, 1 lines)');
    expect(context).not.toContain('remove me');
  });

  it('does not leave a phantom edit after its code element is deleted', () => {
    const context = buildVirtualWhiteboardContext(storeState, [
      record('wb_draw_code', {
        elementId: 'code-1',
        language: 'python',
        code: 'x = 1',
        x: 30,
        y: 40,
      }),
      record('wb_edit_code', {
        elementId: 'code-1',
        operation: 'replace_lines',
        lineIds: ['L1'],
        content: 'x = 2',
      }),
      record('wb_delete', { elementId: 'code-1' }),
    ]);

    expect(context).toBe('');
  });

  it('includes edits to a code element that existed before the current ledger', () => {
    const initialStoreState = {
      ...storeState,
      stage: {
        id: 'stage-1',
        name: 'Code lesson',
        whiteboard: [
          {
            id: 'whiteboard-1',
            elements: [
              {
                id: 'code-1',
                type: 'code',
                language: 'python',
                fileName: 'main.py',
                lines: [{ id: 'L1', content: 'x = 1' }],
              },
            ],
          },
        ],
      },
    } as StatelessChatRequest['storeState'];

    const context = buildVirtualWhiteboardContext(initialStoreState, [
      record('wb_edit_code', {
        elementId: 'code-1',
        operation: 'replace_lines',
        lineIds: ['L1'],
        content: 'x = 2',
      }),
    ]);

    expect(context).toContain('Current whiteboard elements (1)');
    expect(context).toContain('existing code block "main.py" (python, 1 lines)');
    expect(context).toContain('edited by Teacher (replace_lines)');
  });
});
