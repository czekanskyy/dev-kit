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
