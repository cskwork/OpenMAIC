/**
 * Agent Profiles Generation API
 *
 * Two modes over one response shape (`{ agents }`):
 * - generate (default): invent agent profiles (teacher, assistant, student)
 *   for a course stage based on stage info and scene outlines.
 * - adapt (`seedAgents` provided): lightly fit the given preset agents to the
 *   course — localized name, course-flavored persona, voiceDesign + refText —
 *   while identity fields (role/avatar/color/priority/voiceConfig) stay locked
 *   to the seed. Adapted copies get fresh `gen-` ids so they never collide
 *   with the preset registry entries.
 */

import { NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { AGENT_COLOR_PALETTE } from '@/lib/constants/agent-defaults';
import {
  buildAdaptAgentProfilesPrompt,
  buildGenerateAgentProfilesPrompt,
  parseAdaptAgentProfilesResponse,
  parseGenerateAgentProfilesResponse,
  type SeedAgentProfile,
} from '@/lib/generation/agent-profiles';

const log = createLogger('Agent Profiles API');

export const maxDuration = 120;

interface RequestBody {
  stageInfo: { name: string; description?: string };
  sceneOutlines?: { title: string; description?: string }[];
  languageDirective: string;
  availableAvatars?: string[];
  avatarDescriptions?: Array<{ path: string; desc: string }>;
  availableVoices?: Array<{
    providerId: string;
    voiceId: string;
    voiceName: string;
    voiceLanguage?: string;
  }>;
  /** Present → adapt mode: fit these preset agents to the course. */
  seedAgents?: SeedAgentProfile[];
}

function isUsableSeed(seed: unknown): seed is SeedAgentProfile {
  if (!seed || typeof seed !== 'object') return false;
  const record = seed as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.role === 'string' &&
    typeof record.persona === 'string'
  );
}

export async function POST(req: NextRequest) {
  let stageName: string | undefined;
  let modelString: string | undefined;
  try {
    const body = (await req.json()) as RequestBody;
    const {
      stageInfo,
      sceneOutlines,
      languageDirective,
      availableAvatars,
      avatarDescriptions,
      availableVoices,
    } = body;
    stageName = stageInfo?.name;
    const seedAgents = Array.isArray(body.seedAgents) ? body.seedAgents.filter(isUsableSeed) : [];
    const adaptMode = seedAgents.length > 0;

    // ── Validate required fields ──
    if (!stageInfo?.name) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageInfo.name is required');
    }
    if (!languageDirective) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'languageDirective is required');
    }
    if (!adaptMode && (!availableAvatars || availableAvatars.length === 0)) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'availableAvatars is required and must not be empty',
      );
    }

    // ── Model resolution from request headers/body ──
    const {
      model: languageModel,
      modelString: _modelString,
      thinkingConfig,
    } = await resolveModelFromRequest(req, body);
    modelString = _modelString;

    const course = {
      courseName: stageInfo.name,
      courseDescription: stageInfo.description,
      sceneOutlines,
      languageDirective,
    };
    const { systemPrompt, userPrompt } = adaptMode
      ? buildAdaptAgentProfilesPrompt({ seedAgents, course })
      : buildGenerateAgentProfilesPrompt({
          ...course,
          availableAvatars,
          avatarDescriptions,
          colorPalette: [...AGENT_COLOR_PALETTE],
          availableVoices,
        });

    log.info(
      `${adaptMode ? `Adapting ${seedAgents.length} preset` : 'Generating'} agent profiles for "${stageInfo.name}" [model=${modelString}]`,
    );

    const rawResult = (
      await callLLM(
        {
          model: languageModel,
          system: systemPrompt,
          prompt: userPrompt,
        },
        'agent-profiles',
        undefined,
        thinkingConfig,
      )
    ).text;

    if (adaptMode) {
      let adapted: ReturnType<typeof parseAdaptAgentProfilesResponse>;
      try {
        adapted = parseAdaptAgentProfilesResponse(rawResult, seedAgents);
      } catch {
        log.error('Failed to parse LLM response as JSON:', rawResult.substring(0, 500));
        return apiError('PARSE_FAILED', 500, 'Failed to parse agent profiles from LLM response');
      }
      const agents = adapted.map(({ adapted: _adapted, ...agent }) => ({
        ...agent,
        id: `gen-${nanoid(8)}`,
      }));
      log.info(
        `Adapted ${adapted.filter((a) => a.adapted).length}/${seedAgents.length} preset agents for "${stageInfo.name}"`,
      );
      return apiSuccess({ agents });
    }

    let generated: ReturnType<typeof parseGenerateAgentProfilesResponse>;
    try {
      generated = parseGenerateAgentProfilesResponse(rawResult);
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      if (message.startsWith('Expected')) {
        log.error(message);
        return apiError('GENERATION_FAILED', 500, `${message} (from LLM)`);
      }
      log.error('Failed to parse LLM response as JSON:', rawResult.substring(0, 500));
      return apiError('PARSE_FAILED', 500, 'Failed to parse agent profiles from LLM response');
    }

    // ── Build output with IDs ──
    const agents = generated.map((agent, index) => {
      // Parse voice "providerId::voiceId" format
      let voiceConfig: { providerId: string; voiceId: string } | undefined;
      if (agent.voice && agent.voice.includes('::')) {
        const [providerId, voiceId] = agent.voice.split('::');
        if (providerId && voiceId) {
          voiceConfig = { providerId, voiceId };
        }
      }

      return {
        id: `gen-${nanoid(8)}`,
        name: agent.name,
        role: agent.role,
        persona: agent.persona,
        avatar: agent.avatar || availableAvatars![index % availableAvatars!.length],
        color: agent.color || AGENT_COLOR_PALETTE[index % AGENT_COLOR_PALETTE.length],
        priority:
          agent.priority ?? (agent.role === 'teacher' ? 10 : agent.role === 'assistant' ? 7 : 5),
        ...(voiceConfig ? { voiceConfig } : {}),
        ...(agent.voiceDesign ? { voiceDesign: agent.voiceDesign } : {}),
        ...(agent.refText ? { refText: agent.refText } : {}),
      };
    });

    log.info(`Successfully generated ${agents.length} agent profiles for "${stageInfo.name}"`);

    return apiSuccess({ agents });
  } catch (error) {
    log.error(
      `Agent profiles generation failed [stage="${stageName ?? 'unknown'}", model=${modelString ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
