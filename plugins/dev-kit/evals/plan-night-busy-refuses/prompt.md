---
max_turns: 8
allowed_tools: [Skill, Read, Glob, Grep]
---

Run the skill dev-kit:plan-night in a dry run. Scenario: the config is valid with night.rules set, one T1 request is triaged and ready to queue, and just before writing the queue `queue.mjs busy` prints `{"busy":true,"reason":"run 2026-11-15 is paused"}` and exits 1. Do not run any command; say what the skill does.
