---
name: implement-task
description: |
  General autonomous handler that implements a Jira ticket end-to-end for ANY project type:
  investigate -> classify (AC-driven) -> plan -> implement -> build -> test -> self-review ->
  commit-push -> create-pr -> report. Build/test commands are detected from the repo (dotnet,
  npm, msbuild, etc.). Use when the poller dispatches a ticket to this handler, or the user says
  "implement task <key>".
user-invocable: true
argument-hint: <jira-key> [additional instructions]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, TaskCreate, TaskList, TaskGet, TaskUpdate, Agent, Skill
---

<objective>
Implement a Jira ticket end-to-end for whatever project the workflow's repo is, running the same
skeleton a developer would:

1. investigate  - read ticket (summary, description, acceptance criteria, comments, attachments)
2. classify     - from labels + issue type + AC, decide which rule profiles apply and rank them
3. plan         - locate affected code/tests, map each acceptance criterion to a change
4. implement    - branch from an up-to-date base, make the code changes under the loaded rules
5. build        - run the repo's build, classify errors NEW vs pre-existing
6. tests        - run the repo's tests, add/adjust tests so every acceptance criterion is proven
7. self-review  - run /code-review on the diff, fix confirmed findings
8. commit-push  - commit and push the feature branch (automatic, no prompt)
9. create-pr    - open a PR; body links the ticket and maps each AC to how it was met
10. report      - comment the outcome back to the ticket

Input: Jira key (+ optional instructions) as `$ARGUMENTS`.
Output: a working change on a feature branch with a PR open for review.
</objective>

<assumptions>
Confirm these per repo; do not hardcode. Resolve them by inspecting the repo and the poller rule
(`rules[].repo`, `rules[].instructions`); state the resolved values as assumptions in the PR body:
- Repo = the working copy the workflow points at. `cwd` is set by the caller/poller.
- Build/test = detected from the repo (see the build/tests steps): e.g. `.sln`/`.csproj` -> dotnet,
  `package.json` -> npm/pnpm/yarn, `*.dproj`/`*.groupproj` -> msbuild, `pom.xml` -> maven, etc.
  If the workflow instructions specify explicit build/test commands, use those instead.
- Base branch = the repo's default integration branch (read it, do not assume `main` vs `dev`).
- Respect any organization safety policy configured for the repo (e.g. no production infrastructure
  or production database access, no sensitive data in code/tests/fixtures). Do not perform actions the
  ticket does not authorize.
</assumptions>

<jira_access>
All Jira reads/writes use the Jira Cloud REST API v3 with HTTP Basic auth built from environment
variables (no third-party plugin required):
- user  = `JIRA_USER` (the account email)
- token = `JIRA_API_TOKEN`
- base  = the workflow's `jiraBaseUrl` (passed to the handler by the poller)

Auth header: `Authorization: Basic base64("$JIRA_USER:$JIRA_API_TOKEN")`. Endpoints used:
- read issue:     `GET  {base}/rest/api/3/issue/{key}?fields=summary,description,issuetype,labels,status,comment,attachment,issuelinks`
- read comments:  `GET  {base}/rest/api/3/issue/{key}/comment`
- add comment:    `POST {base}/rest/api/3/issue/{key}/comment`   (body = ADF doc)
- transitions:    `GET/POST {base}/rest/api/3/issue/{key}/transitions`
- search (JQL):   `GET  {base}/rest/api/3/search/jql?jql=...`

Run these with the Bash tool (curl or PowerShell `Invoke-RestMethod`). Never hardcode a site URL or
credentials - always read them from the environment / the value the poller passed in.
</jira_access>

<process>

<step name="init">
Extract `<ticket_key>` from `$ARGUMENTS`. Set `<output_dir>` = `~/.jira-agent/tickets/<ticket_key>/` (on Windows: `%USERPROFILE%\.jira-agent\tickets\<ticket_key>\`)
(create if missing) for any working notes (plan.md, build-report.md, test-report.md).

**Fully autonomous - no human-in-the-loop mid-run.** In Option 1 the developer reviews the result
on the GitHub PR, not during execution. Never pause to ask for plan approval or a commit
confirmation. When you cannot proceed safely (missing acceptance criteria, genuinely ambiguous
scope, or a destructive action that the ticket does not authorize), go to the `on_block` step -
do not guess and do not wait for input. The poller's `dryRun` + lock label are the run-level
safety controls.

Create the task list and chain sequentially:
```
id1  = TaskCreate(subject: "Investigate ticket",   activeForm: "Investigating")
id2  = TaskCreate(subject: "Classify + load rules", activeForm: "Classifying")
id3  = TaskCreate(subject: "Create plan",           activeForm: "Planning")
id4  = TaskCreate(subject: "Implement code",        activeForm: "Implementing")
id5  = TaskCreate(subject: "Build",                 activeForm: "Building")
id6  = TaskCreate(subject: "Tests",                 activeForm: "Testing")
id7  = TaskCreate(subject: "Self-review",           activeForm: "Reviewing")
id8  = TaskCreate(subject: "Gate: build+test PASS", activeForm: "Checking gate")
id9  = TaskCreate(subject: "Commit and push",       activeForm: "Committing")
id10 = TaskCreate(subject: "Create pull request",   activeForm: "Creating PR")
id11 = TaskCreate(subject: "Report to Jira",        activeForm: "Reporting")
```
On any failure/blocked case, jump to the `on_block` step (comment + status Blocked + exit non-zero)
instead of continuing.

**Context recovery** - if you lose track after compression: `TaskList()` -> next incomplete ->
`TaskGet` -> resume from that step.
</step>

<step name="investigate">
**Re-visit check (do this FIRST).** If the prompt contains a `[REVISIT: ...]` note (the poller re-ran
an already-blocked ticket), or the ticket carries the block label with a prior automated block
comment: read the comments added **since your last automated block comment** and check them against
what that comment said was needed to unblock.
- If the new comments do NOT supply enough to unblock (or there are no new comments): **do not post
  another comment and do not change status**. End the run by emitting exactly `AGENT_RESULT: blocked-silent`
  as the last line. Nothing else.
- If the block is now resolved: continue the normal flow below (implement -> build -> test -> PR).

Read the ticket via the Jira REST API (see `<jira_access>` for auth + endpoints), e.g.
`GET {base}/rest/api/3/issue/{key}?fields=summary,description,issuetype,labels,status,comment,attachment,issuelinks`.
Capture: summary, full description, **acceptance criteria**, labels, issue type, linked PRs,
attachments/stack traces. Also gather and read the wider context per `_common.md`: ticket
**attachments/documents**, **other tickets mentioned** in description/comments, **linked/related
tickets**, and **blocking/blocked-by** links. If this ticket is blocked by an unresolved ticket,
go to `on_block`. Save `<output_dir>/ticket.md` including a short summary of the linked context.

Extract the acceptance criteria into an explicit **done-checklist** - this is the definition of
done used by plan, tests, and the PR body. If the ticket has no AC and the description is thin,
go to the `on_block` step (comment that acceptance criteria are missing, set status Blocked); do
not guess.
</step>

<step name="classify">
Decide which rule profiles apply - **two inputs, AC-driven, not a fixed precedence**:

Type-based (seed by the ticket's issue type; adapt names to your Jira project):
- Bug -> `bug`; Defect -> `defect`; Story -> `feature`;
  Technical Task -> `technical-task`; Documentation -> `documentation`; Test -> `test`.
- **Non-actionable types -> go to `on_block`** (not a code task, needs a human): e.g. Epic,
  Initiative, or any planning/administrative type that carries no implementable change.

Content-based cross-cutting (seed by description/AC/labels, stack on top of the type profile):
`security`, `database`, `performance`.

Then:
1. Candidate set = the type profile + any cross-cutting profiles the labels/AC suggest, plus `_common`.
2. Read `description` + acceptance criteria (+ comments).
3. Keep only profiles the ticket actually requires; rank them by what the AC demands. Example:
   a SQL-injection ticket labelled both `security` and `database` -> if the AC is "input must be
   sanitized, no injection", Security leads; if the AC is "add index, cut query time", Database leads.
4. Always load `rules/_common.md`. Then load each applicable `rules/<category>.md`.
5. Merge: the **Rules / watch-outs** of every loaded profile all apply (union - never dropped).
   Only the **Instructions** ordering is ranked by the AC.
6. If nothing matches, load `rules/_fallback.md` and note "unclassified" in the plan.

Record the chosen profiles + ranking in `<output_dir>/plan.md` header.
</step>

<step name="plan">
Locate the affected projects, existing tests, and the patterns already used near the change
(Glob/Grep). Produce `<output_dir>/plan.md`: for **each acceptance criterion**, the file(s) to
change and how it will be **verified** (which test/assertion). Keep it minimal - only what the
ticket asks; no speculative refactor.

Do not wait for approval - write the plan and proceed. It is saved for traceability and is
summarized in the PR body, where the developer reviews it.
</step>

<step name="implement">
Create a feature branch from an up-to-date base (fetch, branch off the detected default branch).
Make the code changes following the loaded rules. Every changed line must trace to an acceptance
criterion or the ticket scope.
</step>

<step name="build">
**Skip if** `<output_dir>/build-report.md` contains `Gate: PASS`.
Detect and run the repo's build. Use the workflow instructions if they name a command; otherwise
pick by what is in the repo, e.g.:
- `.sln` / `.csproj` -> `dotnet build`
- `package.json` -> the declared build script (`npm run build`, or `npm ci` when there is none)
- `*.dproj` / `*.groupproj` -> `msbuild`
- `pom.xml` -> `mvn -q compile`; `build.gradle` -> `gradle build`
Classify errors: **NEW** (introduced by this change) -> fix and rebuild; **pre-existing** -> flag
in the report and continue. Write `<output_dir>/build-report.md` with `Gate: PASS/FAIL`.
</step>

<step name="tests">
**Skip if** `<output_dir>/test-report.md` contains `Gate: PASS`.
Add or adjust tests so **each acceptance criterion is proven** (e.g. a regression test for a
security fix). Tests must be deterministic, no network/real services, no sensitive data. Run the repo's test
command (workflow instructions first, else by project type: `dotnet test`, `npm test`,
`mvn test`, `gradle test`, etc.).
Classify failures NEW vs pre-existing. NEW -> fix -> rebuild -> retest. Write
`<output_dir>/test-report.md` with `Gate: PASS/FAIL` and which AC each test covers.
</step>

<step name="self_review">
Run `/code-review` on the working diff. Apply confirmed correctness findings; re-run build/tests
if code changed. This is the automated stand-in for a human code review before the PR.
</step>

<step name="gate">
**Hard gate before any push/PR.** Do NOT commit, push, or open a PR unless BOTH:
- `<output_dir>/build-report.md` = `Gate: PASS` (the repo build succeeded, 0 NEW errors), and
- `<output_dir>/test-report.md` = `Gate: PASS` (the repo tests ran and 0 NEW failures).

If either is FAIL after your fix attempts: **stop, do not push** - go to the `on_block` step
(comment with the failing detail, mention another PR if it is the cause, set status Blocked).
A pre-existing failure that your change did not introduce does not block the gate, but it must be
listed in the report and the PR body.
</step>

<step name="commit">
Reached only when the gate passed. Commit and push automatically - no confirmation prompt
(the developer reviews on the PR).

**Commit per acceptance criterion.** Group the work by AC and make a separate commit for each,
so history is trackable later:
- Subject prefixed with the AC it belongs to: `AC<n>: <what this commit does>`
  (e.g. `AC1: sanitize order-search input`).
- When one AC needs several distinct changes, make several commits all sharing that prefix
  (e.g. `AC1: fix issue 1`, then `AC1: fix issue 2`).
- Stage only the files for that AC per commit (`git add <paths>`), not `git add -A`, so each
  commit maps cleanly to its AC.
- Every commit references `<ticket_key>` (in the body or a trailer) so all commits link to the ticket.
- Do partial/not-done AC honestly: only commit an AC you actually completed; the PR body lists
  which AC are done vs deferred.

After the AC commits, push the branch. Do not skip hooks.
```
(or: git add <paths for AC>; git commit -m "AC1: ..."; ...; git push -u origin <branch>)
```
</step>

<step name="create_pr">
Open a PR targeting the detected base branch with the GitHub CLI:
```
gh pr create --base <base> --head <branch> --title "<ticket_key>: <summary>" --body "<pr body>"
```
PR body: link the ticket, list each acceptance criterion and how it was met, note build/test
gate results and any pre-existing issues left untouched. Present the PR URL.
</step>

<step name="report">
Comment the outcome back on the ticket via the Jira REST API (`POST .../issue/{key}/comment`, PR
link + gate summary). When run by the poller, the poller handles the lock -> done label swap and
state; do not duplicate that here.

**Machine-readable result (MANDATORY, must be the LAST two lines of your output).** The poller cannot
trust the process exit code (headless `claude -p` always exits 0), so it reads these markers instead.
Only emit `done` when a PR was actually opened - print its URL:
```
AGENT_PR: <the PR url>
AGENT_RESULT: done
```
</step>

<step name="on_block">
**Applies to EVERY failure/blocked case** - missing acceptance criteria, gate FAIL (build or test),
ambiguous scope, or a destructive action the ticket does not authorize. On any of these, before
exiting non-zero:
1. Comment on the ticket via the Jira REST API (`POST .../issue/{key}/comment`): what stage failed,
   the concrete reason (NEW build errors / failing tests + report path), and what is needed to unblock.
2. **If the cause is clearly attributable to another change** (e.g. a pre-existing failure, a
   broken base branch, or an error in code this ticket did not touch that a recent/other PR
   introduced), say so explicitly and reference that PR/commit in the comment.
3. **Transition the ticket status to Blocked** via the Jira REST API (`GET .../issue/{key}/transitions`
   to find the id, then `POST` it; map to the project's Blocked/Impediment status).
4. Do NOT push or open a PR.
5. **Machine-readable result (MANDATORY, must be the LAST line of your output).** The poller reads
   this instead of the exit code. Emit `blocked` when a human must supply info or unblock an upstream
   cause; emit `failed` for an unexpected error you could not recover from:
   ```
   AGENT_RESULT: blocked
   ```
   (or `AGENT_RESULT: failed`). Never emit `AGENT_RESULT: done` from this step - no PR was opened.
</step>

</process>

<success_criteria>
- [ ] Ticket read; acceptance criteria extracted into a done-checklist
- [ ] Rule profiles classified (AC-driven) and loaded (_common + applicable categories)
- [ ] Plan maps every acceptance criterion to a change + a verification
- [ ] Feature branch created from an up-to-date base
- [ ] Repo build clean (0 NEW errors)
- [ ] Repo tests passing (0 NEW failures); each AC has a proving test
- [ ] Self-review (/code-review) findings resolved
- [ ] Gate passed: build-report.md and test-report.md both `Gate: PASS` (checked BEFORE push)
- [ ] Committed per AC with `AC<n>:` prefixed messages, each referencing the ticket
- [ ] PR opened targeting the base branch; body maps AC -> evidence
- [ ] Outcome commented back to the ticket
</success_criteria>

<reference>
Rule profiles live in `rules/` next to this SKILL.md:
- `_common.md`   - always loaded; description+AC analysis + org/repo-wide constraints.
- `_fallback.md` - loaded when no category matches.
- Type-based: `bug.md`, `defect.md`, `feature.md`, `technical-task.md`,
  `documentation.md`, `test.md` (one per actionable board issue type).
- Cross-cutting (content-driven): `security.md`, `database.md`, `performance.md`.
Add a new profile by dropping a `rules/<name>.md` file; the classify step picks it up when a
matching type/label/AC appears. Keep each file split into **Instructions** and **Rules / watch-outs**.
</reference>
