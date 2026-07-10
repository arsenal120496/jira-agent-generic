<#
.SYNOPSIS
    Headless poller tick: iterate every workflow file, and for each one that is due, scan Jira
    and dispatch its actionable tickets. This is what the scheduled task calls.

.DESCRIPTION
    For each workflows/<id>.json:
      - skip if enabled == false (the live on/off state; autoRun is only a create-time preference)
      - skip if not due yet: now - _meta.lastRun < pollIntervalMinutes  (unless -Force)
      - skip if _meta.running is set and fresh (a previous tick still working) - no overlap
      - else: mark running='scanning', run poller-search; for each actionable ticket mark
        running='working'+activeTicket and run poller-dispatch (to completion); then record
        lastRun + lastResult and clear running.

    Each ticket is dispatched to completion; there is NO per-ticket interval. The scheduled task
    should tick often (e.g. every minute); per-workflow interval gates the actual scans.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File poller-run.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File poller-run.ps1 -Force          # run all now
    powershell -NoProfile -ExecutionPolicy Bypass -File poller-run.ps1 -WorkflowId my-workflow  # one workflow
#>
param(
    [switch]$Force,
    [string]$WorkflowId = ''
)

. "$PSScriptRoot\poller-common.ps1"

$now = (Get-Date).ToUniversalTime()
Remove-OldLogs 7   # purge logs older than 7 days (runs once per tick)
function Log($m) {
    $line = Write-AgentLog $m   # daily rotating file (agent-<day>.log, 1 MB rotation)
    Write-Host $line
}

$files = @(Get-WorkflowFiles)
if ($WorkflowId) { $files = @($files | Where-Object { [IO.Path]::GetFileNameWithoutExtension($_.Name) -eq $WorkflowId }) }
if (-not $files.Count) { Log 'no workflows found (create one in the Jira Agent extension).'; exit 0 }

$RUNLOCK_STALE_MIN = 120  # a "running" flag older than this is treated as stale (crash) and ignored
$ranAny = $false

foreach ($f in $files) {
    $wf = Read-Workflow $f.FullName
    if (-not $wf) { Log ("skip {0}: unreadable" -f $f.Name); continue }
    $id = $wf._id

    # `enabled` is the live on/off state (Start/Stop in the extension). `autoRun` is only a create-time
    # preference (auto-start on add) and is NOT a poll gate. Files predating `enabled` (property absent)
    # are treated as enabled so existing workflows keep polling.
    if ($wf.enabled -eq $false) { Log ("skip {0}: stopped (disabled)" -f $id); continue }

    $meta = Get-WfMeta $id
    $interval = [int]$wf.pollIntervalMinutes; if ($interval -le 0) { $interval = 10 }

    # due-check
    if (-not $Force -and $meta -and $meta.lastRun) {
        try {
            $last = [datetime]::Parse($meta.lastRun).ToUniversalTime()
            if (($now - $last).TotalMinutes -lt $interval) { Log ("skip {0}: not due ({1}m interval)" -f $id, $interval); continue }
        } catch {}
    }
    # run-lock (no overlap)
    if ($meta -and $meta.running -and $meta.lastRun) {
        try {
            $last = [datetime]::Parse($meta.lastRun).ToUniversalTime()
            if (($now - $last).TotalMinutes -lt $RUNLOCK_STALE_MIN) { Log ("skip {0}: already running ({1})" -f $id, $meta.running); continue }
        } catch {}
    }

    $ranAny = $true
    Set-JiraBase $wf.jiraBaseUrl
    Set-WfMeta $id @{ running = 'scanning'; lastRun = $now.ToString('yyyy-MM-ddTHH:mm:ssZ'); activeTicket = '' }
    Log ("workflow {0}: scanning (interval={1}m, repo={2})" -f $id, $interval, $wf.repo)

    $result = 'ok'
    try {
        $out = & "$PSScriptRoot\poller-search.ps1" -WorkflowFile $f.FullName
        $jsonLine = $out | Where-Object { $_ -is [string] -and $_ -match '^RESULT_JSON: ' } | Select-Object -First 1
        if (-not $jsonLine) { Log ("workflow {0}: no RESULT_JSON (search error)" -f $id); $result = 'error' }
        else {
            $rows = @()
            try { $rows = @(($jsonLine -replace '^RESULT_JSON:\s*', '') | ConvertFrom-Json) } catch { Log ("workflow {0}: parse error {1}" -f $id, $_.Exception.Message); $result = 'error' }
            $todo = @($rows | Where-Object { $_.action -eq 'dispatch' })
            Log ("workflow {0}: {1} ticket(s), {2} to dispatch" -f $id, $rows.Count, $todo.Count)
            foreach ($t in $todo) {
                Set-WfMeta $id @{ running = 'working'; activeTicket = $t.key }
                Log ("dispatch {0} -> {1} (repo {2})" -f $t.key, $t.handler, $t.repo)
                $isWin = $IsWindows -or ($env:OS -eq 'Windows_NT')
                $psExe = if ($isWin) { 'powershell.exe' } else { 'pwsh' }
                $a = @()
                if ($isWin) { $a += @('-NoProfile', '-ExecutionPolicy', 'Bypass') } else { $a += @('-NoProfile') }
                $a += @('-File', ("$PSScriptRoot\poller-dispatch.ps1"),
                    '-WorkflowFile', $f.FullName, '-Key', [string]$t.key, '-Handler', [string]$t.handler, '-Repo', [string]$t.repo)
                if ($t.instructions -and [string]$t.instructions -ne '') { $a += @('-Instructions', [string]$t.instructions) }
                if ($t.revisit) { $a += '-Revisit' }
                $oldEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
                $dout = & $psExe @a *>&1 | Out-String
                $code = $LASTEXITCODE
                $ErrorActionPreference = $oldEap
                # Surface the dispatch's own status/reason into the log (not just the exit code).
                $status = ($dout -split "`r?`n" | Where-Object { $_ -match '\[(DONE|FAILED|BLOCKED|LOCKED)' } | Select-Object -Last 1)
                if ($status) { Log ("  " + $status.Trim()) }
                # A per-ticket outcome (blocked / blocked-silent / failed) is NORMAL operation, not a
                # workflow error: dispatch exits 1 for all non-done outcomes but still prints a
                # [DONE|FAILED|BLOCKED] status marker. Only treat the workflow as 'error' when dispatch
                # exited non-zero WITHOUT emitting any recognized marker (i.e. it genuinely crashed).
                if ($code -ne 0 -and -not $status) {
                    $result = 'error'
                    $tail = (($dout -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 3) -join ' | ')
                    if ($tail) { Log ("  {0}: dispatch crashed - {1}" -f $t.key, $tail.Trim()) }
                }
            }
        }
    } catch {
        Log ("workflow {0}: run error {1}" -f $id, $_.Exception.Message)
        $result = 'error'
    } finally {
        Set-WfMeta $id @{ running = $null; activeTicket = ''; lastRun = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); lastResult = $result }
    }
    Log ("workflow {0}: done ({1})" -f $id, $result)
}

if (-not $ranAny) { Log 'no workflow was due this tick.' }
Log 'tick complete.'
exit 0
