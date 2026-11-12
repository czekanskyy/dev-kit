---
name: build-task
description: Builds one T1 task, or one T2/T3 task from a spec, end to end. Branches or uses an isolated worktree, delegates to the implementer agent, runs the local gate, gets an independent review, updates docs, opens a pull request into the integration branch and merges it per tier policy. Use after triage for any bug fix, small feature or spec task.
argument-hint: <task brief> | <spec path> <task id>
---

# Build a task (T1, or one task of a T2/T3 spec)

Task: $ARGUMENTS

## 0. Load the config first

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails or reports that
`.claude/workflow.json` is missing, stop and tell the user: "This project has no
`.claude/workflow.json`. Create one from `examples/workflow.example.json` in the dev-kit repo
(schema: `plugins/dev-kit/schema/workflow.schema.json`), then run this again." Never continue with
guessed values.

Pass the plugin root `${CLAUDE_PLUGIN_ROOT}` in every subagent brief: agents do not have it in
their environment and need it to run `config.mjs` and `risk.mjs`.

## 1. Read and size

- Read the docs in `docs.index`, then the spec (or the brief). For a spec, take only the named task:
  its tier, files and tests. If the spec has an open `Needs decision` row that this task depends on,
  stop and ask the user (one `AskUserQuestion` round).
- No tier given: classify with the `/dev-kit:triage-task` rules. T0 belongs in `/dev-kit:quick-fix`.
- Models: implementer from `models.implementer` (T1, T2) or `models.implementerT3` (T3); reviewer
  from `models.reviewerT1` (T1) or `models.reviewer` (T2, T3). Pass `model` (alias) and `effort` on
  each Agent call when they differ from the agent's default.

## 2. Branch

1. `git fetch <remote> <integration>`.
2. Branch name from `branches.work` (`{stage}` = `stage.branchPrefix`, `{slug}` = short English
   kebab-case summary). A hotfix uses `branches.hotfix` and targets `branches.hotfixBase`.
3. Create it from `<remote>/<integration>`: `git branch <branch> <remote>/<integration>`.
4. The implementer runs with `isolation: worktree`, so it gets its own checkout. Tell it the branch to
   switch to. If `worktree.setup` is set, tell it to run it (with `{slot}` = the slug and `{path}` =
   its worktree path) before anything else.

## 3. Implement

Spawn `dev-kit:implementer` with a brief containing: the plugin root, spec path and task id (or the
full brief), tier, expected files, acceptance criteria, branch and base, stage, commit summary hint,
and "bug fix: failing test first" when it is a bug.

On return:
- `STATUS: BLOCKED` with open questions: ask the user in one round, then resume the same agent with
  SendMessage.
- Check the commits exist: `git log --oneline <remote>/<integration>..<branch>`. No commits means
  failed.
- If the integration branch moved meanwhile, rebase the task branch onto `<remote>/<integration>`
  (in the agent's worktree), then run `worktree.sync` if set.

## 4. Gate

Push the branch (`git push -u <remote> <branch>`), then run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" --tier <Tn> --base <remote>/<integration> --post-status`
from the task worktree. Gates run one at a time on this machine (`gate.exclusive`).

Red: give the failing step's output to the same implementer (SendMessage) to fix, then rerun.
Red twice on the same task: for T1/T2 retry once with `models.implementerEscalation`; still red, stop,
notify `--priority high`, and report. Never merge a red gate.

## 5. Review

Run the `/dev-kit:review-changes` logic on the branch (or PR, once open): reviewer model per tier,
security pass and Codex per `review` config on risk paths and T3. Each round with blocker or major
findings goes back to the implementer, then gate again. At most `review.maxRounds` rounds; after
that, ask the user how to proceed. Minor findings go into the PR body as follow-ups.

## 6. Docs

Apply the project's definition of done (`docs.done`): update the map, log and topic docs it names,
in the `languages.docs` language. A one-line doc edit can be done inline; more goes to the
implementer. Run the docs check (`docs.check`) if configured. Commit, push, gate again only if code
changed.

## 7. Pull request

`gh pr create --base <integration> --head <branch>` with:
- title: `pullRequest.titleFormat`, in `languages.pullRequests`;
- body: one `## <heading>` per `pullRequest.sections` entry, in order and language. Include the gate
  summary and the green `local-gate` status, the plan (T1: 3 to 5 points), the spec path (T2/T3),
  risk paths and migrations, every assumption, the review verdict, and "single-family review" when
  Codex was skipped. No tool attribution, no em-dash. Write the body to a temp file, never the repo.

## 8. Merge per tier

- T0 to T2 without risk paths: `gh pr merge <n> --squash --delete-branch`. You merge.
- Risk paths touched, or T3, or `tiers.<Tn>.merge` is `ask`: run the same command. The bash guard
  will ask the user and send a push notification; wait for the answer. `human`: do not merge, report
  the PR link.
- If the guard refuses (stale base, missing status), fix the cause and retry. Never bypass it.

After merging: `git fetch` and update the local integration branch, run `worktree.sync` if set,
notify `--priority low` with the PR link. Leave worktree removal to the user (it asks anyway).

## Usage limits

Watch the usage figures you can see (status line, `/usage`, limit notices) against `limits`:
- at `lowerEffortAt` percent: drop subagent effort one level (high to medium, medium to low);
- at `warnAt`: notify `--priority high`, finish only small tasks already started, then write a
  handoff prompt (what is done, branch, PR, next step, exact prompt to resume) to `paths.handoff`;
- at `stopAt`: stop immediately after saving the handoff.

## 9. Report

```
Task: <id or summary>   Tier: Tn   Branch: <branch>
PR: <url>   Merged: yes / waiting for approval / no (<why>)
Commits: <n>   Gate: <summary>   Review: APPROVE after <n> rounds (<families>)
Assumptions: <list>
Follow-ups: <minor findings, open questions>
```

**Next step:** continue with the next task of the spec, or review the merged state.
Prompt: `/dev-kit:build-task <spec path> <next task id>`
Prompt: `/dev-kit:review-changes <PR number>`
