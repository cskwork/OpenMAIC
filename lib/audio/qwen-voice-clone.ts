import { createHash } from 'node:crypto';

import type { TTSGenerationResult } from '@/lib/audio/tts-providers';

export const QWEN_VOICE_ENROLLMENT_MODEL = 'qwen-voice-enrollment';
const DEFAULT_QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const ENROLLMENT_PATH = '/api/v1/services/audio/tts/customization';
const SYNTHESIS_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
const REQUEST_TIMEOUT_MS = 30_000;
const AUDIO_DOWNLOAD_TIMEOUT_MS = 30_000;
const SYNTHESIS_DEADLINE_MS = 24_000;
const MAX_AUDIO_RESPONSE_BYTES = 50 * 1024 * 1024;

export type QwenVoiceCloneErrorCode =
  | 'QWEN_VC_CONFIG_MISSING'
  | 'QWEN_VC_ENDPOINT_INVALID'
  | 'QWEN_VC_HTTP_ERROR'
  | 'QWEN_VC_TIMEOUT'
  | 'QWEN_VC_TRANSPORT_ERROR'
  | 'QWEN_VC_RESPONSE_JSON_INVALID'
  | 'QWEN_VC_RESPONSE_VOICE_MISSING'
  | 'QWEN_VC_RESPONSE_AUDIO_URL_MISSING'
  | 'QWEN_VC_AUDIO_URL_INVALID'
  | 'QWEN_VC_AUDIO_DOWNLOAD_FAILED'
  | 'QWEN_VC_AUDIO_TOO_LARGE'
  | 'QWEN_VC_AUDIO_EMPTY'
  | 'QWEN_VC_SPEED_UNSUPPORTED'
  | 'QWEN_VC_BOOTSTRAP_UNSUPPORTED';

export class QwenVoiceCloneError extends Error {
  constructor(
    readonly code: QwenVoiceCloneErrorCode,
    readonly httpStatus?: number,
  ) {
    super(code);
    this.name = 'QwenVoiceCloneError';
  }
}

export interface QwenVoiceCloneConfig {
  apiKey?: string;
  baseUrl?: string;
  targetModel?: string;
}

interface QwenResponse {
  output?: {
    voice?: unknown;
    audio?: { url?: unknown; format?: unknown };
  };
}

function resolveConfig(config: QwenVoiceCloneConfig): {
  apiKey: string;
  baseUrl: URL;
  targetModel: string;
} {
  const apiKey = config.apiKey?.trim() || '';
  const targetModel = config.targetModel?.trim() || '';
  if (!apiKey || !targetModel) throw new QwenVoiceCloneError('QWEN_VC_CONFIG_MISSING', 400);

  let baseUrl: URL;
  try {
    baseUrl = new URL(config.baseUrl?.trim() || DEFAULT_QWEN_BASE_URL);
  } catch {
    throw new QwenVoiceCloneError('QWEN_VC_ENDPOINT_INVALID', 400);
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost') {
    throw new QwenVoiceCloneError('QWEN_VC_ENDPOINT_INVALID', 400);
  }
  return { apiKey, baseUrl, targetModel };
}

function endpoint(baseUrl: URL, path: string): URL {
  const normalized = new URL(baseUrl);
  const basePath = normalized.pathname.replace(/\/$/u, '');
  const suffix =
    basePath.endsWith('/api/v1') && path.startsWith('/api/v1/')
      ? path.slice('/api/v1'.length)
      : path;
  normalized.pathname = `${basePath}${suffix}`;
  normalized.search = '';
  normalized.hash = '';
  return normalized;
}

export function preferredVoiceName(name: string, audio: Uint8Array): string {
  const prefix = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 6);
  const digest = createHash('sha256').update(audio).digest('hex').slice(0, 8);
  return `${prefix || 'voice'}_${digest}`.slice(0, 16);
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timeoutReached = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function postJson(
  url: URL,
  apiKey: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<QwenResponse> {
  const timeout = timeoutSignal(signal, REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
        signal: timeout.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new QwenVoiceCloneError(
        timeout.timedOut() ? 'QWEN_VC_TIMEOUT' : 'QWEN_VC_TRANSPORT_ERROR',
        timeout.timedOut() ? 504 : 502,
      );
    }

    let parsed: QwenResponse;
    try {
      parsed = (await response.json()) as QwenResponse;
    } catch {
      if (!response.ok) throw new QwenVoiceCloneError('QWEN_VC_HTTP_ERROR', response.status);
      throw new QwenVoiceCloneError('QWEN_VC_RESPONSE_JSON_INVALID', 502);
    }
    if (!response.ok) throw new QwenVoiceCloneError('QWEN_VC_HTTP_ERROR', response.status);
    return parsed;
  } finally {
    timeout.cleanup();
  }
}

export async function registerQwenVoice(
  config: QwenVoiceCloneConfig,
  input: { name: string; audio: Uint8Array; text: string },
  signal?: AbortSignal,
): Promise<{ voiceId: string; targetModel: string }> {
  const resolved = resolveConfig(config);
  const body = await postJson(
    endpoint(resolved.baseUrl, ENROLLMENT_PATH),
    resolved.apiKey,
    {
      model: QWEN_VOICE_ENROLLMENT_MODEL,
      input: {
        action: 'create',
        target_model: resolved.targetModel,
        preferred_name: preferredVoiceName(input.name, input.audio),
        audio: { data: `data:audio/wav;base64,${Buffer.from(input.audio).toString('base64')}` },
        text: input.text,
      },
    },
    signal,
  );
  const voiceId = typeof body.output?.voice === 'string' ? body.output.voice.trim() : '';
  if (!voiceId) throw new QwenVoiceCloneError('QWEN_VC_RESPONSE_VOICE_MISSING', 502);
  return { voiceId, targetModel: resolved.targetModel };
}

export function audioFormat(contentType: string | null, vendorFormat: unknown, url: URL): string {
  if (typeof vendorFormat === 'string' && /^[a-z0-9]+$/iu.test(vendorFormat)) {
    return vendorFormat.toLowerCase();
  }
  const normalizedType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalizedType === 'audio/mpeg' || normalizedType === 'audio/mp3') return 'mp3';
  if (normalizedType === 'audio/wav' || normalizedType === 'audio/x-wav') return 'wav';
  if (normalizedType?.startsWith('audio/')) return normalizedType.slice('audio/'.length);
  return url.pathname.match(/\.([a-z0-9]{2,5})$/iu)?.[1]?.toLowerCase() || 'wav';
}

export async function downloadAudio(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string | null; url: URL }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new QwenVoiceCloneError('QWEN_VC_AUDIO_URL_INVALID', 502);
  }
  const trustedHost = /^dashscope-result-[a-z0-9-]+\.oss-[a-z]{2}-[a-z0-9-]+\.aliyuncs\.com$/u.test(
    url.hostname,
  );
  if (
    !trustedHost ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    (url.port && url.port !== '80' && url.port !== '443')
  ) {
    throw new QwenVoiceCloneError('QWEN_VC_AUDIO_URL_INVALID', 502);
  }
  if (url.protocol === 'http:') url.protocol = 'https:';

  const timeout = timeoutSignal(signal, AUDIO_DOWNLOAD_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: timeout.signal, redirect: 'error' });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new QwenVoiceCloneError(
        timeout.timedOut() ? 'QWEN_VC_TIMEOUT' : 'QWEN_VC_AUDIO_DOWNLOAD_FAILED',
        timeout.timedOut() ? 504 : 502,
      );
    }
    if (!response.ok) {
      throw new QwenVoiceCloneError('QWEN_VC_AUDIO_DOWNLOAD_FAILED', response.status);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_RESPONSE_BYTES) {
      throw new QwenVoiceCloneError('QWEN_VC_AUDIO_TOO_LARGE', 502);
    }
    if (!response.body) throw new QwenVoiceCloneError('QWEN_VC_AUDIO_EMPTY', 502);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_AUDIO_RESPONSE_BYTES) {
        await reader.cancel();
        throw new QwenVoiceCloneError('QWEN_VC_AUDIO_TOO_LARGE', 502);
      }
      chunks.push(value);
    }
    if (!totalBytes) throw new QwenVoiceCloneError('QWEN_VC_AUDIO_EMPTY', 502);
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, contentType: response.headers.get('content-type'), url };
  } finally {
    timeout.cleanup();
  }
}

export async function synthesizeQwenVoiceClone(
  config: QwenVoiceCloneConfig,
  text: string,
  voiceId: string,
  speed = 1,
  signal?: AbortSignal,
): Promise<TTSGenerationResult> {
  const resolved = resolveConfig(config);
  const voice = voiceId.trim();
  if (!voice) throw new QwenVoiceCloneError('QWEN_VC_CONFIG_MISSING', 400);
  if (!Number.isFinite(speed) || speed !== 1) {
    throw new QwenVoiceCloneError('QWEN_VC_SPEED_UNSUPPORTED', 400);
  }
  const deadline = timeoutSignal(signal, SYNTHESIS_DEADLINE_MS);
  try {
    const body = await postJson(
      endpoint(resolved.baseUrl, SYNTHESIS_PATH),
      resolved.apiKey,
      { model: resolved.targetModel, input: { text, voice } },
      deadline.signal,
    );
    const rawAudioUrl =
      typeof body.output?.audio?.url === 'string' ? body.output.audio.url.trim() : '';
    if (!rawAudioUrl) {
      throw new QwenVoiceCloneError('QWEN_VC_RESPONSE_AUDIO_URL_MISSING', 502);
    }
    const downloaded = await downloadAudio(rawAudioUrl, deadline.signal);
    return {
      audio: downloaded.bytes,
      format: audioFormat(downloaded.contentType, body.output?.audio?.format, downloaded.url),
    };
  } catch (error) {
    if (deadline.timedOut()) throw new QwenVoiceCloneError('QWEN_VC_TIMEOUT', 504);
    throw error;
  } finally {
    deadline.cleanup();
  }
}
