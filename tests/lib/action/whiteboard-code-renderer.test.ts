import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PPTCodeElement } from '@openmaic/dsl';
import { BaseCodeElement } from '@/components/slide-renderer/components/element/CodeElement/BaseCodeElement';

function renderCode(overrides: Partial<PPTCodeElement> = {}): string {
  const element: PPTCodeElement = {
    id: 'code-1',
    type: 'code',
    language: 'unknown-language',
    lines: [
      {
        id: 'L1',
        content: '<script>alert("x")</script> & value',
      },
    ],
    fileName: '<img src=x onerror=alert(1)>',
    showLineNumbers: true,
    fontSize: 14,
    left: 0,
    top: 0,
    width: 500,
    height: 300,
    rotate: 0,
    ...overrides,
  };
  return renderToStaticMarkup(
    React.createElement(BaseCodeElement, { elementInfo: element, animate: false }),
  );
}

describe('whiteboard code renderer', () => {
  it('renders unknown languages through the escaped plain-text fallback', () => {
    const html = renderCode();

    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('unknown-language');
  });

  it('preserves visible indentation and stable line-number order', () => {
    const html = renderCode({
      language: 'python',
      fileName: 'main.py',
      lines: [
        { id: 'L1', content: 'def f():' },
        { id: 'L2', content: '    return 1' },
      ],
    });

    expect(html).toContain('def f():');
    expect(html).toContain('    return 1');
    expect(html.indexOf('>1<')).toBeLessThan(html.indexOf('>2<'));
    expect(html).toContain('main.py');
    expect(html).toContain('Python');
  });
});
