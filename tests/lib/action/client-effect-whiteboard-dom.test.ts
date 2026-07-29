// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  escapeNativeWhiteboardText,
  visibleTextFromNativeWhiteboardHtml,
} from '@/lib/action/client-effect-whiteboard';
import { normalizeVisibleTextV1 } from '@/lib/agent/runtime/client-effect-contract';

function nativeTextHtml(value: string): string {
  return `<p style="font-size: 18px;">${escapeNativeWhiteboardText(value)}</p>`;
}

function visibleTextWithNodeFallback(html: string): string {
  vi.stubGlobal('DOMParser', undefined);
  try {
    return visibleTextFromNativeWhiteboardHtml(html);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('native whiteboard visible-text extraction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    'k < 0 & b > 0',
    `quotes: ' / "`,
    'literal &lt; stays encoded once',
    'line one\r\nline two',
    'NBSP:\u00a0value',
  ])('keeps browser DOMParser and Node fallback equivalent for %j', (value) => {
    const html = nativeTextHtml(value);
    const browserResult = visibleTextFromNativeWhiteboardHtml(html);
    const fallbackResult = visibleTextWithNodeFallback(html);

    expect(normalizeVisibleTextV1(browserResult)).toBe(normalizeVisibleTextV1(value));
    expect(normalizeVisibleTextV1(fallbackResult)).toBe(normalizeVisibleTextV1(browserResult));
  });

  it('fails closed for non-canonical multi-node HTML in the Node verifier', () => {
    const tampered = '<p style="font-size: 18px;">one</p><p>two</p>';
    expect(() => visibleTextFromNativeWhiteboardHtml(tampered)).toThrow(
      'CLIENT_EFFECT_TEXT_HTML_INVALID',
    );
    expect(() => visibleTextWithNodeFallback(tampered)).toThrow('CLIENT_EFFECT_TEXT_HTML_INVALID');
  });
});
