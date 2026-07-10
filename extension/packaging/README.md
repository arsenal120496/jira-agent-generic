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
   project key, agent label(s), and rules.
3. The extension finds the poller at `%USERPROFILE%\.claude\skills\jira-poller\scripts\poller-run.ps1`
   automatically. To override, set `jiraAgent.pollerScriptPath` in Settings.

## Update
Re-run `install.cmd` from a newer bundle - it overwrites the skills and force-installs the newer VSIX.

## Uninstall
- Extension: Extensions view -> Jira Agent -> Uninstall.
- Skills: delete `%USERPROFILE%\.claude\skills\jira-poller` and `...\implement-task`.
- Workflows/logs live in `%USERPROFILE%\.jira-agent` - delete if you want a clean slate.
