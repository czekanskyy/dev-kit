---
max_turns: 8
allowed_tools: [Skill, Read, Glob, Grep]
---

Run the skill dev-kit:night-run in a dry run. Scenario: night.merge is lowRisk, task t1 (T1, merge yes) finished with an open PR https://example.test/pr/6, and `risk.mjs --json` prints `touchesRisk: null` (the diff could not be read). Do not run any command; list the exact commands the skill would run next, with the risk value passed on, and say whether it merges.
