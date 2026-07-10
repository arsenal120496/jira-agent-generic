# Fallback rules (no category matched)

Loaded when labels + issue type + acceptance criteria do not map to any specific category.

## Instructions
- Treat as a generic implementation task driven purely by the acceptance criteria.
- In the plan, note "unclassified - no category profile matched" and list which labels/type were seen.

## Rules / watch-outs
- Be conservative: smaller scope, more verification. Prefer asking over assuming.
- If the ticket looks like it should fit a category but the label is missing, say so in the PR
  and suggest the label, rather than silently applying that category's rules.
