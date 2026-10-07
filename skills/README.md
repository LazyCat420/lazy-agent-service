# Skills

On-demand skill packages live here, one directory per skill:

```
skills/
  repo-triage/
    SKILL.md
```

`SKILL.md` frontmatter:

````markdown
---
name: repo-triage
description: Systematic triage of failing tests in this repository
tools:
  - shell
---

Skill body — loaded on demand when the model calls `skill_read` with
`{"name": "repo-triage"}`.
````

Only `name` + `description` enter the system prompt (via
`src/platform/skills/SkillRegistry.ts#describeAll`); the body is loaded
lazily through the `skill_read` internal tool.
