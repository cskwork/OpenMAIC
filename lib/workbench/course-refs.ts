/**
 * Course references — the classrooms a user names for the agent alongside a
 * message (e.g. "@course-name, swap the example on page 3").
 *
 * The wire shape is the sibling of `ElementRef` (`lib/workbench/element-refs`)
 * with the element identity removed: same strict decoder in the same two modes,
 * same cap-and-dedupe discipline, same "the id is the handle, the human label is
 * a snapshot" split.
 *
 * NOTE (chat slice): ported as-is so the chat surface and its tests can run;
 * the sibling data-layer slice owns this module and supersedes this copy.
 */

export interface CourseRef {
  kind: 'course';
  stageId: string;
  /**
   * What the course was called when the user picked it. Display + degradation
   * only: never the name the agent is told to trust when the course resolves.
   */
  title: string;
}

/**
 * How many courses one message may name.
 */
export const MAX_COURSE_REFS = 5;

export const COURSE_REF_ID_MAX = 64;
export const COURSE_REF_TITLE_MAX = 120;

const COURSE_REF_FIELDS = new Set(['kind', 'stageId', 'title']);

/**
 * Build a ref from a picked course.
 */
export function makeCourseRef(stageId: string, title: string): CourseRef | null {
  const id = stageId.trim();
  const label = title.trim();
  if (!id || !label) return null;
  return { kind: 'course', stageId: id, title: label.slice(0, COURSE_REF_TITLE_MAX) };
}

export function sameCourseRef(
  a: Pick<CourseRef, 'stageId'>,
  b: Pick<CourseRef, 'stageId'>,
): boolean {
  return a.stageId === b.stageId;
}

export function hasCourseRef(refs: readonly CourseRef[], stageId: string): boolean {
  return refs.some((ref) => ref.stageId === stageId);
}

/**
 * Append unless the same course is already named or the cap is reached.
 * Returns the SAME array identity when nothing changed, so a store `set` with
 * this result is a no-op re-render-wise.
 */
export function addCourseRef(refs: readonly CourseRef[], ref: CourseRef): CourseRef[] {
  if (hasCourseRef(refs, ref.stageId)) return refs as CourseRef[];
  if (refs.length >= MAX_COURSE_REFS) return refs as CourseRef[];
  return [...refs, ref];
}

export function removeCourseRef(refs: readonly CourseRef[], stageId: string): CourseRef[] {
  const next = refs.filter((ref) => ref.stageId !== stageId);
  return next.length === refs.length ? (refs as CourseRef[]) : next;
}

export type CourseRefsDecodeResult = { ok: true; refs: CourseRef[] } | { ok: false; error: string };

/**
 * The one strict wire decoder used by both the POST boundary and durable replay.
 */
export function decodeCourseRefs(
  value: unknown,
  invalid: 'reject' | 'drop' = 'reject',
): CourseRefsDecodeResult {
  if (!Array.isArray(value)) {
    return invalid === 'drop'
      ? { ok: true, refs: [] }
      : { ok: false, error: 'courseRefs must be an array' };
  }
  const refs: CourseRef[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const reject = (error: string): CourseRefsDecodeResult | null =>
      invalid === 'reject' ? { ok: false, error } : null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      const failure = reject(`courseRefs[${index}] must be an object`);
      if (failure) return failure;
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const unknownField = Object.keys(rec).find((field) => !COURSE_REF_FIELDS.has(field));
    if (unknownField) {
      const failure = reject(`courseRefs[${index}] contains unknown field "${unknownField}"`);
      if (failure) return failure;
      continue;
    }
    if (rec.kind !== 'course') {
      const failure = reject(`courseRefs[${index}].kind must be "course"`);
      if (failure) return failure;
      continue;
    }
    if (typeof rec.stageId !== 'string' || !rec.stageId.trim()) {
      const failure = reject(`courseRefs[${index}].stageId must be a non-empty string`);
      if (failure) return failure;
      continue;
    }
    if (rec.stageId.length > COURSE_REF_ID_MAX) {
      const failure = reject(
        `courseRefs[${index}].stageId cannot exceed ${COURSE_REF_ID_MAX} characters`,
      );
      if (failure) return failure;
      continue;
    }
    if (typeof rec.title !== 'string' || !rec.title.trim()) {
      const failure = reject(`courseRefs[${index}].title must be a non-empty string`);
      if (failure) return failure;
      continue;
    }
    if (rec.title.length > COURSE_REF_TITLE_MAX) {
      const failure = reject(
        `courseRefs[${index}].title cannot exceed ${COURSE_REF_TITLE_MAX} characters`,
      );
      if (failure) return failure;
      continue;
    }
    const ref: CourseRef = { kind: 'course', stageId: rec.stageId, title: rec.title };
    if (seen.has(ref.stageId)) continue;
    seen.add(ref.stageId);
    if (refs.length >= MAX_COURSE_REFS) {
      if (invalid === 'reject') {
        return { ok: false, error: `courseRefs cannot contain more than ${MAX_COURSE_REFS} items` };
      }
      continue;
    }
    refs.push(ref);
  }
  return { ok: true, refs };
}

/** Decode refs from a durable event, dropping invalid historical items. */
export function parseCourseRefs(value: unknown): CourseRef[] {
  const decoded = decodeCourseRefs(value, 'drop');
  return decoded.ok ? decoded.refs : [];
}
