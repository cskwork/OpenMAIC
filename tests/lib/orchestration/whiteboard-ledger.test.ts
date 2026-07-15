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

    expect(context).toContain('whiteboard is now empty');
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

    expect(context).toContain('whiteboard is now empty');
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
    // Element id and line id are now exposed so a later agent can target them.
    expect(context).toContain('(id: code-1)');
    expect(context).toContain('code block "main.py" (python, 1 lines)');
    expect(context).toContain('L1: x = 2');
    expect(context).toContain('edited (replace_lines)');
  });

  it('reports initial elements removed by delete or clear as absent', () => {
    const initialStoreState = {
      ...storeState,
      stage: {
        id: 'stage-1',
        name: 'Whiteboard lesson',
        whiteboard: [
          {
            id: 'whiteboard-1',
            elements: [{ id: 'note-1', type: 'text', content: '<p>old note</p>' }],
          },
        ],
      },
    } as StatelessChatRequest['storeState'];

    expect(
      buildVirtualWhiteboardContext(initialStoreState, [
        record('wb_delete', { elementId: 'note-1' }),
      ]),
    ).toContain('whiteboard is now empty');
    expect(buildVirtualWhiteboardContext(initialStoreState, [record('wb_clear', {})])).toContain(
      'whiteboard is now empty',
    );
  });

  it('exposes element ids and all code line ids so later agents can target them', () => {
    const context = buildVirtualWhiteboardContext(storeState, [
      record('wb_draw_text', { elementId: 'note-1', content: 'a label', x: 0, y: 0 }),
      record('wb_draw_code', {
        elementId: 'code-9',
        language: 'python',
        code: 'a = 1\nb = 2\nc = 3',
        lineIds: ['L1', 'L2', 'L3'],
        x: 10,
        y: 20,
      }),
    ]);

    // Every element's id is visible for wb_delete targeting.
    expect(context).toContain('(id: note-1)');
    expect(context).toContain('(id: code-9)');
    // All code line ids are visible for wb_edit_code targeting — not just a
    // 3-line preview cut off mid-block.
    expect(context).toContain('L1: a = 1');
    expect(context).toContain('L2: b = 2');
    expect(context).toContain('L3: c = 3');
  });

  it('bounds a very long code block to a deterministic prompt size', () => {
    const lineCount = 5000;
    const code = Array.from({ length: lineCount }, (_, i) => `line_${i + 1} = ${i + 1}`).join('\n');
    const lineIds = Array.from({ length: lineCount }, (_, i) => `L${i + 1}`);

    const context = buildVirtualWhiteboardContext(storeState, [
      record('wb_draw_code', {
        elementId: 'big-code',
        language: 'python',
        code,
        lineIds,
        x: 0,
        y: 0,
      }),
    ]);

    // The tail is reported as an omitted count, not dumped line-by-line.
    expect(context).toContain('more line(s) omitted');
    // A late line's content is NOT rendered — proving the content cap held.
    expect(context).not.toContain('line_5000 = 5000');
    // Deterministic upper bound regardless of the 5000-line source: the whole
    // context stays within the two shared char budgets plus small overhead.
    expect(context.length).toBeLessThan(2500);
  });

  it('bounds the context even when line ids themselves are very long', () => {
    // No schema cap on id length — a pathological block of long ids must still
    // not blow up the prompt (id-list tier is a char budget, not a count).
    const lineCount = 500;
    const longId = (i: number) => `line-identifier-${'x'.repeat(200)}-${i}`;
    const code = Array.from({ length: lineCount }, (_, i) => `v${i} = ${i}`).join('\n');
    const lineIds = Array.from({ length: lineCount }, (_, i) => longId(i));

    const context = buildVirtualWhiteboardContext(storeState, [
      record('wb_draw_code', {
        elementId: 'huge-ids',
        language: 'text',
        code,
        lineIds,
        x: 0,
        y: 0,
      }),
    ]);

    expect(context).toContain('more line(s) omitted');
    expect(context.length).toBeLessThan(2500);
  });

  it('shares the code-line budget across multiple code blocks', () => {
    // A first block large enough to exhaust the shared content budget must
    // leave the second block unable to render all of its content — proving the
    // budget is shared, not per-block.
    const bigCode = Array.from({ length: 400 }, (_, i) => `a_${i} = ${i}`).join('\n');
    const bigIds = Array.from({ length: 400 }, (_, i) => `A${i}`);

    const context = buildVirtualWhiteboardContext(storeState, [
      record('wb_draw_code', {
        elementId: 'block-1',
        language: 'text',
        code: bigCode,
        lineIds: bigIds,
        x: 0,
        y: 0,
      }),
      record('wb_draw_code', {
        elementId: 'block-2',
        language: 'text',
        code: 'later_line = 999',
        lineIds: ['Z1'],
        x: 10,
        y: 10,
      }),
    ]);

    // Both blocks are still announced (ids visible for targeting)...
    expect(context).toContain('(id: block-1)');
    expect(context).toContain('(id: block-2)');
    // ...but the shared budget is already spent by block-1, so block-2's content
    // line is not rendered in full.
    expect(context).not.toContain('later_line = 999');
    expect(context.length).toBeLessThan(2500);
  });
});
