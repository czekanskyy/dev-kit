# Changelog

## 0.2.0

Four new skills, one new script and two guard fixes that remove needless prompts.

- `/dev-kit:plan-feature`: triages a T2 or T3 request, runs the planner, asks every `Needs decision`
  row in one round and stops for acceptance. Writes only the spec.
- `/dev-kit:fix-bug`: reproduce, root cause, failing regression test first, minimal fix, then the
  `build-task` steps. Two failed attempts escalate to `models.implementerEscalation`.
- `/dev-kit:update-deps`: inventory by `scripts/deps.mjs`, one `dep-researcher` per family in
  parallel, one dated report. Installs nothing. New optional config key `deps.families`.
- `/dev-kit:workflow-help`: read-only state summary and one proposed next skill.
- Guard: git commands in a sibling worktree of the same repository (`git -C <worktree>`, `cd <worktree> && ...`)
  no longer ask for confirmation. The worktree shares the git dir, so its branch is checked as usual.
- Guard: a message file written by the same command (`cat > body.md <<EOF ... EOF` then `gh pr create
  --body-file body.md` or `git commit -F`) is checked from the heredoc text instead of asking.
- `WORKFLOW.md` moved into `plugins/dev-kit/` so skills can read it.

## 0.1.1

Fewer interruptions where the agent can fix the problem itself, plus fixes from real use.

- Guard: a recursive `grep` (`-r`, `-R`, `--recursive`, `--dereference-recursive`) or an `rg` that reads
  hidden or ignored files (`--hidden`, any `-u` or `-.` including combined flags such as `-uug`,
  `--no-ignore*`) over a directory holding a secret file is denied with an instruction: use
  `git grep <pattern>` or plain `rg <pattern>`, or narrow the path. Exclusion flags are not trusted.
- Guard: dumping the environment (`printenv`, `env`, `export -p`, `set`, `Get-ChildItem env:`) or
  printing a secret-looking variable is denied with an instruction instead of asking.
- Guard: `git worktree remove` and `rm -rf` of a finished agent worktree no longer ask: real path
  strictly under `worktree.root`, listed by `git worktree list`, not the main or current checkout
  nor an ancestor, with a `.agent-scope` file and a clean `git status --porcelain --ignored` (ignored
  entries only in `guard.removableDirs` folders or as root-level `.env*` files, never directories). Anything else still asks.
- Guard: `git worktree move` is denied (it breaks symlinked `node_modules` and slot bindings).
- Guard: `gh pr merge --delete-branch` is denied; merge without it and delete the remote branch with
  `git push <remote> --delete <branch>`. Skills `build-task`, `quick-fix` and `review-changes` follow.
- Guard: `--match-head-commit` accepts a unique prefix (at least 7 hex characters) of the PR head.
- Guard: shell variables in `gh pr merge` are refused with a plain explanation.
- Stop check: files with unresolved merge conflicts are left out of the checked list; all other
  changed files are still checked.
- Gate: step option `alwaysFromTier` (runs when `when` matches or the tier is high enough, also for
  subproject steps); a hint to
  gitignore `.claude/worktrees/` when `--post-status` refuses because of agent worktrees.
- Agents `implementer` and `quick-fixer`: scratch files in their own temp directory, never run
  foreign scripts, never move a worktree.

Known gaps, planned for 0.1.2: the guard inspects command text and cannot see every reader. Not covered
yet: `find ... | xargs grep` and `find -exec grep`, PowerShell `Get-ChildItem -Recurse | Select-String`,
`grep -d recurse` and abbreviated long options, `rg --unrestricted`, positive `-g`/`--glob` rules,
secrets in directories the scan skips or beyond its limits, and secret files that are neither hidden
nor git-ignored. The primary control is the Claude Code permission deny rules for reading secret files.

## 0.1.0

First release.
