/**
 * Detect a supported audio MIME type for MediaRecorder.
 *
 * Safari does not support audio/webm — it uses audio/mp4 instead.
 * We prefer webm (smaller, widely supported server-side) and fall back to mp4.
 */
export function getSupportedAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';

  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';

  // Fallback: let the browser pick its default
  return '';
}

/**
 * Get the file extension for a given audio MIME type.
 */
export function getAudioFileExtension(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  return 'webm';
}
