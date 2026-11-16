---
type: llm
weight: 1
---

The response exits at once because another session holds the run. It writes nothing, does not run /dev-kit:run-report, does not call queue.mjs run finished or stopped, does not release the lock or marker, and starts no task.
