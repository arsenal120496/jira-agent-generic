# Jira Agent (generic / white-label)

## Table of Contents
- [Overview](#overview)
- [Layout](#layout)
- [Prerequisites](#prerequisites)
- [Configuring a Sample Workflow](#configuring-a-sample-workflow)
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

## Prerequisites
Set up these requirements in your environment before using the agent:
- **Jira Credentials**: Define the following environment variables in your system:
  - `JIRA_USER`: Your Jira account email.
  - `JIRA_API_TOKEN`: Your Jira API token (generate one at https://id.atlassian.com/manage-profile/security/api-tokens).
- **Claude Code CLI**: The `claude` executable must be available on your PATH.
- **Git and GitHub CLI**: `git` and `gh` must be installed. Run `gh auth login` so that repository operations and PR creations succeed.
- **PowerShell Core**: On Linux and macOS, PowerShell Core (`pwsh`) must be installed on your PATH for running the background poller tasks.

### Setting up Environment Variables

#### On Linux / macOS
To set these environment variables permanently for command-line and GUI applications, add them to your shell configuration file (e.g., `~/.bashrc` or `~/.zshrc`):
1. Open your configuration file:
   ```bash
   nano ~/.bashrc
   ```
2. Add the following lines at the end of the file:
   ```bash
   export JIRA_USER="your-email@example.com"
   export JIRA_API_TOKEN="your-jira-api-token"
   ```
3. Load the updated configuration:
   ```bash
   source ~/.bashrc
   ```
4. Restart your IDE from the terminal (e.g., `code` or `antigravity-ide`) so it inherits the environment variables.

#### On Windows
To set these environment variables permanently on Windows:
1. Open the Start menu, search for "env", and select **Edit environment variables for your account**.
2. Under **User variables**, click **New...** to add the following variables:
   - Variable name: `JIRA_USER` / Variable value: `your-email@example.com`
   - Variable name: `JIRA_API_TOKEN` / Variable value: `your-jira-api-token`
3. Click **OK** to save, and restart your IDE for the changes to take effect.

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
