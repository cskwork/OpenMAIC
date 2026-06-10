/**
 * Shared agent-profile generation: prompts + response parsing.
 *
 * Two modes over one output schema:
 * - generate: invent a fresh agent roster for a course. Used by the server
 *   classroom pipeline (lib/server/classroom-generation.ts) and the client
 *   route (app/api/generate/agent-profiles/route.ts).
 * - adapt: take preset agents as seeds and lightly fit them to the course
 *   (localized name, course-flavored persona) while locking identity fields
 *   (id/role/avatar/color/priority/voiceConfig) to the seed.
 *
 * Both modes require per-agent `voiceDesign` (3-layer vocal descriptor) and
 * `refText` (a course-language seed script, ~5-10s spoken) so auto voices can
 * be bootstrapped into a stable registered reference clip
 * (see lib/audio/voice-registration.ts).
 */

import { normalizeRefText, normalizeVoiceDesign, type VoiceDesign } from '@/lib/audio/voice-design';

export interface GeneratedAgentProfile {
  name: string;
  role: string;
  persona: string;
  avatar?: string;
  color?: string;
  priority?: number;
  /** Raw "providerId::voiceId" voice reference from the LLM (generate mode only). */
  voice?: string;
  voiceDesign?: VoiceDesign;
  refText?: string;
}

/** A preset agent used as the seed for adapt mode. */
export interface SeedAgentProfile {
  id: string;
  name: string;
  role: string;
  persona: string;
  avatar: string;
  color: string;
  priority: number;
  voiceConfig?: { providerId: string; modelId?: string; voiceId: string };
  voiceDesign?: VoiceDesign;
  refText?: string;
}

export interface AdaptedAgentProfile extends SeedAgentProfile {
  /** false when the LLM output had no usable entry for this seed (kept verbatim). */
  adapted: boolean;
}

export interface AgentProfilesPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export interface CourseContext {
  courseName: string;
  courseDescription?: string;
  sceneOutlines?: Array<{ title: string; description?: string }>;
  languageDirective: string;
}

export interface GenerateAgentProfilesPromptOptions extends CourseContext {
  availableAvatars?: string[];
  avatarDescriptions?: Array<{ path: string; desc: string }>;
  colorPalette?: string[];
  availableVoices?: Array<{
    providerId: string;
    voiceId: string;
    voiceName: string;
    voiceLanguage?: string;
  }>;
}

export function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

/** Requirement block shared by both modes: vocal descriptor + bootstrap script. */
const VOICE_FIELDS_REQUIREMENT = `- Each agent needs a "voiceDesign" object describing their VOCAL identity (not personality), written following the language directive and consistent with the persona, as three short comma-free phrases:
  - "identity": gender + age + role (e.g. "middle-aged male teacher")
  - "texture": pitch + vocal quality (e.g. "warm low-pitched slightly husky")
  - "delivery": emotion + pace (e.g. "calm measured encouraging")
- Each agent needs a "refText" string: a natural spoken course-opening line in the course language, consistent with the persona (e.g. a short self-introduction plus a welcoming sentence about the course topic). Around 30-60 Chinese characters or 20-40 English words (about 5-10 seconds when spoken aloud). Plain prose only: no parentheses, no stage directions, no emoji.`;

function courseContextBlock(ctx: CourseContext): string {
  const sceneSummary = ctx.sceneOutlines?.length
    ? ctx.sceneOutlines
        .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''}`)
        .join('\n')
    : null;
  return [
    `Course name: ${ctx.courseName}`,
    ctx.courseDescription ? `Course description: ${ctx.courseDescription}` : '',
    sceneSummary ? `\nScene outlines:\n${sceneSummary}\n` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildGenerateAgentProfilesPrompt(
  opts: GenerateAgentProfilesPromptOptions,
): AgentProfilesPrompt {
  const systemPrompt = `You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Decide the appropriate number of agents (typically 3-5) based on the course content and complexity. Return ONLY valid JSON, no markdown or explanation.`;

  const voiceListStr = opts.availableVoices?.length
    ? JSON.stringify(
        opts.availableVoices.map((v) => ({
          id: `${v.providerId}::${v.voiceId}`,
          name: v.voiceName,
          language: v.voiceLanguage || 'unknown',
        })),
      )
    : '';

  const voicePrompt = voiceListStr
    ? `- Each agent should be assigned a voice that matches their persona from this list: ${voiceListStr}
  - Prefer a voice whose language matches the course language directive
  - Pick a voice that suits the agent's personality and role (e.g. authoritative voice for teacher, lively voice for energetic student)
  - Try to use different voices for each agent`
    : '';

  const voiceJsonField = voiceListStr
    ? ',\n      "voice": "string (voice id from available list, e.g. \'qwen-tts::Cherry\')"'
    : '';

  const avatarRequirement = opts.availableAvatars?.length
    ? `- Each agent must be assigned one avatar from this list: ${JSON.stringify(
        opts.avatarDescriptions?.length
          ? opts.avatarDescriptions.map((a) => ({ path: a.path, description: a.desc }))
          : opts.availableAvatars,
      )}
  - Pick an avatar that visually matches the agent's personality and role
  - Try to use different avatars for each agent
  - Use the "path" value as the avatar field in the output`
    : '';

  const colorRequirement = opts.colorPalette?.length
    ? `- Each agent must be assigned one color from this list: ${JSON.stringify(opts.colorPalette)}
  - Each agent must have a different color`
    : '';

  const avatarJsonField = opts.availableAvatars?.length
    ? ',\n      "avatar": "string (from available list)"'
    : '';
  const colorJsonField = opts.colorPalette?.length
    ? ',\n      "color": "string (hex color from palette)"'
    : '';

  const userPrompt = `Generate agent profiles for the following course:

${courseContextBlock(opts)}
Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Priority values: teacher=10 (highest), assistant=7, student=4-6
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Language directive for this course: ${opts.languageDirective}
  Agent names and personas must follow this language directive.
${avatarRequirement ? `${avatarRequirement}\n` : ''}${colorRequirement ? `${colorRequirement}\n` : ''}${VOICE_FIELDS_REQUIREMENT}
${voicePrompt}

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)",
      "voiceDesign": { "identity": "string", "texture": "string", "delivery": "string" },
      "refText": "string"${avatarJsonField}${colorJsonField},
      "priority": number (10 for teacher, 7 for assistant, 4-6 for student)${voiceJsonField}
    }
  ]
}`;

  return { systemPrompt, userPrompt };
}

export function buildAdaptAgentProfilesPrompt(opts: {
  seedAgents: SeedAgentProfile[];
  course: CourseContext;
}): AgentProfilesPrompt {
  const systemPrompt = `You are an expert instructional designer. Adapt a fixed roster of preset classroom agents to a specific course. This is a light adaptation, not a redesign. Return ONLY valid JSON, no markdown or explanation.`;

  const seeds = opts.seedAgents.map((a) => ({
    seedId: a.id,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));

  const userPrompt = `Adapt the following preset agents to this course:

${courseContextBlock(opts.course)}
Preset agents (seeds):
${JSON.stringify(seeds, null, 2)}

Requirements:
- Return exactly one entry per seed, with "seedId" copied verbatim from the seed. Do not add or remove agents.
- Keep every agent's role and overall character EXACTLY as in the seed.
- Language directive for this course: ${opts.course.languageDirective}
  Adapted names, personas, voiceDesign and refText must follow this language directive.
- "name": localize the seed name into the course language, keeping its meaning and personality (translate it; do not invent an unrelated name). If the seed name already follows the language directive, keep it unchanged.
- "persona": rewrite the seed persona in the course language, preserving ALL behavioral instructions, structure and tone, and weave in 1-2 light references to the course topic. Do not add or remove responsibilities.
${VOICE_FIELDS_REQUIREMENT}

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "seedId": "string (copied from seed)",
      "name": "string",
      "persona": "string",
      "voiceDesign": { "identity": "string", "texture": "string", "delivery": "string" },
      "refText": "string"
    }
  ]
}`;

  return { systemPrompt, userPrompt };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Parse + validate a generate-mode LLM response.
 * Throws on structural problems (callers map to API errors / fallbacks).
 */
export function parseGenerateAgentProfilesResponse(raw: string): GeneratedAgentProfile[] {
  const parsed = JSON.parse(stripCodeFences(raw)) as {
    agents?: Array<Record<string, unknown>>;
  };

  if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new Error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
  }
  const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
  if (teacherCount !== 1) {
    throw new Error(`Expected exactly 1 teacher, got ${teacherCount}`);
  }

  return parsed.agents.map((agent) => {
    const voiceDesign = normalizeVoiceDesign(agent.voiceDesign);
    const refText = normalizeRefText(agent.refText);
    return {
      name: asNonEmptyString(agent.name) || 'Agent',
      role: asNonEmptyString(agent.role) || 'student',
      persona: asNonEmptyString(agent.persona) || '',
      avatar: asNonEmptyString(agent.avatar),
      color: asNonEmptyString(agent.color),
      priority: typeof agent.priority === 'number' ? agent.priority : undefined,
      voice: asNonEmptyString(agent.voice),
      ...(voiceDesign ? { voiceDesign } : {}),
      ...(refText ? { refText } : {}),
    };
  });
}

/**
 * Parse an adapt-mode LLM response against the seeds.
 * Identity fields (id/role/avatar/color/priority/voiceConfig) always come from
 * the seed; a seed with no usable LLM entry is kept verbatim (adapted: false).
 * Throws only when the response is not parseable JSON at all.
 */
export function parseAdaptAgentProfilesResponse(
  raw: string,
  seedAgents: SeedAgentProfile[],
): AdaptedAgentProfile[] {
  const parsed = JSON.parse(stripCodeFences(raw)) as {
    agents?: Array<Record<string, unknown>>;
  };
  const entries = Array.isArray(parsed.agents) ? parsed.agents : [];
  const bySeedId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const seedId = asNonEmptyString(entry.seedId);
    if (seedId && !bySeedId.has(seedId)) bySeedId.set(seedId, entry);
  }

  return seedAgents.map((seed) => {
    const entry = bySeedId.get(seed.id);
    if (!entry) return { ...seed, adapted: false };

    const voiceDesign = normalizeVoiceDesign(entry.voiceDesign) ?? seed.voiceDesign;
    const refText = normalizeRefText(entry.refText) ?? seed.refText;
    return {
      ...seed,
      name: asNonEmptyString(entry.name) || seed.name,
      persona: asNonEmptyString(entry.persona) || seed.persona,
      ...(voiceDesign ? { voiceDesign } : {}),
      ...(refText ? { refText } : {}),
      adapted: true,
    };
  });
}
