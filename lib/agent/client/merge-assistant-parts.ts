/**
 * Pure, side-effect-free helper that assembles the assistant message content
 * parts from accumulated per-run state. Extracted so it can be unit-tested
 * without React or a browser environment.
 *
 * Behaviour (mirrors the PoC buildAssistant closure):
 *  - Text part first: `text` if non-empty, else `error` if non-empty.
 *  - One `tool-call` part per id in `toolOrder` (upserted name/args, with
 *    `result`/`isError` if a result exists).
 *  - If no parts at all, a single empty text part.
 */

export type AssistantPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: unknown;
      isError?: boolean;
    };

export interface MergeInput {
  text: string;
  error: string;
  toolOrder: string[];
  toolCalls: Map<string, { name: string; args: Record<string, unknown> }>;
  toolResults: Map<string, { result: unknown; isError: boolean }>;
}

export function mergeAssistantParts(input: MergeInput): AssistantPart[] {
  const { text, error, toolOrder, toolCalls, toolResults } = input;
  const parts: AssistantPart[] = [];

  const displayText = text || error;
  if (displayText) parts.push({ type: 'text', text: displayText });

  for (const tcId of toolOrder) {
    const tc = toolCalls.get(tcId);
    if (!tc) continue;
    const tr = toolResults.get(tcId);
    parts.push({
      type: 'tool-call',
      toolCallId: tcId,
      toolName: tc.name,
      args: tc.args,
      ...(tr ? { result: tr.result, isError: tr.isError } : {}),
    });
  }

  if (parts.length === 0) parts.push({ type: 'text', text: '' });
  return parts;
}
