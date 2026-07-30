# Changesets

This folder holds the pending release intents for the published `@openmaic/*` packages. Each
`*.md` file here declares which packages a change releases and at what level. Nothing in this
repository edits a published version number by hand.

Full documentation: <https://github.com/changesets/changesets>. What follows is only what is
specific to this repository.

## Adding one

```bash
pnpm changeset  # pick packages and levels, write a summary
```

Commit the generated file with the rest of your change.

## What CI checks

`scripts/check-changesets.mjs`, on every pull request and every push to `main`. It fails unless
**every** publishable package changed in the range is named, at `patch`, `minor` or `major`, by a
changeset **added** in that same range.

That is deliberately stricter than `changeset status`, which only fails when a range contains no
changesets at all. Under plain `status`, changing the renderer while declaring only storage
passes; so does changing the renderer with `--empty`; so does declaring it at `none`. The check
that matters is per package.

Three things deliberately do not satisfy it:

- an **empty** changeset, or one declaring a changed package at `none` — both release nothing, so
  accepting them would be accepting the drift the check exists to catch
- a changeset left **pending** by an earlier pull request
- a pending changeset that this change **edits** rather than adds — that is somebody else's
  release intent being borrowed

There is no escape hatch for a changed package. A change that touches no publishable input needs
nothing at all, and the check says so and passes. If you are unsure whether a change needs
releasing, name it at `patch`: a release nobody needed costs less than a published version that
means nothing.

### The release itself

`changeset version` consumes every pending changeset, so the change that applies them alters
packages with none left to find and can never satisfy the check — including on the pull request
that carries it, which is where branch protection looks first. It needs an exemption, and that
exemption is the most dangerous rule in the file, because it is the one path by which a package
change can reach `main` with nothing declaring it.

So it is granted only to a range that **cannot** contain anything else: every file it touches is
a package manifest, a `CHANGELOG.md`, or a deleted changeset. A hand-written version bump sitting
next to a real source edit does not qualify, and neither does a range that deletes pending
changesets without releasing what they declared.

## How versions and publishing divide

changesets computes versions and writes changelogs. It does **not** publish here.

`changeset publish` publishes every non-private workspace package, in parallel, with no allowlist
and no registry preflight. The publish path in `.github/workflows/publish-packages.yml` keeps
three properties that would otherwise be lost:

- the publish set is an asserted allowlist (`scripts/openmaic-packages.mjs`), and it is the same
  set that gets built, tested and packed
- publishing is sequential in dependency order, so a dependent is never published pinned to a dsl
  version whose own publish failed
- a real registry preflight runs first, which treats only a definitive 404 as "never published"
  and refuses a tree that is behind the registry

## Vendored forks

`mathml2omml` and `pptxgenjs` are vendored third-party forks. Their npm names belong to their
original authors, so this repository must never version or publish them. Two mechanisms, because
they guard different commands:

- `ignore` in `config.json` keeps them out of `changeset add`, `status` and `version`
- `"private": true` in their own manifests keeps them off the registry, and it is the **only**
  thing that does — `ignore` has no effect on any publish

Neither is left to a reviewer to notice. `scripts/check-package-version-bumps.mjs --assert-set`
fails the release if the publishable workspace packages are not exactly the allowlist, or if an
ignored package is not private.

## Internal dependency ranges

`storage`, `renderer` and `importer` depend on `@openmaic/dsl` through `workspace:^`, and
`updateInternalDependencies` is `minor`. `pnpm publish` turns `workspace:^` into a caret range, so
consumers installing two of these packages resolve one copy of the dsl.

`workspace:*` published an exact pin instead, which is how the registry ended up with
`storage@0.1.0` pinning dsl `0.5.0` while `renderer@0.0.3` and `importer@0.1.1` pin `0.4.0` — two
copies of a contract package in one install, each validating documents against its own schema.

## Known limitation

"Changed" means "a file under the package directory changed", which under-approximates the real
inputs of all four packages. `renderer` and `importer` inline their dependency graph through
Rollup, so a lockfile-only resolution change rewrites their published bundles. `dsl` and `storage`
are not exempt either: their `dist` is whatever the lockfile's TypeScript emits, and `dsl`'s
shipped JSON Schema is generated by the lockfile's `ts-json-schema-generator`. A toolchain bump
can therefore change any of the four tarballs with no diff under the package directory.

Closing this would mean treating the lockfile and toolchain configuration as an input of every
package, which makes every dependency bump demand four changesets, or externalising the bundled
dependencies. Both are decisions about how the packages are built rather than about this check.
The exact per-package definition of "publishable input" lives in `scripts/check-changesets.mjs`.
