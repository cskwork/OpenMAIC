import { describe, expect, it } from 'vitest';
import { UserSkillError, validateUserSkillInput } from '@/lib/server/agent-runtime/user-skills';

const valid = {
  name: 'my-course-review',
  title: 'Course review',
  description: 'A structured review to run after a course is complete',
  content: 'Check the goals first, then check the evidence.',
};

describe('user Skill validation', () => {
  it('normalizes handle and description without preserving prompt-breaking newlines', () => {
    expect(
      validateUserSkillInput({
        ...valid,
        name: ' MY-Course-Review ',
        description: 'First line\nSecond line',
      }),
    ).toMatchObject({ name: 'my-course-review', description: 'First line Second line' });
  });

  it.each(['review', 'my-double--dash', 'my-trailing-'])('rejects invalid handle %s', (name) => {
    expect(() => validateUserSkillInput({ ...valid, name })).toThrow(UserSkillError);
  });

  it('rejects oversized instructions', () => {
    expect(() => validateUserSkillInput({ ...valid, content: 'a'.repeat(65_537) })).toThrow(
      /64 KiB/,
    );
  });
});
