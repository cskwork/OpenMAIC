/**
 * Animation descriptor registry — the versioned, declarative animations both
 * the app effect components and the video exporter interpret.
 */
import type { AnimationDescriptor } from './types.js';
import { spotlightV1 } from './spotlight.js';
import { laserV1 } from './laser.js';

export * from './types.js';
export { spotlightV1 } from './spotlight.js';
export { laserV1 } from './laser.js';

/** All shipped descriptors, keyed by their versioned id. */
export const DESCRIPTORS: Record<string, AnimationDescriptor> = {
  'spotlight.v1': spotlightV1,
  'laser.v1': laserV1,
};

/** Look up a descriptor by its versioned id (e.g. 'spotlight.v1'). */
export function getDescriptor(id: string): AnimationDescriptor | undefined {
  return DESCRIPTORS[id];
}
