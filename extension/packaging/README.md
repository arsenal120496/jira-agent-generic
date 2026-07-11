# Jira Agent - Install

## Table of Contents
- [What is in this bundle](#what-is-in-this-bundle)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [After install](#after-install)
- [Update](#update)
- [Uninstall](#uninstall)

## What is in this bundle
- `skills/jira-poller` - the poller (scans Jira per workflow, dispatches tickets).
- `skills/implement-task` - the handler that implements a ticket end-to-end and opens a PR.
- `jira-agent-<version>.vsix` - the VS Code / Antigravity extension (workflow + tickets + live log UI).
- `install.ps1` / `install.cmd` - the installer.

The skills are self-contained: they talk to Jira through the Jira Cloud REST API and open PRs with
the GitHub CLI (`gh`). There are no plugin dependencies to install.

## Prerequisites
Set up separately before using the agent:
- `git` and the GitHub CLI `gh` (run `gh auth login` so pushes and PRs work).
- The Claude Code CLI `claude` on PATH.
- Node.js (only if a target repo's build/test needs it).
- PowerShell Core (`pwsh`) on PATH (required for Linux/macOS).
- Jira Cloud API access as environment variables:
  - `JIRA_USER`      = your Jira account email
  - `JIRA_API_TOKEN` = a Jira API token (id.atlassian.com -> Security -> API tokens)

## Install
1. Unzip this bundle anywhere.
2. Double-click `install.cmd` (or run `powershell -ExecutionPolicy Bypass -File install.ps1`).
   - Flag: `-SkipExtension` installs just the skills.
3. It copies the two skills to `%USERPROFILE%\.claude\skills` and installs the VSIX into every
   detected IDE (`code`, `antigravity`). If no IDE CLI is on PATH, install the VSIX manually from the
   Extensions view (`... -> Install from VSIX`).

## After install
1. Reload the IDE window (Command Palette -> `Reload Window`).
2. Open the Jira Agent side panel -> create a workflow: set the repo path, your Jira base URL,
   project key, agent label(s), and rules (see below for a sample setup).
3. The extension finds the poller at `%USERPROFILE%\.claude\skills\jira-poller\scripts\poller-run.ps1`
   automatically. To override, set `jiraAgent.pollerScriptPath` in Settings.

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

### Reference: Workflow Setting Properties

Here is the complete reference of all the fields available in the workflow editor form:

#### Core Settings
- **Name**: Display name for this workflow (e.g., `My Dev Workflow`).
- **Repo**: Local working copy path this workflow operates on. You can browse for a folder or enter a GitHub clone URL and click **Clone**.
- **Query labels**: Semicolon-separated labels the poller searches for (e.g., `claude-fix`). The poller scans for tickets assigned to you containing any/all of these labels.
- **Match mode**: How query labels are combined:
  - `Any of these labels (OR)`: Matches tickets with any of the query labels.
  - `All of these labels (AND)`: Matches tickets with all of the query labels.
  - `None of these labels (NEITHER)`: Excludes tickets carrying any of the query labels.
  - `Custom JQL`: Allows you to write a custom JQL query.
- **Custom JQL**: A custom Jira JQL query (used when Match mode is set to "Custom").
- **Auto run after add**: Toggle (`ON`/`OFF`) that automatically starts the background poller upon workflow creation.
- **Poll interval (min)**: How often the scheduled task ticks and checks this workflow, in minutes (e.g., `10` minutes).

#### Advanced Settings (click "Advanced" to expand)
- **Handler**: The headless skill that implements the ticket (default: `implement-task`).
- **Max tickets / run**: Safety cap for the maximum number of tickets to dispatch per scan (default: `2`).
- **Project key**: Jira project key (e.g., `XYZ`). Used to query Jira labels and load project-specific issue types.
- **Issue types**: Semicolon-separated issue types to filter (e.g., `Bug;Task;Story`). Leave empty to retrieve and match all project issue types.
- **Instructions**: Custom guidance instructions appended to the agent's prompt (e.g. `Follow coding rules defined in rules.md`).
- **Jira base URL**: Your organization's Jira site URL (e.g., `https://your-org.atlassian.net`).
- **Lock label**: Label added to a ticket while the agent is working on it (default: `claude-in-progress`).
- **Done label**: Label added to a ticket when the agent successfully opens a PR (default: `claude-done`).
- **Block label**: Label added when the run is blocked (e.g., missing AC, needs info; default: `claude-blocked`).
- **Fail label**: Label added when the run fails (e.g. build/test gate failures or crash; default: `claude-failed`).


### How to trigger the agent:
1. Go to Jira, assign a ticket from the `XYZ` project to yourself.
2. Add the label `claude-fix` to that ticket.
3. Click the **Run Poller Now** (play icon) in the Workflows header of the extension side panel to trigger an immediate scan.
4. The background poller will detect the ticket, launch the handler in your local repo to fix the issue, and open a GitHub PR!

## Update
Re-run `install.cmd` from a newer bundle - it overwrites the skills and force-installs the newer VSIX.

## Uninstall
- Extension: Extensions view -> Jira Agent -> Uninstall.
- Skills: delete `%USERPROFILE%\.claude\skills\jira-poller` and `...\implement-task`.
- Workflows/logs live in `%USERPROFILE%\.jira-agent` - delete if you want a clean slate.
