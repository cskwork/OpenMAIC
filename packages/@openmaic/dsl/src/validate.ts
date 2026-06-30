/**
 * Pure, dependency-free structural validators for the slide DSL contract.
 *
 * These are cheap, zero-dependency *structural pre-checks*: they verify object
 * shape, the envelope's required fields, and that discriminants are known
 * contract values. They are a deliberate **strict subset** of the shipped JSON
 * Schema (`@openmaic/dsl/schema/*`): passing a validator does NOT prove a
 * document is schema-valid. The JSON Schema is the authoritative, exhaustive
 * per-field validator (it checks variant-specific fields like an action's
 * `elementId`); reach for it, with your own validator (e.g. ajv), at real trust
 * boundaries (untrusted LLM / agent output, persistence). These functions add
 * no dependency and describe the same contract shape — the schema just checks
 * more of it. No runtime dependencies.
 */
import { isActionType } from './action.js';
import { isSceneType } from './stage.js';

export interface ValidationIssue {
  /** JSON-pointer-ish path to the offending value, e.g. `/actions/0/type`. */
  path: string;
  message: string;
}

export type ValidationResult = { valid: true } | { valid: false; errors: ValidationIssue[] };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(
  o: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): void {
  if (typeof o[key] !== 'string')
    errors.push({ path: `${path}/${key}`, message: `expected string \`${key}\`` });
}

function reqNumber(
  o: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): void {
  if (typeof o[key] !== 'number')
    errors.push({ path: `${path}/${key}`, message: `expected number \`${key}\`` });
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
    errors.push({
      path: `${path}/type`,
      message: `unknown action type: ${JSON.stringify(doc.type)}`,
    });
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

  if (!isSceneType(doc.type)) {
    errors.push({
      path: `${path}/type`,
      message: `unknown scene type: ${JSON.stringify(doc.type)}`,
    });
  }

  // `content` must be one of the contract-owned content kinds (slide/quiz),
  // mirroring `SceneContent` in the public type and the generated schema. App
  // widened content kinds (interactive/pbl) are the consuming app's to validate.
  // The scene-level `type` and `content.type` are validated independently — the
  // public `Scene` type does not bind them, so neither does this validator.
  const content = doc.content;
  if (!isObject(content)) {
    errors.push({ path: `${path}/content`, message: 'scene `content` must be an object' });
  } else if (content.type === 'slide') {
    if (!isObject(content.canvas))
      errors.push({
        path: `${path}/content/canvas`,
        message: 'slide content requires an object `canvas`',
      });
  } else if (content.type === 'quiz') {
    if (!Array.isArray(content.questions))
      errors.push({
        path: `${path}/content/questions`,
        message: 'quiz content requires a `questions` array',
      });
  } else {
    errors.push({
      path: `${path}/content/type`,
      message: `unknown content type: ${JSON.stringify(content.type)} (expected 'slide' or 'quiz')`,
    });
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
  if (!isObject(doc))
    return { valid: false, errors: [{ path: '/', message: 'stage must be an object' }] };
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
