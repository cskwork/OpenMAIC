'use client';

/**
 * Assistant text renderer — Streamdown via the official assistant-ui bridge.
 *
 * StreamdownTextPrimitive reads the message part's text/status from assistant-ui
 * context (works with our ExternalStoreRuntime unchanged) and renders with
 * streaming-first behavior: incomplete-markdown repair (no mid-stream flicker
 * on unclosed bold/links), a streaming caret while running, word fade-in at
 * token cadence, and memoized block rendering. `smooth` adds useSmooth char
 * interpolation so bursty SSE deltas read as a steady reveal.
 */
import 'streamdown/styles.css';
import { StreamdownTextPrimitive } from '@assistant-ui/react-streamdown';
import { code } from '@streamdown/code';

export function MarkdownText() {
  return (
    <StreamdownTextPrimitive
      className="text-[13.5px] leading-relaxed text-foreground [overflow-wrap:anywhere]"
      caret="block"
      animated={{ animation: 'fadeIn', sep: 'word' }}
      smooth
      plugins={{ code }}
    />
  );
}
