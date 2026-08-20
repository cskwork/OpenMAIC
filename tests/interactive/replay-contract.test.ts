import { describe, expect, it } from 'vitest';
import {
  analyzeReplayHtml,
  parseReplayContract,
  parseReplayTargets,
  REPLAY_CONTRACT_VERSION,
  ReplayContractParseError,
} from '@/lib/interactive/replay-contract';

describe('ReplayContract static parsing', () => {
  it('finds stable targets without treating script text as DOM', () => {
    const html = `
      <div id="board" data-testid="surface"></div>
      <button id="start-button">Start</button>
      <button id="1start">Special</button>
      <script>document.body.innerHTML = '<div id="fake-script-target"></div>'</script>
    `;
    expect(parseReplayTargets(html)).toEqual([
      '#board',
      '#start-button',
      '[data-testid="surface"]',
      '[id="1start"]',
    ]);
  });

  it('reports deterministic replay risks without guessing support', () => {
    const report = analyzeReplayHtml(`
      <a href="https://example.test">external</a>
      <canvas></canvas><video src="movie.mp4"></video>
      <input type="file"><script>setInterval(() => Math.random(), 20); window.open('/popup'); window.location = '/next'</script>
    `);
    expect(report.capabilities).toMatchObject({
      reset: 'supported',
      timers: 'risk',
      canvas: 'unsupported',
      media: 'risk',
      externalResources: 'risk',
      nondeterminism: 'risk',
      navigation: 'risk',
      popups: 'risk',
      fileOperations: 'risk',
    });
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'capability-timers',
        'capability-canvas',
        'capability-fileOperations',
      ]),
    );
  });

  it('scans executable handlers without treating prose as navigation', () => {
    const risky = analyzeReplayHtml(`
      <button onclick=history.back()>Back</button>
      <button onclick="(()=>globalThis['location'].href='/next')()">Next</button>
      <button onclick="navigation.navigate('/next')">Navigate</button>
    `);
    expect(risky.capabilities.navigation).toBe('risk');
    expect(
      analyzeReplayHtml('<p>Choose a location.</p><button>Start</button>').capabilities.navigation,
    ).toBe('not-detected');
  });

  it('rejects malformed, unsupported, and stale contracts', () => {
    expect(() => parseReplayContract(null)).toThrow(ReplayContractParseError);
    expect(() => parseReplayContract({ version: 99 })).toThrow(/Unsupported ReplayContract/);
    const contract = {
      version: REPLAY_CONTRACT_VERSION,
      sourceHtmlHash: 'a'.repeat(64),
      viewport: { width: 1280, height: 720 },
      initial: {
        signature: '0',
        targets: [],
        visible: [],
        hidden: [],
        offViewport: [],
        occluded: [],
      },
      targets: [],
      controls: [],
      transitions: [],
      capabilities: { reset: 'supported' },
      diagnostics: [],
      limits: { maxOperations: 1, maxDepth: 1, maxStates: 1, operationTimeoutMs: 100 },
    };
    expect(() => parseReplayContract(contract, 'b'.repeat(64))).toThrow(/source hash/);
    expect(parseReplayContract(contract).sourceHtmlHash).toBe('a'.repeat(64));
  });
});
