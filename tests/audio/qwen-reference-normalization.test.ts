import { describe, expect, it } from 'vitest';

import { audioBufferToMonoWav, preserveRecordedVoiceName } from '@/lib/audio/voxcpm-voices';
import { validateReferenceAudio } from '@/lib/audio/wav-validate';

describe('Qwen reference audio normalization', () => {
  it('truncates decoder padding at the 60-second boundary', () => {
    const sampleRate = 24_000;
    const samples = Math.ceil(60.01 * sampleRate);
    const channel = new Float32Array(samples);
    const audioBuffer = {
      duration: 60.01,
      sampleRate,
      numberOfChannels: 1,
      length: samples,
      getChannelData: () => channel,
    } as unknown as AudioBuffer;

    const wav = new Uint8Array(audioBufferToMonoWav(audioBuffer, sampleRate));
    expect(validateReferenceAudio(wav).durationSeconds).toBe(60);
  });

  it('preserves a name typed while recording is in progress', () => {
    expect(preserveRecordedVoiceName('Typed during recording', 'Recorded Voice')).toBe(
      'Typed during recording',
    );
    expect(preserveRecordedVoiceName('  ', 'Recorded Voice')).toBe('Recorded Voice');
  });
});
