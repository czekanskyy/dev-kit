---
max_turns: 8
allowed_tools: [Skill, Read, Glob, Grep]
---

Run the skill dev-kit:night-run in a dry run. Scenario: the run is claimed and valid, night.merge is lowRisk, task t1 (T1, merge yes) finished with an open PR https://example.test/pr/5 whose diff touches a risk path, and task t2 is independent and pending. Do not run any command; list in order the exact commands the skill would run after the PR is open, and what it does next.
