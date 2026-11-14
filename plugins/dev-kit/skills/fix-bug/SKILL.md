---
name: fix-bug
description: Fixes a bug with a mandatory regression test. Reproduces the report, names the root cause, writes a failing test first, makes the minimal fix and proves the test goes from red to green, then continues through the build-task steps (gate, review, pull request). Escalates the model after two failed attempts. Use for any reported defect, instead of a plain build-task.
argument-hint: <bug report: what happens, what should happen, how to reproduce>
---

# Fix a bug

Report: $ARGUMENTS

## 0. Load the config first

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails or reports that
`.claude/workflow.json` is missing, stop and tell the user: "This project has no
`.claude/workflow.json`. Create one from `examples/workflow.example.json` in the dev-kit repo
(schema: `plugins/dev-kit/schema/workflow.schema.json`), then run this again." Never continue with
guessed values. Keep `commands.test`, `commands.testFiles`, `tiers`, `riskPaths`, `models` and
`languages.chat` in mind and answer in the `languages.chat` language.

If the report is empty or says nothing about expected behaviour, ask for it and stop.

## 1. Reproduce and find the cause

- Read the docs in `docs.index` that matter, then spawn one or more `dev-kit:explorer` subagents in
  parallel (model from `models.explorer`, pass `${CLAUDE_PLUGIN_ROOT}`) to locate the code path, the
  existing tests around it and recent changes (`git log` on those files).
- Reproduce before touching code: a failing test, a script or exact steps. A report you cannot
  reproduce is not fixed by guessing. Ask the user for what is missing in one `AskUserQuestion`
  round, or stop with "not reproducible" and what you tried.
- Write the root cause in one or two sentences, with `file:line`. A symptom is not a cause: "the
  list is empty" is a symptom, "the filter reads the stored status instead of the draft" is a cause.

## 2. Tier and route

Classify with the triage rules (`riskPaths` hit: at least T2; `riskPaths.alwaysT3`: T3). A bug is
normally T1. If the fix needs a spec (schema change, new behaviour, several modules), stop and give
the `/dev-kit:plan-feature` prompt. T0 changes are not bugs: `/dev-kit:quick-fix`.

## 3. Failing test first (not optional)

The first commit on the task branch contains a regression test that fails for the reported reason
and runs through `commands.testFiles` (or `commands.test`). Record the failing output, since the PR
shows it. When no test is possible (pure visual defect, no harness), do not skip: say why, propose
the closest check (a snapshot, a script), and ask the user before going on without a test.

## 4. Fix, gate, review, pull request

Follow `/dev-kit:build-task` from its step 2 (branch), with these changes:

- The implementer brief says "bug fix: failing test first, then the minimal fix, no refactoring and
  no new features", and carries the root cause and the red test output.
- Models: `models.implementer` and `models.reviewerT1` for T1; the T2 and T3 models for those tiers.
  After two failed attempts at the same bug (a fix that leaves the test red, or a gate that stays
  red because of it) switch the implementer to `models.implementerEscalation` for one more attempt.
  Still failing: stop, notify `--priority high` and report what was tried and what you suspect.
- The pull request body, under the "how it was checked" heading, shows the regression test red
  before the fix (output excerpt) and green after, and states the root cause in one line.
- Fix the cause. If the same defect can occur elsewhere, list the other places as follow-ups; do not
  widen the fix.

## 5. Report

```
Bug: <summary>   Tier: Tn   Branch: <branch>
Root cause: <one line, file:line>
Regression test: <file and name>   Red before: yes   Green after: yes
PR: <url>   Merged: yes / waiting for approval / no (<why>)
Follow-ups: <similar places, open questions>
```

**Next step:** independent review of the fix before merge, or the next bug.
Prompt: `/dev-kit:review-changes <PR number>`
Prompt: `/dev-kit:fix-bug <next report>`
