<!--
Spec template for T2 and T3 tasks. The planner agent copies this structure into
<paths.specs>/<slug>.md and deletes every comment. Keep the headings and their order.
-->
# <Title: what changes, in one line>

Tier: T2 | T3. Status: draft | accepted | in progress (<what is merged, what is open>).

## Goal
<Three lines at most: what changes for the user and why, and what must land before or after it.>

## Acceptance criteria
<!-- Numbered, observable, testable. Name the actor, the input and the exact result (status code,
error code, visible text). Add what stays as it is today: the criteria that must NOT change are as
important as the new ones. Last criterion: which tests prove the rest, and where they run. -->
1. <Actor does X and gets Y.>
2. <Still works as today: ...>
3. <Tests: one unit test per rule branch, integration test, where each runs.>

## Data model
<!-- Collections, fields, types, relations, migrations. If nothing changes, say so and list what
stays untouched (generated files, migrations): "No change. No migration, no generated file." -->

## Tasks
| # | Task | Tier | Files | Tests | Depends on |
|---|---|---|---|---|---|
| 1 | <One deliverable, specific enough to implement without asking.> | T1 | `path/file.ts` | <test that fails first> | none |

<!-- One line after the table: which tasks may run in parallel (they must touch disjoint files) and
which are sequential. A destructive migration is its own T3 task. A task on a risk path is T2 or
higher. A T3 spec is split into T1 and T2 tasks. -->
Parallelism: <tasks X and Y touch disjoint files and may run in parallel after Z.>

## Decisions
<!-- Every decision is one row. Decided: say where the answer comes from (triage, the user, the
source file you read). Assumed: a default you picked without confirmation; it goes into the PR
description. Needs decision: a product or business question, or a new library, service or
infrastructure change; give the options and a recommendation. Work stops only on Needs decision. -->
| # | Question | Status | Choice or options | Recommendation |
|---|---|---|---|---|
| D1 | <Question.> | Decided (<source>) | <Choice and the reason.> | n/a |
| D2 | <Question.> | Assumed | <Default picked.> | Keep. |
| D3 | <Question.> | Needs decision | A: ... B: ... | <Option and why.> |

## Risks
<!-- What could silently break, and the check that catches it, in the form "Caught by: <test or
gate step>". A risk without a check is a finding for the user. End with what is out of scope. -->
- <Risk. Caught by: <test or gate step>.>
- Out of scope, not changed: <list.>
