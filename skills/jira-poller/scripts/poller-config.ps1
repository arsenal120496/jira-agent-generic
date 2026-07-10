<#
.SYNOPSIS
    Show or edit the agent config at %USERPROFILE%\.jira-agent\config.json.

.DESCRIPTION
    Default (no args): print the config JSON (creating the default on first use) plus
    its path. Edits:
      -SetInterval <min>  set pollIntervalMinutes (1-1439)
      -Enable / -Disable  master kill switch (poller exits immediately when disabled)
      -SetDryRun on|off   dry-run mode (list what would be dispatched, change nothing)

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File poller-config.ps1
    powershell -ExecutionPolicy Bypass -File poller-config.ps1 -SetInterval 15
    powershell -ExecutionPolicy Bypass -File poller-config.ps1 -SetDryRun off
#>
param(
    [int]$SetInterval = 0,
    [switch]$Enable,
    [switch]$Disable,
    [ValidateSet('', 'on', 'off')]
    [string]$SetDryRun = ''
)

. "$PSScriptRoot\poller-common.ps1"

$cfg = Get-AgentConfig
$changed = $false

if ($SetInterval -gt 0) {
    if ($SetInterval -gt 1439) { throw 'Interval must be 1-1439 minutes (schtasks limit).' }
    $cfg.pollIntervalMinutes = $SetInterval
    $changed = $true
    Write-Host ("pollIntervalMinutes -> {0}" -f $SetInterval) -ForegroundColor Green
    Write-Host 'NOTE: re-register the scheduled task to apply: setup-option1.cmd -AgentRegister' -ForegroundColor Yellow
}
if ($Enable)  { $cfg.enabled = $true;  $changed = $true; Write-Host 'enabled -> true'  -ForegroundColor Green }
if ($Disable) { $cfg.enabled = $false; $changed = $true; Write-Host 'enabled -> false' -ForegroundColor Yellow }
if ($SetDryRun -eq 'on')  { $cfg.dryRun = $true;  $changed = $true; Write-Host 'dryRun -> true'  -ForegroundColor Green }
if ($SetDryRun -eq 'off') { $cfg.dryRun = $false; $changed = $true; Write-Host 'dryRun -> false (dispatches will execute)' -ForegroundColor Yellow }

if ($changed) { Save-AgentConfig $cfg; $cfg = Get-AgentConfig }

Write-Host ("CONFIG_PATH: {0}" -f (Get-AgentConfigPath))
$cfg | ConvertTo-Json -Depth 6
