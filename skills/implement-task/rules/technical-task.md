# Technical Task rules

Issue type: Technical Task ("technically oriented, e.g. creating a database script; no code
changes to the core product"). Candidate labels: `tech-task`, `script`, `infra`, `config`.

## Instructions
- Scope is technical/operational work that does not modify core product code: scripts, config,
  build/tooling, one-off data or maintenance scripts.
- If the task turns out to require core product code changes, it was mis-typed - note it and, if
  the AC cannot be met without touching product code, go to `on_block` for re-triage.
- If the technical work is a database script/change, ALSO load and follow `database.md`.

## Rules / watch-outs
- Keep changes reversible where possible; scripts idempotent and safe to re-run.
- No hardcoded environment-specific values or secrets; read from config.
- No production infrastructure or production DB access (org rule).
- Provide how-to-run / verification notes in the PR body since there may be no unit test surface.
