/**
 * Tests for the promoted stream-fn adapter — `toModelMessages` conversion.
 */
import { describe, it, expect } from 'vitest';
import { toModelMessages } from '@/lib/agent/runtime/stream-fn';
import type { ToolCallProviderMetadata } from '@/lib/agent/runtime/provider-metadata';
import type { Message as PiMessage, ToolCall } from '@earendil-works/pi-ai';

describe('toModelMessages', () => {
  it('converts assistant toolCall with providerMetadata to tool-call part with providerOptions', () => {
    const toolCallWithMeta: ToolCall & { providerMetadata?: ToolCallProviderMetadata } = {
      type: 'toolCall',
      id: 'call-1',
      name: 'myTool',
      arguments: { x: 1 },
      providerMetadata: { google: { thoughtSignature: 's' } },
    };

    const messages: PiMessage[] = [
      {
        role: 'assistant',
        content: [toolCallWithMeta],
        api: 'unknown' as never,
        provider: 'unknown' as never,
        model: 'test',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: 0,
      },
    ];

    const result = toModelMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    const parts = (result[0] as { content: Array<Record<string, unknown>> }).content;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('tool-call');
    expect(parts[0].toolCallId).toBe('call-1');
    expect(parts[0].toolName).toBe('myTool');
    expect(parts[0].providerOptions).toEqual({ google: { thoughtSignature: 's' } });
  });

  it('converts toolResult message to AI SDK tool role message', () => {
    const messages: PiMessage[] = [
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'myTool',
        content: [{ type: 'text', text: 'result text' }],
        isError: false,
        timestamp: 0,
      },
    ];

    const result = toModelMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('tool');
    const content = (result[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('tool-result');
    expect(content[0].toolCallId).toBe('call-1');
    expect(content[0].toolName).toBe('myTool');
    expect(content[0].output).toEqual({ type: 'text', value: 'result text' });
  });
});
