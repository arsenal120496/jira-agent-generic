# Common rules (always loaded)

Applies to every CCS ticket regardless of label or type. The common rule is **description + AC
driven**: what to do, and which category profiles apply, is decided by analyzing the ticket's
description and acceptance criteria - not by the label alone.

## Instructions
- Analyze the **description + acceptance criteria first**. Derive from them: the scope, the
  definition of done, and which task type(s) this ticket really is. Labels/issue type are only
  hints that seed the candidate category profiles; the description + AC confirm and rank them.
- **Gather and analyze the full ticket context before doing any work**, not just the description:
  - **Attachments / documents** in the ticket (specs, screenshots, logs, sample payloads) - read
    the ones relevant to the AC.
  - **Other tickets mentioned** in the description or comments (by key or URL) - read them for
    context/requirements.
  - **Linked / related tickets** (relates to, clones, causes) - check for overlapping scope or
    decisions already made.
  - **Blocking / blocked-by links** - if this ticket is blocked by an unresolved ticket, do NOT
    start; go to `on_block` and note the blocker.
  Summarize what you found from these in the plan so the PR reviewer sees the context used.
- Treat each acceptance criterion as a checklist item that must be implemented and verified.
- Make the minimum change that satisfies the AC. Every changed line must trace to an acceptance
  criterion or the stated scope.
- State assumptions explicitly in the plan and PR body. When the description/AC are missing or
  genuinely ambiguous, do not guess - go to the `on_block` step.
- Match the existing CCS conventions: project layout, naming, DI patterns, logging style.

## Rules / watch-outs
- No production infrastructure changes and no production database access (org rule).
- No secrets or sensitive data (credentials, tokens, personal data) anywhere: not in code, tests, fixtures, logs, or the PR/ticket comment.
- No emojis or AI-gen typographic characters; use ASCII (em/en dash -> `-`, arrows -> `->`).
- Do not "improve" adjacent code, reformat, or refactor unrelated code.
- Do not skip git hooks or bypass signing.
- Run `dotnet build` and `dotnet test` before opening the PR; report gate results honestly -
  if tests fail or a step was skipped, say so.
