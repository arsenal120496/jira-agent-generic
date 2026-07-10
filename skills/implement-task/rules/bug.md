# Bug - runtime rules

Candidate labels: `bug`, `exception`, `crash`. Issue types: Bug.
Symptoms: unhandled exception / null reference, wrong result, stack trace in the ticket/log.

## Instructions
- Reproduce from the stack trace / repro steps in the ticket before changing anything.
- Find the root cause; fix there, not with a broad catch/guard that hides it.

## Rules / watch-outs
- Do not swallow errors with empty catch blocks or a blanket catch-all.
- Add a guard only at the actual root cause, not scattered defensively.
- Include a test that reproduces the bug and now passes.
- Preserve public signatures and behavior contracts unless the AC requires a change.
