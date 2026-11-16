---
type: llm
weight: 1
---

The response runs risk.mjs and queue.mjs route, gets waiting, records t1 with set waiting and --notified, sends exactly one notify.mjs push at priority default with the project as title and the PR link, runs no gh pr merge command at all, and starts the next task t2 at once. It never uses priority 5 for it.
