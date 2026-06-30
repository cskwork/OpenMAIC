/**
 * Pure, dependency-free structural validators for the slide DSL contract.
 *
 * Lightweight, fail-loud boundary checks (LLM / agent output, persistence):
 * they verify discriminants, required fields, and that nested discriminants are
 * known values. Exhaustive per-field validation is delegated to the shipped
 * JSON Schema (`@openmaic/dsl/schema/*`) for consumers that bring their own
 * validator (e.g. ajv). No runtime dependencies.
 */
import { isActionType } from './action.js';
import type { SceneType } from './stage.js';

export interface ValidationIssue {
  /** JSON-pointer-ish path to the offending value, e.g. `/actions/0/type`. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: ValidationIssue[] };

const SCENE_TYPES = ['slide', 'quiz', 'interactive', 'pbl'] as const satisfies readonly SceneType[];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(o: Record<string, unknown>, key: string, path: string, errors: ValidationIssue[]): void {
  if (typeof o[key] !== 'string') errors.push({ path: `${path}/${key}`, message: `expected string \`${key}\`` });
}

function reqNumber(o: Record<string, unknown>, key: string, path: string, errors: ValidationIssue[]): void {
  if (typeof o[key] !== 'number') errors.push({ path: `${path}/${key}`, message: `expected number \`${key}\`` });
}

function done(errors: ValidationIssue[]): ValidationResult {
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function checkAction(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'action must be an object' });
    return;
  }
  reqString(doc, 'id', path, errors);
  if (!isActionType(doc.type)) {
    errors.push({ path: `${path}/type`, message: `unknown action type: ${JSON.stringify(doc.type)}` });
  }
}

function checkScene(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'scene must be an object' });
    return;
  }
  reqString(doc, 'id', path, errors);
  reqString(doc, 'stageId', path, errors);
  reqString(doc, 'title', path, errors);
  reqNumber(doc, 'order', path, errors);

  if (typeof doc.type !== 'string' || !(SCENE_TYPES as readonly string[]).includes(doc.type)) {
    errors.push({ path: `${path}/type`, message: `unknown scene type: ${JSON.stringify(doc.type)}` });
  }

  const content = doc.content;
  if (!isObject(content)) {
    errors.push({ path: `${path}/content`, message: 'scene `content` must be an object' });
  } else if (typeof content.type !== 'string' || !(SCENE_TYPES as readonly string[]).includes(content.type)) {
    errors.push({ path: `${path}/content/type`, message: `unknown content type: ${JSON.stringify(content.type)}` });
  } else if (content.type === 'slide' && !isObject(content.canvas)) {
    errors.push({ path: `${path}/content/canvas`, message: 'slide content requires an object `canvas`' });
  } else if (content.type === 'quiz' && !Array.isArray(content.questions)) {
    errors.push({ path: `${path}/content/questions`, message: 'quiz content requires a `questions` array' });
  }

  if (doc.actions !== undefined) {
    if (!Array.isArray(doc.actions)) {
      errors.push({ path: `${path}/actions`, message: '`actions` must be an array' });
    } else {
      doc.actions.forEach((a, i) => checkAction(a, `${path}/actions/${i}`, errors));
    }
  }
}

/** Validate a {@link Stage} aggregate (course metadata; scenes are separate). */
export function validateStage(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isObject(doc)) return { valid: false, errors: [{ path: '/', message: 'stage must be an object' }] };
  reqString(doc, 'id', '', errors);
  reqString(doc, 'name', '', errors);
  reqNumber(doc, 'createdAt', '', errors);
  reqNumber(doc, 'updatedAt', '', errors);
  return done(errors);
}

/** Validate a {@link Scene} aggregate, including its nested content + actions. */
export function validateScene(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkScene(doc, '', errors);
  return done(errors);
}

/** Validate a single {@link Action}. */
export function validateAction(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkAction(doc, '', errors);
  return done(errors);
}
