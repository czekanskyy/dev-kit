---
type: llm
weight: 1
---

The response either stops because `.claude/workflow.json` is missing, or says that with no runs since the previous digest the digest still writes a short file stating there were no runs. It does not touch the lock, marker or queue, and does not invent runs or PRs.
