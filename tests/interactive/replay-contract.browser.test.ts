import { readFile } from 'node:fs/promises';
import { chromium, type Browser } from '@playwright/test';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REQUIRED = process.env.REPLAY_CONTRACT_BROWSER === '1';

interface BrowserContract {
  initial: {
    targets: Array<{
      selector: string;
      visibility: string;
      checked?: boolean | 'mixed';
      value?: string;
    }>;
  };
  controls: Array<{ selector: string; safe: boolean; reason?: string }>;
  transitions: Array<{
    depth: number;
    operation: { kind: string; selector: string };
    postconditions: { changed: boolean };
    before: {
      targets: Array<{ selector: string; checked?: boolean | 'mixed'; value?: string }>;
    };
    after: {
      targets: Array<{ selector: string; checked?: boolean | 'mixed'; value?: string }>;
    };
  }>;
  diagnostics: Array<{ code: string }>;
}

describe.skipIf(!REQUIRED)('ReplayContract browser inspector', () => {
  let browser: Browser;

  it(
    'is deterministic and explores only reachable, state-specific controls',
    { timeout: 20_000 },
    async () => {
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: ['--disable-crash-reporter', '--disable-crashpad'],
      });
      const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
      try {
        const inspectorSource = await readFile(
          new URL('../../lib/interactive/replay-contract.ts', import.meta.url),
          'utf8',
        );
        const inspectorModule = ts.transpileModule(inspectorSource, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        await page.route('http://localhost/replay-contract-test', (route) =>
          route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }),
        );
        await page.goto('http://localhost/replay-contract-test');
        await page.addScriptTag({
          type: 'module',
          content: `${inspectorModule}\nglobalThis.__inspectReplayContract = inspectReplayContract;`,
        });
        await page.waitForFunction(() => '__inspectReplayContract' in globalThis);

        const html = `<!doctype html><style>
        body{margin:0}.overlay{position:fixed;inset:0;background:#111;color:white;z-index:2}
        #board{position:absolute;left:30px;top:100px;width:200px;height:120px;background:green}
        #score{position:absolute;left:30px;top:20px}
        #password,#phone{position:fixed;right:20px;width:120px}
        #password{top:20px}#phone{top:60px}
      </style>
        <div id="board">board<button id="covered-action">Covered</button></div>
        <div id="score">score</div>
        <input id="password" type="password" maxlength="8">
        <input id="phone" type="tel" maxlength="8">
        <input id="file-role" type="file" role="switch">
        <a id="external-link" href="https://example.test">External</a>
        <div id="start-overlay" class="overlay"><button id="start-button">Start</button></div>
        <div id="status">idle</div>
        <script>document.getElementById('start-button').onclick=()=>{
          document.getElementById('start-overlay').style.display='none';
          const next=document.createElement('button');
          next.id='next-button';next.textContent='Next';
          next.style.cssText='position:fixed;right:20px;bottom:20px';
          next.onclick=()=>{document.getElementById('status').textContent='done'};
          document.body.appendChild(next);
        }</script>`;
        const contracts = await page.evaluate(async (sourceHtml) => {
          const inspect = (
            globalThis as typeof globalThis & {
              __inspectReplayContract: (
                html: string,
                options: Record<string, number>,
              ) => Promise<BrowserContract>;
            }
          ).__inspectReplayContract;
          const options = {
            maxOperations: 12,
            maxDepth: 2,
            maxStates: 8,
            operationTimeoutMs: 300,
            settleMs: 10,
          };
          const first = await inspect(sourceHtml, options);
          const second = await inspect(sourceHtml, options);
          const toggle = await inspect('<input id="toggle" type="checkbox">', {
            ...options,
            maxDepth: 1,
            maxOperations: 1,
          });
          const specialId = await inspect(
            '<button id="1start" onclick="this.textContent=\'done\'">Start</button>',
            { ...options, maxDepth: 1, maxOperations: 1 },
          );
          const navigation = await inspect(
            '<button id="navigate" onclick="location.href=\'https://example.test\'">Go</button>',
            options,
          );
          const bracketNavigation = await inspect(
            '<button id="navigate" onclick="(()=>self[\'location\'].href=\'https://example.test\')()">Go</button>',
            options,
          );
          const unquotedNavigation = await inspect(
            '<button id="back" onclick=history.back()>Back</button>',
            options,
          );
          const prose = await inspect(
            '<p>Choose a location.</p><button id="start" onclick="this.textContent=\'done\'">Start</button>',
            { ...options, maxDepth: 1, maxOperations: 1 },
          );
          const mixed = await inspect(
            '<input id="mixed" type="checkbox"><script>document.getElementById(\'mixed\').indeterminate=true</script>',
            { ...options, maxDepth: 0, maxOperations: 0 },
          );
          return {
            first,
            second,
            toggle,
            specialId,
            navigation,
            bracketNavigation,
            unquotedNavigation,
            prose,
            mixed,
          };
        }, html);

        const {
          first,
          second,
          toggle,
          specialId,
          navigation,
          bracketNavigation,
          unquotedNavigation,
          prose,
          mixed,
        } = contracts;
        expect(first).toEqual(second);
        expect(
          first.initial.targets.find((target) => target.selector === '#start-overlay')?.visibility,
        ).toBe('visible');
        expect(
          first.initial.targets.find((target) => target.selector === '#start-button')?.visibility,
        ).toBe('visible');
        expect(
          first.initial.targets.find((target) => target.selector === '#board')?.visibility,
        ).toBe('occluded');
        expect(
          first.initial.targets.find((target) => target.selector === '#score')?.visibility,
        ).toBe('occluded');
        expect(
          first.controls.find((control) => control.selector === '#covered-action'),
        ).toMatchObject({
          safe: false,
          reason: 'target-occluded',
        });
        for (const selector of ['#password', '#phone', '#file-role']) {
          expect(first.controls.find((control) => control.selector === selector)).toMatchObject({
            safe: false,
            reason: 'unsafe-input-type',
          });
          expect(first.transitions.some((item) => item.operation.selector === selector)).toBe(
            false,
          );
        }
        expect(first.transitions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              depth: 1,
              operation: { kind: 'click', selector: '#start-button' },
            }),
            expect.objectContaining({
              depth: 2,
              operation: { kind: 'click', selector: '#next-button' },
            }),
          ]),
        );
        expect(
          first.transitions.some(
            (item) => item.depth === 1 && item.operation.selector === '#covered-action',
          ),
        ).toBe(false);
        expect(toggle.transitions[0]).toMatchObject({
          operation: { kind: 'toggle', selector: '#toggle' },
          postconditions: { changed: true },
          before: {
            targets: expect.arrayContaining([expect.objectContaining({ checked: false })]),
          },
          after: { targets: expect.arrayContaining([expect.objectContaining({ checked: true })]) },
        });
        expect(specialId.controls[0]?.selector).toBe('[id="1start"]');
        expect(specialId.transitions[0]?.operation.selector).toBe('[id="1start"]');
        expect(navigation.transitions).toEqual([]);
        expect(navigation.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'exploration-skipped-uncontainable-side-effect' }),
          ]),
        );
        expect(bracketNavigation.transitions).toEqual([]);
        expect(bracketNavigation.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'exploration-skipped-uncontainable-side-effect' }),
          ]),
        );
        expect(unquotedNavigation.transitions).toEqual([]);
        expect(unquotedNavigation.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'exploration-skipped-uncontainable-side-effect' }),
          ]),
        );
        expect(prose.transitions[0]?.operation.selector).toBe('#start');
        expect(mixed.initial.targets).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ selector: '#mixed', checked: 'mixed' }),
          ]),
        );
        expect(mixed.diagnostics).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 'ambiguous-control-state' })]),
        );
      } finally {
        await page.close();
        await browser.close();
      }
    },
  );
});
