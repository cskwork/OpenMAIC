import { describe, expect, it } from 'vitest';
import {
  measureAudioDuration,
  measureMp3Duration,
  measureWavDuration,
} from '@/lib/audio/audio-duration';

/** Build a minimal 44-byte-header PCM WAV for a given duration. */
function buildWav(
  seconds: number,
  sampleRate = 8000,
  channels = 1,
  bitsPerSample = 16,
): Uint8Array {
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * channels * bytesPerSample;
  const dataSize = Math.round(byteRate * seconds);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}

/**
 * Build a CBR MP3 (MPEG-1 Layer III, 128 kbps, 44100 Hz, mono) of roughly the
 * requested duration by repeating a valid frame header + padding. Duration is
 * estimated from total audio bytes, so exact frame content doesn't matter.
 */
function buildCbrMp3(seconds: number): Uint8Array {
  const bitrateKbps = 128;
  const sampleRate = 44100;
  const samplesPerFrame = 1152;
  const frameLength = Math.floor((samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate));
  const frameCount = Math.round((seconds * sampleRate) / samplesPerFrame);
  const bytes = new Uint8Array(frameLength * frameCount);
  for (let f = 0; f < frameCount; f++) {
    const off = f * frameLength;
    bytes[off] = 0xff; // sync
    bytes[off + 1] = 0xfb; // MPEG1, Layer III, no CRC
    bytes[off + 2] = 0x90; // 128 kbps (0x9), 44100 Hz (0x0), no padding
    bytes[off + 3] = 0xc0; // mono
  }
  return bytes;
}

describe('measureWavDuration', () => {
  it('measures duration from a PCM WAV header', () => {
    const wav = buildWav(2.5);
    expect(measureWavDuration(wav)).toBeCloseTo(2.5, 3);
  });

  it('tolerates an odd-length preceding chunk (word alignment)', () => {
    // Prepend a LIST chunk of odd size before data; parser must skip its pad byte.
    const base = buildWav(1);
    const list = new Uint8Array(8 + 3 + 1); // header + 3-byte body + 1 pad
    const dv = new DataView(list.buffer);
    'LIST'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
    dv.setUint32(4, 3, true);
    // Splice the LIST chunk in right after the WAVE tag (offset 12).
    const out = new Uint8Array(base.length + list.length);
    out.set(base.subarray(0, 12), 0);
    out.set(list, 12);
    out.set(base.subarray(12), 12 + list.length);
    // Fix RIFF size.
    new DataView(out.buffer).setUint32(4, out.length - 8, true);
    expect(measureWavDuration(out)).toBeCloseTo(1, 3);
  });

  it('returns null for non-RIFF bytes', () => {
    expect(measureWavDuration(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });
});

describe('measureMp3Duration', () => {
  it('estimates duration of a CBR MP3', () => {
    const mp3 = buildCbrMp3(3);
    const d = measureMp3Duration(mp3);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(2.5);
    expect(d!).toBeLessThan(3.5);
  });

  it('skips a leading ID3v2 tag', () => {
    const mp3 = buildCbrMp3(2);
    const id3 = new Uint8Array(10 + 20);
    'ID3'.split('').forEach((c, i) => (id3[i] = c.charCodeAt(0)));
    id3[6] = 0;
    id3[7] = 0;
    id3[8] = 0;
    id3[9] = 20; // syncsafe size = 20
    const out = new Uint8Array(id3.length + mp3.length);
    out.set(id3, 0);
    out.set(mp3, id3.length);
    const d = measureMp3Duration(out);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(1.5);
    expect(d!).toBeLessThan(2.5);
  });

  it('returns null when no frame sync is found', () => {
    expect(measureMp3Duration(new Uint8Array(64))).toBeNull();
  });
});

describe('measureAudioDuration', () => {
  it('dispatches on the wav format hint', () => {
    expect(measureAudioDuration(buildWav(1.5), 'wav')).toBeCloseTo(1.5, 3);
  });

  it('dispatches on the mp3 format hint', () => {
    const d = measureAudioDuration(buildCbrMp3(1), 'mp3');
    expect(d).not.toBeNull();
  });

  it('sniffs format when no hint is given', () => {
    expect(measureAudioDuration(buildWav(1))).toBeCloseTo(1, 3);
    expect(measureAudioDuration(buildCbrMp3(1))).not.toBeNull();
  });

  it('degrades to null on empty or unsupported input (caller still persists)', () => {
    expect(measureAudioDuration(new Uint8Array(0))).toBeNull();
    expect(measureAudioDuration(new Uint8Array([0x00, 0x01, 0x02, 0x03]), 'flac')).toBeNull();
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', () => {
    const wav = buildWav(2);
    const copy = wav.slice().buffer as ArrayBuffer;
    expect(measureAudioDuration(copy, 'wav')).toBeCloseTo(2, 3);
  });
});
