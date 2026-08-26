import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Pro route swap', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('falls back to immediate navigation when View Transitions are unavailable', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost' },
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('document', { documentElement: {} });
    const push = vi.fn();
    const { isProSwapRunning, startProSwap } = await import('@/lib/workbench/pro-swap');

    startProSwap('/workspace', push);

    expect(push).toHaveBeenCalledWith('/workspace');
    expect(isProSwapRunning()).toBe(false);
  });

  it('holds the transition until the destination route reports its arrival', async () => {
    let finish: (() => void) | undefined;
    let routeUpdate: Promise<void> | undefined;
    const root = {
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost' },
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('document', {
      documentElement: root,
      startViewTransition: (callback: () => void | Promise<void>) => {
        routeUpdate = Promise.resolve(callback());
        return { finished, ready: Promise.resolve(), skipTransition: vi.fn() };
      },
    });
    const push = vi.fn();
    const { isProSwapRunning, proSwapArrived, startProSwap } =
      await import('@/lib/workbench/pro-swap');

    startProSwap('/workspace?session=example', push);
    expect(root.setAttribute).toHaveBeenCalledWith('data-pro-swap', 'enter');
    expect(push).toHaveBeenCalledWith('/workspace?session=example');
    expect(isProSwapRunning()).toBe(true);

    proSwapArrived('/workspace');
    await routeUpdate;
    finish?.();
    await finished;
    await Promise.resolve();

    expect(root.removeAttribute).toHaveBeenCalledWith('data-pro-swap');
    expect(isProSwapRunning()).toBe(false);
  });

  it('respects reduced-motion preference', async () => {
    const startViewTransition = vi.fn();
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost' },
      matchMedia: () => ({ matches: true }),
    });
    vi.stubGlobal('document', { documentElement: {}, startViewTransition });
    const push = vi.fn();
    const { startProSwap } = await import('@/lib/workbench/pro-swap');

    startProSwap('/workspace', push);

    expect(push).toHaveBeenCalledWith('/workspace');
    expect(startViewTransition).not.toHaveBeenCalled();
  });
});
