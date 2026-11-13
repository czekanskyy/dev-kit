# Changelog

## 0.1.1

Fewer interruptions where the agent can fix the problem itself, plus fixes from real use.

- Guard: a recursive `grep -r` or `rg --hidden`/`-uu` over a directory holding a secret file is now
  denied with the fix (`--exclude='.env*'`, `-g '!.env*'`) and allowed when the command already
  excludes the secret files.
- Guard: dumping the environment (`printenv`, `env`, `export -p`, `set`, `Get-ChildItem env:`) or
  printing a secret-looking variable is denied with an instruction instead of asking.
- Guard: `git worktree remove` and `rm -rf` of a clean agent worktree (under `worktree.root`, with a
  `.agent-scope` file) no longer ask. Anything else still asks.
- Guard: `git worktree move` is denied (it breaks symlinked `node_modules` and slot bindings).
- Guard: `gh pr merge --delete-branch` is denied; merge without it and delete the remote branch with
  `git push <remote> --delete <branch>`. Skills `build-task`, `quick-fix` and `review-changes` follow.
- Guard: `--match-head-commit` accepts a unique prefix (at least 7 hex characters) of the PR head.
- Guard: shell variables in `gh pr merge` are refused with a plain explanation.
- Stop check: skipped while a merge, rebase, cherry-pick or revert is in progress.
- Gate: step option `alwaysFromTier` (runs when `when` matches or the tier is high enough); a hint to
  gitignore `.claude/worktrees/` when `--post-status` refuses because of agent worktrees.
- Agents `implementer` and `quick-fixer`: scratch files in their own temp directory, never run
  foreign scripts, never move a worktree.

## 0.1.0

First release.
