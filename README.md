# Jira Agent (generic / white-label)

## Table of Contents
- [Overview](#overview)
- [Layout](#layout)
- [Build a distributable bundle](#build-a-distributable-bundle)
- [What differs from the internal version](#what-differs-from-the-internal-version)
- [Open items before public release](#open-items-before-public-release)

## Overview
A local, Jira-driven coding agent with a VS Code / Antigravity UI. A poller scans a Jira board per
workflow, dispatches each actionable ticket to a handler skill that implements it end-to-end
(investigate -> classify -> plan -> implement -> build -> test -> self-review -> commit -> PR ->
report), and reports back to the ticket. This is the generic build: no organization-specific
endpoints, project keys, plugin dependencies, or domain content.

## Layout
- `extension/` - the VS Code / Antigravity extension source (TypeScript).
- `extension/packaging/` - `install.ps1` / `install.cmd`, `README.md` (end-user), `build-bundle.ps1`.
- `skills/jira-poller/` - the poller skill + PowerShell scripts (Jira Cloud REST, per-workflow state).
- `skills/implement-task/` - the handler skill + rule profiles.

## Configuring a Sample Workflow
To get started quickly, you can set up a sample workflow in the extension side panel:
1. **Open the Jira Agent** sidebar panel in your editor.
2. Click **"Create workflow"** (or the **+** button).
3. Fill out the workflow form with these sample settings:
   - **Name**: `My Dev Workflow`
   - **Repo**: The absolute path to your local git repository (e.g., `C:\Users\Username\Projects\my-web-app`).
   - **Query labels**: `claude-fix`
   - **Jira base URL**: `https://your-organization.atlassian.net`
   - **Project key**: `XYZ` (replace with your actual Jira Project Key)
   - **Auto run after add**: `ON`
   - Keep the other advanced settings as default (e.g., Handler: `implement-task`).
4. Click **Save**.

### How to trigger the agent:
1. Go to Jira, assign a ticket from the `XYZ` project to yourself.
2. Add the label `claude-fix` to that ticket.
3. Click the **Run Poller Now** (play icon) in the Workflows header of the extension side panel to trigger an immediate scan.
4. The background poller will detect the ticket, launch the handler in your local repo to fix the issue, and open a GitHub PR!


## Build a distributable bundle
```
powershell -ExecutionPolicy Bypass -File extension/packaging/build-bundle.ps1
```
This compiles the extension, packages the VSIX, stages skills + installer, runs a leak-check gate
(fails if any internal string slips in), and produces `extension/jira-agent-bundle-<version>.zip`.
End users unzip it and run `install.cmd` (see `extension/packaging/README.md`).

## What differs from the internal version
- No hardcoded Jira site, project key, or board - all supplied via config/workflow.
- Handler is self-contained: Jira access via the Jira Cloud REST API (`JIRA_USER` + `JIRA_API_TOKEN`),
  PRs via the GitHub CLI (`gh`). No dependency on any private Claude Code plugins.
- Neutral naming: extension id `jira-agent`, command/setting prefix `jiraAgent`, home `~/.jira-agent`,
  skills `jira-poller` / `implement-task`, result markers `AGENT_RESULT` / `AGENT_PR`.
- No organization-specific content (fixed issue-type lists, domain wording, internal repo names) in
  the skills - everything org-specific is supplied through config/workflow.

## Open items before public release
- Replace the `--dangerously-skip-permissions` default with a scoped allowlist + deny list
  (this build carries the flag over so the workflow runs unattended out of the box).
- Sanitize workflow inputs (id / repo path / instructions) before they reach the terminal command.
- Pick a LICENSE and a real publisher id if publishing to a registry.
