<#
.SYNOPSIS
    Dispatch ONE ticket for a given workflow: lock it, run the handler skill headless in the
    workflow's repo, then report the outcome back to Jira (label swap + comment) and to the
    workflow's per-ticket state.

.DESCRIPTION
    Driven by a workflow file (workflows/<id>.json) for its labels, Jira base URL, and state.
    Flow:
      1. add <lockLabel>, workflow state = dispatched
      2. run:  claude -p "/<Handler> <Key> <Instructions>"  with cwd=<Repo>
         (output appended to %USERPROFILE%\.jira-agent\logs\<ts>-<Key>.log)
      3. by handler exit code:
           0        -> swap lock->done label, comment success, state=done
           2        -> swap lock->block label, comment blocked, state=blocked
           other    -> swap lock->fail label,  comment failure, state=failed, exit 1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File poller-dispatch.ps1 -WorkflowFile "...\my-workflow.json" `
        -Key ABC-123 -Handler implement-task -Repo d:\work\my-repo -Instructions "..."
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkflowFile,
    [Parameter(Mandatory = $true)]
    [string]$Key,
    [string]$Handler = '',
    [string]$Repo = '',
    [string]$Instructions = '',
    [switch]$Revisit
)

. "$PSScriptRoot\poller-common.ps1"

$wf = Read-Workflow $WorkflowFile
if (-not $wf) { Write-Host ("[FAILED ] {0}: cannot read workflow {1}" -f $Key, $WorkflowFile) -ForegroundColor Red; exit 1 }
Set-JiraBase $wf.jiraBaseUrl
$wid = $wf._id
$marker = 'jira-poller - automated dispatch'
$lock  = $wf.lockLabel;  if (-not $lock)  { $lock  = 'claude-in-progress' }
$done  = $wf.doneLabel;  if (-not $done)  { $done  = 'claude-done' }
$block = $wf.blockLabel; if (-not $block) { $block = 'claude-blocked' }
$fail  = $wf.failLabel;  if (-not $fail)  { $fail  = 'claude-failed' }

# --- config validation (no state writes: fixing config lets the next run retry) ---
if (-not $Handler) { Write-Host ("[FAILED ] {0}: rule has no handler" -f $Key) -ForegroundColor Red; exit 1 }
if (-not $Repo)    { Write-Host ("[FAILED ] {0}: workflow has no repo path" -f $Key) -ForegroundColor Red; exit 1 }
if (-not (Test-Path -LiteralPath $Repo)) { Write-Host ("[FAILED ] {0}: repo not found: {1}" -f $Key, $Repo) -ForegroundColor Red; exit 1 }
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) { Write-Host ("[FAILED ] {0}: claude CLI not found on PATH" -f $Key) -ForegroundColor Red; exit 1 }

$prompt = "/$Handler $Key"
if ($Instructions) { $prompt = "$prompt $Instructions" }
# Re-visit of a still-blocked ticket: tell the handler to read NEW comments and either continue (if
# the block is now resolvable) or stay blocked WITHOUT posting another comment (avoid spam).
if ($Revisit) { $prompt = "$prompt [REVISIT: this ticket is already blocked. Read comments added since the last automated block comment and decide if the block is resolved. If NOT resolved, do not comment again - emit 'AGENT_RESULT: blocked-silent'. If resolved, continue implementing.]" }
# Headless runs must not stop for tool-permission prompts (read Jira, git, gh, edit files),
# otherwise the agent just reports "blocked on permissions" and exits 0 (a false "done").
$extraArgs = @('--dangerously-skip-permissions')
if ($wf.claudeArgs) { foreach ($x in $wf.claudeArgs) { if ($x -and ($extraArgs -notcontains $x)) { $extraArgs += [string]$x } } }

$logFile = Join-Path (Get-AgentLogDir) ("{0}-{1}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $Key)

# --- 1. lock ---
Update-JiraLabels $Key @($lock) @()
Set-WfTicketState $wid $Key 'dispatched' ("handler={0}" -f $Handler)
Write-Host ("[LOCKED ] {0}: '{1}' added; running handler (log: {2})" -f $Key, $lock, $logFile)

# --- 2. run handler headless in the target repo ---
$code = 1
$oldEap = $ErrorActionPreference
$oldBaseBranch = $env:BASE_BRANCH
$oldCreatePR = $env:CREATE_PR

if ($wf.baseBranch) { $env:BASE_BRANCH = $wf.baseBranch } else { $env:BASE_BRANCH = '' }
if ($wf.createPR -eq $false) { $env:CREATE_PR = 'false' } else { $env:CREATE_PR = 'true' }

Push-Location $Repo
try {
    # Continue (not Stop): claude writes warnings/progress to stderr; under Stop that would throw
    # and mask the real exit code. We rely on $LASTEXITCODE for pass/fail.
    $ErrorActionPreference = 'Continue'
    "=== $marker | $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | $Key -> /$Handler ===" | Set-Content -LiteralPath $logFile -Encoding UTF8
    & $claude.Source -p $prompt @extraArgs *>> $logFile
    $code = $LASTEXITCODE
} catch {
    ("dispatch exception: {0}" -f $_.Exception.Message) | Add-Content -LiteralPath $logFile
    $code = 1
} finally {
    $ErrorActionPreference = $oldEap
    $env:BASE_BRANCH = $oldBaseBranch
    $env:CREATE_PR = $oldCreatePR
    Pop-Location
}

# --- 3. decide outcome ---
# The process exit code is NOT authoritative: headless `claude -p` returns 0 even when the handler
# blocked or errored. Source of truth = the handler's machine-readable marker in the log, and for a
# claimed "done", a real PR must exist in the repo. Precedence: AGENT_RESULT marker -> PR verification.
$logText = ''
try { $logText = Get-Content -LiteralPath $logFile -Raw -ErrorAction SilentlyContinue } catch {}
# The header is written UTF-8 (BOM) but claude's output is appended via `*>>` as UTF-16LE in PS 5.1.
# Get-Content sees the UTF-8 BOM and decodes the whole file as UTF-8, so the appended UTF-16 bytes
# come back interleaved with NUL chars, which breaks the AGENT_RESULT regex. Strip NULs so the ASCII
# markers match regardless of the encoding mismatch.
$logText = [string]$logText -replace "`0", ''
$resultMarker = ''
$mm = [regex]::Matches([string]$logText, '(?im)^\s*AGENT_RESULT:\s*(done|blocked-silent|blocked|failed)\s*$')
if ($mm.Count -gt 0) { $resultMarker = $mm[$mm.Count - 1].Groups[1].Value.ToLower() }

# Verify a real PR for this ticket exists (branch + commit + PR). "Done" is only allowed when true.
function Test-PrExists {
    param([string]$RepoPath, [string]$IssueKey, [string]$Log)
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($gh) {
        Push-Location $RepoPath
        try {
            $oe = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            $found = & $gh.Source pr list --state all --search $IssueKey --json url,title,headRefName *>&1 | Out-String
            $ErrorActionPreference = $oe
            if ($found -and ($found -match '"url"')) { return $true }
        } catch {} finally { Pop-Location }
    }
    if ($Log -match '(?im)^\s*AGENT_PR:\s*https?://\S+') { return $true }
    if ($Log -match 'https?://\S*/pull/\d+') { return $true }
    return $false
}

# Resolve final result. Default to failed unless we have positive evidence otherwise.
$result = 'failed'
if ($resultMarker -eq 'blocked-silent') {
    $result = 'blocked-silent'
} elseif ($resultMarker -eq 'blocked') {
    $result = 'blocked'
} elseif ($resultMarker -eq 'failed') {
    $result = 'failed'
} elseif ($resultMarker -eq 'done') {
    if ($wf.createPR -eq $false -or (Test-PrExists -RepoPath $Repo -IssueKey $Key -Log $logText)) { $result = 'done' }
    else { $result = 'failed'; ("verify: handler reported done but no PR found for {0} - downgraded to failed" -f $Key) | Add-Content -LiteralPath $logFile }
} else {
    # no marker - fall back to exit code, but still require a real PR for done unless disabled
    if ($code -eq 0 -and ($wf.createPR -eq $false -or (Test-PrExists -RepoPath $Repo -IssueKey $Key -Log $logText))) { $result = 'done' }
    elseif ($code -eq 2) { $result = 'blocked' }
    else { $result = 'failed' }
}

# --- 4. report outcome ---
if ($result -eq 'done') {
    Update-JiraLabels $Key @($done) @($lock)
    try {
        if ($wf.createPR -eq $false) {
            Add-JiraComment $Key ("{0}: handler '{1}' completed (PR creation disabled). Log: {2}" -f $marker, $Handler, $logFile)
        } else {
            Add-JiraComment $Key ("{0}: handler '{1}' completed. Check the linked PR. Log: {2}" -f $marker, $Handler, $logFile)
        }
    } catch {}
    Set-WfTicketState $wid $Key 'done' ("handler={0}; log={1}" -f $Handler, $logFile)
    if ($wf.createPR -eq $false) {
        Write-Host ("[DONE   ] {0}: handler completed (PR creation disabled)" -f $Key) -ForegroundColor Green
    } else {
        Write-Host ("[DONE   ] {0}: handler completed (PR verified)" -f $Key) -ForegroundColor Green
    }
    exit 0
} elseif ($result -eq 'blocked-silent') {
    # Re-visit: still blocked and nothing new to say. Keep the block label, do NOT comment again.
    Update-JiraLabels $Key @($block) @($lock)
    Set-WfTicketState $wid $Key 'blocked' ("handler={0}; revisit still blocked (no comment); log={1}" -f $Handler, $logFile)
    Write-Host ("[BLOCKED] {0}: still blocked on re-visit (no new comment posted)" -f $Key) -ForegroundColor Yellow
    exit 1
} elseif ($result -eq 'blocked') {
    Update-JiraLabels $Key @($block) @($lock)
    try { Add-JiraComment $Key ("{0}: handler '{1}' BLOCKED - needs a human. Log: {2}" -f $marker, $Handler, $logFile) } catch {}
    Set-WfTicketState $wid $Key 'blocked' ("handler={0}; log={1}" -f $Handler, $logFile)
    Write-Host ("[BLOCKED] {0}: handler blocked (no PR; needs info)" -f $Key) -ForegroundColor Yellow
    exit 1
} else {
    Update-JiraLabels $Key @($fail) @($lock)
    # Do NOT comment on failure. Comments are reserved for the 'blocked' case (missing info that a
    # human must supply). A failure is a system/handler error - it is recorded via the fail label,
    # workflow state, and the log file, not by spamming the ticket.
    Set-WfTicketState $wid $Key 'failed' ("handler={0}; exit={1}; log={2}" -f $Handler, $code, $logFile)
    Write-Host ("[FAILED ] {0}: no PR produced (exit {1}, log: {2})" -f $Key, $code, $logFile) -ForegroundColor Red
    exit 1
}
