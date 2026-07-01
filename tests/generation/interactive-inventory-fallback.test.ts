/**
 * Regression: when a scene's persisted `elementInventory` is missing (legacy
 * scenes generated before the field existed, or scenes handed to
 * `generateSceneActions` from a caller that omits it), the interactive-actions
 * prompt should still receive real selectors — extracted on the fly from
 * `content.html` — rather than the "(no interactive elements detected)"
 * sentinel that would send the model back to convention-guessing.
 */
import { describe, expect, it } from 'vitest';

import { generateSceneActions } from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type {
  GeneratedInteractiveContent,
  SceneOutline,
} from '@/lib/types/generation';

function baseOutline(): SceneOutline {
  return {
    id: 'scene-inventory-fallback',
    type: 'interactive',
    title: 'Inventory fallback test',
    description: 'legacy scene without persisted inventory',
    keyPoints: ['key point'],
    order: 0,
    widgetType: 'game',
    widgetOutline: { gameType: 'puzzle' },
  };
}

describe('generateSceneActions — legacy inventory fallback', () => {
  it('extracts inventory from content.html when the persisted field is absent', async () => {
    let lastUser = '';
    const aiCall: AICallFn = async (_system, user) => {
      lastUser = user;
      return '[]';
    };

    const content: GeneratedInteractiveContent = {
      html:
        '<div id="game-container">' +
        '  <button id="check-btn">Check</button>' +
        '  <div id="active-zone" class="dropzone"></div>' +
        '  <span id="score-val">0</span>' +
        '</div>',
      widgetType: 'game',
      widgetConfig: {
        type: 'game',
        gameType: 'puzzle',
        description: 'd',
        scoring: { correctPoints: 10, speedBonus: 5 },
      },
      // Deliberately no elementInventory — simulates a scene stored before
      // fix-widget-html-inventory, or one whose caller forgot to persist it.
    };

    await generateSceneActions(baseOutline(), content, aiCall, {
      languageDirective: 'Teach in English.',
    });

    // Prompt should carry the real selectors, not the fallback sentinel.
    expect(lastUser).toContain('#game-container');
    expect(lastUser).toContain('#check-btn');
    expect(lastUser).toContain('#active-zone');
    expect(lastUser).toContain('#score-val');
    expect(lastUser).not.toContain('(no interactive elements detected)');
  });

  it('shows the sentinel only when there is no html at all', async () => {
    let lastUser = '';
    const aiCall: AICallFn = async (_system, user) => {
      lastUser = user;
      return '[]';
    };

    const content: GeneratedInteractiveContent = {
      html: '',
      widgetType: 'game',
      widgetConfig: {
        type: 'game',
        gameType: 'puzzle',
        description: 'd',
        scoring: { correctPoints: 10, speedBonus: 5 },
      },
    };

    await generateSceneActions(baseOutline(), content, aiCall, {
      languageDirective: 'Teach in English.',
    });

    expect(lastUser).toContain('(no interactive elements detected)');
  });
});
