/**
 * `content` is an HTML-string contract. Only tag-free values can safely use
 * `white-space: pre-line`: a newline between rich HTML block tags is source
 * formatting, not visible slide content.
 */
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/i;

export function preservesPlainTextLineBreaks(content: string): boolean {
  return !HTML_TAG_PATTERN.test(content);
}
