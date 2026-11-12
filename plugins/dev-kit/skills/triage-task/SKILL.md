---
name: triage-task
description: Classifies a development request into tier T0, T1, T2 or T3, predicts the risk paths it will touch, asks every blocking question in one round, and returns the route (quick-fix, build-task or a plan first), the models per role and acceptance criteria. Use at the start of any new task, bug or feature request, before writing code.
argument-hint: <task description>
---

# Triage a task

Request: $ARGUMENTS

## 0. Load the config first

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails or reports that
`.claude/workflow.json` is missing, stop and tell the user: "This project has no
`.claude/workflow.json`. Create one from `examples/workflow.example.json` in the dev-kit repo
(schema: `plugins/dev-kit/schema/workflow.schema.json`), then run this again." Never continue with
guessed values. Keep the merged config in mind: `tiers`, `riskPaths`, `models`, `paths.specs`,
`languages.chat`. Answer in the `languages.chat` language.

If the request is empty, ask the user what the task is and stop.

## 1. Understand the request

- Read the docs in `docs.index` that matter for this request (map first, if any).
- Find the files the task will touch. For anything beyond a couple of greps, spawn one or more
  `dev-kit:explorer` subagents in parallel (model from `models.explorer`), passing the plugin root
  `${CLAUDE_PLUGIN_ROOT}` in the brief.

## 2. Check risk

- If the work already exists on a branch or PR, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/risk.mjs" --json` (with `--base <integration>` or `--pr <n>`).
- Otherwise predict: match the files the task will touch against `riskPaths.globs`, and the kind of
  code it will add against `riskPaths.contentPatterns` (for example reading environment variables).
- Any risk path hit means at least T2. Anything matching `riskPaths.alwaysT3` means T3.

## 3. Classify

| Tier | Typical work | Route |
|---|---|---|
| T0 | copy, colour, spacing, typo, translation string | `/dev-kit:quick-fix` |
| T1 | bug fix, small component, form field without schema change | `/dev-kit:build-task` with a 3 to 5 point plan in the PR |
| T2 | new section, schema or collection change with migration, integration | spec first (planner, `models.plannerT2`), then `/dev-kit:build-task` per task |
| T3 | architecture, page-builder-scale feature, checkout or payments, destructive migration | spec first (planner, `models.plannerT3`), user accepts the spec, then tasks one by one |

Also use the project's `tiers.<Tn>.examples` when present. When in doubt between two tiers, pick
the higher one. A migration that drops a field or collection or changes a field type is always T3.

## 4. Ask everything at once

Collect every question that blocks the work (unclear scope, a product choice, conflicting docs,
missing content). Ask them in a single `AskUserQuestion` round, each with concrete options and your
recommendation first. Do not ask what you can find in the repo, and do not ask about details you can
mark as an assumption. No blocking questions: skip this step.

## 5. Report

```
Tier: Tn
Why: <one or two lines, naming the rule that decided it>
Risk paths expected: <globs or patterns hit, or "none">
Models: implementer <model/effort>, reviewer <model/effort>, planner <model/effort or "none">
Route: quick-fix | build-task | plan first
Acceptance criteria:
1. <observable, testable statement>
Assumptions: <list or "none">
```

Models come from the merged `models` config: `quickFixer` for T0; `implementer` and `reviewerT1`
for T1; `implementer`, `plannerT2` and `reviewer` for T2; `implementerT3`, `plannerT3` and `reviewer`
for T3.

## 6. Next step

End your reply with exactly one Next step paragraph, filled in for the tier you picked (one prompt,
or two when a realistic alternative exists):

- T0: **Next step:** apply the quick fix.
  Prompt: `/dev-kit:quick-fix <exact change: file or page, old text, new text>`
- T1: **Next step:** build the task.
  Prompt: `/dev-kit:build-task <task summary> | criteria: <numbered acceptance criteria>`
- T2 or T3: **Next step:** write the spec before any code.
  Prompt: `Spawn dev-kit:planner (model and effort from models.plannerTn) for: <request>, tier Tn, slug <slug>, answers: <answers>. Then show me the Needs decision items.`

**Next step:** once the routed task is merged, triage the next request the same way.
Prompt: `/dev-kit:triage-task <the next request in your own words>`
