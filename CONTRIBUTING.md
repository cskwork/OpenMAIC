# Contributing to OpenMAIC

Thank you for your interest in contributing to OpenMAIC! This guide will help you get started and ensure a smooth collaboration.

## How to Contribute

| Contribution type | What to do |
| --- | --- |
| **Bug fix** | Open a PR directly (link the issue if one exists) |
| **Extending existing features** (e.g. adding a new model provider, new TTS engine) | Open a PR directly |
| **New feature or architecture change** | Start a [GitHub Discussion](https://github.com/THU-MAIC/OpenMAIC/discussions) or ask in [Discord](https://discord.gg/p8Pf2r3SaG) **before** opening a PR |
| **Design / UI change** | Discuss in a GitHub Discussion or Discord first — include mockups or screenshots |
| **Refactor-only PR** | Not accepted unless a maintainer explicitly requests it |
| **Documentation** | Open a PR directly |
| **Question** | Ask in [Discord](https://discord.gg/p8Pf2r3SaG) |

## Claiming Issues

To avoid duplicate effort, please **comment on an issue** to claim it before you start working. A maintainer will assign you.

- If **no PR or meaningful update** (WIP commit, progress comment) appears within **1 day**, the issue may be reassigned to someone else.
- If you see an issue already assigned, reach out to the assignee first to coordinate — you may be able to collaborate or split the work.
- If you can no longer work on a claimed issue, please leave a comment so others can pick it up.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20.9.0
- [pnpm](https://pnpm.io/) (latest)
- A copy of `.env.local` — see [`.env.example`](.env.example) for reference

## Getting Started

```bash
# Clone the repository
git clone https://github.com/THU-MAIC/OpenMAIC.git
cd OpenMAIC

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your API keys

# Start the development server
pnpm dev
```

## Development Workflow

1. **Fork** the repository and create a branch from `main`:
   ```bash
   git checkout -b feat/your-feature main
   ```
2. **Branch naming convention:**
   - `feat/` — new features or enhancements
   - `fix/` — bug fixes
   - `docs/` — documentation changes
3. Make your changes and **test locally**.
4. Run **all CI checks** before committing (see below).
5. Open a **Pull Request** against `main`.

## Before You Submit a PR

Run the following checks locally — CI will run them too, but catching issues early saves everyone time:

```bash
# 1. Format code
pnpm format

# 2. Lint (with auto-fix)
pnpm lint --fix

# 3. TypeScript type checking
npx tsc --noEmit

# 4. If you changed a file that ships from packages/@openmaic/*, declare the release
#    (see "Changing a Published Package")
pnpm changeset
```

If formatting or lint auto-fixes produce changes, include them in your commit.

### Local Testing

Before marking a PR as **Ready for Review**, you **must**:

1. **Verify your goal** — confirm that the PR achieves what it set out to do (bug is fixed, feature works as expected, etc.)
2. **Regression test** — manually check that existing functionality is not broken by your changes (e.g. navigate key flows, verify related features still work)
3. **Run CI checks locally** (see above)

If you have not completed local verification, keep your PR in **Draft** status. Only move it to Ready for Review once you are confident it works and does not regress other features.

### PR Guidelines

- **Every PR must link to an issue** — use `Closes #123` or `Fixes #456` in the PR description. If no issue exists yet, create one first. PRs without a linked issue will not be reviewed.
- **Keep PRs focused** — one concern per PR; do not mix unrelated changes
- **Describe what and why** — fill out the [PR template](.github/pull_request_template.md)
- **Include screenshots** — for UI changes, show before/after
- **Ensure CI passes** before requesting review
- **All UI text must be internationalized (i18n)** — do not hardcode user-facing strings

## Commit Message Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `perf`, `style`

Examples:

```
feat(tts): add Azure TTS provider
fix(whiteboard): prevent canvas from resetting on window resize
docs: add CONTRIBUTING.md
```

## Changing a Published Package

Four packages under `packages/@openmaic/` are published to npm: `dsl`, `storage`, `renderer`, and `importer`. Anything that ships inside one of those tarballs is under version control in the literal sense — the version number on npm has to keep meaning "this exact source".

**Do not edit a `version` field in `packages/@openmaic/*/package.json`.** Versions are owned by [changesets](https://github.com/changesets/changesets): a release pull request applies them, updates the dependency ranges between these packages, and writes each `CHANGELOG.md`. A hand-edited number will be overwritten or will collide with the computed one.

**If your PR changes a publishable file in one of those packages, add a changeset in the same PR:**

```bash
pnpm changeset
```

It asks which packages your change releases and at what level, then writes a file like this into `.changeset/`:

```markdown
---
'@openmaic/dsl': minor
'@openmaic/storage': patch
---

Add runtime and storage contracts to the DSL entry points.
```

Commit that file with the rest of your change. The summary becomes the changelog entry, so write it for someone reading the release notes rather than the diff. One change can declare different levels for different packages.

Choosing the level is a [semver](https://semver.org/) judgement, and it is yours to make rather than something CI can infer:

- **patch** — a fix that changes no documented behaviour
- **minor** — new behaviour that existing consumers can ignore
- **major** — anything an existing consumer must react to

Be deliberate with `@openmaic/dsl`. It is the contract the other packages and downstream deployments validate against, so a change that narrows what an existing document may contain is a breaking change even when the diff looks small.

**The check is per package.** CI runs `scripts/check-changesets.mjs` on every pull request, and it fails unless every package you changed is named — at `patch`, `minor` or `major` — by a changeset your PR *adds*. Naming a different package does not satisfy it, and neither does editing a changeset somebody else left pending:

```
@openmaic/renderer: publishable package inputs changed but no changeset in this range releases it.
```

Files that no package ships — `test/`, `docs/`, `vitest.config.ts`, `CHANGELOG.md`, and the importer's legacy `src1/` — do not count as changes, so editing only those needs nothing. The exact per-package list lives in [`scripts/check-changesets.mjs`](scripts/check-changesets.mjs).

### When your change releases nothing

There is no changeset that means "I changed this package but do not release it", and that is deliberate: the version on npm has to keep meaning "this exact source", so a changed package gets a release. If you are unsure whether a change is worth releasing, name it at `patch` — a release nobody needed costs less than a published version that means nothing.

What you often do *not* need is a changeset at all. Editing only files that no package ships — `test/`, `docs/`, `vitest.config.ts`, a `CHANGELOG.md`, the importer's `src1/` — needs nothing, and the check will say so and pass. The same goes for any change outside `packages/@openmaic/`.

`pnpm changeset --empty` exists and other changesets repositories rely on it, but here it satisfies nothing: an empty changeset releases no package, so it cannot discharge the obligation to release one you changed. A `none` level is refused for the same reason. If [changeset-bot](https://github.com/apps/changeset-bot) suggests an empty changeset on your PR, that is its generic advice, not this repository's rule.

[`.changeset/README.md`](.changeset/README.md) explains the rest of the configuration.

### How releases happen

You never publish anything yourself, and you never pick a version number. Once your PR is merged, its changeset sits in `.changeset/` until a maintainer runs `changeset version`, which consumes every pending changeset into one "Version Packages" pull request. Merging that pull request releases: each version that is not yet on the registry is published automatically, in dependency order, and a `@openmaic/<name>@<version>` tag is written afterwards to record it. That tag is a marker, not a trigger — pushing one does not release anything.

Note that `changeset version` may bump packages you did not name. `storage`, `renderer` and `importer` depend on `@openmaic/dsl`, so a minor dsl release also releases them with an updated dependency range.

So your changeset is the release intent, and a release may batch it with others. If you need something out quickly, say so on the PR.

## AI-Assisted PRs 🤖

PRs built with AI tools (Codex, Claude, Cursor, etc.) are welcome! We just ask for transparency and self-review:

- **Mark it** — note in the PR title or description that the PR is AI-assisted
- **AI-review your own code first** — before requesting maintainer review, run an AI code review (e.g. Claude, Codex, Copilot) on your changes and address the findings. This is **required** for AI-assisted PRs to avoid dumping large amounts of unreviewed generated code on maintainers.
- **You are responsible for what you submit** — understand the code, not just the prompt.

AI-assisted PRs are held to the same quality standard as any other PR. Community members are also encouraged to leave constructive feedback on any PR — peer review helps everyone improve.

## Project Structure

```
OpenMAIC/
├── app/              # Next.js app router pages and API routes
├── components/       # React components
├── lib/              # Shared utilities and core logic (i18n in lib/i18n/locales/)
├── packages/         # Internal packages (mathml2omml, pptxgenjs)
├── public/           # Static assets
└── .github/          # Issue templates, PR template, CI workflows
```

## Reporting Bugs

Use the [Bug Report](https://github.com/THU-MAIC/OpenMAIC/issues/new?template=bug_report.yml) issue template. Include:

- Steps to reproduce
- Expected vs. actual behavior
- Browser / OS / Node version
- Screenshots or error logs if applicable

## Requesting Features

Use the [Feature Request](https://github.com/THU-MAIC/OpenMAIC/issues/new?template=feature_request.yml) issue template. For larger features, please open a [Discussion](https://github.com/THU-MAIC/OpenMAIC/discussions) first.

## Security Vulnerabilities

Please report security vulnerabilities through [GitHub Security Advisories](https://github.com/THU-MAIC/OpenMAIC/security/advisories/new). **Do not** open a public issue for security vulnerabilities.

## License

By contributing to OpenMAIC, you agree that your contributions will be licensed under the [MIT License](LICENSE).
