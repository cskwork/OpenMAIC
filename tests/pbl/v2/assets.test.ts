import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('PBL v2 static assets', () => {
  test('ships the instructor avatar referenced by the runtime UI', () => {
    const bytes = readFileSync('public/avatars/instructor.png');

    expect(bytes.length).toBeGreaterThan(0);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
