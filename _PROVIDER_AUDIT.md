# Provider Decoupling Audit

## Scope and method

This audit covers the nine upstream-provider seams requested: LLM stage routing and the agent driver, TTS, voice registration/cloning, ASR, image generation, video generation, web search, document/PDF extraction, and object storage. Each seam was evaluated against six criteria:

1. **Contract** — a provider-neutral callable contract exists and is sufficient.
2. **Registry dispatch** — generic callers dispatch through a registry rather than vendor branches.
3. **Neutral generic layer** — generic routes, orchestration, and configuration resolution contain no vendor identifiers.
4. **Configuration symmetry** — providers use the same configuration path and precedence rules.
5. **Fail loud** — unsupported, absent, or invalid configurations fail at the boundary rather than silently changing providers.
6. **Explicit capabilities** — optional behavior is declared as data instead of inferred from provider identity, model names, or method presence.

`Pass` means the criterion holds for the complete seam, `Partial` means a usable abstraction exists but has exceptions, and `Fail` means normal provider integration still requires vendor knowledge in a generic layer.

## Scorecard

| Seam | Contract | Registry dispatch | Neutral generic layer | Config symmetry | Fail loud | Explicit capabilities |
| --- | --- | --- | --- | --- | --- | --- |
| LLM stage routing + agent driver | Partial | Partial | Fail | Partial | Partial | Partial |
| TTS | Partial | Fail | Fail | Partial | Partial | Partial |
| Voice registration/cloning | Pass | Pass | Fail | Partial | Pass | Partial |
| ASR | Partial | Fail | Fail | Partial | Pass | Partial |
| Image generation | Partial | Pass | Pass | Partial | Pass | Partial |
| Video generation | Partial | Pass | Pass | Partial | Fail | Partial |
| Web search | Partial | Fail | Fail | Fail | Partial | Fail |
| Document/PDF extraction | Pass | Partial | Fail | Fail | Partial | Pass |
| Object storage | Partial | Fail | Fail | Fail | Partial | Partial |

The strongest seams are image generation and the document/media extractor registries. The largest risks are web search, legacy PDF dispatch, and storage selection. Voice registration has a good adapter boundary, but its route currently bypasses that boundary for Qwen model selection and error translation.

## 1. LLM stage routing and agent driver

### Contract and dispatch

- The stage surface is explicit in `lib/server/model-routes.ts:131-154`; registry-derived stage lookup happens in `lib/server/model-routes.ts:253`.
- Model construction is centralized in `lib/ai/providers.ts:2056-2250`, but it is a provider-type switch rather than adapter registration.
- `lib/server/resolve-model.ts:55-110` is the generic server resolver. It fails for missing or unknown explicit provider references, but contains Bedrock policy and messaging at `lib/server/resolve-model.ts:100-101`.
- The agent driver dispatches transport dialect using the OpenAI-named set and string values at `lib/server/agent-runtime/agent-driver-model.ts:12-19` instead of a provider capability.
- `lib/orchestration/ai-sdk-adapter.ts` accepts an already-resolved `LanguageModel` and is provider-neutral.

The contract covers model creation and stage selection but not server-managed credential policy, transport dialect, thinking-request adaptation, or compatibility behavior. Those gaps cause identity checks in resolution and the driver. Presence is partly explicit (`ProviderType`, stage routes) and partly inferred from provider identity and compatibility maps. A bare model name ultimately defaults to OpenAI at `lib/ai/providers.ts:2317-2358`, which is backward-compatible but not fail-loud.

### Files required to add hypothetical vendor `acme`

- `lib/types/provider.ts` — add the built-in ID/type and protocol shape.
- `lib/ai/providers.ts` — add catalog metadata, model construction, and any compatibility adapter.
- `lib/server/provider-config.ts` — add server/client key and base-URL resolution if the standard provider-config map cannot express it.
- `lib/store/settings.ts` — add persisted default configuration and migration behavior.
- `tests/ai/acme-provider.test.ts` — add provider construction and request-shape coverage.
- `tests/server/provider-config.test.ts` — add configuration precedence and missing-credential coverage.
- `tests/server/model-routes.test.ts` — add stage override coverage if `acme` is used in model routes.
- `tests/agent-runtime/agent-driver-model.test.ts` — add coverage only if `acme` introduces a driver transport dialect; the desired design is a capability declaration in the provider contract, with no neutral-driver edit.
- `package.json` and `pnpm-lock.yaml` — required only when the adapter uses a new SDK dependency.

## 2. TTS

### Contract and dispatch

- `TTSProviderConfig` at `lib/audio/types.ts:113-130` describes metadata, models, voices, formats, and speed, but it is not a callable adapter contract and has no error classifier or health/probe method.
- The catalog is `TTS_PROVIDERS` in `lib/audio/constants.ts`; execution dispatch is the switch in `lib/audio/tts-providers.ts:170-205` and implementations remain in the same module.
- The generic generation route imports and branches on Qwen and VoxCPM behavior at `app/api/generate/tts/route.ts:11-28,65-91,122-135,170-174`.
- Qwen model/configuration policy is separately encoded in `lib/server/provider-config.ts:659-721`; persisted defaults are vendor-shaped in `lib/store/settings.ts:478-522`.
- Custom TTS silently uses the OpenAI-compatible implementation at `lib/audio/tts-providers.ts:202-203`; this behavior is implicit in type/category rather than declared capability.

Configuration is symmetric for the common API key/base URL/model fields but not for clone models, special request fields, or error mapping. Unknown providers fail in the dispatcher, while several provider-specific fallbacks and special cases occur before that boundary.

### Files required to add hypothetical vendor `acme-tts`

- `lib/audio/types.ts` — add the built-in provider ID and any configuration fields.
- `lib/audio/constants.ts` — add provider metadata, models, voices, formats, and speed limits.
- `lib/audio/tts-providers.ts` — add implementation and switch dispatch under the current architecture.
- `lib/audio/provider-display.ts` — add the localized display-name key mapping.
- `lib/store/settings.ts` — add persisted provider defaults/migration behavior.
- `lib/server/provider-config.ts` — add server override resolution if the provider needs nonstandard credentials, model pins, or base URLs.
- `app/api/generate/tts/route.ts` — required under the current architecture if request preparation or errors differ; this is precisely the neutral-layer edit an adapter contract should eliminate.
- `lib/i18n/locales/ar-SA.json`, `lib/i18n/locales/de-DE.json`, `lib/i18n/locales/en-US.json`, `lib/i18n/locales/es-MX.json`, `lib/i18n/locales/fr-FR.json`, `lib/i18n/locales/ja-JP.json`, `lib/i18n/locales/ko-KR.json`, `lib/i18n/locales/pt-BR.json`, `lib/i18n/locales/ru-RU.json`, `lib/i18n/locales/vi-VN.json`, `lib/i18n/locales/zh-CN.json`, and `lib/i18n/locales/zh-TW.json` — add the provider display name.
- `tests/audio/acme-tts.test.ts`, `tests/audio/provider-enablement.test.ts`, and `tests/server/tts-route-missing-key.test.ts` — implementation, selection, and boundary failure coverage.
- `package.json` and `pnpm-lock.yaml` — only if a new SDK is needed.

## 3. Voice registration and cloning

### Contract and dispatch

- `VoiceRegistrationAdapter` at `lib/audio/voice-registration.ts:23-53` is a real callable contract with `exists`, `register`, optional `delete`, and bootstrap behavior.
- `VOICE_REGISTRATION_ADAPTERS` at `lib/audio/voice-registration.ts:56-59` and lookup at `lib/audio/voice-registration.ts:61-72` provide registry dispatch and explicit `supportsRegistration`/`supportsBootstrapReferenceClip` capabilities.
- `app/api/generate/voice/route.ts:142-144` selects a Qwen clone model with a provider ternary instead of asking the adapter.
- `app/api/generate/voice/route.ts:23,34,237-244` imports and maps Qwen-specific error types/codes in the generic route.

The route is fail-loud for missing adapters and registration failures. Configuration is not fully symmetric because clone-model resolution lives in `lib/server/provider-config.ts:659-721`, outside the adapter. Delete support is inferred from an optional method; it should be an explicit capability paired with the method.

### Files required to add hypothetical vendor `acme-tts` voice registration

- `lib/audio/voice-registration-adapters/acme.ts` — implement the adapter, including model resolution and neutral error classification after the contract is completed.
- `lib/audio/voice-registration.ts` — register the adapter and extend the contract/capabilities if required.
- `tests/audio/voice-registration.test.ts` — registry and capability coverage.
- `tests/audio/acme-voice-registration.test.ts` — provider behavior, delete, bootstrap, and error classification coverage.
- The TTS files listed in section 2 — required if `acme-tts` is also a new synthesis provider rather than registration for an existing provider.

No edit to `app/api/generate/voice/route.ts` should be necessary after clone-model resolution and error classification move behind the adapter.

## 4. ASR

### Contract and dispatch

- `ASRProviderConfig` at `lib/audio/types.ts:169-179` describes metadata and supported languages but not a callable transcription adapter, error contract, or probe.
- `ASR_PROVIDERS` is the catalog in `lib/audio/constants.ts`; execution dispatch is the switch at `lib/audio/asr-providers.ts:175-204`.
- The transcription route uses the common resolver and fails when the provider is missing or disabled at `app/api/transcription/route.ts:40-51`.
- Custom ASR implicitly falls back to the OpenAI-compatible implementation at `lib/audio/asr-providers.ts:200-201`; FunASR/Lemonade compatibility is inferred by an identity helper at `lib/audio/asr-providers.ts:215-218`.
- Selection in `lib/server/provider-config.ts:750-753` chooses the first configured provider, while persisted defaults reside in `lib/store/settings.ts:478-522`.

Configuration is symmetric for common fields, and the route fails loudly, but execution and compatibility capabilities remain identity-based.

### Files required to add hypothetical vendor `acme-asr`

- `lib/audio/types.ts` — add the built-in provider ID/configuration.
- `lib/audio/constants.ts` — add metadata, model, URL, and languages.
- `lib/audio/asr-providers.ts` — add implementation and switch dispatch under the current architecture.
- `lib/audio/provider-display.ts` — add the localized display-name key mapping.
- `lib/store/settings.ts` — add persisted defaults/migration behavior.
- `lib/server/provider-config.ts` — add nonstandard server configuration resolution if needed.
- The same twelve `lib/i18n/locales/*.json` files enumerated in section 2 — add the provider display name.
- `tests/audio/acme-asr.test.ts`, `tests/audio/provider-enablement.test.ts`, and `tests/audio/asr-force-off.test.ts` — implementation, selection, and disable/failure coverage.
- `package.json` and `pnpm-lock.yaml` — only if a new SDK is needed.

## 5. Image generation

### Contract and dispatch

- `ImageProviderConfig` at `lib/media/types.ts:102-124` explicitly declares size, aspect-ratio, input-image, model, and key requirements, but execution and error classification are not part of the interface.
- `IMAGE_PROVIDERS` at `lib/media/image-providers.ts:33` is the catalog. Connectivity and generation dispatch through adapter maps/switches at `lib/media/image-providers.ts:166-214`.
- `app/api/generate/image/route.ts:57-61` fails for an unavailable provider; normal route logic is provider-neutral.
- Common server configuration chooses the first enabled provider at `lib/server/provider-config.ts:826-829`; defaults are enumerated in `lib/store/settings.ts:545-559`.

Capabilities are mostly explicit in catalog data. The remaining weakness is that the contract is split between metadata and conventionally shaped adapter functions rather than one checked adapter interface. Config resolution is symmetric after each provider has been manually added to default persisted state.

### Files required to add hypothetical vendor `acme-image`

- `lib/media/types.ts` — add the provider ID and any capability/config fields.
- `lib/media/image-providers.ts` — add catalog metadata and register connectivity/generation adapters.
- `lib/media/adapters/acme-image.ts` — implement generation and connectivity behavior.
- `lib/store/settings.ts` — add persisted default configuration.
- `lib/server/provider-config.ts` — add nonstandard server override resolution if needed.
- `tests/media/acme-image-adapter.test.ts`, `tests/media/seed-provider-catalog.test.ts`, and `tests/server/provider-config.test.ts` — adapter, catalog, and resolution coverage.
- `package.json` and `pnpm-lock.yaml` — only if a new SDK is needed.

## 6. Video generation

### Contract and dispatch

- `VideoProviderConfig` at `lib/media/types.ts:212-233` explicitly declares models, durations, sizes, image-input support, key requirements, and optional browser mode, but there is no single callable adapter/error contract.
- `VIDEO_PROVIDERS` at `lib/media/video-providers.ts:22` is the catalog. Normalization, connectivity, and generation dispatch are centralized at `lib/media/video-providers.ts:136-218`.
- Generic routes are provider-neutral and reject unavailable providers.
- `sora` is advertised in the catalog at `lib/media/video-providers.ts:84-90` but has no connectivity or generation case in `lib/media/video-providers.ts:136-154,203-218`. This violates fail-loud-at-selection: a selectable provider reaches an unsupported execution path later.
- Common server configuration chooses the first enabled provider at `lib/server/provider-config.ts:879-882`; defaults are enumerated in `lib/store/settings.ts:561-574`.

Capabilities are primarily explicit, though polling/result normalization behavior is still associated with adapter identity rather than a checked unified contract.

### Files required to add hypothetical vendor `acme-video`

- `lib/media/types.ts` — add the provider ID and capabilities.
- `lib/media/video-providers.ts` — add catalog metadata and register normalization, connectivity, and generation behavior.
- `lib/media/adapters/acme-video.ts` — implement generation/polling/result normalization.
- `lib/store/settings.ts` — add persisted default configuration.
- `lib/server/provider-config.ts` — add nonstandard server override resolution if needed.
- `tests/media/acme-video-provider.test.ts`, `tests/media/video-manifest.test.ts`, and `tests/generation/video-manifest-wiring.test.ts` — adapter, catalog, and route wiring coverage.
- `package.json` and `pnpm-lock.yaml` — only if a new SDK is needed.

## 7. Web search

### Contract and dispatch

- `WebSearchProviderConfig` at `lib/web-search/types.ts:30-39` is metadata-only. `WebSearchParams` carries Baidu- and Claude-specific request fields at `lib/web-search/index.ts:20-21`.
- `lib/web-search/index.ts:37-78` dispatches with a provider switch.
- The API route defaults to Tavily at `app/api/web-search/route.ts:59-64`, branches for SearXNG at `app/api/web-search/route.ts:98`, shapes Baidu/Claude payloads at `app/api/web-search/route.ts:166-171`, and selects environment keys by provider at `app/api/web-search/route.ts:190-215`.
- URL validation has a vendor map and vendor option branches at `lib/server/web-search-config.ts:12-43,115-133`.
- Backward configuration resolution defaults to Tavily and uses the hard-coded order Tavily, Bocha, Baidu, MiniMax, Claude at `lib/server/provider-config.ts:918-968`.

This seam has no callable adapter contract, no registry execution dispatch, and no generic parameter-bag abstraction. Base-URL support, native-search behavior, sub-sources, and credential source are inferred from IDs. Unsupported providers fail in the execution switch, but silent default/fallback selection prevents the overall seam from being reliably fail-loud.

### Files required to add hypothetical vendor `acme-search`

- `lib/web-search/types.ts` — add the provider ID and any request/configuration fields.
- `lib/web-search/constants.ts` — add catalog metadata and fallback placement.
- `lib/web-search/acme.ts` — implement the search call under the current module layout.
- `lib/web-search/index.ts` — add switch dispatch.
- `app/api/web-search/route.ts` — add credential, URL, and payload branches under the current architecture.
- `lib/server/web-search-config.ts` — add URL policy and options.
- `lib/server/provider-config.ts` — add server resolution and precedence.
- `lib/store/settings.ts` — add persisted defaults and migration behavior.
- `tests/web-search/acme.test.ts`, `tests/web-search/index.test.ts`, `tests/web-search/route.test.ts`, `tests/server/web-search-config.test.ts`, and `tests/server/provider-config.test.ts` — adapter, dispatch, route, and precedence coverage.
- `package.json` and `pnpm-lock.yaml` — only if a new SDK is needed.

## 8. Document and PDF extraction

### Contract and dispatch

- `DocumentExtractorProvider` at `lib/document/types.ts:35-48` and `MediaExtractorProvider` at `lib/document/types.ts:72-90` are callable contracts. Their capability structures at `lib/document/types.ts:3-11,56-62` are explicit.
- Registry selection is generic in `lib/document/extractors/registry.ts:13-50` and `lib/document/extractors/media-registry.ts:7-44`; manifest capability selection is explicit in `lib/document/extractors/manifest.ts:59-152,195-247`.
- The legacy PDF seam still uses a switch at `lib/pdf/pdf-providers.ts:218-237`, and `PDFProviderConfig` carries Aliyun-specific credentials at `lib/pdf/types.ts:29-37`.
- The PDF document adapter branches on `alidocmind`, `mineru-cloud`, and `mineru` at `lib/document/extractors/pdf.ts:38-58`.
- The extraction route infers self-hosted MinerU from identity at `app/api/extract-document/route.ts:132-135`, defaults media extraction to AliDocMind at `app/api/extract-document/route.ts:220`, applies Ali credentials at `app/api/extract-document/route.ts:236`, and silently changes self-hosted MinerU to MinerU Cloud at `app/api/extract-document/route.ts:335-349`.
- The legacy PDF route defaults to `unpdf` at `app/api/parse-pdf/route.ts:40`.

The newer registry contract is strong, but its generic route and PDF bridge still know concrete vendors. Capability presence is explicit in the manifest. Configuration and fail-loud behavior are weakened by managed-vendor credentials and the self-hosted-to-cloud fallback.

### Files required to add hypothetical vendor `acme-document`

- `lib/document/types.ts` — add provider-specific configuration only if the neutral credential bag cannot express it; capability changes belong here.
- `lib/document/extractors/providers/acme.ts` — implement the document or media extractor.
- `lib/document/extractors/manifest.ts` — add manifest metadata and explicit capabilities.
- `lib/document/extractors/registry.ts` or `lib/document/extractors/media-registry.ts` — register the adapter.
- `lib/pdf/types.ts`, `lib/pdf/constants.ts`, and `lib/pdf/pdf-providers.ts` — additionally required while the legacy PDF surface remains supported.
- `lib/store/settings.ts` — add persisted defaults for a user-selectable provider.
- `lib/server/provider-config.ts` — add nonstandard managed credentials or server overrides under the current architecture.
- `app/api/extract-document/route.ts` — required under the current architecture if configuration is not representable by the neutral extractor request; the desired contract removes this edit.
- `tests/document/acme.test.ts`, `tests/document/extractor-manifest.test.ts`, `tests/document/extractor-registry.test.ts`, `tests/document/extract-document-route.test.ts`, `tests/document/pdf-providers.test.ts`, and `tests/api/verify-pdf-provider.test.ts` — adapter, manifest, registry, route, legacy bridge, and verification coverage.
- `package.json` and `pnpm-lock.yaml` — only if a new SDK is needed.

## 9. Object storage

### Contract and dispatch

- The package-level `AssetByteStore` contract at `packages/@openmaic/storage/src/asset/byte-store.ts:54-105` covers write, read, delete, and optional signed reads.
- The application-level legacy `StorageProvider` at `lib/storage/types.ts:3-12` covers upload, existence, URL, and batch existence; `lib/storage/index.ts:1-31` is fixed to a no-op implementation and swallows client errors into `null`.
- Actual asset-byte-store selection imports and constructs PostgreSQL or S3 directly in `lib/persistence/asset-byte-store.ts:1-71`. AWS/S3 names and environment semantics occur in this generic selection layer at `lib/persistence/asset-byte-store.ts:20-53`.
- `lib/persistence/server-provider.ts:45` supplies `ASSET_S3_BUCKET`; there is no registry or provider-neutral storage configuration object.
- Invalid S3 bucket/SDK configuration fails loudly, but absence of the S3 setting silently selects PostgreSQL. That default may be intentional, yet it is not represented as an explicit provider selection.
- Signed-read support is inferred from optional method presence at `lib/persistence/asset-byte-store.ts:103-115`, not declared as a capability.

The package contract is usable, but application composition is a two-provider conditional and configuration is vendor-specific. The older client-facing storage abstraction is incomplete and obscures failures.

### Files required to add hypothetical vendor `acme-object-store`

- `packages/@openmaic/storage/src/asset/acme-bytes.ts` — implement `AssetByteStore`.
- `packages/@openmaic/storage/src/index.ts` — export the adapter if it is part of the root public API.
- `packages/@openmaic/storage/package.json` — add an `./asset/acme-bytes` export.
- `lib/persistence/asset-byte-store.ts` — import, configure, and select it under the current architecture; the desired design replaces this conditional with a registry.
- `lib/persistence/server-provider.ts` — pass provider-neutral selection/configuration or, under the current architecture, Acme environment settings.
- `.env.example` — document required Acme settings.
- `packages/@openmaic/storage/test/asset/acme-bytes.test.ts` — contract and error coverage.
- `tests/runtime/runtime-storage-config.test.ts` and `tests/agent-runtime/entry-tree-storage.test.ts` — application selection and wiring coverage.
- `package.json` and `pnpm-lock.yaml` — only if the adapter uses a new SDK dependency.

## Vendor identifiers in generic layers

This table enumerates the observed vendor knowledge outside provider adapters/catalog composition roots. Repeated implementation-local references inside provider modules are intentionally not listed; those modules are the intended containment boundary.

| Generic location | Criterion | Severity | Vendor identifier or inference | Consequence | Proposed fix |
| --- | --- | --- | --- | --- | --- |
| `lib/server/resolve-model.ts:100-101` | C3, C4 | High | `bedrock`, Amazon Bedrock | Generic resolution owns vendor enablement policy and error text. | Move credential policy and neutral error classification to the provider descriptor. Temporarily allowlisted by exact token/count. |
| `lib/server/agent-runtime/agent-driver-model.ts:12-19` | C3, C6 | High | `OPENAI_PI_APIS`, `openai-completions`, `openai-responses` | Driver protocol is inferred using an OpenAI-named set. | Add an explicit agent-driver transport capability. Temporarily allowlisted by exact token/count. |
| `lib/ai/providers.ts:1610-1757` | C1, C2, C3 | High | OpenAI, Kimi, Xiaomi, GLM, DeepSeek, Qwen, SiliconFlow, Doubao, OpenRouter, Hunyuan, Lemonade, MiniMax | Compatibility behavior is a vendor switch in the central generic factory. | Move request adaptation into registered provider descriptors/adapters. |
| `lib/ai/providers.ts:2056-2250` | C2, C3 | High | All LLM provider types | Model construction is a central provider-type switch. | Register model factories by provider type. |
| `lib/ai/providers.ts:2317-2358` | C3, C5 | High | `openai` | Bare model IDs silently acquire an OpenAI provider ID. | Require an explicit provider or retain only behind a separately named legacy parser. |
| `lib/server/provider-config.ts:353-479` | C3, C4 | High | OpenAI image, AliDocMind, Bedrock | Generic config resolution has vendor credential/model branches. | Put server configuration resolvers on provider descriptors. |
| `lib/server/provider-config.ts:659-721` | C3, C4, C6 | High | Qwen | Clone-model pins and catalog-vs-clone policy live in shared config. | Move model resolution to `VoiceRegistrationAdapter`. |
| `lib/server/provider-config.ts:918-968` | C3, C4, C5 | High | Tavily, Bocha, Baidu, MiniMax, Claude | Default and fallback precedence is a fixed vendor order. | Store priority as registry metadata or explicit operator configuration. |
| `lib/store/settings.ts:478-614` | C3, C4 | Medium | Every built-in audio, PDF, image, video, and search provider | Persisted default shape must be edited for each vendor. | Derive empty/default provider state from registry metadata and version only true migrations. |
| `lib/store/settings.ts:1052-1077` | C3, C4 | Low | Qwen | A provider-specific migration resolves the clone model. | Keep historical migration isolated and prevent new runtime policy here. |
| `app/api/generate/tts/route.ts:11-28,65-91,122-135,170-174` | C1, C2, C3 | High | Qwen, VoxCPM | Generic TTS route owns request and error behavior. | Introduce a callable TTS adapter with prepare/generate/classify-error operations. |
| `lib/audio/tts-providers.ts:170-205` | C1, C2 | High | All TTS IDs | Central execution switch must change for every provider. | Register callable TTS adapters. |
| `lib/audio/tts-providers.ts:202-203` | C5, C6 | Medium | OpenAI-compatible fallback | Custom-provider capability is inferred and silently redirected. | Declare protocol capability on custom configuration. |
| `app/api/generate/voice/route.ts:23,142-144` | C3, C4, C6 | High | Qwen clone-model resolver and `qwen-tts` | Generic voice route chooses a provider model. | Add `resolveRegistrationModel` to the voice adapter. Temporarily allowlisted by exact token/count. |
| `app/api/generate/voice/route.ts:34,237-244` | C1, C3 | High | Qwen error class/message/code | Generic voice route maps provider errors. | Add neutral adapter error classification. Temporarily allowlisted by exact token/count. |
| `lib/audio/asr-providers.ts:175-218` | C1, C2, C6 | High | All ASR IDs; OpenAI/FunASR/Lemonade inference | Central switch and compatibility helper encode identity. | Register callable ASR adapters and protocol capabilities. |
| `lib/media/video-providers.ts:84-90,136-154,203-218` | C2, C5 | High | Sora | Catalog presence is not matched by executable dispatch. | Remove the selectable entry until an adapter exists, or register a complete adapter atomically. |
| `lib/web-search/index.ts:20-21,37-78` | C1, C2, C3 | High | Baidu, Claude and all search IDs | Generic request type and dispatcher encode vendors. | Introduce a `WebSearchAdapter` registry with provider-owned option validation. |
| `app/api/web-search/route.ts:59-64,98,166-215` | C3, C4, C5, C6 | High | Tavily, SearXNG, Baidu, Claude and credential cases | Route owns defaults, payload shape, URL rules, and key lookup. | Resolve one neutral search request/config before calling the selected adapter. |
| `lib/server/web-search-config.ts:12-43,115-133` | C3, C4, C6 | High | Official vendor URLs and vendor options | Shared validator must change for each vendor. | Move URL/options validation to adapter descriptors. |
| `lib/pdf/types.ts:29-37` | C1, C3, C4 | Medium | Aliyun | Generic legacy PDF config has vendor credentials. | Use an opaque provider configuration payload validated by the adapter. |
| `lib/pdf/pdf-providers.ts:209-237` | C2, C3 | High | PDF vendor key rules and all PDF IDs | Legacy PDF execution uses identity-based key handling and switch dispatch. | Delegate fully to the document extractor registry, then retire the legacy switch. |
| `lib/document/extractors/pdf.ts:38-58` | C2, C3 | Medium | AliDocMind, MinerU Cloud, MinerU | The PDF bridge branches within an otherwise registered extractor. | Register each PDF implementation independently with explicit capabilities. |
| `app/api/extract-document/route.ts:132-135,220,236,335-367` | C3, C4, C5, C6 | High | MinerU and AliDocMind | Generic route infers hosting mode, defaults a vendor, injects vendor credentials, and changes provider. | Move managed configuration/fallback policy into explicit selection before the route or into adapters; never silently change provider. |
| `app/api/parse-pdf/route.ts:40` | C3, C5 | Medium | `unpdf` | Legacy route silently chooses a concrete local implementation. | Make the local default explicit configuration or a named system policy. |
| `lib/persistence/asset-byte-store.ts:20-71` | C2, C3, C4 | High | AWS/S3 and PostgreSQL | Generic composition uses vendor environment variables and an if/else factory. | Add a storage adapter registry and neutral selected-provider configuration. |
| `lib/persistence/asset-byte-store.ts:103-115` | C6 | Medium | Optional `signReadUrl` method | Capability is inferred from method presence. | Declare `capabilities.signedReadUrl` and validate it against implementation. |
| `lib/persistence/server-provider.ts:45` | C3, C4 | High | `ASSET_S3_BUCKET` | Generic server composition passes a vendor setting. | Pass a neutral storage-provider configuration object. |
| `lib/storage/index.ts:1-31` | C2, C5 | High | Hard-coded no-op provider and swallowed error | The nominal generic storage entry point neither dispatches nor fails loudly. | Remove the obsolete abstraction or register a real provider and propagate typed failures. |

## Guard design

`tests/providers/provider-neutrality-guard.test.ts` adds a CI-suitable Vitest guard with these properties:

- Vendor vocabulary is derived from source-of-truth registry object keys, not maintained as a parallel hand-written vendor list. It reads LLM, TTS, ASR, image, video, web-search, PDF, document/media extractor, and voice-registration registries. Storage IDs are derived from the package's public `./asset/*-bytes` exports.
- The scanned surface is explicit and covers LLM routing/resolution/driver/orchestration, shared provider configuration, TTS/voice/ASR/image/video/search/document/PDF routes, web-search dispatch/configuration, document/media registry dispatch, and both object-storage entry points.
- Catalogs, composition roots, and concrete adapter/provider modules are deliberately exempt because those are the correct homes for vendor knowledge.
- The scanner parses TypeScript and checks identifier and literal/template tokens, avoiding comment-only matches.
- Every failure reports `file:line:column`, the derived vendor token, the matching source token, and the required action: move behavior into an adapter or add a provider-neutral contract method.
- Focused exceptions require exact file, vendor, AST token, and occurrence count. Broad pre-existing seams are pinned by exact file, derived vendor, and occurrence count. A new occurrence fails, and a removed occurrence makes the debt entry stale and fails. No entry suppresses a whole file or accepts an uncounted match.

### Temporary allowlist

Focused exceptions are:

- `lib/server/resolve-model.ts`: two `bedrock` literals and one Bedrock policy error string, pending a provider-owned server credential policy.
- `lib/server/agent-runtime/agent-driver-model.ts`: two `OPENAI_PI_APIS` references and one each of `openai-completions` and `openai-responses`, pending an explicit transport capability.
- `app/api/generate/voice/route.ts`: the Qwen clone-model resolver, Qwen error class/message/import, `qwen-tts`, and `QWEN_VC_TIMEOUT`, each pinned to its current exact occurrence count pending adapter model/error methods.

Broader existing debt is pinned by file/vendor/count:

- `lib/server/provider-config.ts`: Qwen 20, OpenAI 23, Azure 6, AtlasCloud 2, Anthropic 2, Google 2, DeepSeek 2, Kimi 2, MiniMax 13, GLM 4, SiliconFlow 2, Doubao 6, OpenRouter 2, Grok 6, Tencent 4, Hunyuan 3, Xiaomi 3, Ollama 3, Lemonade 12, Bedrock 29, VoxCPM 3, ElevenLabs 2, Whisper 1, FunASR 3, UnPDF 2, MinerU 5, Seedream 2, Banana 2, Nano 2, Seedance 2, Kling 2, Veo 2, Sora 2, Happyhorse 2, Tavily 7, Bocha 5, Brave 3, Baidu 5, Claude 5, SearXNG 3, browser-native-tts 1, browser-native 2, ComfyUI 2, and AliDocMind 13. These are temporary because the module is still a mixed catalog and resolver composition root.
- `app/api/generate/tts/route.ts`: Qwen 14, VoxCPM 12, browser-native-tts 2, and browser-native 2, pending TTS request/error adapters.
- `app/api/web-search/route.ts`: Baidu 9, Claude 8, Tavily 3, SearXNG 5, Bocha 2, Brave 2, MiniMax 2, and Doubao 2, pending adapter-owned credentials and request options.
- `app/api/extract-document/route.ts`: AliDocMind 6 and MinerU 9, pending adapter-owned managed configuration and explicit fallback policy.
- `app/api/parse-pdf/route.ts`: UnPDF 1, pending removal of the concrete legacy default.
- `lib/web-search/index.ts`: Baidu 9, Bocha 4, Brave 4, Claude 7, Doubao 4, MiniMax 4, SearXNG 4, and Tavily 4, pending registry dispatch.
- `lib/server/web-search-config.ts`: Baidu 11, Tavily 3, Bocha 7, Brave 4, Claude 5, Anthropic 2, MiniMax 9, Doubao 1, and SearXNG 2, pending adapter-owned URL and option validation.
- `lib/persistence/asset-byte-store.ts`: PostgreSQL 4 and S3 16; `lib/persistence/server-provider.ts`: PostgreSQL 13 and S3 1. These remain until storage selection and server composition use a neutral registry/configuration object.

No exception is an unbounded file-wide or vendor-wide suppression. The grouped entries are less relocation-sensitive than focused token entries: removing one occurrence while adding another for the same vendor in the same file preserves the count. This tradeoff keeps large existing seams protected against growth without encoding hundreds of token snapshots.

### Red-path evidence

The test injects an in-memory neutral-route fixture containing a new `qwen-tts` ternary and `resolveQwenModel` identifier. The scanner detects the registry-derived `qwen` token and verifies that the diagnostic names the fixture, vendor, source token, and required remediation. The fixture is not added to the repository as a permanently failing test, so the committed tree remains green.

## Verification

Verification results from the final tree:

- `VITEST_MAX_WORKERS=2 NODE_OPTIONS=--max-old-space-size=1024 pnpm exec vitest run ...`: 16 files passed, 1 file skipped; 156 tests passed, 3 tests skipped. This includes the three guard tests and representative LLM, TTS, voice, ASR, image, video, search, document/PDF, and storage suites.
- The injected red-path test passed by observing the expected Qwen violation and remediation diagnostic.
- `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit`: passed.
- `pnpm check`: passed after running Prettier with `--write` on both touched files.
- `pnpm lint`: passed with 0 errors. It reports 15 pre-existing warnings in untouched files; neither touched file reports a lint warning.

## What the guard cannot check

- The guard protects explicitly neutral files; it does not pretend that current mixed catalog/factory modules are neutral. Expanding its file list before extracting their switches would only create broad permanent suppressions.
- Vocabulary matching is lexical and registry-derived. It catches direct identifiers and literals, not semantic coupling expressed without a vendor token.
- Registry source declarations must remain object literals, and the storage package export map must remain readable; the test fails if a declaration disappears or changes form, preventing a silently empty vocabulary.
- The guard does not prove configuration precedence, error semantics, or capability completeness. Those require the seam-specific behavioral tests listed above.
- It cannot decide whether a provider difference is a legitimate adapter concern or missing neutral contract behavior; that remains an architectural review judgment.
- It cannot determine whether a fallback is product policy or an accidental silent vendor change; fail-loud semantics require periodic behavioral review.
- It cannot prove the enumerated add-a-vendor file cost remains exhaustive after future UI, persistence, or packaging changes; that operational exercise should be repeated during periodic review.

The highest-value next boundary is a common descriptor shape containing callable adapter, configuration resolver, error classifier, and explicit capabilities. Web search and TTS should migrate first; storage should then adopt the same registry/composition pattern.
