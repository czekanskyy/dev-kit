---
name: night-run
description: Works the planned night queue unattended inside a time-boxed run. Claims the armed run, checks usage before each task, builds each task through quick-fix or build-task in its own worktree, defers what gets stuck instead of asking, leaves T3 and risk-path pull requests open as waiting for merge with one quiet push, merges only where night.merge allows, and ends with run-report. With --until or --for it arms the run first; without them it only continues an armed run. Use from a trigger or an explicit start, after plan-night.
argument-hint: [--until <HH:MM | ISO time> | --for <hours>] [--start <time>] [--resumable]
disable-model-invocation: true
---

# Night run (unattended, time-boxed)

Arguments: $ARGUMENTS

This session asks nothing. It never calls `AskUserQuestion`, never answers a prompt, and never works
around a refusal. Whatever would need the developer is deferred into the queue state with a reason
and the run moves on. The queue file (`paths.queue`) and the night marker are never written by
this session; run state goes through `queue.mjs` only.

Session id for every call below: `${CLAUDE_SESSION_ID}`. Plugin root: `${CLAUDE_PLUGIN_ROOT}`.

## 1. Arm (only with --until or --for)

With `--until` or `--for`, arm the run first:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/night-lock.mjs" acquire --until <time>` (or `--for <hours>`,
plus `--start <time>` and `--resumable` when given). It refuses a box longer than
`night.maxRunHours`, an end in the past and a second valid marker: print its message and stop.
Its JSON output holds the `runId`.

Without those arguments never arm anything. Read the run id from
`node "${CLAUDE_PLUGIN_ROOT}/scripts/night-lock.mjs" status`. `valid: false` means no armed run: say
"No armed night run. Arm one with /dev-kit:night-run --until <time> or --for <hours>." and stop,
having written nothing.

## 2. Claim (the first command of the run proper)

Run exactly `node "${CLAUDE_PLUGIN_ROOT}/scripts/night-lock.mjs" claim --run <runId>` as a plain
command of its own: the guard registers this session in the marker when it sees it, and only then
turns every later `ask` into a `deny`. Do not chain it with other commands.

It fails with no valid marker, before the start time, after the end time or for another run id.
Then write nothing, run no other command except the read-only
`node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"` to explain the cause (no `.claude/workflow.json`:
say so as the other skills do), report the reason and stop.

## 3. Preconditions

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If `night.rules` is not set, stop and say:
   "This project's `.claude/workflow.json` has no `night.rules` (the path of the night rules doc).
   Add it, then run this again." Do not start a task. Otherwise read the rules doc it names and obey
   it (it can only add restrictions). Keep `night.merge`, `limits`, `branches`, `review`, `models`,
   `worktree`, `riskPaths`, `paths`, `languages` and `commands` in mind.
2. If the session visibly runs in a bypass permission mode, stop: the run needs the default mode so
   the guard can refuse. Say so.
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" heartbeat --session ${CLAUDE_SESSION_ID}`. It is an
   atomic check-and-claim: exit 1 means another session holds a fresh heartbeat. Write nothing, send
   no report, release nothing, and stop. Otherwise it has written this session's own heartbeat.
4. `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" run running --session ${CLAUDE_SESSION_ID}`. A
   refusal (the run is stopped or finished) ends the session with that message. A paused run (armed
   `--resumable`) continues here after the window reset.
5. The session working folder is the main checkout on the integration branch. Never edit there:
   every task gets its own worktree (step 5).

## 4. Loop: usage, next task

Repeat until a stop condition below. Pass `--session ${CLAUDE_SESSION_ID}` on every `queue.mjs`
`set`, `usage`, `next`, `run` and `heartbeat` call. Any non-zero exit from one of them (other than
the documented codes below, such as exit 3 of `usage`) means: start no more tasks and go to step 7.
Never retry around it.

**Time and marker.** Before each task run `night-lock.mjs status`. Not `valid`, or `ended`: start no
task, go to step 7. If `lockAlive` is false run `night-lock.mjs keepawake`. No task starts after the
end time.

**Usage.** Read it with the usage tool (`mcp__ccd_session_mgmt__get_usage`): 5 hour window percent
and weekly percent (all models). Then
`node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" usage --window <pct> --weekly <pct> --session ${CLAUDE_SESSION_ID}`
and act on the printed word:

- `continue`: run as configured.
- `lowerEffort`: drop subagent effort one level (high to medium, medium to low) for the rest of the run.
- `onlyLow`: only T0 and T1 tasks start. Send one `high` push for the run:
  First `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" warn --session ${CLAUDE_SESSION_ID}`; send
  the push only when it prints `{"already":false}` (`already:true`: send nothing):
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/notify.mjs" --priority high --title "<project>" --message "Weekly usage at the warn mark, only small tasks"`.
  When `next` returns a T2 or T3 task, take the first pending T0 or T1 task from
  `queue.mjs summary` whose `dependsOn` are all merged; none left: step 7. Leave skipped tasks
  `pending` (the report lists them as not started).
- `pause` (5 hour window): start no new task. Write the handoff to `paths.handoff` (what is done,
  branches, PRs, next step, the exact resume prompt). Armed with `--resumable` (`night-lock.mjs status`):
  `queue.mjs run paused`, keep marker and sleep lock, end the session; a later invocation after the
  reset continues. Otherwise go to step 7.
- `stop` (weekly): write the handoff, send
  `notify.mjs --priority max --title "<project>" --message "Weekly usage limit, run stopped"`,
  `queue.mjs run stopped`, then step 7.
- Exit code 3 (`unreadable`): start no new task. The reason is already in the state. Treat it like
  `pause`.

If usage reaches `pause` or `stop` while a task runs, let it reach a pushed checkpoint (branch pushed,
gate status posted), then proceed as above.

**Next task.** `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" next --session ${CLAUDE_SESSION_ID}`.
It prints `{ task, route, deferred, reason, held }` and has already deferred tasks whose dependencies
are not merged (reason "depends on <id>"). It also converts a stale `running` task (its session is
gone) to `interrupted`.

- `held: true`: a running task belongs to a live other session, so another session holds the run.
  Exit now and write nothing: no run-report, no `run` call, no lock release.
- `task: null` (and not held): no runnable task, step 7.
- An unmerged, waiting, deferred or interrupted dependency never blocks independent tasks. An
  `interrupted` task comes back here; a resumed session continues it from its pushed branch.

## 5. Run the task

1. `queue.mjs set <id> running --session ...`. It refuses when another live session holds the task:
   treat that as a non-zero exit (step 4) and stop starting tasks.
2. Create the task's own worktree from the fresh integration branch (`git fetch <remote> <integration>`,
   then `git worktree add` under `worktree.root` with a new branch named from `branches.work`; an
   interrupted task reuses its pushed branch). Write a `.agent-scope` file in it with the line
   `run: <runId>`, run `worktree.setup` if set, and do all work and all commands from there. Record
   it: `queue.mjs set <id> running --branch <branch> --session ...`.
3. Route by tier. T0: follow `/dev-kit:quick-fix`. T1 to T3: follow `/dev-kit:build-task` with the
   spec path and task id (or the queue brief). The `decisions` lines of the queue are settled; do not
   reopen them. Pass the plugin root and the run's effort level to every subagent.
4. Night overrides to those skills (they win over the skill text):
   - The implementer works in the prepared task worktree (it carries `.agent-scope` with
     `run: <runId>`), so no `isolation: worktree` for it in a night run. If a subagent must use a
     worktree of its own, write the same `.agent-scope` line there before it starts.
   - Keep the claim fresh: run `queue.mjs heartbeat --session ...` between build-task steps, after
     the implement step, after each gate and after each review round. Exit 1 means another session
     took over: stop at once, write nothing more.
   - Never `AskUserQuestion`. A question you would have to ask, an implementer `STATUS: BLOCKED`, or
     a step that "asks the user" means defer.
   - Never push to or open a PR into `test` or `main`; the base is `branches.integration`.
   - Never use `gh pr merge` with `--auto`, `--admin` or `--delete-branch`.
   - After `review.maxRounds` rounds without APPROVE: defer instead of asking how to proceed.
   - Gate red twice and the escalation retry red too: defer (no `high` push; the report carries it).
   - Dependency changes, `.claude/` or hook writes and other guarded actions are refused for this
     session with a `Night mode:` reason. Do not retry or route around it: defer.
   - Leave the PR open; merging is decided in step 6 only.
5. Deferral: `queue.mjs set <id> deferred --category <guard|gate|review|blocked|question|dependency> --reason "<one line, the exact action the developer must take>" [--pr <url>] --session ...`.
   Keep the branch and any PR. Then the next task at once (step 4).

## 6. Finish a built task (merge route)

With the PR open and the final head gated:

1. From the task worktree run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/risk.mjs" --base <remote>/<integration> --json` (or
   `--pr <n>`). `touchesRisk: false` means risk `no`. `touchesRisk: true`, `touchesRisk: null` or any
   non-zero exit means risk `yes`: unknown never merges. Keep this result as `<risk>`.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" route <id> --risk <risk>` (read-only) prints `waiting`, `merge`
   or `open`. Act on that word, not on your own reading of the tier.
   - `waiting` (T3 spec or risk path): never merge, at any `night.merge` level. First record it with
     the flag, which refuses a second notification:
     `queue.mjs set <id> waiting --pr <url> --risk <risk> --notified --session ...`. Only if that
     succeeded send one push:
     `notify.mjs --priority default --title "<project>" --message "PR waiting for merge" --click <PR url>`
     (title is the project, never priority 5). Start the next task at once.
   - `open` (`night.merge` is `none`, or the task is not eligible): run no merge command.
     `queue.mjs set <id> open --pr <url> --risk <risk> --session ...`.
   - `merge` (`lowRisk`, T0 or T1, not from a T3 spec, no risk path, `merge: yes`): merge only when
     the `local-gate` status is green on the PR head and the review verdict is APPROVE. Use the
     command of `/dev-kit:build-task` step 8 with literal values:
     `gh pr merge <n> --squash --match-head-commit <sha>`. Then `git push <remote> --delete <branch>`,
     remove the task worktree as build-task says, run `worktree.sync` if set, send
     `notify.mjs --priority low` with the PR link, and
     `queue.mjs set <id> merged --pr <url> --risk no --session ...`. A refusal (stale base: rebase,
     push, gate again, retry once) that stays refused, or a `Night mode:` deny: leave the PR open and
     defer with the guard category and the PR link.
3. Remove or leave the worktree of an unmerged task as it is; never move a worktree.

## 7. End of the run

When no runnable task is left, the end time has passed, usage said `stop`, a non-resumable `pause`
or unreadable usage ended it (never when `next` said `held`, or `heartbeat` exit 1): first
`queue.mjs run finished --session ...` (`stopped` when usage said `stop`, as in step 4), which also
sets a task still `running` to `interrupted`. Then run `/dev-kit:run-report`. It writes the report, sends the one closing
`low` push (counts only, `max` when every task ended deferred), releases the sleep lock and removes
the marker. A resumable run that paused in step 4 does not run it yet. Send no other notification
at the end, and no second one for the same PR.

## 8. Report to the transcript

```
Run: <runId>   Tasks: merged <n>, waiting <n>, open <n>, deferred <n>, not started <n>
Usage at end: window <pct>, weekly <pct>   Ended by: <no task left | end time | stop | pause | unreadable>
Report: <path>
```

**Next step:** the developer reads the report and merges or fixes what it lists.
Prompt: `/dev-kit:review-changes <PR number>`
