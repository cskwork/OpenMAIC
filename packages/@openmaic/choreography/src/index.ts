/**
 * @openmaic/choreography — the shared orchestration/spec package.
 *
 * The single source of truth for the semantics a faithful video exporter needs
 * from playback, so neither the app runtime nor the exporter re-implements (and
 * silently drifts from) the other:
 *
 * - **Timing** — playback timing constants + the deterministic no-audio speech
 *   estimate ({@link estimateSpeechDurationMs}).
 * - **Cursor** — {@link resolvePlaybackCursor}, the scene/action walk.
 * - **Timeline** — {@link resolveActionTimeline}, the index→time expansion.
 * - **Descriptors** — versioned, declarative animation descriptors
 *   ({@link DESCRIPTORS}, e.g. `spotlight.v1`).
 *
 * Dependency arrow (kept acyclic): @openmaic/choreography -> @openmaic/dsl.
 * This package must never gain a runtime dependency on React, DOM, GSAP,
 * framer-motion, or any render backend — the exporter runs in pure Node.
 */
export * from './timing.js';
export * from './cursor.js';
export * from './timeline.js';
export * from './descriptors/index.js';
