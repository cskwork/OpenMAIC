# @openmaic/choreography

The MAIC **orchestration spec** — the single source of truth for the semantics a
faithful classroom-video exporter needs from playback, so the app runtime and
the exporter interpret the same spec instead of each re-implementing (and
silently drifting from) the other.

Pure TypeScript. Depends only on [`@openmaic/dsl`](../dsl); no React, DOM, GSAP,
framer-motion, or any render backend — the exporter runs in a pure Node
environment, verifiable on the dependency graph.

## Contents

- **Timing** (`timing.ts`) — playback timing constants (`EFFECT_AUTO_CLEAR_MS`,
  `DISCUSSION_TRIGGER_DELAY_MS`, the whiteboard/widget action durations, …) and
  the deterministic no-audio narration estimate `estimateSpeechDurationMs`.
- **Cursor** (`cursor.ts`) — `resolvePlaybackCursor`, the scene/action walk
  (with the empty-scene dwell beat).
- **Timeline** (`timeline.ts`) — `resolveActionTimeline`, the index-domain →
  time-domain expansion: blocking actions advance the cursor, fire-and-forget
  visual effects do not. Accepts an optional audio-duration resolver and falls
  back to the estimate.
- **Descriptors** (`descriptors/`) — versioned, declarative animation
  descriptors (`spotlight.v1`, `laser.v1`) describing *what property, from what
  value to what value, over how long, with what easing* — no implementation.
  Schema-validated against a build-time-generated JSON Schema.

## Scripts

```bash
pnpm build       # tsc + JSON Schema codegen → dist/
pnpm test        # vitest (standalone; resolves src, no build needed)
pnpm typecheck   # tsc --noEmit
```
