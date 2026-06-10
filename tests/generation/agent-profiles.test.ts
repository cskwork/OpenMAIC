import { describe, it, expect } from 'vitest';
import {
  AgentProfilesValidationError,
  buildAdaptAgentProfilesPrompt,
  buildGenerateAgentProfilesPrompt,
  parseAdaptAgentProfilesResponse,
  parseGenerateAgentProfilesResponse,
  type SeedAgentProfile,
} from '@/lib/generation/agent-profiles';

const course = {
  courseName: '线性代数入门',
  courseDescription: '面向大一新生的线性代数基础课',
  languageDirective: '使用中文回答。',
};

const seeds: SeedAgentProfile[] = [
  {
    id: 'default-1',
    name: 'AI teacher',
    role: 'teacher',
    persona: 'You are the lead teacher. Patient and warm.',
    avatar: '/avatars/teacher.png',
    color: '#3b82f6',
    priority: 10,
  },
  {
    id: 'default-3',
    name: '显眼包',
    role: 'student',
    persona: 'You are the class clown.',
    avatar: '/avatars/clown.png',
    color: '#f59e0b',
    priority: 4,
    voiceConfig: { providerId: 'qwen-tts', voiceId: 'Cherry' },
  },
];

describe('buildGenerateAgentProfilesPrompt', () => {
  it('always requires voiceDesign and refText', () => {
    const { userPrompt } = buildGenerateAgentProfilesPrompt(course);
    expect(userPrompt).toContain('"voiceDesign"');
    expect(userPrompt).toContain('"refText"');
    expect(userPrompt).toContain(course.languageDirective);
  });
  it('only includes avatar/color/voice blocks when lists are provided', () => {
    const bare = buildGenerateAgentProfilesPrompt(course).userPrompt;
    expect(bare).not.toContain('avatar');
    expect(bare).not.toContain('hex color');

    const rich = buildGenerateAgentProfilesPrompt({
      ...course,
      availableAvatars: ['/avatars/teacher.png'],
      colorPalette: ['#3b82f6'],
      availableVoices: [{ providerId: 'qwen-tts', voiceId: 'Cherry', voiceName: 'Cherry' }],
    }).userPrompt;
    expect(rich).toContain('avatar');
    expect(rich).toContain('hex color');
    expect(rich).toContain('qwen-tts::Cherry');
  });
});

describe('parseGenerateAgentProfilesResponse', () => {
  const validAgents = [
    {
      name: '王老师',
      role: 'teacher',
      persona: '耐心的数学老师。',
      voiceDesign: { identity: '中年男教师', texture: '低沉温暖', delivery: '从容鼓励' },
      refText: '大家好，我是王老师，欢迎来到线性代数的课堂，让我们一起开启这段旅程。',
      priority: 10,
    },
    {
      name: '小明',
      role: 'student',
      persona: '好奇的学生。',
      voiceDesign: { identity: '年轻男学生', texture: '清亮', delivery: '活泼快速' },
      refText: '哈喽大家好，我是小明，很期待今天的课！',
      priority: 5,
    },
  ];

  it('parses agents with normalized voiceDesign and refText (code fences tolerated)', () => {
    const raw = '```json\n' + JSON.stringify({ agents: validAgents }) + '\n```';
    const agents = parseGenerateAgentProfilesResponse(raw);
    expect(agents).toHaveLength(2);
    expect(agents[0].voiceDesign).toEqual(validAgents[0].voiceDesign);
    expect(agents[0].refText).toBe(validAgents[0].refText);
  });
  it('drops an unusable refText instead of keeping garbage', () => {
    const raw = JSON.stringify({
      agents: [{ ...validAgents[0], refText: '（好）' }, validAgents[1]],
    });
    const agents = parseGenerateAgentProfilesResponse(raw);
    expect(agents[0].refText).toBeUndefined();
  });
  it('throws when there are fewer than 2 agents or not exactly 1 teacher', () => {
    expect(() =>
      parseGenerateAgentProfilesResponse(JSON.stringify({ agents: [validAgents[0]] })),
    ).toThrow(AgentProfilesValidationError);
    expect(() =>
      parseGenerateAgentProfilesResponse(
        JSON.stringify({ agents: [validAgents[1], validAgents[1]] }),
      ),
    ).toThrow(/exactly 1 teacher/);
  });
  it('distinguishes structural violations from unparseable JSON by error type', () => {
    // V8's own SyntaxError messages also start with "Expected" — the route must
    // not classify those as LLM roster violations.
    try {
      parseGenerateAgentProfilesResponse('{,');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SyntaxError);
      expect(error).not.toBeInstanceOf(AgentProfilesValidationError);
    }
  });
});

describe('buildAdaptAgentProfilesPrompt', () => {
  it('embeds the seeds with seedId and the locked-field rules', () => {
    const { userPrompt } = buildAdaptAgentProfilesPrompt({ seedAgents: seeds, course });
    expect(userPrompt).toContain('"seedId": "default-1"');
    expect(userPrompt).toContain('one entry per seed');
    expect(userPrompt).toContain('"refText"');
    expect(userPrompt).toContain(course.languageDirective);
  });
});

describe('parseAdaptAgentProfilesResponse', () => {
  const llmOutput = JSON.stringify({
    agents: [
      {
        seedId: 'default-1',
        name: 'AI老师',
        persona: '你是这门线性代数课的主讲老师，耐心而温暖。',
        voiceDesign: { identity: '中年男教师', texture: '低沉温暖', delivery: '从容鼓励' },
        refText: '大家好，我是这门线性代数课的老师，欢迎大家来到课堂，我们马上开始。',
        // Fields the LLM is NOT allowed to change — must be ignored:
        role: 'assistant',
        avatar: '/avatars/evil.png',
        color: '#000000',
        priority: 1,
      },
    ],
  });

  it('adapts matched seeds while locking identity fields to the seed', () => {
    const result = parseAdaptAgentProfilesResponse(llmOutput, seeds);
    expect(result).toHaveLength(2);
    const teacher = result[0];
    expect(teacher.adapted).toBe(true);
    expect(teacher.name).toBe('AI老师');
    expect(teacher.persona).toContain('线性代数');
    expect(teacher.refText).toContain('线性代数');
    // Locked fields come from the seed even when the LLM tries to change them
    expect(teacher.id).toBe('default-1');
    expect(teacher.role).toBe('teacher');
    expect(teacher.avatar).toBe('/avatars/teacher.png');
    expect(teacher.color).toBe('#3b82f6');
    expect(teacher.priority).toBe(10);
  });
  it('keeps a seed verbatim when the LLM output has no entry for it', () => {
    const result = parseAdaptAgentProfilesResponse(llmOutput, seeds);
    const clown = result[1];
    expect(clown.adapted).toBe(false);
    expect(clown.name).toBe('显眼包');
    expect(clown.persona).toBe('You are the class clown.');
    expect(clown.voiceConfig).toEqual({ providerId: 'qwen-tts', voiceId: 'Cherry' });
    expect(clown.voiceDesign).toBeUndefined();
  });
  it('preserves the seed voiceConfig on adapted agents', () => {
    const withClown = JSON.stringify({
      agents: [
        {
          seedId: 'default-3',
          name: '气氛担当',
          persona: '你是课堂里的气氛担当，用幽默让线性代数不再枯燥。',
          voiceDesign: { identity: '年轻男学生', texture: '明亮', delivery: '俏皮轻快' },
          refText: '嘿嘿，大家好呀，我是班里的气氛担当，这节课保证不无聊！',
        },
      ],
    });
    const result = parseAdaptAgentProfilesResponse(withClown, seeds);
    expect(result[1].adapted).toBe(true);
    expect(result[1].voiceConfig).toEqual({ providerId: 'qwen-tts', voiceId: 'Cherry' });
  });
  it('throws on unparseable JSON so callers can fall back wholesale', () => {
    expect(() => parseAdaptAgentProfilesResponse('not json', seeds)).toThrow();
  });
});
