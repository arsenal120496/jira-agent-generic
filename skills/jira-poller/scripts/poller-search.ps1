<#
.SYNOPSIS
    Poll Jira for one workflow's tickets: run its JQL (assignee = current user + its query
    labels), match each to a routing rule, and emit the actionable list.

.DESCRIPTION
    Driven by a single workflow file (workflows/<id>.json), NOT the flat config.json.
    Final JQL = "(<workflow.jql>) AND labels not in (lock,done,block,fail) AND statusCategory != Done".
    Idempotency is per-workflow and state-based (workflows/<id>.state.json), so runs missed while
    the laptop slept never lose tickets.

    Per ticket:
      - skip when the workflow state already records it (dispatched/done/failed/blocked - clear
        the entry to force a retry)
      - match the FIRST rule where ANY of its labels is on the ticket (OR) and whose issueTypes
        list is empty or contains the ticket type
      - repo comes from the WORKFLOW (workflow.repo); handler/instructions from the matched rule
      - cap actionable tickets at workflow.maxTicketsPerRun; the rest wait for the next run

    Output: human table + one machine-readable line:
      RESULT_JSON: [ { key, summary, issueType, labels, action, reason, handler, repo, instructions } ]

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File poller-search.ps1 -WorkflowFile "%USERPROFILE%\.jira-agent\workflows\my-workflow.json"
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkflowFile,
    [string]$OutFile = ''
)

. "$PSScriptRoot\poller-common.ps1"

$wf = Read-Workflow $WorkflowFile
if (-not $wf) { Write-Host ("cannot read workflow: {0}" -f $WorkflowFile) -ForegroundColor Red; Write-Output 'RESULT_JSON: []'; exit 1 }
Set-JiraBase $wf.jiraBaseUrl

# Build the final JQL: the workflow's own query + the poller's exclusions.
# NOTE: the block label is intentionally NOT excluded - a blocked ticket must keep being re-crawled
# so the handler can read new comments and continue once the block is resolved. done/fail/lock stay
# excluded (terminal or in-flight).
$excl = @($wf.lockLabel, $wf.doneLabel, $wf.failLabel) | Where-Object { $_ }
$exclClause = ''
if ($excl.Count) { $exclClause = ' AND labels not in (' + (($excl | ForEach-Object { '"' + $_ + '"' }) -join ', ') + ')' }
$baseJql = if ($wf.jql) { $wf.jql } else { 'assignee = currentUser() AND labels = "{0}"' -f $wf.agentLabel }
$jql = "($baseJql)$exclClause AND statusCategory != Done ORDER BY updated ASC"
Write-Host ("JQL: {0}" -f $jql) -ForegroundColor Cyan

$q = [uri]::EscapeDataString($jql)
$resp = Invoke-Jira 'GET' ("/rest/api/3/search/jql?jql={0}&maxResults=50&fields=summary,issuetype,labels,status" -f $q) $null
$issues = @()
if ($resp.issues) { $issues = @($resp.issues) }
Write-Host ("matched by JQL: {0}" -f $issues.Count)

function Test-RuleMatch($rule, $ticketLabels, $issueType) {
    $ruleLabels = @($rule.labels | Where-Object { $_ })
    if ($ruleLabels.Count -gt 0) {
        $anyMatch = $false
        foreach ($l in $ruleLabels) { if (@($ticketLabels) -contains $l) { $anyMatch = $true; break } }
        if (-not $anyMatch) { return $false }
    }
    $types = @($rule.issueTypes | Where-Object { $_ })
    if ($types.Count -gt 0 -and ($types -notcontains $issueType)) { return $false }
    return $true
}

$rows = @()
$actionable = 0
$cap = [int]$wf.maxTicketsPerRun
if ($cap -le 0) { $cap = 1 }

foreach ($is in $issues) {
    $key    = $is.key
    $labels = @($is.fields.labels)
    $itype  = [string]$is.fields.issuetype.name
    $row = [pscustomobject]@{
        key = $key; summary = [string]$is.fields.summary; issueType = $itype
        labels = $labels; action = 'skip'; reason = ''; handler = ''; repo = ''; instructions = ''; revisit = $false
    }

    $st = Get-WfTicketState $wf._id $key
    # A 'blocked' ticket is re-dispatched every run (re-visit: handler checks new comments and either
    # continues or stays silently blocked). done/failed/dispatched are terminal/in-flight -> skip.
    if ($st -and $st.status -ne 'blocked') {
        $row.reason = ("already {0} at {1} (clear {2} in {3}.state.json to retry)" -f $st.status, $st.ts, $key, $wf._id)
        $rows += $row
        continue
    }
    $isRevisit = [bool]($st -and $st.status -eq 'blocked')

    $matched = $null
    foreach ($r in @($wf.rules)) { if (Test-RuleMatch $r $labels $itype) { $matched = $r; break } }
    if (-not $matched) { $row.reason = 'no matching rule (labels/issueType)'; $rows += $row; continue }
    if ($actionable -ge $cap) { $row.reason = ("over maxTicketsPerRun={0}; waits for next run" -f $cap); $rows += $row; continue }

    $actionable++
    $row.action       = 'dispatch'
    $row.revisit      = $isRevisit
    $row.reason       = if ($isRevisit) { ("re-visit blocked; rule '{0}'" -f $matched.name) } else { ("rule '{0}'" -f $matched.name) }
    $row.handler      = [string]$matched.handler
    $row.repo         = [string]$wf.repo
    $row.instructions = [string]$matched.instructions
    $rows += $row
}

foreach ($r in $rows) {
    $color = if ($r.action -eq 'dispatch') { 'Green' } else { 'Yellow' }
    Write-Host ("  [{0}] {1}  {2}  - {3}" -f $r.action.ToUpper().PadRight(8), $r.key.PadRight(9), $r.issueType.PadRight(8), $r.reason) -ForegroundColor $color
}
Write-Host ("ACTIONABLE: {0}   SKIPPED: {1}" -f $actionable, ($rows.Count - $actionable))

$json = ''
if ($rows.Count -eq 0)     { $json = '[]' }
elseif ($rows.Count -eq 1) { $json = '[' + ($rows[0] | ConvertTo-Json -Compress -Depth 5) + ']' }
else                       { $json = ($rows | ConvertTo-Json -Compress -Depth 5) }
Write-Output ("RESULT_JSON: {0}" -f $json)

if ($OutFile) {
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $json | Set-Content -LiteralPath $OutFile -Encoding UTF8
    Write-Host ("written: {0}" -f $OutFile)
}
