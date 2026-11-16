---
type: llm
weight: 1
---

The response treats the request as T2 or T3 work (a new table means a migration) and does not queue it, because there is no accepted spec. It says that a spec is missing and asks the developer what to do, or gives the /dev-kit:plan-feature prompt as the next step. It writes no spec and no code, and it writes no queue file that holds this task.
