# @maic/dsl

The **contract keystone** of the MAIC SDK family. `@maic/dsl` is *pure spec* — the
slide object-model types, (planned) JSON Schema, pure validators / type-guards,
and version/migration helpers — with **zero runtime dependencies** (no React, no
pptx, no echarts).

That purity is the whole point: the renderer, the importer, and any future
package can depend on `@maic/dsl` without pulling in junk.

## Dependency arrows (acyclic)

```
@maic/dsl       ->  (nothing)
@maic/renderer  ->  @maic/dsl
@maic/importer  ->  @maic/dsl
@maic/exporter  ->  @maic/dsl     (reserved, future)
```

`@maic/dsl` is the only package everything else depends on, and it depends on
nothing.

## What's in here

| Module        | Contents                                                            |
| ------------- | ------------------------------------------------------------------- |
| `slides.ts`   | The slide object model: `Slide`, `PPTElement` and all variants, theme, background, animation, table/chart/code types, plus `ElementTypes` / `ShapePathFormulasKeys` enums. |
| `guards.ts`   | Pure discriminant type-guards (`isTextElement`, …) and `PPT_ELEMENT_TYPES`. |
| `version.ts`  | `DSL_VERSION` + the `DslMigration` shape and (empty) migration registry. |

```ts
import type { Slide, PPTElement } from '@maic/dsl';
import { isTextElement, DSL_VERSION } from '@maic/dsl';
```

## Status

- **`maic-import` is wired up**: it depends on `@maic/dsl`, imports all slide
  types from it, and its vendored `openmaic/types/slides.ts` copy has been
  deleted. The importer now emits complete DSL `Slide` objects directly (the old
  partial "draft slide" + post-fill step is gone — see below).
- **`@maic/renderer` is not wired yet**: it still vendors its own copy of the
  slide types. Re-pointing it at `@maic/dsl` is the next step.

### Roadmap

- [x] Wire `@maic/importer` (`maic-import`) to import types from `@maic/dsl`
      (vendored `slides.ts` copy deleted).
- [ ] Wire `@maic/renderer` (`maic-renderer`) the same way.
- [ ] Add the JSON Schema for the slide contract + a pure schema validator.
- [ ] Promote the `stage` / `scene` / `scene-content` types into the DSL (these
      currently live in `lib/types/stage.ts` and carry deps on `Action`, PBL,
      Widgets, generation types — those pure types need migrating too).
- [ ] Reserve `@maic/exporter` as the 4th family member.

## Divergence reconciled (seed provenance)

The seed is the app's `lib/types/slides.ts`, but before this package existed the
contract had been copy-pasted into three places that **drifted apart**. This
package is the **canonical superset**: every field that existed in any copy is
kept, so consumers can adopt the DSL without losing data. Merged-in fields are
annotated `@since-merge` in `slides.ts`.

| Field                                   | app `lib/types` | renderer copy | importer copy | DSL decision |
| --------------------------------------- | :-------------: | :-----------: | :-----------: | ------------ |
| `PPTTextElement.vAlign`                 |        —        |       ✓       |       ✓       | kept |
| `PPTImageElement.softEdge`              |        —        |       ✓       |       ✓       | kept |
| `TableCellBorder` + `TableCell.borders` |        —        |       ✓       |       ✓       | kept |
| `TableCell.padding`                     |        —        |       ✓       |       ✓       | kept |
| `TableCell.vAlign`                      |        —        |  `top/middle/bottom`  | `up/mid/down/top/middle/bottom` | canonical = `top/middle/bottom`; importer already normalizes its `up/mid/down` aliases in `transformParsedToSlides` |
| `PPTTableElement.rowHeights`            |        —        |       ✓       |       ✓       | kept |
| `Slide.script` (speaker notes)          |        —        |       —       |       ✓       | kept |
| `Slide.viewportSize/viewportRatio/theme`|    required     |   required    |   optional    | canonical = **required**; importer now fills them at construction in `transformParsedToSlides` (no partial/draft stage) |
| `SlideData` (deprecated)                |        ✓        |       —       |       ✓       | kept, `@deprecated` |

The importer already conforms to the canonical contract: it normalizes cell
`vAlign` aliases and emits the required `Slide` fields on output. When the
renderer is re-pointed at the DSL it will additionally gain `script`.

## Build

Pure TypeScript compiled with `tsc` to ESM + `.d.ts`:

```bash
pnpm --filter @maic/dsl build      # -> dist/ (index.js, index.d.ts, …)
pnpm --filter @maic/dsl typecheck
```

## License

MIT. (The family-wide license policy is still being decided — `@maic/renderer`
is currently AGPL-3.0 and `@maic/importer` is MIT. A pure contract keystone is most
useful under a permissive license so anything can depend on it; revisit if the
family standardizes on a single policy.)
