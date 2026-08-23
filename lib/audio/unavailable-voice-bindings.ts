const unavailableBindings = new Set<string>();
const noticedBindings = new Set<string>();

export function voiceBindingKey(binding: { providerId: string; voiceId: string }): string {
  return `${binding.providerId}\0${binding.voiceId}`;
}

export function isVoiceBindingUnavailable(binding: {
  providerId: string;
  voiceId: string;
}): boolean {
  return unavailableBindings.has(voiceBindingKey(binding));
}

export function markVoiceBindingUnavailable(binding: {
  providerId: string;
  voiceId: string;
}): string {
  const key = voiceBindingKey(binding);
  unavailableBindings.add(key);
  return key;
}

export function clearVoiceBindingUnavailable(binding: {
  providerId: string;
  voiceId: string;
}): void {
  const key = voiceBindingKey(binding);
  unavailableBindings.delete(key);
  noticedBindings.delete(key);
}

export function trackAssignedVoiceBinding(
  previousKey: string | undefined,
  binding: { providerId: string; voiceId: string },
): string {
  const nextKey = voiceBindingKey(binding);
  if (previousKey && previousKey !== nextKey) {
    const separator = previousKey.indexOf('\0');
    clearVoiceBindingUnavailable({
      providerId: previousKey.slice(0, separator),
      voiceId: previousKey.slice(separator + 1),
    });
  }
  return nextKey;
}

export function markVoiceBindingNoticeShown(key: string): boolean {
  if (noticedBindings.has(key)) return false;
  noticedBindings.add(key);
  return true;
}

export function clearUnavailableVoiceBindingsForTests(): void {
  unavailableBindings.clear();
  noticedBindings.clear();
}
