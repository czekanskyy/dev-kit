---
name: audit-docs
description: Audits a repo's docs and agent orchestration (CLAUDE.md, AGENTS.md, .claude/, docs/, specs, README) against the actual code, branches, CI and config. Produces a read-only report of what is current, stale or contradicting, missing, and worth revisiting, asks which fixes to apply, then applies them as a normal T0/T1 task with a gate and a pull request. Use when docs feel out of date, after a big merge, or when onboarding the workflow into a repo.
argument-hint: [focus area or folder]
---

# Audit docs

Focus: $ARGUMENTS (empty means the whole repo)

## 0. Load the config first

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --validate`, then
`node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails or reports that
`.claude/workflow.json` is missing, stop and tell the user: "This project has no
`.claude/workflow.json`. Create one from `examples/workflow.example.json` in the dev-kit repo
(schema: `plugins/dev-kit/schema/workflow.schema.json`), then run this again." Validation errors in
the config are themselves findings: list them in the report.

## Phase 1: read-only report

Nothing is edited in this phase.

1. **Inventory.** List the doc and orchestration files: `CLAUDE.md`, `AGENTS.md`, `README*`,
   `.claude/` (agents, skills, commands, settings, hooks, `workflow.json`), `docs/`, `paths.specs`,
   `.github/` workflows. Note sizes.
2. **Ground truth.** Collect what is actually true: `package.json` scripts and dependencies, folder
   layout, `git branch -a`, recent `git log`, CI workflow triggers and jobs, recent runs
   (`gh run list --limit 10`), the merged config, which commands in `commands` exist.
3. **Fan out.** Split the doc set into 3 to 6 areas and spawn `dev-kit:explorer` subagents in
   parallel (model from `models.explorer`, plugin root `${CLAUDE_PLUGIN_ROOT}` in the brief). Each
   checks every factual claim in its area (paths, commands, branch names, versions, counts, rules,
   status statements) against the repo and returns `doc:line | claim | reality`.
4. **Run the project's docs check** if `docs.check` or `commands.docs` is set, and include its output.
5. **Report** in the `languages.chat` language:

```
## Current
- <doc>: <one line on what it gets right>
## Stale or contradicting
| # | Doc:line | Claim | Reality | Fix |
|---|---|---|---|---|
## Missing
| # | What | Where it should go | Why it matters |
|---|---|---|---|
## Rules worth revisiting
| # | Rule (doc:line) | Observation | Suggestion |
|---|---|---|---|
## Config
- <validation errors, commands that do not exist, riskPaths that match nothing>
## Docs check
<command, result>
```

Only list a contradiction with evidence (`file:line` or command output). If unsure, put it under
"Rules worth revisiting" with a question, not under "Stale".

## Phase 2: choose

Ask the user which fixes to apply with `AskUserQuestion`, grouped (for example: stale facts, missing
docs, rule changes, config). One question per group, multi-select, with "all" and "none" options.
Rule changes and anything that alters a project decision are never applied without an explicit yes.

## Phase 3: apply

Apply the chosen fixes as one task through the `/dev-kit:build-task` conventions:
- Pure text corrections: T0. Restructured docs, rule changes, config or `.claude/` changes: T1 (the
  config and hook files will trigger the guard's ask prompt; that is expected).
- Fresh branch from the integration branch per `branches.work`, edits in the `languages.docs`
  language, docs check, `gate.mjs --tier <Tn> --post-status`, pull request into the integration
  branch with the configured sections, merge per tier policy.
- Respect the project's doc budgets and the generated-file rules. Never edit files under the plugin.

## Report

```
Audit: <n> stale, <n> missing, <n> rules to revisit, config <ok/errors>
Applied: <groups>   PR: <url>   Merged: yes/no
Deferred: <items the user skipped>
```

**Next step:** apply the deferred items later or move on to regular work.
Prompt: `/dev-kit:audit-docs <folder or area to re-check>`
Prompt: `/dev-kit:triage-task <next request>`
