# Performance rules (cross-cutting)

Content-driven, not tied to one issue type. Triggered when the description/AC/labels indicate a
speed/resource problem. Candidate labels: `performance`, `slow`, `timeout`.
Symptoms: slow query/endpoint, timeout, N+1, high allocation/CPU.

## Instructions
- Measure a baseline first (the slow path's current timing/resource use); state the numbers.
- Fix the dominant cost (e.g. N+1 -> batched query, missing index, redundant work), then re-measure.
- Put before/after numbers in the PR body as the evidence the AC's target is met.

## Rules / watch-outs
- Correctness first: the result set / behavior must not change unless the AC says so.
- No premature micro-optimization without a measurement showing it matters.
- If the fix is a query/index change, also follow `database.md`.
- Add a test guarding correctness of the optimized path; note any load/benchmark done manually.
