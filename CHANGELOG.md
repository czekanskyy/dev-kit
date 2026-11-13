# Changelog

## 0.1.1

Fewer interruptions where the agent can fix the problem itself, plus fixes from real use.

- Guard: a recursive `grep` (`-r`, `-R`, `--recursive`, `--dereference-recursive`) or an `rg` that reads
  hidden or ignored files (`--hidden`, `-u` twice or more including combined flags such as `-uug`,
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

## 0.1.0

First release.
