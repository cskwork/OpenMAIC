export type QuizRuntimePhase = 'not_started' | 'answering' | 'grading' | 'reviewing';

const phases = new Map<string, QuizRuntimePhase>();

export function setQuizRuntimePhase(sceneId: string, phase: QuizRuntimePhase): void {
  phases.set(sceneId, phase);
}

export function clearQuizRuntimePhase(sceneId: string): void {
  phases.delete(sceneId);
}

export function getQuizRuntimePhase(sceneId: string | null): QuizRuntimePhase | undefined {
  return sceneId ? phases.get(sceneId) : undefined;
}
