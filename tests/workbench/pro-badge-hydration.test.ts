// @vitest-environment jsdom
import { act, createElement } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const preferences = vi.hoisted(() => ({ reduced: null as boolean | null }));
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  // Server rendering cannot read the OS preference; the browser can.
  useReducedMotion: () => preferences.reduced,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
import { ProBadge } from '@/components/workbench/ProBadge';

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
  preferences.reduced = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Pro switch hydration with reduced motion', () => {
  it.each([false, true])('hydrates active=%s without an attribute mismatch', async (active) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const element = createElement(ProBadge, { active, onToggle: () => {} });
    preferences.reduced = null;
    const host = document.createElement('div');
    host.innerHTML = renderToString(element);
    document.body.appendChild(host);
    const serverTabIndex = host.querySelector('button')!.getAttribute('tabindex');
    preferences.reduced = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      root = hydrateRoot(host, element);
    });
    const hydrationErrors = errors.mock.calls.filter((args) =>
      /hydration|hydrated|didn.t match/i.test(args.join(' ')),
    );
    expect(hydrationErrors).toEqual([]);
    expect(serverTabIndex).toBe('0');
    expect(host.querySelector('button')!.tabIndex).toBe(0);
    expect(host.querySelector('button')!.getAttribute('aria-checked')).toBe(String(active));
  });
});
