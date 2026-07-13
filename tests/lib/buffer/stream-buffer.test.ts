import { describe, expect, it } from 'vitest';
import { StreamBuffer } from '@/lib/buffer/stream-buffer';

describe('StreamBuffer Pi wrap-up ordering', () => {
  it('resolves immediately when done was processed before the drain waiter was registered', async () => {
    const lifecycle: string[] = [];
    const buffer = new StreamBuffer({
      onAgentStart() {},
      onAgentEnd() {},
      onTextReveal() {},
      onActionReady() {},
      onLiveSpeech() {},
      onSpeechProgress() {},
      onThinking() {},
      onCueUser() {},
      onDone() {
        lifecycle.push('done');
      },
      onError(message) {
        throw new Error(message);
      },
    });

    buffer.pushDone({ totalActions: 0, totalAgents: 0 });
    buffer.flush();

    await expect(buffer.waitUntilDrained()).resolves.toBeUndefined();
    expect(lifecycle).toEqual(['done']);
  });

  it('reveals teacher wrap-up text before done can trigger soft-closing', async () => {
    const visibleTexts: string[] = [];
    const lifecycle: string[] = [];
    const donePayloads: unknown[] = [];
    const buffer = new StreamBuffer(
      {
        onAgentStart(data) {
          lifecycle.push(`start:${data.agentId}`);
        },
        onAgentEnd(data) {
          lifecycle.push(`end:${data.agentId}`);
        },
        onTextReveal(_messageId, _partId, revealedText, isComplete) {
          if (isComplete) visibleTexts.push(revealedText);
        },
        onActionReady() {},
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone(data) {
          lifecycle.push('done');
          donePayloads.push(data);
        },
        onError(message) {
          throw new Error(message);
        },
      },
      { tickMs: 1, charsPerTick: 100 },
    );

    buffer.pushAgentStart({
      messageId: 'wrap-up-message',
      agentId: 'teacher-1',
      agentName: 'AI teacher',
    });
    buffer.pushText('wrap-up-message', '总结一下：树荫通过减少直射辐射，让地面少吸热。');
    buffer.pushAgentEnd({ messageId: 'wrap-up-message', agentId: 'teacher-1' });
    buffer.pushDone({
      totalActions: 0,
      totalAgents: 1,
      agentHadContent: true,
      cueUserReceived: false,
      sessionClosed: true,
      endReason: 'user_done',
    });

    buffer.start();
    await buffer.waitUntilDrained();

    expect(visibleTexts).toEqual(['总结一下：树荫通过减少直射辐射，让地面少吸热。']);
    expect(lifecycle).toEqual(['start:teacher-1', 'end:teacher-1', 'done']);
    expect(donePayloads).toEqual([
      expect.objectContaining({ sessionClosed: true, endReason: 'user_done' }),
    ]);
  });
});
