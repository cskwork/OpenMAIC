---
name: fact-check
title: "事实核查"
description: "Improve factual reliability while creating or reviewing a course or supplied content. Use when the user asks to fact-check, verify accuracy, reduce hallucinations, make a reliable course, or mentions 事实性错误、知识性错误、专业知识准确性、可靠性. During creation, verifies high-risk claims before they are taught and runs a final sanity check; on existing content, returns a short evidence-backed report and lets the user choose what to fix. Not for grammar, style, or layout. Combine with deep-research when current evidence is the course's main subject."
---

# Fact check

Keep serious factual mistakes and AI hallucinations out of the course without
turning course-making into an exhaustive audit. Focus on the few claims that
materially affect trust.

Choose the mode from the request and current course state; do not ask the user
to choose a mode:

- **Creating:** when there is no course yet or the user asks to build/rebuild
  one, load `stage-design` and apply the checks while planning and generating.
- **Reviewing:** when content already exists and the user asks to inspect it,
  report findings first. Do not edit unless fixes were already requested or the
  user approves findings after the report.

## While creating a course

Use the normal `stage-design` workflow; this skill changes factual handling,
not the teaching method, page style, or build sequence.

Before `create_stage`, scan the proposed page plan for the high-signal risks
below. Verify only claims the course will actually rely on. Put the verified
wording, relevant date or scope, and source attribution into the page `brief`
or pass it to `generate_scene` as `materialFacts` so the page generator receives
the fact — it cannot use research left only in chat memory.

After all pages exist, use `list_scenes` and read their text for a quick final
sanity check of exact facts and cross-page contradictions. Correct obvious
errors before delivery because creating the course already authorizes making
its content accurate. Do not interrupt creation with a separate audit report or
an approval gate; briefly mention only material corrections or remaining
uncertainty when handing off the finished course.

## When reviewing existing content

For a course, call `list_scenes`, then read all visible text and narration with
`read_stage` using `detail:"text"`; follow `nextOffset` until complete. Respect a
narrower scope if the user gave one.

Read once for context and silently shortlist high-signal risks:

- exact numbers, dates, counts, names, and attributed quotations;
- laws, standards, formulas, technical definitions, and classifications;
- “first”, “only”, “always”, “must”, and similar absolute claims;
- causal or professional conclusions stated as settled fact;
- contradictions between pages;
- suspiciously specific claims with no visible support.

Do not verify every claim. Skip correct material, wording preferences, harmless
simplifications, and low-value trivia.

## Verify only the shortlist

Check `list_materials` and relevant `read_material` content first. User sources
may support a claim, but the course being checked cannot prove itself.

Use `web_search` for shortlisted claims that depend on current, exact, disputed,
or specialist knowledge. A normal first pass should need no more than about
6–8 searches. Use `fetch_url` to read the source: a result snippet or the mere
existence of a related source is not evidence.

Do not pause the run to ask the user for sources, permission to use general
knowledge, or permission to continue. Use the tools and materials that are
available. If web search is unavailable, continue with stable knowledge, make
fewer factual commitments, and mark genuinely uncertain claims. Never guess a
URL for `fetch_url`; fetch only a user-provided URL or one returned by
`web_search`.

For a compound statement, isolate the questionable part and verify that exact
part. Prefer primary or official sources. One authoritative source is enough
for an obvious error; add corroboration only for disputed or high-impact
claims. For versioned knowledge such as law, policy, standards, or medicine,
check the relevant date, version, and jurisdiction.

“No reliable evidence found” does not mean false. If verification remains
inconclusive, say so rather than inventing a verdict or correction.

## Give a short, readable review report

In review mode, return roughly 3–8 useful findings in the first pass, or fewer
when fewer exist. Group them under these top-level headings, in this order, and
omit an empty group:

1. **一、明确事实错误**
2. **二、表述不严谨**
3. **三、需要核实** — include only when the claim matters

Within the groups, number findings consecutively across the whole report with
Arabic numerals. Give every finding a short subheading containing its number,
page/location, and specific issue, for example:
`### 1. 第 5 页｜测验解析｜知识混淆`.

Under each heading, use exactly three bullets:

- **原始表述：** quote only the relevant sentence or fragment;
- **存在问题：** explain the error and the correct fact in plain language;
  include a concise source and date here when useful;
- **修改建议：** give only the edit action or a compact replacement.

Keep each bullet to one or two short sentences. Do not repeat the same fact or
quotation across bullets. If **存在问题** already gives the applicable rule or
correct wording, **修改建议** should only state the change — for example,
“按上述条文改写，删除‘商业秘密、法人’” — instead of quoting the article again.

Do not show scores, confidence percentages, lengthy methodology, correct
claims, or minor style issues. Do not pad the report to reach a quota. If no
material issue is found, say what scope was scanned and that no obvious error
was found; do not claim the content is perfectly accurate.

## Let the user choose after a review

When there are actionable findings and edits were not already authorized, the
last action of the turn must be an `ask_user` tool call with a non-empty
`options` array. This is an interaction requirement: do not merely print option
ids or end a normal chat message with “which do you choose?”. Use concise labels
in the user's language, equivalent to:

- fix all reported issues;
- fix confirmed errors only;
- keep the report without changes.

Use stable option ids such as `fix_all`, `fix_confirmed`, and `keep`. The form's
free-text choice lets the user enter selected finding numbers such as `1, 3`.

Do not patch before the answer. After approval, load `pro-editing`, read each
selected page with `read_stage` using `detail:"source"`, and change only the
approved claims. If narration changes, regenerate its audio as required by
`pro-editing`.
