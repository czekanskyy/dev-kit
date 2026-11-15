---
name: plan-feature
description: Plans a T2 or T3 feature. Classifies the tier, runs the planner agent to write the spec (goal, acceptance criteria, data model, tiered tasks, Decisions marked Decided, Assumed or Needs decision, risks) into the configured specs folder, asks every Needs decision item in one round and stops for the user's acceptance. Writes no code. Use for any task triage routed to "plan first", before build-task.
argument-hint: <feature request in your own words> [slug]
---

# Plan a feature (T2 or T3)

Request: $ARGUMENTS

## 0. Load the config first

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails or reports that
`.claude/workflow.json` is missing, stop and tell the user: "This project has no
`.claude/workflow.json`. Create one from `examples/workflow.example.json` in the dev-kit repo
(schema: `plugins/dev-kit/schema/workflow.schema.json`), then run this again." Never continue with
guessed values. Keep `tiers`, `riskPaths`, `models`, `paths.specs`, `docs.index` and
`languages.chat` in mind and answer in the `languages.chat` language.

If the request is empty, ask the user what the feature is and stop.

## 1. Tier

If the request already carries a tier from `/dev-kit:triage-task`, use it. Otherwise apply the
triage rules: a risk path hit means at least T2, anything in `riskPaths.alwaysT3` means T3, doubt
means the higher tier. A request that is really T0 or T1 does not get a spec: say so and give the
`/dev-kit:quick-fix` or `/dev-kit:build-task` prompt instead, then stop.

Slug: the second argument, else a short English kebab-case summary. If `<paths.specs>/<slug>.md`
already exists, stop and ask whether to update it or pick another slug. Never overwrite it.

## 2. Questions that block the spec

Read the docs in `docs.index` and find what the feature touches (spawn `dev-kit:explorer`
subagents in parallel for anything beyond a couple of greps, passing `${CLAUDE_PLUGIN_ROOT}`). Ask
what blocks the spec (scope, a product choice, conflicting docs) in one `AskUserQuestion` round,
recommendation first. Do not ask what the repo answers, and mark small details as Assumed instead.

## 3. Write the spec

Spawn `dev-kit:planner` with `model` and `effort` from `models.plannerT2` (T2) or `models.plannerT3`
(T3). The brief carries: `${CLAUDE_PLUGIN_ROOT}`, the request, the tier, the slug, the answers from
step 2 and the explorer findings. The agent writes exactly one file, `<paths.specs>/<slug>.md`. Do
not write or edit it yourself.

Check the result before showing it:
- it follows `${CLAUDE_PLUGIN_ROOT}/templates/spec.md`: Status line, Goal, Acceptance criteria
  (observable and testable), Data model, Tasks with a Parallelism line, Decisions and Risks, and no
  template comment or placeholder is left;
- every task names its tier, files, tests and dependencies, and T3 work is split into T1 and T2 tasks;
- every decision is marked Decided, Assumed or Needs decision, with a recommendation on each open one;
- risk paths and migrations are listed, and a destructive migration is marked T3.

If something is missing, send it back to the same agent with SendMessage. Two rounds at most.

## 4. Stop for acceptance

Show the user: the path, the tier, the task table in short form, every Assumed row, and every
`Needs decision` row with its options. Ask the open decisions in one `AskUserQuestion` round, then
write the answers into the spec's Decisions table (change the status to Decided, one line each).

A T3 spec needs the user's explicit acceptance before any task starts. For T2, the acceptance is
the answer to this round. Do not start building.

## 5. Next step

End your reply with exactly one Next step paragraph, filled in:

**Next step:** build the first task of the accepted spec.
Prompt: `/dev-kit:build-task <paths.specs>/<slug>.md task 1`

When tasks are independent, add one line naming which can run in parallel and how to start them.
