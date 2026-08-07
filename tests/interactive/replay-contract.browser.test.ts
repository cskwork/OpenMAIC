import { describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { buildReplayInspectorDocument } from '@/lib/interactive/replay-contract';

const REQUIRED = process.env.REPLAY_CONTRACT_BROWSER === '1';

interface BrowserTarget {
  selector: string;
  visibility: string;
}

interface BrowserSnapshot {
  targets: BrowserTarget[];
  visible: string[];
  hidden: string[];
}

interface ReadyMessage {
  snapshot: BrowserSnapshot;
}

interface OperationMessage {
  result: { ok: boolean };
  after: BrowserSnapshot;
}

describe.skipIf(!REQUIRED)('ReplayContract browser inspector', () => {
  let browser: Browser;

  it('records occlusion and an observed start-to-running transition', async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--disable-crash-reporter', '--disable-crashpad'],
    });
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    try {
      await page.goto('about:blank');
      const documentHtml = buildReplayInspectorDocument(
        `<!doctype html><style>
        body{margin:0}.overlay{position:fixed;inset:0;background:#111;color:white;z-index:2}
        #board{position:absolute;left:30px;top:100px;width:200px;height:120px;background:green}
        #score{position:absolute;left:30px;top:20px}
      </style><div id="board">board</div><div id="score">score</div>
        <div id="start-overlay" class="overlay"><button id="start-button">Start</button></div>
        <script>document.getElementById('start-button').onclick=()=>{document.getElementById('start-overlay').style.display='none'}</script>`,
        {
          operationTimeoutMs: 1_200,
          settleMs: 10,
        },
      );
      const result = await page.evaluate(async (srcdoc) => {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.style.cssText = 'position:fixed;left:-10000px;width:800px;height:500px';
        document.body.appendChild(iframe);
        const wait = <T>(kind: string) =>
          new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout')), 1_200);
            const listener = (event: MessageEvent) => {
              if (event.source !== iframe.contentWindow || event.data?.kind !== kind) return;
              clearTimeout(timer);
              window.removeEventListener('message', listener);
              resolve(event.data as T);
            };
            window.addEventListener('message', listener);
          });
        const readyPromise = wait<ReadyMessage>('__openmaicReplay-ready');
        iframe.srcdoc = srcdoc;
        const ready = await readyPromise;
        const operationPromise = wait<OperationMessage>('__openmaicReplay-operation-result');
        iframe.contentWindow?.postMessage(
          {
            kind: '__openmaicReplay-operation',
            id: '1',
            operation: { kind: 'click', selector: '#start-button' },
          },
          '*',
        );
        const operation = await operationPromise;
        iframe.remove();
        return { ready, operation };
      }, documentHtml);
      expect(
        result.ready.snapshot.targets.find((target) => target.selector === '#start-overlay')
          ?.visibility,
      ).toBe('visible');
      expect(
        result.ready.snapshot.targets.find((target) => target.selector === '#start-button')
          ?.visibility,
      ).toBe('visible');
      expect(
        result.ready.snapshot.targets.find((target) => target.selector === '#board')?.visibility,
      ).toBe('occluded');
      expect(
        result.ready.snapshot.targets.find((target) => target.selector === '#score')?.visibility,
      ).toBe('occluded');
      expect(result.operation.result).toEqual({ ok: true });
      expect(result.operation.after.hidden).toContain('#start-overlay');
      expect(result.operation.after.visible).toContain('#board');
    } finally {
      await page.close();
      await browser.close();
    }
  });
});
