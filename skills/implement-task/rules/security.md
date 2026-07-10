# Security / SAST rules

Candidate labels: `security`, `sast`, `ox`, `vulnerability`. Issue types: Vulnerability, Bug.
Symptoms: SQL injection, XSS, hardcoded credentials, path traversal, insecure deserialization,
missing authz/authn checks.

## Instructions
- Identify the source -> sink taint path; fix at the boundary, not just the symptom.
- Reference the finding ID and CWE in the plan and PR body.
- Apply the standard .NET remediation for the class of issue:
  - SQL injection -> parameterized queries / an ORM parameter, never string concatenation.
  - XSS -> encode output for the correct context; do not disable framework encoders.
  - Path traversal -> canonicalize and allowlist paths.
  - Deserialization -> restrict types / avoid unsafe binders.
  - Secrets -> move to configuration/secret store; never inline.

## Rules / watch-outs
- Never suppress or disable the scanner rule to make the finding "pass".
- Never log secrets, tokens, or the tainted payload.
- A regression test that proves the exploit is now blocked is REQUIRED before the PR.
- Keep the change minimal - fixing the vulnerability, not refactoring the surrounding code.
- Link the OX/SAST finding to the PR so the fix is traceable.
