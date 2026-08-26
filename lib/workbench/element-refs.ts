/**
 * Element references — the slide elements a user hands the agent alongside a
 * message (e.g. "these elements — make the title shorter").
 *
 * The wire shape is deliberately self-describing. `elementId` is the handle the
 * agent's edit tools address, but an id alone is worthless in a transcript and
 * dangling the moment the element is deleted, so every ref also carries the
 * human `label` the chip shows and a `snapshotText` fallback the server can
 * match against when the id no longer resolves.
 *
 * NOTE (chat slice): this file is the thin local stand-in the chat surface
 * compiles against — the TYPE surface and the identity helper the composer
 * needs. The sibling data-layer slice owns the full reference module (the
 * decoders, the localized labels, the picker helpers) and supersedes this copy.
 */

export interface SlideElementRef {
  kind: 'slide-element';
  stageId: string;
  sceneId: string;
  elementId: string;
  /** DSL element type: text | image | shape | line | chart | table | latex | video | audio | code */
  elementType: string;
  /** Human label for the chip (localized type + a short content snippet). */
  label: string;
  /** Visible text of the element, capped — the fallback when `elementId` dangles. */
  snapshotText?: string;
}

export interface InteractiveElementRef {
  kind: 'interactive-element';
  stageId: string;
  sceneId: string;
  /** Best-effort identity in the live iframe DOM. */
  selector: string;
  /** Bounded DOM anchor captured at pick time. */
  outerHTML: string;
  /** Visible text captured at pick time; empty is valid. */
  text: string;
  /** Human label for the chip. */
  label: string;
}

export type ElementRef = SlideElementRef | InteractiveElementRef;

/**
 * How many elements one message may carry.
 */
export const MAX_ELEMENT_REFS = 10;

/** Snapshot cap. Long enough to identify a paragraph, short enough to stay a hint. */
export const ELEMENT_SNAPSHOT_MAX = 200;
export const ELEMENT_REF_ID_MAX = 64;
export const ELEMENT_REF_LABEL_MAX = 120;
export const ELEMENT_REF_SELECTOR_MAX = 512;
export const INTERACTIVE_OUTERHTML_MAX = 2048;

/** The stable identity of a ref — what dedupe and "already referenced" key on. */
export function elementRefIdentity(ref: ElementRef): string {
  return ref.kind === 'slide-element'
    ? `slide:${ref.stageId}:${ref.sceneId}:${ref.elementId}`
    : `interactive:${ref.stageId}:${ref.sceneId}:${ref.selector}`;
}
