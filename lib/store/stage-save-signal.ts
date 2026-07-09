type StageSavedListener = (stageId: string) => void;

const stageSavedListeners = new Set<StageSavedListener>();

export function onStageSaved(listener: StageSavedListener): () => void {
  stageSavedListeners.add(listener);
  return () => {
    stageSavedListeners.delete(listener);
  };
}

export function emitStageSaved(stageId: string): void {
  for (const listener of [...stageSavedListeners]) {
    listener(stageId);
  }
}
