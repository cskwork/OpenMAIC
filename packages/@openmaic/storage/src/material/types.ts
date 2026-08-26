/**
 * Durable session-scoped material records.
 *
 * A material is the session-visible metadata row for one persisted piece of
 * content (today: a `web` page fetched by the host's `fetch_url` tool). The
 * bytes are not kept on this row — they are stored through the package's
 * hash-addressed asset registry/byte store and the row records the returned
 * asset ids (`textAssetId` for the extracted markdown, `rawAssetId` for the
 * optional raw download), exactly like the reference product's `ossKey`
 * linkage. The material id (`mat_` + Crockford base32 suffix) is minted by
 * {@link createMaterialId}, mirroring the reference's id shape.
 *
 * No per-owner quota and no extraction queue in this slice: materials are
 * session-scoped only, and a `web` material is already extracted at fetch time.
 */
import { randomBytes } from 'node:crypto';

const CROCKFORD_BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

/** Allocate a private material id from 128 random bits (reference id shape). */
export function createMaterialId(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let encoded = '';

  for (const byte of bytes) {
    value = value * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += CROCKFORD_BASE32[(value / 2 ** bits) & 31];
      value %= 2 ** bits;
    }
  }
  if (bits > 0) encoded += CROCKFORD_BASE32[(value * 2 ** (5 - bits)) & 31];
  return `mat_${encoded}`;
}

/**
 * The reference store's kind vocabulary. Only `web` is written by this slice,
 * but the CHECK keeps the full forward-compatible set so a later slice can
 * persist `source` uploads and derived extraction/transcript/media records
 * without a migration.
 */
export const AGENT_SESSION_MATERIAL_KINDS = [
  'source',
  'extraction',
  'transcript',
  'audio-track',
  'image',
  'web',
] as const;

export type AgentSessionMaterialKind = (typeof AGENT_SESSION_MATERIAL_KINDS)[number];

export function isAgentSessionMaterialKind(value: unknown): value is AgentSessionMaterialKind {
  return (
    typeof value === 'string' && (AGENT_SESSION_MATERIAL_KINDS as readonly string[]).includes(value)
  );
}

/** One durable session-scoped material row. */
export interface AgentSessionMaterial {
  id: string;
  sessionId: string;
  kind: AgentSessionMaterialKind;
  title: string | null;
  /** The fetch's source URL; never a model-invented target. */
  sourceUrl: string | null;
  /** Asset id (registry) of the extracted text/markdown bytes. */
  textAssetId: string | null;
  /** Optional asset id (registry) of the raw downloaded bytes. */
  rawAssetId: string | null;
  /** Character count of the extracted text, for preview/paging decisions. */
  textChars: number;
  /** ISO-8601 timestamp of the row. */
  createdAt: string;
}

export interface CreateAgentSessionMaterialInput {
  /** Caller-minted stable id; defaults to a fresh `mat_` id. */
  id?: string;
  kind: AgentSessionMaterialKind;
  title?: string;
  sourceUrl?: string;
  textAssetId?: string;
  rawAssetId?: string;
  textChars?: number;
}

export interface ListAgentSessionMaterialsOptions {
  /** Maximum rows returned (default 50, capped at 200). */
  limit?: number;
  /** Keyset cursor: a material id from the previous page; returns older rows. */
  before?: string;
}

/** A material operation failed for a reason the caller can act on. */
export class AgentSessionMaterialError extends Error {
  override readonly name = 'AgentSessionMaterialError';

  constructor(
    readonly code: 'invalid_input' | 'session_missing',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Session-scoped material store: create / list (keyset paged) / read.
 * Every read is scoped by `sessionId`; a foreign or nonexistent id reads as
 * absent, never as another session's row.
 */
export interface AgentSessionMaterialStore {
  createMaterial(
    sessionId: string,
    input: CreateAgentSessionMaterialInput,
  ): Promise<AgentSessionMaterial>;
  listMaterials(
    sessionId: string,
    options?: ListAgentSessionMaterialsOptions,
  ): Promise<AgentSessionMaterial[]>;
  getMaterial(sessionId: string, materialId: string): Promise<AgentSessionMaterial | null>;
}
