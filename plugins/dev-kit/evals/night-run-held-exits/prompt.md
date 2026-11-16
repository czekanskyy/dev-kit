---
max_turns: 8
allowed_tools: [Skill, Read, Glob, Grep]
---

Run the skill dev-kit:night-run in a dry run. Scenario: the run is armed and claimed, preconditions pass, and `queue.mjs next` prints JSON with `held: true` (a running task belongs to a live other session). Do not run any command; say what the skill does next and which commands it runs or deliberately does not run.
