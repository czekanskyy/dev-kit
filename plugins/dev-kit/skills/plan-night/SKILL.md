---
name: plan-night
description: Plans an unattended, time-boxed run. Triages each request, queues a T2 or T3 item only when it has an accepted spec without open decisions, asks every remaining question in one round, writes the ordered queue file (paths.queue) with tier, spec or brief, decisions, dependencies and merge consent, validates it with queue.mjs and offers to arm the run or create a trigger. Writes no code and no file other than the queue. Use in the evening, before night-run.
argument-hint: <one or more requests, each in your own words>
disable-model-invocation: true
---

# Plan a night run

Requests: $ARGUMENTS

Every decision, a T3 spec's included, is settled here, while the developer is present. A run asks
nothing. What is not settled now is not queued. This skill writes exactly one file, `paths.queue`,
and no code.

## 0. Load the config first

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails or reports that
`.claude/workflow.json` is missing, stop and tell the user: "This project has no
`.claude/workflow.json`. Create one from `examples/workflow.example.json` in the dev-kit repo
(schema: `plugins/dev-kit/schema/workflow.schema.json`), then run this again." Never continue with
guessed values.

The defaults always supply a `night` object, so a missing key shows up as a missing
`night.rules`. If `night.rules` is absent, stop and tell the user: "This project config has no
`night` block with `night.rules`. Add `night` (`merge`, `rules`, `maxRunHours`) to
`.claude/workflow.json`, then run this again." Do not queue anything.

Keep `tiers`, `riskPaths`, `branches`, `paths.specs`, `paths.queue`, `limits`, `night`, `docs.index`
and `languages.chat` in mind and answer in the `languages.chat` language.

If the requests are empty, ask the user what to plan and stop.

## 1. Read the rules and check the preconditions

Read the file named by `night.rules`. If it does not exist, stop and say so. It lists what must be
true before a run (for example services that must be up) and what a run must not touch. Check each
precondition you can check with a read-only command, and ask the user to confirm the rest in the
question round of step 4. A request the rules forbid (a hotfix, a dependency or config change that
would only be deferred) is dropped now, with the rule quoted.

## 2. Triage each request

Split the arguments into separate requests. For each one apply the triage rules
(`/dev-kit:triage-task`): predict the files and risk paths, a risk path hit is at least T2, a hit in
`riskPaths.alwaysT3` is T3, doubt means the higher tier. Spawn `dev-kit:explorer` subagents in
parallel (model from `models.explorer`, pass `${CLAUDE_PLUGIN_ROOT}`) for anything beyond a few
greps.

| Tier | May be queued when |
|---|---|
| T0, T1 | it has a brief: goal, files, acceptance criteria, in the task's own words |
| T2, T3 | it has a spec in `paths.specs` with `Status: accepted` (or `in progress`) whose Decisions table has no `Needs decision` row; the queue entry names the task id in that spec |

A T2 or T3 request without such a spec is not queued. Say which of the three is missing (no spec,
not accepted, open `Needs decision` rows) and give the next step: `/dev-kit:plan-feature <request>`
for a missing spec, or answering the open rows. Never write or edit a spec here, never invent an
acceptance, and never queue a task from a spec you have not read. A request that is a hotfix, or a
base other than `branches.integration`, is not queued: a night queue only builds on the integration
branch.

## 3. Usage at planning time

Read the weekly usage. In a desktop session call the usage tool (`mcp__ccd_session_mgmt__get_usage`);
elsewhere ask the user for the weekly percent. Record the figure in the queue header.

- Weekly below `limits.lowerEffortAt`: no cut.
- At or above it: keep only T0 and T1 tasks and name every dropped task in the reply, with its tier.
- Unreadable and not given: treat it as at or above the limit (cut to T0 and T1) and say why.

Warn, without cutting, when the queue clearly exceeds the time-box the run will get (the planned
task count against `night.maxRunHours`).

## 4. One round of questions

Ask everything still open in one `AskUserQuestion` round, recommendation first:
- the content of each `Needs decision` row of a spec the developer wants queued, with its options.
  The answer belongs in the spec, which this skill does not edit: the item stays out of the queue
  until the spec is updated (`/dev-kit:plan-feature` on its slug) and this skill runs again;
- `dependsOn`: for each pair of tasks where one builds on the other, ask which queue task it depends
  on. A task runs only when every task it depends on is merged into `branches.integration`; a run
  never stacks on an unmerged branch. When `night.merge` is `none` nothing merges, so a dependent task
  will always be deferred: say so and prefer independent tasks;
- `merge` consent per task, `yes` or `no`. It only counts under `night.merge` `lowRisk`, and only for
  T0 or T1 work without risk paths; a T3 or risk-path PR is never merged by a run whatever is
  written here. Recommend `no` for everything while `night.merge` is `none`;
- precondition items from step 1 you could not check;
- the end of the run (step 7), when the user wants to arm it now.

Never guess an answer. A question left unanswered means the task is not queued.

## 5. Write the queue

Order the tasks the way they should run, dependencies first. Write `paths.queue` (overwrite the
previous queue only after telling the user it is replaced) in this format: a header line with the
planning date and the weekly usage, then one block per task.

```
Planned: <YYYY-MM-DD>   Weekly usage: <pct>%

## <id>: <title>
- tier: T1
- brief: <goal, files and acceptance criteria in one or two lines>
- decisions: none
- dependsOn: none
- merge: no

## <id>: <title>
- tier: T2
- spec: <paths.specs>/<slug>.md#<task id>
- specTier: T2
- decisions: <row ids the task relies on, or none>
- dependsOn: <earlier queue ids, comma separated, or none>
- merge: no
```

Ids are short and unique (`n1`, `n2`, ...). T0 and T1 carry `brief`, T2 and T3 carry `spec` and
`specTier` (the tier in the spec header). `merge` is always written. Never write `base` or `hotfix`
lines, a status, or a branch name: run state lives in `night-state.json`, which only the run writes.

## 6. Validate

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" validate`. Exit 0 prints `queue ok: <n> tasks`.
On exit 1 every line names a task and a rule: fix the queue file (or drop the task and tell the user
why) and run it again. Planning does not finish while validate fails. If it cannot be made to pass
in two attempts, stop and show the exact output.

## 7. Offer to arm

Show the queue in short form: id, title, tier, merge, dependsOn, the dropped tasks and the
warnings. Then offer one of:

- Arm now: ask for the bound as `--until <HH:MM | ISO time>` or `--for <hours>`, optionally
  `--start <time>` and `--resumable`, then run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/night-lock.mjs" acquire <bounds>`. It refuses a box longer
  than `night.maxRunHours`, an end in the past and a second marker: show the refusal and ask for
  another bound. Never arm without the user's explicit bound.
- Trigger: a trigger passes no arguments, only its stored prompt. The developer creates it in the
  desktop app; its prompt is `/dev-kit:night-run --until <time>` or `/dev-kit:night-run --for <hours>`
  (add `--resumable` when wanted). Give the exact prompt to copy. The default permission mode must
  stay on, not bypass.
- Neither: the queue is saved and nothing runs.

## 8. Report and next step

```
Queue: <paths.queue>   Tasks: <n>   Validate: ok   Weekly usage: <pct>%
Queued: <id tier title merge dependsOn>
Not queued: <request, tier, which of: no spec / not accepted / Needs decision / rules / usage cut>
Armed: <run id, start, end> or not armed
Warnings: <dependents that will defer, queue longer than the box, unchecked preconditions>
```

End your reply with exactly one Next step paragraph, filled in:

**Next step:** start the run, or settle what is not queued yet.
Prompt: `/dev-kit:night-run --until <HH:MM>` (or `--for <hours>`; skip when a trigger or armed marker exists)
Prompt: `/dev-kit:plan-feature <request that has no accepted spec>` (only when something was not queued)
