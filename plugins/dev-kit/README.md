# dev-kit plugin

Tiered task workflow for Claude Code: triage, quick fixes, build tasks, independent review, a local
merge gate and guard hooks. Every project value comes from the project's `.claude/workflow.json`,
deep-merged over `defaults.json` and validated against `schema/workflow.schema.json`.

| Folder | Contents |
|---|---|
| `agents/` | `explorer`, `quick-fixer`, `implementer`, `planner`, `reviewer`, `dep-researcher` |
| `skills/` | `triage-task`, `quick-fix`, `build-task`, `review-changes`, `audit-docs` |
| `hooks/` | bash guard, file guard, stop check, notifications |
| `scripts/` | `config.mjs`, `risk.mjs`, `gate.mjs`, `notify.mjs` |
| `schema/` | JSON Schema for `.claude/workflow.json` |

Install:

```text
/plugin marketplace add czekanskyy/dev-kit
/plugin install dev-kit@dev-kit
```

On Claude Code 2.1.275 or later this also works in one step:
`/plugin install dev-kit --marketplace czekanskyy/dev-kit`.

Project setup and the full manual: see the repository's `README.md` and `WORKFLOW.md`.

## Known limitations

The guard hooks are a safety net, not a sandbox. They read command text and do not see what runs
later. Known gaps:

- `git -c remote.<name>.push=...` refspec overrides on the command line are not evaluated.
- curl multipart lists of several files (`-F file=@a,b`) are checked only up to the first file.
- PowerShell colon-bound parameters such as `-InFile:.env` are not inspected.
- The words `codex` and `copilot` are refused in commit and PR text even inside SDK or package names (on purpose).
- Interpreters (`node -e`, `python -c`, `perl`) and scripts the agent writes and runs can do anything the guard refuses.
- Variables and indirection (`X=main; git push origin $X`, `$(echo cat) .env`, aliases, functions, base64) hide commands.
  The guard checks a command before it runs and cannot resolve shell variables, so `gh pr merge $n ...` is refused: use literal values.
- A recursive `grep` or an `rg --hidden`/`-u` over a directory holding a secret file is refused even with `--exclude` or `-g '!...'`: the guard does not parse their option grammar. Use `git grep` or plain `rg`.
- A worktree counts as a finished agent slot only under `worktree.root` (real paths), listed by git, with a `.agent-scope` file and a clean status including ignored files; other ignored files (local databases, uploads) make the guard ask. `rm -rf` of a slot is not unregistered from git, use `git worktree remove`.
- The stop check skips only files with unresolved merge conflicts; it does not detect other half-finished operations.
- Text piped into a shell (`echo "..." | bash`) is not inspected; only a download piped into one is.
- Git aliases (`git p` for push) are not expanded; hook or config edits through the Edit tool only ask.
- `cd` inside a subshell or `bash -c` leaks into the following commands of the same line.
- Secrets read through tools outside the reader list (`vim`, `diff`, `jq`, `git show HEAD:.env`, `git diff`) are not caught.
- Remote database hosts taken implicitly from config files or `.env` are invisible to the guard.
- A commit message file created earlier in the same command line is asked about, not checked.
- Unusual quoting or bash constructs the parser mis-reads (`case` patterns, nested heredocs, PowerShell here-strings) can hide a command.
