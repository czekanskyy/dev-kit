# dev-kit workflow manual

How work flows through a project that uses dev-kit: who does what, which checks are hard gates, and
what you type to get things done. Every name in angle brackets (`<integration>`, `<protected>`) is a
value from your project's `.claude/workflow.json`.

## The idea

- **One orchestrator.** The main Claude Code session plans, delegates and integrates. It does not
  write bulk code. Subagents do focused jobs and report back in a fixed format.
- **Four tiers.** The depth of planning, testing and review depends on the tier, not on habit. A typo
  does not get a spec; a payment flow does not skip review.
- **Hard gates over agent count.** Quality comes from a local gate that must be green, a commit status
  pinned to the tested SHA, risk paths detected by a script on the diff, and hooks that refuse unsafe
  actions. More agents checking each other is not a substitute.
- **The developer is the author.** No tool or AI attribution in branches, commits, PR titles or
  bodies, code or docs.
- **Ask early, then deliver.** All blocking questions come in one round at the start. During the work
  the agent asks only at critical decisions, with a push notification.

## Tiers

| Tier | Typical work | Plan | Tests | Review | Merge into `<integration>` |
|---|---|---|---|---|---|
| T0 | copy, colour, spacing, typo, translation | none | gate | none separate | orchestrator |
| T1 | bug fix, small component, form field without schema change | 3 to 5 points in the PR | failing test first, gate | `reviewer` on `reviewerT1` (fresh context) | orchestrator |
| T2 | new section, schema or collection change with migration, integration | spec in `paths.specs` | tests, gate, e2e | `reviewer` on `reviewer` vs spec; Codex on risk paths | orchestrator; with risk paths after your yes |
| T3 | architecture, page-builder-scale feature, checkout or payments, destructive migration | spec split into T1/T2 tasks, **you accept it** | every task its own path, plus the whole | `reviewer` plus Codex adversarial review | after your yes |

Rules that move a task up:
- touching any **risk path** makes it at least T2;
- anything in `riskPaths.alwaysT3` (for example a migration that drops a field or changes a type)
  makes it T3;
- in doubt between two tiers, take the higher one.

Specs mark every decision **Decided**, **Assumed** or **Needs decision**. Work stops only on
`Needs decision` (asked up front); assumptions go into the PR body. Per-tier overrides live in
`tiers` (`merge`: `orchestrator`, `ask` or `human`; `e2e`; `examples`).

## Branch flow

```text
task branch  -->  <integration>  -->  <protected...>
(branches.work)    gate + PR          PR only, merged by a human
```

- Task branches follow `branches.work` (for example `{stage}/{slug}`), cut from a fresh
  `<remote>/<integration>`.
- The orchestrator merges into `<integration>` through a PR, after a green gate. Into protected
  branches it only opens PRs; it never pushes, merges, rebases or deletes them.
- Hotfixes use `branches.hotfix` and target `branches.hotfixBase`; the base is then merged back into
  the integration branch.
- Subagents commit on their own task branch, usually in their own worktree. Only the orchestrator
  pushes and opens PRs.

## Local gate and commit status

`gate.mjs` runs `gate.steps` in order (plus `subprojects` gates when their path is touched). Steps can
be limited with `when` (globs) and `minTier`; `alwaysFromTier: "T3"` next to `when` makes a step run
whenever the diff matches or the tier is at least that tier (also for subproject steps, where it
overrides the "diff does not touch the subproject" skip). Only one gate runs at a time on a machine
(`gate.exclusive`), so two builds never compete.

On success it posts a commit status (`gate.statusContext`, default `local-gate`) on the tested SHA.
The merge hook requires that status to be green **on the PR head** and the branch to contain the
current `<integration>`. So what lands on the integration branch is exactly what was tested, and
no CI minutes are spent for task PRs. Keep full CI for PRs into protected branches.

## Risk paths

`riskPaths` in the config lists:
- `globs`: files whose change needs extra care (access control, schema, migrations, API routes,
  auth, money, package manifests and lockfiles, CI, Docker, env examples);
- `contentPatterns`: regexes matched against added lines (for example `process.env`);
- `alwaysT3`: plain-language triggers used at triage.

`risk.mjs` evaluates the diff, not the agent's claim. A risk hit means at least T2, a security pass in
review, Codex review when configured, and your approval before merge.

## Models and limits

Default role mapping (override any of it in `models`):

| Role | Default |
|---|---|
| orchestrator (main session) | sonnet, medium |
| `explorer` | haiku |
| `quick-fixer` (T0) | haiku, low |
| `implementer` T1/T2, T3 | sonnet medium, sonnet high |
| `implementerEscalation` (after two red gates) | opus, high |
| `planner` T2, T3 | sonnet high, opus high |
| `reviewer` T1, T2/T3 | sonnet high, opus high (read-only) |
| `dep-researcher` | haiku (read-only) |
| writer (PR bodies, docs, log) | haiku |

Usage thresholds (`limits`, percent of your weekly limit):
- **75 (`lowerEffortAt`):** subagent effort drops one level; models stay.
- **90 (`warnAt`):** push warning, finish only small tasks already started, write a handoff prompt to
  `paths.handoff`.
- **95 (`stopAt`):** stop.

## Review policy

- T0: none beyond the gate.
- T1: `reviewer` on the T1 model, fresh context, against the plan in the PR.
- T2: `reviewer` on the T2/T3 model against the spec; on risk paths also a security pass and a Codex
  review (`review.codex.T2risk`).
- T3: `reviewer` plus Codex adversarial review (`review.codex.T3`).
- Codex only reviews, never writes code. If it is missing or out of limits, review continues with
  Claude and the PR says "single-family review".
- At most `review.maxRounds` fix rounds (default 2), then the orchestrator asks you.
- Findings carry a concrete failure scenario and a severity (blocker, major, minor). No style nits.

## Guard rules

Hooks run on every tool call in the project. Summary:

**Deny** (refused with a reason):
- push, merge, rebase, reset, delete or force-push on protected branches; force-push, hard reset or
  delete on the integration branch;
- `--no-verify`, `-c core.hooksPath`, changing `git config user.*`;
- tool or AI attribution or an em-dash in commit messages and PR text, plus `commit.forbid` patterns;
- editing `guard.generated` files; editing `guard.immutableOnceMerged` files once they exist on the
  integration or a protected branch;
- reading `guard.secrets` (with `guard.allowRead` exceptions such as `.env.example`), including a
  recursive `grep -r` or `rg --hidden`/`-uu` over a directory that holds one. The refusal says to add
  `--exclude='.env*'` (or `-g '!.env*'`). Only a narrow form is trusted: a bare basename glob (no
  `/`) that matches the secret file case-sensitively; for grep via `--exclude` (never
  `--exclude-dir`) with no `--include*`, `--exclude-from`, `-L` or `--dereference-recursive`; for rg
  via a negative `-g`/`--glob` with no later positive glob, no `--iglob`, no
  `--glob-case-insensitive`, no `-L`/`--follow`. Naming the secret as a path is still refused;
- printing the whole environment (`printenv`, `env`, `export -p`, `set`, `Get-ChildItem env:`) or a
  secret-looking variable (`printenv X_TOKEN`, `echo $API_KEY`): print only the variable you need;
- `git worktree move` (it breaks symlinked `node_modules` and slot bindings) and
  `gh pr merge --delete-branch` (gh switches the local checkout to the base branch; merge without it
  and run `git push <remote> --delete <branch>` afterwards);
- `gh pr merge` with shell variables as PR number or SHA: the guard cannot resolve them;
- destructive commands: volume and database wipes, `rm -rf` outside `guard.removableDirs` and
  worktrees, `curl | sh`, `git clean -x`, plus `guard.denyCommands`;
- any command carrying a `guard.databaseUrlEnv` connection string to a host outside
  `guard.localHosts`.

**Ask** (you get a prompt and a push notification):
- installing, upgrading or removing packages;
- removing worktrees that are not finished agent slots (see Allow), and `git worktree prune`;
- editing `.claude/settings*.json`, `.claude/workflow.json` or hooks;
- `gh pr merge` into the integration branch when risk paths are touched, and every T3 merge;
- pushing to a remote other than `branches.remote`; `guard.askCommands`.

**Allow** without asking:
- reading, editing in your worktree, running configured `commands`;
- git on your own task branch (`--force-with-lease` only there);
- `gh pr create` into any branch; `gh pr merge` into the integration branch with a green gate, a
  current base and no risk paths; `--match-head-commit` may be a unique prefix of at least 7 hex
  characters of the PR head;
- `git worktree remove` (also with `--force`) and `rm -rf` of a worktree that is under
  `worktree.root` (real paths compared, so symlinks cannot escape), is listed by
  `git worktree list`, is not the main worktree, the current checkout or an ancestor of either, holds
  a `.agent-scope` file (made by the project's `worktree.setup`) and has a clean
  `git status --porcelain --ignored`. Ignored entries are accepted only inside a
  `guard.removableDirs` folder, as `.agent-scope`, or as a root-level `.env*` file (derived, recreated
  by setup). Any other ignored file (local databases, uploads, media) makes the guard ask;
- `git push <remote> --delete <task-branch>` for non-protected branches.

A stop check runs `stopCheck.commands` when an agent tries to finish with uncommitted code changes
matching `stopCheck.codeGlobs`. Files with unresolved merge conflicts (`git diff --diff-filter=U`) are
left out of the checked list so a half-finished merge does not block; every other changed file is
still checked.

## Notifications

`notify.mjs` sends to ntfy (`notify.ntfy.server`, topic and token from the env names in the config).
Messages carry only a title and a link.

| Priority | When |
|---|---|
| max | everything is blocked and nothing can continue |
| high | a question waits for you, usage at 90 or 95 percent, a task was set aside after two red gates |
| low | PR ready, merged into the integration branch, report written |

## Skill catalog

| Skill | Example |
|---|---|
| `/dev-kit:triage-task` | `/dev-kit:triage-task The contact form accepts an empty phone number` |
| `/dev-kit:quick-fix` | `/dev-kit:quick-fix Footer: change "Contact us" to "Get in touch"` |
| `/dev-kit:build-task` | `/dev-kit:build-task specs/newsletter-signup.md task 2` |
| `/dev-kit:review-changes` | `/dev-kit:review-changes 142` |
| `/dev-kit:audit-docs` | `/dev-kit:audit-docs docs/` |

Coming next: night mode (`/plan-night`, unattended queue, morning report), `/plan-feature`,
`/fix-bug` (mandatory regression test), `/update-deps` (inventory, parallel `dep-researcher`, report,
your pick), `/release-stage`, `/workflow-help`.

## Typical scenarios

**Small text fix.** `/dev-kit:quick-fix Pricing page: "per month" should read "monthly"`. The
orchestrator branches from the integration branch, edits, runs the T0 gate, opens a PR and merges it.
You get a quiet notification with the link.

**Bug.** `/dev-kit:triage-task Saving a draft loses the selected category`. Triage says T1 with
criteria. `/dev-kit:build-task ...` then has the implementer write a failing test, fix it, pass the
gate; a fresh reviewer checks it; the PR merges.

**New feature (T2).** Triage says T2 because it adds a collection field and a migration (risk path).
The planner writes `specs/<slug>.md`; you answer the `Needs decision` rows once. Each task goes
through `/dev-kit:build-task`, with a security pass and a Codex review. The merge command asks for
your yes because risk paths are touched.

**Big change (T3).** The planner splits it into T1/T2 tasks. Nothing is built until you accept the
spec. Every task follows its own path; the final review is adversarial; every merge waits for your
yes.

**Dependency update (coming next).** `/update-deps` will inventory outdated packages, research each
family in parallel with `dep-researcher` (web content treated as untrusted data), and present a report
with risk, tier and affected code. Your selection is the go-ahead; security fixes first, then patches
in one T1 PR, families separately as T2, majors one by one with a spec.

## FAQ

**Do I need GitHub Actions?** Not for task PRs: the local gate and its commit status replace CI there.
Keep CI on PRs into protected branches.

**What if the gate is red twice?** The implementer gets one escalation attempt on the stronger model.
Still red: the task stops, you get a notification and a report.

**Can an agent merge into my protected branch?** No. The bash guard refuses it. Server-side branch
protection is still recommended, because hooks only see what runs through Claude Code.

**Is the hook a sandbox?** No. It is a local safety net that inspects commands and edits. Review what
you approve.

**Codex is not installed. Does review still work?** Yes. Review runs with Claude only and the PR says
"single-family review".

**Where do branch names, commit language and PR sections come from?** From `.claude/workflow.json`:
`branches`, `commit.format`, `languages`, `pullRequest`.

**A skill says the config is missing.** Create `.claude/workflow.json` from
`examples/workflow.example.json` and run `config.mjs --validate`.

**Several teammates?** The config, settings and plugin pin live in the repo, so everyone runs the same
rules. Each person installs the plugin once with `--scope project` and sets their own ntfy topic.
