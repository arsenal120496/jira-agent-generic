<#
.SYNOPSIS
    Shared helpers for the jira-poller skill. Dot-source from sibling scripts:
        . "$PSScriptRoot\poller-common.ps1"

.DESCRIPTION
    Provides: agent config (create-on-first-use at %USERPROFILE%\.jira-agent\config.json),
    per-ticket state (state.json), Jira REST auth (JIRA_API_TOKEN User env var + email
    autodetect), label update and comment helpers.
    Windows PowerShell 5.1 compatible.
#>

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------------------
# Agent home: %USERPROFILE%\.jira-agent
# ---------------------------------------------------------------------------
function Get-AgentDir {
    $home = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
    $d = Join-Path $home '.jira-agent'
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    return $d
}
function Get-AgentLogDir {
    $d = Join-Path (Get-AgentDir) 'logs'
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    return $d
}
# Daily rotating log: logs/agent-<yyyyMMdd>.log. When the current day file reaches 1 MB it is
# rotated to agent-<day>.<n>.log and a fresh file continues. Files older than 7 days are purged.
$script:MaxLogBytes = 1MB
function Get-DailyLogPath {
    $dir = Get-AgentLogDir
    $day = Get-Date -Format 'yyyyMMdd'
    $base = Join-Path $dir ("agent-{0}.log" -f $day)
    if (Test-Path -LiteralPath $base) {
        try {
            if ((Get-Item -LiteralPath $base).Length -ge $script:MaxLogBytes) {
                $n = 1
                while (Test-Path -LiteralPath (Join-Path $dir ("agent-{0}.{1}.log" -f $day, $n))) { $n++ }
                Rename-Item -LiteralPath $base -NewName ("agent-{0}.{1}.log" -f $day, $n)
            }
        } catch {}
    }
    return $base
}
function Write-AgentLog($msg) {
    $line = "{0}  {1}" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $msg
    try { Add-Content -LiteralPath (Get-DailyLogPath) -Value $line } catch {}
    return $line
}
function Remove-OldLogs([int]$days = 7) {
    $cut = (Get-Date).AddDays(-$days)
    Get-ChildItem -Path (Get-AgentLogDir) -Filter '*.log' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $cut } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}
function Get-AgentConfigPath { return (Join-Path (Get-AgentDir) 'config.json') }
function Get-AgentStatePath  { return (Join-Path (Get-AgentDir) 'state.json') }

# ---------------------------------------------------------------------------
# Config. dryRun defaults TRUE so first runs are observe-only.
# ---------------------------------------------------------------------------
function Get-DefaultAgentConfig {
    return [pscustomobject]@{
        enabled             = $true
        dryRun              = $true
        pollIntervalMinutes = 10
        jiraBaseUrl         = ''
        agentLabel          = 'claude-fix'
        lockLabel           = 'claude-in-progress'
        doneLabel           = 'claude-done'
        maxTicketsPerRun    = 2
        claudeArgs          = @()
        rules               = @(
            [pscustomobject]@{
                name         = 'sast-remediation'
                labels       = @('ox-sast')
                issueTypes   = @()
                handler      = 'ih-implement-task'
                repo         = ''
                instructions = 'Apply the minimal fix per the SAST recommendation in the ticket.'
            }
        )
    }
}
function Get-AgentConfig {
    $p = Get-AgentConfigPath
    if (-not (Test-Path -LiteralPath $p)) {
        (Get-DefaultAgentConfig | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $p -Encoding UTF8
        Write-Host ("created default config: {0}" -f $p) -ForegroundColor Cyan
    }
    return (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json)
}
function Save-AgentConfig($cfg) {
    ($cfg | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Get-AgentConfigPath) -Encoding UTF8
}

# ---------------------------------------------------------------------------
# Per-ticket state: { "PR-123": { status, ts, note } }. Idempotency is state-based
# (not a JQL time window) so missed scheduler runs never lose tickets.
# ---------------------------------------------------------------------------
function Get-AgentState {
    $p = Get-AgentStatePath
    if (Test-Path -LiteralPath $p) {
        try { return (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json) } catch { return [pscustomobject]@{} }
    }
    return [pscustomobject]@{}
}
function Get-TicketState($key) {
    $s = Get-AgentState
    $prop = $s.PSObject.Properties[$key]
    if ($prop) { return $prop.Value }
    return $null
}
function Set-TicketState($key, $status, $note) {
    $s = Get-AgentState
    $entry = [pscustomobject]@{
        status = $status
        ts     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        note   = [string]$note
    }
    if ($s.PSObject.Properties[$key]) { $s.$key = $entry }
    else { $s | Add-Member -NotePropertyName $key -NotePropertyValue $entry }
    ($s | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath (Get-AgentStatePath) -Encoding UTF8
}

# ---------------------------------------------------------------------------
# Workflows: one file per workflow at %USERPROFILE%\.jira-agent\workflows\<id>.json,
# with per-workflow state at <id>.state.json (ticket entries + a "_meta" object holding
# runtime: { running, lastRun, activeTicket, lastResult }). This replaces the single
# flat config.json for driving the poller; config.json is now only DEFAULTS for the UI.
# ---------------------------------------------------------------------------
function Get-WorkflowsDir {
    $d = Join-Path (Get-AgentDir) 'workflows'
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    return $d
}
function Get-WorkflowFiles {
    Get-ChildItem -Path (Get-WorkflowsDir) -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '*.state.json' }
}
function Read-Workflow($file) {
    try {
        $w = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        $id = if ($w.id) { $w.id } else { [IO.Path]::GetFileNameWithoutExtension($file) }
        $w | Add-Member -NotePropertyName _file -NotePropertyValue $file -Force
        $w | Add-Member -NotePropertyName _id   -NotePropertyValue $id   -Force
        return $w
    } catch { return $null }
}
function Get-WorkflowStatePath($id) { return (Join-Path (Get-WorkflowsDir) ("{0}.state.json" -f $id)) }
function Get-WorkflowState($id) {
    $p = Get-WorkflowStatePath $id
    if (Test-Path -LiteralPath $p) {
        try { return (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json) } catch { return [pscustomobject]@{} }
    }
    return [pscustomobject]@{}
}
function Save-WorkflowState($id, $s) {
    ($s | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Get-WorkflowStatePath $id) -Encoding UTF8
}
function Get-WfTicketState($id, $key) {
    $s = Get-WorkflowState $id
    $p = $s.PSObject.Properties[$key]
    if ($p) { return $p.Value }
    return $null
}
function Set-WfTicketState($id, $key, $status, $note) {
    $s = Get-WorkflowState $id
    $entry = [pscustomobject]@{
        status = $status
        ts     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        note   = [string]$note
    }
    if ($s.PSObject.Properties[$key]) { $s.$key = $entry } else { $s | Add-Member -NotePropertyName $key -NotePropertyValue $entry }
    Save-WorkflowState $id $s
}
# Merge partial runtime keys into _meta (keeps other keys, e.g. update running without losing lastRun).
function Set-WfMeta($id, [hashtable]$updates) {
    $s = Get-WorkflowState $id
    $meta = if ($s.PSObject.Properties['_meta']) { $s._meta } else { [pscustomobject]@{} }
    foreach ($k in $updates.Keys) {
        if ($meta.PSObject.Properties[$k]) { $meta.$k = $updates[$k] } else { $meta | Add-Member -NotePropertyName $k -NotePropertyValue $updates[$k] }
    }
    if ($s.PSObject.Properties['_meta']) { $s._meta = $meta } else { $s | Add-Member -NotePropertyName '_meta' -NotePropertyValue $meta }
    Save-WorkflowState $id $s
}
function Get-WfMeta($id) {
    $s = Get-WorkflowState $id
    if ($s.PSObject.Properties['_meta']) { return $s._meta }
    return $null
}

# ---------------------------------------------------------------------------
# Jira REST (Jira Cloud basic auth: JIRA_USER + JIRA_API_TOKEN, User env var first).
# ---------------------------------------------------------------------------
function Get-JiraUserEmail {
    if ($env:JIRA_USER) { return $env:JIRA_USER }
    $u = [Environment]::GetEnvironmentVariable('JIRA_USER', 'User')
    if ($u) { return $u }
    try {
        $upn = & whoami /upn 2>$null
        if ($LASTEXITCODE -eq 0 -and $upn -and $upn.Trim() -match '@') { return $upn.Trim() }
    } catch {}
    try {
        $ge = & git config user.email 2>$null
        if ($ge -and $ge.Trim() -match '@') { return $ge.Trim() }
    } catch {}
    return $null
}
# Per-workflow Jira base URL override (set by poller-run before scanning a workflow).
$script:JiraBase = $null
function Set-JiraBase($url) { $script:JiraBase = $url }
function Get-JiraBase {
    if ($script:JiraBase) { return $script:JiraBase }
    return (Get-AgentConfig).jiraBaseUrl
}
function Get-JiraContext {
    $token = [Environment]::GetEnvironmentVariable('JIRA_API_TOKEN', 'User')
    if (-not $token) { $token = $env:JIRA_API_TOKEN }
    if (-not $token) { throw 'JIRA_API_TOKEN is not set. Run setup-option1.cmd first.' }
    $user = Get-JiraUserEmail
    if (-not $user) { throw 'Jira user email could not be resolved. Set JIRA_USER.' }
    $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${user}:${token}"))
    return [pscustomobject]@{
        BaseUrl = (Get-JiraBase)
        Headers = @{ Authorization = "Basic $b64"; Accept = 'application/json'; 'Content-Type' = 'application/json' }
        User    = $user
    }
}
function Invoke-Jira($method, $pathAndQuery, $bodyObj) {
    $ctx = Get-JiraContext
    $uri = $ctx.BaseUrl + $pathAndQuery
    try {
        if ($null -ne $bodyObj) {
            $json = $bodyObj | ConvertTo-Json -Depth 10
            return Invoke-RestMethod -Method $method -Uri $uri -Headers $ctx.Headers -Body $json -ErrorAction Stop
        }
        return Invoke-RestMethod -Method $method -Uri $uri -Headers $ctx.Headers -ErrorAction Stop
    } catch {
        $status = ''
        try { $status = [int]$_.Exception.Response.StatusCode } catch {}
        throw ("Jira {0} {1} failed (HTTP {2}): {3}" -f $method, $pathAndQuery, $status, $_.Exception.Message)
    }
}
# Add/remove labels atomically (no read-modify-write race).
function Update-JiraLabels($key, $add, $remove) {
    $ops = @()
    foreach ($l in @($add))    { if ($l) { $ops += @{ add = $l } } }
    foreach ($l in @($remove)) { if ($l) { $ops += @{ remove = $l } } }
    if ($ops.Count -eq 0) { return }
    $body = @{ update = @{ labels = $ops } }
    Invoke-Jira 'PUT' ("/rest/api/3/issue/{0}" -f $key) $body | Out-Null
}
# Plain-text comment (single ADF paragraph). First line should carry the marker.
function Add-JiraComment($key, $text) {
    $body = @{
        body = @{
            type    = 'doc'
            version = 1
            content = @(@{ type = 'paragraph'; content = @(@{ type = 'text'; text = [string]$text }) })
        }
    }
    Invoke-Jira 'POST' ("/rest/api/3/issue/{0}/comment" -f $key) $body | Out-Null
}
