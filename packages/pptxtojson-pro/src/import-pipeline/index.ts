/**
 * High-level entry: parsed pptxtojson(-pro) JSON → OpenMAIC canvas `Slide[]`.
 *
 * `parsedToSlides` is the transform-only path: it never touches the parser
 * source under `../src`, which keeps `pdfjs-dist`'s dynamic `require()` out
 * of the consumer's bundle. Callers running in bundlers that can't tolerate
 * those patterns (Turbopack, today) load `parse` via a runtime URL and pass
 * the JSON in.
 *
 * `importPptx` bundles parse + transform for environments without that
 * bundler constraint (Node scripts, plain Vite, etc.).
 *
 * Failure policy: every upload site inside `transformParsedToSlides` already
 * swallows individual errors and leaves the original base64 in place; we use
 * `Promise.allSettled` here so a missing inner `.catch` cannot fail the
 * whole import either.
 */
import type { Slide, SlideTheme } from "../openmaic/types/slides";
import type { Output } from "../adapter/types";
import { parseZip } from "../parser/ZipParser";
import { buildPresentation } from "../model/Presentation";
import { toPptxtojsonFormat } from "../adapter/toPptxtojson";
import type { ImportContext } from "./types";
import { transformParsedToSlides } from "./transformParsedToSlides";
import { createMockImportContext } from "./mockContext";

/**
 * OpenMAIC canvas default viewport width in CSS pixels. Matches the value
 * used by the slide renderer when no per-slide override is present.
 */
const CANVAS_VIEWPORT_SIZE = 1000;

export type OssUpload = (
  blob: Blob,
  filename: string,
  dir?: string,
) => Promise<string>;

export interface ImportPptxOptions {
  /**
   * Upload media (images, audio, video) to remote storage and return the
   * public URL. If omitted, images keep their base64 data URLs and media
   * keeps an in-memory `blob:` URL (valid only for the current tab).
   */
  upload?: OssUpload;
}

/**
 * Convert a pre-parsed pptxtojson(-pro) `Output` JSON into OpenMAIC slides.
 *
 * Resolves after every queued upload has settled, so `Slide` elements
 * either hold the uploaded URL or fall back to the original base64.
 *
 * Bundler-safe: this entry has no transitive dependency on
 * `pptxtojson-pro/src` and therefore no `pdfjs-dist` dynamic-require trap.
 */
export async function parsedToSlides(
  json: Output,
  options: ImportPptxOptions = {},
): Promise<Slide[]> {
  const ctx = createMockImportContext(buildContextOverrides(options.upload));

  // pptxtojson-pro's `Output` is structurally compatible with the npm
  // `pptxtojson` shape that `transformParsedToSlides` is typed against;
  // the cast bridges the two declaration sources.
  const { slides, uploadTasks } = await transformParsedToSlides(
    json as unknown as Parameters<typeof transformParsedToSlides>[0],
    ctx,
  );

  await Promise.allSettled(uploadTasks);

  // `transformParsedToSlides` only sets a minimal subset of Slide fields
  // (id, elements, background, script). Fill in the canvas-required fields
  // from the parsed presentation + import context so the result is a
  // ready-to-render `Slide[]`.
  const viewportRatio = json.size.width > 0 ? json.size.height / json.size.width : 0.5625;
  const theme: SlideTheme = {
    backgroundColor: ctx.theme.backgroundColor,
    themeColors: json.themeColors ?? ctx.theme.themeColors,
    fontColor: ctx.theme.fontColor,
    fontName: ctx.theme.fontName,
    outline: ctx.theme.outline,
    shadow: ctx.theme.shadow,
  };
  for (const slide of slides) {
    if (slide.viewportSize === undefined) slide.viewportSize = CANVAS_VIEWPORT_SIZE;
    if (slide.viewportRatio === undefined) slide.viewportRatio = viewportRatio;
    if (slide.theme === undefined) slide.theme = theme;
  }

  return slides;
}

/**
 * Parse a .pptx file and convert it into OpenMAIC canvas slides.
 *
 * Convenience wrapper for environments that can bundle `pptxtojson-pro/src`
 * (Node, Vite, etc.). Inside Next/Turbopack, prefer URL-loading `parse`
 * yourself and calling {@link parsedToSlides} with the result.
 */
export async function importPptx(
  input: File | Blob | ArrayBuffer,
  options: ImportPptxOptions = {},
): Promise<Slide[]> {
  const buffer = await toArrayBuffer(input);
  const files = await parseZip(buffer);
  const presentation = buildPresentation(files);
  const json = await toPptxtojsonFormat(presentation, files, "base64");
  return parsedToSlides(json, options);
}

function buildContextOverrides(
  upload: OssUpload | undefined,
): Partial<ImportContext> {
  if (!upload) return {};
  return {
    uploadBase64Image: async (base64, filename, dir) => {
      const blob = await dataUrlToBlob(base64);
      return upload(blob, filename, dir);
    },
    uploadBlobMedia: (blob, filename, dir) => upload(blob, filename, dir),
  };
}

async function toArrayBuffer(
  input: File | Blob | ArrayBuffer,
): Promise<ArrayBuffer> {
  if (input instanceof ArrayBuffer) return input;
  return input.arrayBuffer();
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

export type { ImportContext, TransformResult } from "./types";
export { transformParsedToSlides } from "./transformParsedToSlides";
export { createMockImportContext } from "./mockContext";
export type { Output } from "../adapter/types";
