---
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep, Write, Bash, AskUserQuestion]
---

First set up a throwaway project in this folder: write .claude/workflow.json with {"project": "demo", "branches": {"integration": "dev", "protected": ["main"]}, "commands": {"test": "echo ok"}, "gate": {"steps": [{"run": "echo ok"}]}, "night": {"merge": "none", "rules": "docs/night-rules.md"}}, and docs/night-rules.md with one line: "No hotfixes. No dependency changes." Create an empty specs/ folder. Then run the skill dev-kit:plan-night with the request "Add a newsletter signup form with double opt-in and a new subscribers table". There is no spec for it anywhere.
