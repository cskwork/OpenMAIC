import { describe, expect, it } from 'vitest';
import { shouldRunClassroomGenerationResume } from '@/lib/classroom/resume-generation';

describe('shouldRunClassroomGenerationResume', () => {
  it('ignores stale scene-load tokens for the current classroom generation resume', () => {
    expect(
      shouldRunClassroomGenerationResume({
        cancelled: false,
        sceneLoadTokenIsCurrent: false,
      }),
    ).toBe(true);
  });

  it('suppresses generation resume after navigation away or unmount', () => {
    expect(
      shouldRunClassroomGenerationResume({
        cancelled: true,
        sceneLoadTokenIsCurrent: true,
      }),
    ).toBe(false);
  });
});
