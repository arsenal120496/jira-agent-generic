---
name: jira-poller
description: |
  Poll Jira for tickets the developer flagged for the agent (assignee = currentUser()
  AND a configured label), match each to a routing rule, and dispatch it to a handler
  skill that fixes it and opens a PR. Use when the user says "check my agent tickets",
  "run the poller", "poll jira", or wants to configure/schedule the agent.
user-invocable: true
argument-hint: "[--dispatch] [--dry-run] | config | register | status"
allowed-tools: Read, Bash, AskUserQuestion
---

<objective>
Drive the local Option 1 agent loop for the CURRENT developer:

1. Search Jira for actionable tickets (assigned to me + agent label, not locked/done).
2. Match each ticket to a routing rule (labels + issue type -> handler + repo).
3. Dispatch actionable tickets to their handler (headless `claude -p "/<handler>"` in the
   target repo), which fixes the ticket and opens a PR.
4. Report each outcome back to Jira (comment + label swap) and to local state.

There is NO shared "Claude Dev" account: every developer polls their own assigned tickets
under their own Jira token. Config lives at `%USERPROFILE%\.jira-agent\config.json` and is the
single source of truth (poller, scheduler, and any future UI all read/write it).

Input: `$ARGUMENTS`. Output: a table of tickets + what was (or would be) dispatched.
</objective>

<process>

> **Scripts location.** All logic is in PowerShell under this skill's `scripts/` folder.
> Resolve `<scripts>` = the absolute path to the `scripts/` directory next to this SKILL.md,
> and run each with the Bash tool via `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`.
> Never inline `$variable` PowerShell in a `-Command` string.

<step name="route-by-argument">
Parse `$ARGUMENTS`:
- `config`   -> run `poller-config.ps1` (show/edit config), print the result, stop.
- `register` -> tell the user to run `setup-option1.cmd -AgentRegister` (registers the
                Windows scheduled task at the config interval). Stop.
- `status`   -> tell the user to run `setup-option1.cmd -AgentStatus`. Stop.
- otherwise  -> continue (scan; dispatch only if `--dispatch` is present).
</step>

<step name="scan">
Run:
```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<scripts>/poller-search.ps1"
```
This prints one row per ticket (`DISPATCH` or `SKIP` + reason) and a machine-readable
`RESULT_JSON:` line. Show the user the table. If there are 0 `DISPATCH` rows, report
"nothing to do" and stop.
</step>

<step name="confirm-and-dispatch">
Only if `$ARGUMENTS` contains `--dispatch`:

Parse the `RESULT_JSON:` line; for each row with `action == "dispatch"`, confirm with the
user (list key -> handler -> repo) via AskUserQuestion unless `--dry-run` is set. Then run,
one ticket at a time:
```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<scripts>/poller-dispatch.ps1" -Key <key> -Handler <handler> -Repo <repo> -Instructions "<instructions>"
```
Append `-DryRun` when `--dry-run` is set OR the config has `dryRun=true`. Report each
result ([DONE]/[FAILED]) and the log path it prints.

If `--dispatch` is absent, this is a read-only scan: tell the user to re-run with
`--dispatch` (or let the scheduled task do it) to actually execute.
</step>

<step name="summarize">
Print: how many tickets matched, how many dispatched, ok/failed counts, and where logs
live (`%USERPROFILE%\.jira-agent\logs\`). Remind that unattended runs come from the scheduled
task (`setup-option1.cmd -AgentRegister`), and the interval is `pollIntervalMinutes` in the
config.
</step>

</process>

<reference>
An annotated reference of every field lives in `config.sample.jsonc` next to this
SKILL.md (documentation only - the live config must be plain JSON, no comments,
because Windows PowerShell 5.1 ConvertFrom-Json rejects `//`).

Config keys (`%USERPROFILE%\.jira-agent\config.json`):
- `enabled` (bool)          - master kill switch; poller exits immediately when false.
- `dryRun` (bool)           - list what would run, change nothing. Defaults true on first use.
- `pollIntervalMinutes`     - scheduled interval (re-register the task after changing).
- `agentLabel`              - the label a dev adds to hand a self-assigned ticket to the agent.
- `lockLabel` / `doneLabel` - the poller manages these (in-progress / completed).
- `maxTicketsPerRun`        - safety cap per run.
- `rules[]`                 - each: `{ name, labels[], issueTypes[], handler, repo, instructions }`.
                              First rule where ANY of its labels is on the ticket (OR) and
                              whose issueTypes is empty-or-matching wins.

Idempotency is state-based (`%USERPROFILE%\.jira-agent\state.json`), so runs missed while the
laptop slept do not lose tickets; clear a ticket's entry there to force a retry.
</reference>
