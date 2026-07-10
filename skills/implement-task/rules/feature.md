# Feature rules

Issue types: Story, Independent Story. New or extended functionality expressed as a user goal.
Candidate labels: `feature`, `enhancement`.

## Instructions
- Implement each acceptance criterion as a distinct, verifiable slice; map every AC to code + test.
- Reuse existing CCS patterns (DI, controllers/handlers, validation) rather than introducing a
  new style for the same concern.
- Keep the public surface (API contracts, DTOs) consistent with existing endpoints.

## Rules / watch-outs
- Backward compatibility: do not break existing callers/contracts unless an AC explicitly requires it.
- Add tests for the new behavior AND for the boundary/negative cases the AC implies.
- No speculative extensibility - build only what the AC asks; no unused config/flags/abstractions.
- New endpoints/inputs must validate input and handle errors like the surrounding code.
