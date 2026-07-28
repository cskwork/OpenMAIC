/**
 * @openmaic/storage — the MAIC pluggable persistence layer.
 *
 * Dependency arrow (kept acyclic): `@openmaic/storage -> @openmaic/dsl` only.
 * The DSL owns *what* persists (document/runtime shape + validation + migration
 * + the asset `StorageProvider` interface); this package owns *where/how* it
 * persists — the KV / asset primitives and their swappable backends. The
 * pluggable seam is the backend, not the database driver.
 *
 * Every primitive ships a browser backend (zero server) and an HTTP backend
 * that speaks a documented contract, proven equivalent by one shared contract
 * suite per primitive. `KVStore` is the one asymmetric case: only its `account`
 * scope has an HTTP backend, because `device` values never leave the device.
 */
export type { KVScope, KVStore } from './kv/types.js';
export { DEFAULT_KV_SCOPE } from './kv/types.js';
export { BrowserKVStore, type BrowserKVStoreOptions } from './kv/browser.js';
export {
  HttpAccountKV,
  HttpKVStore,
  HttpKVStoreError,
  type HttpAccountKVOptions,
  type HttpKVHeadersContext,
  type HttpKVHeadersHook,
  type HttpKVStoreOptions,
} from './kv/http.js';
export { BrowserAssetProvider, type BrowserAssetProviderOptions } from './asset/browser.js';
export { assetRefForBytes, computeAssetRef, isContentAssetRef } from './asset/content-ref.js';
export {
  HttpAssetProvider,
  HttpAssetProviderError,
  type HttpAssetHeadersContext,
  type HttpAssetHeadersHook,
  type HttpAssetProviderOptions,
} from './asset/http.js';

export {
  kvPersistStorage,
  type PersistedValue,
  type PersistStorageLike,
} from './zustand/persist.js';

export type {
  DocumentStore,
  MaicDocument,
  DocumentSummary,
  SceneLike,
  SceneValidator,
  StageValidator,
} from './document/types.js';
export { DocumentNotFoundError, DocumentVersionError } from './document/types.js';
export { BrowserDocumentStore, type BrowserDocumentStoreOptions } from './document/browser.js';
export {
  HttpDocumentStore,
  HttpDocumentStoreError,
  type HttpDocumentHeadersContext,
  type HttpDocumentHeadersHook,
  type HttpDocumentStoreOptions,
} from './document/http.js';
export {
  PgDocumentStore,
  DOCUMENT_PG_SCHEMA,
  ensureDocumentSchema,
  type PgDocumentStoreOptions,
} from './document/pg.js';

export type {
  RuntimeStore,
  RuntimeSessionInit,
  RuntimePayloadValidator,
  RuntimeAppendOptions,
  RuntimeTailOptions,
} from './runtime/types.js';
export { RuntimeAppendConflictError } from './runtime/types.js';
export { BrowserRuntimeStore, type BrowserRuntimeStoreOptions } from './runtime/browser.js';

// Re-export the DSL-owned asset contract for convenience, so consumers can get
// the interface and a backend from one import without reaching into the DSL.
export type { AssetRef, AssetMeta, BinaryBlob, StorageProvider } from '@openmaic/dsl';
