---
name: workflow-help
description: Read-only guide to where the work stands and what to run next. Shows the current stage, branch, open pull requests, the last report and the night queue, then proposes one skill with a ready-to-copy prompt and answers questions about tiers, the gate, risk paths and limits from the manual. Changes nothing. Use when unsure which skill fits or what state the project is in.
argument-hint: [a question about the workflow, optional]
model: haiku
allowed-tools: Read, Grep, Glob, Bash(git status:*), Bash(git branch:*), Bash(git log:*), Bash(gh pr list:*), Bash(gh pr view:*), Bash(node:*)
---

# Workflow help (read-only)

Question: $ARGUMENTS

This skill never edits, commits, pushes, merges, installs or sends anything. If the answer would
need a change, name the skill that does it and give its prompt.

## 0. Load the config first

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails or reports that
`.claude/workflow.json` is missing, stop and tell the user: "This project has no
`.claude/workflow.json`. Create one from `examples/workflow.example.json` in the dev-kit repo
(schema: `plugins/dev-kit/schema/workflow.schema.json`), then run this again." Never continue with
guessed values. Keep `stage`, `branches`, `paths` and `languages.chat` in mind and answer in the
`languages.chat` language.

## 1. A question was asked

Read `${CLAUDE_PLUGIN_ROOT}/WORKFLOW.md` (tiers, branch flow, gate, risk paths, models and limits,
review policy, guard rules, notifications, skill catalogue, scenarios, FAQ) and answer from it in a
few lines, naming the section. Where the project's config differs from the manual's defaults, say
what the config says. If the manual does not cover it, say so; do not guess.

## 2. Show the state

Collect, with read-only commands only, and skip a line when its source does not exist:

- stage: `stage.current` from the config;
- branch and tree: `git branch --show-current`, `git status --short` (count of changed files);
- open pull requests: `gh pr list --state open --json number,title,headRefName,baseRefName` (if `gh`
  fails, say it is unavailable);
- the newest file in `paths.reports` and in `paths.specs`, by modified time;
- the night queue at `paths.queue` and the handoff at `paths.handoff`, when they exist.

Print it as a short block: stage, branch, tree clean or N files changed, PRs (number, title, base),
last report, queue length.

## 3. Propose one skill

Pick the single best next skill from the state, in this order:

| State | Propose |
|---|---|
| Dirty tree on an integration branch | stop and say what is uncommitted; no skill yet |
| Open PR without a review comment | `/dev-kit:review-changes <number>` |
| Accepted spec with unbuilt tasks | `/dev-kit:build-task <spec> task <n>` |
| Spec waiting for acceptance | answer its `Needs decision` rows, then `/dev-kit:build-task` |
| Clean tree, no open work | `/dev-kit:triage-task <describe the task>` |
| Docs feel stale after big merges | `/dev-kit:audit-docs` |
| Periodic dependency review | `/dev-kit:update-deps` |

Give the reason in one line and the prompt in a code block.

## 4. Next step

**Next step:** the one proposed skill.
Prompt: `<the prompt from step 3>`
