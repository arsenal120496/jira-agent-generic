# Jira Agent

## Table of Contents
- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Platform support](#platform-support)
- [Quick start](#quick-start)
- [How it runs](#how-it-runs)
- [Settings](#settings)
- [Data and files](#data-and-files)
- [Uninstall](#uninstall)

## What it does
A control panel for a local, Jira-driven coding agent. You define workflows that scan Jira for
labelled tickets assigned to you, then dispatch each matched ticket to a handler that implements it
end to end and opens a pull request. The extension gives you:
- Workflows view: one row per workflow. Create, Start/Stop, set the poll interval, edit, delete.
  Each workflow's status reflects the headless background poller (Running / Overdue / Stopped /
  Not scheduled / Scanning / Error).
- Tickets view: tickets aggregated across all workflows, grouped by status (Running, Blocked,
  Failed, Done) and tagged with their workflow. Re-run a ticket, open its log, open it in Jira.
- Live Log view: run one poll now, open the newest log, open the logs folder.

The poller and handler ship inside the extension as Claude Code skills and are installed
automatically on first run (see [How it runs](#how-it-runs)).

## Requirements
Set these up before using the agent:
- Claude Code CLI (`claude`) on PATH.
- `git` and the GitHub CLI (`gh`); run `gh auth login` so pushes and PRs work.
- Jira Cloud API access as environment variables:
  - `JIRA_USER` = your Jira account email
  - `JIRA_API_TOKEN` = a Jira API token (id.atlassian.com -> Security -> API tokens)
- Node.js only if a target repo's build/test needs it.

## Platform support
Windows only for now. The headless poller is registered as a Windows Scheduled Task and the
extension shells out to `powershell.exe`, `schtasks`, and `taskkill`. macOS/Linux are not yet
supported.

## Quick start
1. Install the extension and reload the window.
2. On first activation it copies the `jira-poller` and `implement-task` skills into
   `%USERPROFILE%\.claude\skills` (re-copied after each extension update).
3. Open the Jira Agent side panel and create a workflow: set the repo path, your Jira base URL,
   project key, agent label(s), and rules.
4. Click Start on the workflow. This registers the background poller (a per-user Scheduled Task,
   no admin rights needed) and kicks one run immediately; after that it polls on its interval.

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

## How it runs
Start registers a single Scheduled Task (`Jira-Agent-Poller`) that ticks every minute and runs the
poller. The poller gates each workflow by its own interval, so one task serves all workflows. Stop
disables a workflow (`enabled = false`) so the poller skips it; the task keeps ticking for the
others. A workflow is only worked on while it is enabled AND the task is alive.

## Settings
- `jiraAgent.homeDir` - path to the agent home (empty = `%USERPROFILE%\.jira-agent`).
- `jiraAgent.pollerScriptPath` - full path to `poller-run.ps1` (empty = auto-detect: the installed
  user-scope skill, then the open workspace).

## Data and files
Everything lives under `%USERPROFILE%\.jira-agent`:
- `config.json` - global defaults used to seed new workflows.
- `workflows/<id>.json` - one file per workflow (repo, JQL, label, interval, rules).
- `workflows/<id>.state.json` - per-workflow ticket state.
- `logs/` - dispatch logs.

## Uninstall
- Extension: Extensions view -> Jira Agent -> Uninstall.
- Skills: delete `%USERPROFILE%\.claude\skills\jira-poller` and `...\implement-task`.
- Scheduled task: `schtasks /Delete /TN Jira-Agent-Poller /F`.
- Workflows/logs: delete `%USERPROFILE%\.jira-agent` for a clean slate.
