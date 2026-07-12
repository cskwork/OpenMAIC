export interface ClassroomGenerationResumeState {
  cancelled: boolean;
  sceneLoadTokenIsCurrent?: boolean;
}

export function shouldRunClassroomGenerationResume({
  cancelled,
}: ClassroomGenerationResumeState): boolean {
  return !cancelled;
}
