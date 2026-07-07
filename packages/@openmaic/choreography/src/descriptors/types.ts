/**
 * Animation descriptor model — a declarative, render-backend-agnostic
 * description of an effect animation: *what property, from what value to what
 * value, over how long, with what easing*. No implementation, no `motion`, no
 * DOM. The app's effect components and the video exporter both interpret these,
 * so the animation values live in exactly one place.
 *
 * Descriptors are versioned (`spotlight.v1`) and schema-validated — the JSON
 * Schema is generated from these types at build time (see scripts/gen-schema.mjs)
 * and every shipped descriptor is checked against it in tests.
 *
 * Pure types, no runtime dependencies.
 */

/** A field of the target element's percentage geometry (0-100 space). */
export type GeometryRef = 'x' | 'y' | 'w' | 'h' | 'centerX' | 'centerY';

/**
 * A value derived linearly from the target element's geometry:
 * `value = geometry[ref] * scale + offset`. Used for effect positions that
 * track the highlighted element (e.g. a spotlight cutout inset by a few units).
 */
export interface GeometryValue {
  ref: GeometryRef;
  /** Multiplier on the geometry field. Default 1. */
  scale?: number;
  /** Added after scaling. Default 0. */
  offset?: number;
}

/**
 * A corner/edge fly-in start value: pick one of two off-screen positions based
 * on which half of the viewport the element center sits in. Models the laser's
 * `center > 50 ? 105 : -5` start rule.
 */
export interface CornerValue {
  /** Which center axis to test. */
  axis: 'centerX' | 'centerY';
  /** Comparison threshold (percent). */
  threshold: number;
  /** Value used when the center is strictly above the threshold. */
  whenAbove: number;
  /** Value used otherwise. */
  whenBelow: number;
}

/**
 * An animatable endpoint: a literal number, a literal string (colors; may carry
 * a `{param}` placeholder), or a geometry-/corner-derived value.
 */
export type AnimatableValue = number | string | GeometryValue | CornerValue;

/** Easing curve. Omit on a track to use the consumer's engine default. */
export type Easing =
  | { type: 'cubicBezier'; points: [number, number, number, number] }
  | { type: 'named'; name: string }
  | { type: 'spring'; stiffness: number; damping: number; mass?: number };

/** Which phase of the effect lifecycle a track belongs to. Default 'enter'. */
export type TrackPhase = 'enter' | 'exit';

/** A single animated property from `from` to `to` over `durationMs`. */
export interface Track {
  /** The property name (e.g. 'x', 'width', 'opacity', 'scale', 'left', 'top'). */
  property: string;
  from: AnimatableValue;
  to: AnimatableValue;
  durationMs: number;
  delayMs?: number;
  /** Omitted when the source specifies no explicit easing. */
  easing?: Easing;
  phase?: TrackPhase;
  /** Number of repeats, or 'infinite'. Omit for no repeat. */
  repeat?: number | 'infinite';
  repeatDelayMs?: number;
}

/**
 * A visual layer of the effect (e.g. the spotlight cutout, its border, the
 * laser ring). Groups animated `tracks` with non-animated `staticProps`; string
 * static values may contain `{param}` placeholders resolved from `params`.
 */
export interface Layer {
  id: string;
  tracks: Track[];
  staticProps?: Record<string, number | string>;
}

/** A versioned, declarative animation for one effect. */
export interface AnimationDescriptor {
  /** Stable id including version, e.g. 'spotlight.v1'. */
  id: string;
  /** Numeric version, bumped on any behavioral change. */
  version: number;
  effect: 'spotlight' | 'laser';
  /** Default parameter values; consumers may override (e.g. dimness, color). */
  params?: Record<string, number | string>;
  /** Stacking order the effect renders at. */
  zIndex: number;
  layers: Layer[];
}
