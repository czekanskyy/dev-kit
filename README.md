# dev-kit

A Claude Code plugin for running software work as **one orchestrator, four task tiers and hard local
gates**. The main session triages each request, hands the work to a small set of focused agents,
runs a local quality gate, gets an independent review and merges into your integration branch only
when the gate is green. Guard hooks block the dangerous parts (pushing to protected branches, editing
generated files, reading secrets, attributing commits to tools) no matter what an agent decides.

Everything project-specific lives in your repo, in `.claude/workflow.json`. The plugin hardcodes no
branch names, commands, paths or languages.

The full user manual is in [WORKFLOW.md](WORKFLOW.md).

## Install

```text
/plugin marketplace add czekanskyy/dev-kit
/plugin install dev-kit@dev-kit
```

## Project setup

1. **Create `.claude/workflow.json`.** Start from
   [examples/workflow.example.json](examples/workflow.example.json) and adjust branches, commands,
   gate steps, risk paths and languages. The contract is
   [plugins/dev-kit/schema/workflow.schema.json](plugins/dev-kit/schema/workflow.schema.json); your
   file is deep-merged over [plugins/dev-kit/defaults.json](plugins/dev-kit/defaults.json), so only
   `project`, `branches`, `commands` and `gate` are required. Check it with:

   ```text
   node "<plugin root>/scripts/config.mjs" --validate
   ```

2. **Enable the plugin for the project** in `.claude/settings.json`, so every teammate gets the same
   workflow:

   ```json
   {
     "extraKnownMarketplaces": {
       "dev-kit": {
         "source": { "source": "github", "repo": "czekanskyy/dev-kit" }
       }
     },
     "enabledPlugins": {
       "dev-kit@dev-kit": true
     }
   }
   ```

   To pin a release, add `"ref": "<tag>"` to the source; updating the plugin is then a normal pull
   request in your project.

3. **Each teammate installs it once:**

   ```text
   claude plugin install dev-kit@dev-kit --scope project
   ```

4. Optional: set `NTFY_TOPIC` (and `NTFY_TOKEN`) in your environment and `notify.ntfy.server` in the
   config to get push notifications when an agent waits for you.

Requirements: Node 20 or newer, git, and the GitHub CLI (`gh`) logged in for pull requests and
commit statuses. Codex review is optional and uses the Codex plugin when installed.

## Skills

| Skill | What it does |
|---|---|
| `/dev-kit:triage-task <request>` | Tier T0 to T3, risk paths, blocking questions in one round, route and acceptance criteria |
| `/dev-kit:quick-fix <change>` | T0 path: branch, change, gate, PR, merge |
| `/dev-kit:build-task <brief or spec task>` | T1 or one spec task: implementer, gate, review, docs, PR, merge per tier |
| `/dev-kit:review-changes <PR or branch>` | Independent review, security pass on risk paths, optional Codex second opinion |
| `/dev-kit:audit-docs [area]` | Compares docs and agent setup with the real code, then fixes what you pick |

Agents (used by the skills, also callable as `dev-kit:<name>`): `explorer`, `quick-fixer`,
`implementer`, `planner`, `reviewer`, `dep-researcher`.

## Safety note

The hooks are a **local safety net, not a sandbox**. They inspect commands and file edits made through
Claude Code on your machine and refuse or ask about the risky ones, but they cannot see everything a
shell command might do, and they do nothing for pushes made outside Claude Code. Keep server-side
branch protection (required reviews or status checks on your protected branches) wherever your forge
plan allows it, and review what you approve.

## License

[MIT](LICENSE)
