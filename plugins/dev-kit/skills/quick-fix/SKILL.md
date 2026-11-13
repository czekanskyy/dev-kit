---
name: quick-fix
description: The T0 path for copy, colour, spacing, typo and translation changes. Branches from a fresh integration branch, applies the change through the quick-fixer agent, runs the T0 gate, opens a pull request into the integration branch and merges it. Stops and re-triages if a risk path is touched. Use when a task was triaged as T0 or is plainly cosmetic.
argument-hint: <exact change: where, old value, new value>
---

# Quick fix (T0)

Change: $ARGUMENTS

## 0. Load the config first

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails or reports that
`.claude/workflow.json` is missing, stop and tell the user: "This project has no
`.claude/workflow.json`. Create one from `examples/workflow.example.json` in the dev-kit repo
(schema: `plugins/dev-kit/schema/workflow.schema.json`), then run this again." Never continue with
guessed values. You need: `branches`, `stage`, `commit`, `pullRequest`, `languages`, `commands`,
`riskPaths`, `models.quickFixer`.

If the change is not plainly T0 (copy, colour, spacing, typo, translation), stop and run
`/dev-kit:triage-task` instead.

## 1. Branch from a fresh integration branch

1. `git status --porcelain` must be clean. If not, stop and tell the user what is uncommitted.
2. `git fetch <remote> <integration>`.
3. Build the branch name from `branches.work`: `{stage}` is `stage.branchPrefix`, `{slug}` is a short
   kebab-case summary in English. If the name exists, append `-2`.
4. `git switch -c <branch> <remote>/<integration>`.

## 2. Make the change

- Locate the target with Grep. If the change sits in a single file and is a one-line edit, do it
  inline. Otherwise spawn `dev-kit:quick-fixer` with model and effort from `models.quickFixer`, and a
  brief containing: the exact change, the branch name, the commands to run (`commands.lintFiles` with
  the touched files, if set), the commit message, the risk globs and patterns, and the plugin root
  `${CLAUDE_PLUGIN_ROOT}`.
- Commit message: `commit.format` with `{stage}` = `stage.current` and `{summary}` written in the
  `languages.commits` language. No tool attribution, no em-dash.
- If the agent reports `ESCALATE`, stop here (see step 3).

## 3. Risk check

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/risk.mjs" --base <remote>/<integration> --json`.
If `touchesRisk`, `generatedTouched` or `immutableEdited` is true: stop. Do not open a PR. Tell the
user which files or patterns triggered it, leave the branch as it is, and suggest re-triage.

## 4. Gate

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" --tier T0 --base <remote>/<integration> --post-status`.
It needs the branch pushed for the commit status, so push first: `git push -u <remote> <branch>`.
Gate red: read the first error, fix it once if it is caused by the change, commit, rerun. Red twice:
stop and notify (`notify.mjs --priority high --title "<project>: quick fix blocked" --message "<branch>: gate failed twice"`).

## 5. Pull request

`gh pr create --base <integration> --head <branch> --title "<title>" --body-file <tmp file>`

- Title: `pullRequest.titleFormat` with the same summary, in the `languages.pullRequests` language.
- Body: one `## <heading>` per entry of `pullRequest.sections`, in that order and language. Fill
  what changed, why, how it was checked (paste the gate summary line and say the `local-gate` status
  is green on the head SHA), risk ("none, T0"), assumptions. No tool attribution, no em-dash.
- Write the body to a file in the scratchpad or temp dir, never into the repo.

## 6. Merge

`gh pr merge <number> --squash --match-head-commit <sha>` (`<sha>` from `gh pr view <number> --json headRefOid --jq .headRefOid`, or a unique prefix of at least 7 characters; never `--auto`, never `--delete-branch`: gh would switch the local checkout to the base branch). Use literal values: the guard cannot resolve shell variables.

The bash guard hook checks the green `local-gate` status on the PR head, an up-to-date base and the
risk paths, and asks the user when needed. If it refuses because the base moved: rebase onto
`<remote>/<integration>`, push with `--force-with-lease`, rerun the gate, merge again. Never try to
work around a refusal.

After merging: `git push <remote> --delete <branch>` to drop the remote task branch, then
`git switch <integration> && git pull --ff-only`, then run `worktree.sync` if set.
Notify quietly: `node "${CLAUDE_PLUGIN_ROOT}/scripts/notify.mjs" --priority low --title "<project>: merged" --message "<PR title>" --click <PR url>`.

## 7. Report

```
Branch: <branch>   PR: <url>   Merged: yes/no
Files: <list>
Gate: <summary line>
```

**Next step:** pick the next small change or triage the next request.
Prompt: `/dev-kit:quick-fix <next exact change>`
Prompt: `/dev-kit:triage-task <next request>`
