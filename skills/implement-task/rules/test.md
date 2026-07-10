# Test rules

Issue type: Test ("test of epic, story or bug"). Candidate labels: `test`, `coverage`, `qa`.

## Instructions
- Add or extend automated tests for the target unit/behavior named in the AC; cover the branches
  the AC calls out (happy path + the negative/boundary cases).
- Follow the existing test project's framework, naming, and arrange-act-assert style.

## Rules / watch-outs
- Tests must be deterministic: no real network, no real services, no wall-clock/random dependence,
  no shared mutable state between tests.
- No real personal or sensitive records in fixtures - use synthetic data only.
- Do not weaken assertions or add `[Ignore]`/skips to make a suite "pass".
- A test-only ticket must not change product code; if a fix is needed to make a test pass, that is
  a separate Bug/Defect - note it and go to `on_block`.
