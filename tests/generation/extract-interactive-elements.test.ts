import { describe, expect, test } from 'vitest';

import { extractInteractiveElements } from '@/lib/generation/scene-generator';

describe('extractInteractiveElements', () => {
  test('returns empty string on empty input', () => {
    expect(extractInteractiveElements('')).toBe('');
  });

  test('collects real element ids so widget actions can select from them', () => {
    const html = `
      <main id="game-root">
        <div id="score-val">0</div>
        <button id="reset-btn" aria-label="Reset the game">Reset</button>
        <div id="active-zone" class="pairing-rules dropzone" role="region">...</div>
        <input id="angle-slider" type="range" name="angle" />
      </main>
    `;
    const inventory = extractInteractiveElements(html);

    expect(inventory).toContain('Elements with id:');
    expect(inventory).toContain('#score-val');
    expect(inventory).toContain('#reset-btn');
    expect(inventory).toContain('aria-label="Reset the game"');
    expect(inventory).toContain('#active-zone');
    expect(inventory).toContain('role=region');
    expect(inventory).toContain('#angle-slider');
    expect(inventory).toContain('type=range');
    expect(inventory).toContain('name=angle');

    expect(inventory).toContain('Notable classes:');
    expect(inventory).toContain('.pairing-rules');
    expect(inventory).toContain('.dropzone');
  });

  test('captures procedural-skill data-step-id attributes', () => {
    const html = `
      <li data-step-id="step-1" id="step-1-row">
        <button id="step-1-control">Complete</button>
        <div id="step-1-feedback"></div>
      </li>
      <li data-step-id="step-2" id="step-2-row"></li>
    `;
    const inventory = extractInteractiveElements(html);

    expect(inventory).toContain('#step-1-row');
    expect(inventory).toContain('data-step-id="step-1"');
    expect(inventory).toContain('#step-1-control');
    expect(inventory).toContain('#step-2-row');
    expect(inventory).toContain('data-step-id="step-2"');
  });

  test('ignores contents of <script> and <style>', () => {
    const html = `
      <style>
        #should-not-appear { color: red; }
        .fake-class { color: blue; }
      </style>
      <script id="widget-config" type="application/json">
        { "id": "not-a-real-id" }
      </script>
      <div id="real-id" class="real-class"></div>
    `;
    const inventory = extractInteractiveElements(html);

    expect(inventory).toContain('#real-id');
    expect(inventory).toContain('.real-class');
    expect(inventory).not.toContain('#should-not-appear');
    expect(inventory).not.toContain('.fake-class');
    expect(inventory).not.toContain('not-a-real-id');
    // The <script id="widget-config"> tag itself lives inside the stripped
    // block, so the widget-config id should not leak into the inventory.
    expect(inventory).not.toContain('widget-config');
  });

  test('deduplicates repeated ids and classes', () => {
    const html = `
      <div id="dup" class="card"></div>
      <div id="dup" class="card"></div>
      <div class="card"></div>
    `;
    const inventory = extractInteractiveElements(html);

    const dupMatches = inventory.match(/#dup/g) || [];
    const cardMatches = inventory.match(/\.card\b/g) || [];
    expect(dupMatches.length).toBe(1);
    expect(cardMatches.length).toBe(1);
  });

  test('drops Tailwind/utility classes so semantic classes survive the cap', () => {
    const html = `
      <div id="game" class="flex items-center p-4 rounded-lg bg-white pairing-rules dna-card md:flex-row hover:bg-gray-100"></div>
      <button class="btn-launch p-2 text-white"></button>
    `;
    const inventory = extractInteractiveElements(html);

    // Semantic classes retained
    expect(inventory).toContain('.pairing-rules');
    expect(inventory).toContain('.dna-card');
    expect(inventory).toContain('.btn-launch');
    // Utility / responsive / hover classes dropped
    expect(inventory).not.toContain('.flex ');
    expect(inventory).not.toContain('.items-center');
    expect(inventory).not.toContain('.p-4');
    expect(inventory).not.toContain('.p-2');
    expect(inventory).not.toContain('.rounded-lg');
    expect(inventory).not.toContain('.bg-white');
    expect(inventory).not.toContain('.md:flex-row');
    expect(inventory).not.toContain('.hover:bg-gray-100');
    expect(inventory).not.toContain('.text-white');
  });

  test('captures attributes after a > inside a quoted attribute value', () => {
    const html = '<button id="go" aria-label="go >>" data-action="advance">Go</button>';
    const inventory = extractInteractiveElements(html);
    expect(inventory).toContain('#go');
    expect(inventory).toContain('aria-label="go >>"');
    expect(inventory).toContain('data-action="advance"');
  });

  test('captures unquoted attribute values', () => {
    const html = '<div id=main class=card></div><button id=go type=button>Go</button>';
    const inventory = extractInteractiveElements(html);
    expect(inventory).toContain('#main');
    expect(inventory).toContain('#go');
    expect(inventory).toContain('type=button');
    // Semantic class name preserved
    expect(inventory).toContain('.card');
  });
});
