# Defect rules

Issue type: Defect ("deviation from requirements"). Distinct from Bug: the code may run without
error but behaves differently from what the requirement/AC specifies.
Candidate labels: `defect`, `regression`.

## Instructions
- Establish the expected behavior from the requirement/AC, then the actual behavior from the
  ticket/repro; the fix closes that gap.
- Trace which change introduced the deviation if it is a regression; reference it in the plan.
- Prefer correcting the logic at its source over adding compensating branches downstream.

## Rules / watch-outs
- Confirm the "correct" behavior against the AC/requirement, not against an assumption.
- Add a test that asserts the required behavior (the one the defect violated) and now passes.
- Do not change unrelated behavior to "improve" it - scope is the deviation only.
- If the requirement itself is unclear or contradicts the AC, go to `on_block` (do not guess).
