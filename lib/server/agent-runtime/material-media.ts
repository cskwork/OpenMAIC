import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssetStore } from '@openmaic/storage';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { getSessionMaterial } from './session-materials';

const Params = Type.Object({
  materialId: Type.String({ description: 'The session material id to promote.' }),
});

export interface MaterialMediaDeps {
  sessionId: string;
  getMaterial?: typeof getSessionMaterial;
  assetStore?: Pick<AssetStore, 'resolve' | 'put'>;
}

export function buildMaterialMediaTool(deps: MaterialMediaDeps): AgentTool<never, never> {
  return {
    name: 'use_material_media',
    label: 'Use material media',
    description:
      'Promote one session image, video, or audio material into the course asset registry and return its stable src.',
    parameters: Params,
    async execute(_callId: string, params: Static<typeof Params>, signal?: AbortSignal) {
      const material = await (deps.getMaterial ?? getSessionMaterial)(
        deps.sessionId,
        params.materialId,
      );
      if (!material?.rawAssetId) {
        return {
          content: [{ type: 'text', text: 'Media material not found or has no media bytes.' }],
          details: { materialId: params.materialId },
          isError: true,
        };
      }
      const store =
        deps.assetStore ??
        (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).assetStore;
      const source = await store.resolve(
        { key: `session-materials:${deps.sessionId}` },
        material.rawAssetId,
      );
      if (!source) {
        return {
          content: [{ type: 'text', text: 'Media bytes are unavailable.' }],
          details: { materialId: material.id },
          isError: true,
        };
      }
      if (signal?.aborted) throw new Error('aborted');
      if (!/^(image|video|audio)\//.test(source.mime)) {
        return {
          content: [
            { type: 'text', text: 'Only image, video, or audio materials can be promoted.' },
          ],
          details: { materialId: material.id, mimeType: source.mime },
          isError: true,
        };
      }
      const src = await store.put(
        { key: 'shared' },
        new Blob([Buffer.from(source.bytes)], { type: source.mime }),
        { contentType: source.mime },
      );
      return {
        content: [{ type: 'text', text: `Use src "${src}" for the slide media element.` }],
        details: {
          materialId: material.id,
          src,
          mimeType: source.mime,
          bytes: source.bytes.byteLength,
        },
      };
    },
  } as unknown as AgentTool<never, never>;
}

export const MATERIAL_MEDIA_TOOL_NAME = 'use_material_media' as const;
