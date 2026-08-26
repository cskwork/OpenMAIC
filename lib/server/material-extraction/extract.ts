import {
  createMaterialId,
  toAssetId,
  type ClaimedMaterialExtraction,
  type CompleteMaterialExtractionInput,
} from '@openmaic/storage';

import {
  getDocumentExtractorProviders,
  type DocumentArtifact,
  type DocumentExtractorProvider,
} from '@/lib/document';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  getServerPDFProviders,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
} from '@/lib/server/provider-config';
import {
  getAgentSessionMaterialStore,
  materialPrincipal,
} from '@/lib/server/agent-runtime/session-materials';

import { isTransientExtractionError, MaterialExtractionError } from './errors';

export interface MaterialExtractionExecutionDependencies {
  resolveSource?: (
    sessionId: string,
    assetId: string,
  ) => Promise<{ bytes: Buffer; mime: string } | null>;
  providers?: () => DocumentExtractorProvider[];
  configuredProviderIds?: () => string[];
  putText?: (sessionId: string, text: Buffer) => Promise<string>;
  complete?: (input: CompleteMaterialExtractionInput) => Promise<boolean>;
}

function artifactText(artifact: DocumentArtifact): string {
  return artifact.blocks
    .filter((block) => block.type === 'text' || block.type === 'markdown')
    .map((block) => block.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join('\n\n');
}

function extractorCandidates(
  mime: string,
  providers: DocumentExtractorProvider[],
  configuredIds: string[],
): DocumentExtractorProvider[] {
  const supported = providers.filter((provider) =>
    provider.supportedMimeTypes.includes(mime.toLowerCase()),
  );
  const configured = new Set(configuredIds);
  return supported.toSorted(
    (left, right) => Number(configured.has(right.id)) - Number(configured.has(left.id)),
  );
}

async function defaultResolveSource(sessionId: string, assetId: string) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const provider = await getServerPersistenceProvider(connectionString);
  const asset = await provider.assetStore.resolve(materialPrincipal(sessionId), toAssetId(assetId));
  return asset ? { bytes: Buffer.from(asset.bytes), mime: asset.mime } : null;
}

async function defaultPutText(sessionId: string, text: Buffer): Promise<string> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const provider = await getServerPersistenceProvider(connectionString);
  return provider.assetStore.put(
    materialPrincipal(sessionId),
    new Blob([new Uint8Array(text)], { type: 'text/markdown' }),
    { contentType: 'text/markdown' },
  );
}

/** Extract one lease-fenced source through the upstream extractor registry. */
export async function extractClaimedSessionMaterial(
  claim: ClaimedMaterialExtraction,
  dependencies: MaterialExtractionExecutionDependencies = {},
): Promise<{ materialId: string; text: string; extractorVersion: string }> {
  const source = claim.material;
  if (!source.rawAssetId) throw new Error(`source material ${source.id} has no raw asset`);
  const resolveSource = dependencies.resolveSource ?? defaultResolveSource;
  const raw = await resolveSource(source.sessionId, source.rawAssetId);
  if (!raw) throw new Error(`source bytes are unavailable for material ${source.id}`);

  const providers = dependencies.providers?.() ?? getDocumentExtractorProviders();
  const configuredIds =
    dependencies.configuredProviderIds?.() ?? Object.keys(getServerPDFProviders());
  const candidates = extractorCandidates(raw.mime, providers, configuredIds);
  if (candidates.length === 0) throw new Error(`no document extractor supports ${raw.mime}`);

  const errors: string[] = [];
  const failures: unknown[] = [];
  let artifact: DocumentArtifact | undefined;
  let selected: DocumentExtractorProvider | undefined;
  for (const provider of candidates) {
    try {
      artifact = await provider.extract({
        buffer: raw.bytes,
        fileName: source.title ?? undefined,
        fileSize: raw.bytes.byteLength,
        mimeType: raw.mime,
        config: {
          providerId: provider.id,
          apiKey: resolvePDFApiKey(provider.id) || undefined,
          baseUrl: resolvePDFBaseUrl(provider.id),
          allowEnvFallback: true,
        },
      });
      selected = provider;
      break;
    } catch (error) {
      errors.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
      failures.push(error);
    }
  }
  if (!artifact || !selected) {
    throw new MaterialExtractionError(
      `document extraction failed (${errors.join('; ')})`,
      failures.some(isTransientExtractionError),
    );
  }

  const text = artifactText(artifact);
  const bytes = Buffer.from(text, 'utf8');
  const textAssetId = await (dependencies.putText ?? defaultPutText)(source.sessionId, bytes);
  const derivativeId = createMaterialId();
  const store = dependencies.complete ? undefined : await getAgentSessionMaterialStore();
  const complete = dependencies.complete ?? store!.completeExtraction.bind(store);
  const extractorVersion = `${selected.id}@${selected.version}`;
  const completed = await complete({
    sourceId: source.id,
    workerId: claim.workerId,
    extractorVersion,
    stats: {
      chars: text.length,
      pages: artifact.metadata.pageCount ?? 0,
      imageCount: artifact.assets.filter((asset) => asset.type === 'image').length,
      ...(artifact.diagnostics?.length
        ? { diagnostics: artifact.diagnostics.map((diagnostic) => diagnostic.message) }
        : {}),
    },
    derived: {
      id: derivativeId,
      kind: 'extraction',
      title: source.title ? `${source.title}.extracted.md` : 'extracted.md',
      textAssetId,
      textChars: text.length,
    },
  });
  if (!completed) throw new Error(`material extraction lease lost for ${source.id}`);
  return { materialId: derivativeId, text, extractorVersion };
}
