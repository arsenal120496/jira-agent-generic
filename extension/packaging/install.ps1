<#
.SYNOPSIS
    Install the Jira Agent bundle for the current user: the two skills (user scope) and the
    VS Code / Antigravity extension. The skills are self-contained (Jira Cloud REST + GitHub CLI),
    so there are no plugin dependencies to install.

.DESCRIPTION
    Environment bootstrap (git, gh, node, Jira/GitHub login, scheduled task) is NOT handled here -
    run your environment setup separately. This installer only lays down the agent's own pieces and
    is safe to re-run (idempotent, overwrites in place).

    Steps:
      1. copy skills/jira-poller and skills/implement-task -> %USERPROFILE%\.claude\skills
      2. install the bundled .vsix into every detected IDE (code, antigravity/antigravity-ide)

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -SkipExtension   # skills only
#>
param(
    [switch]$SkipExtension
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Have($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

Say "Jira Agent installer" 'Cyan'
Say ("bundle: {0}" -f $here)

# --- 1. skills (user scope) ---
$skillsSrc = Join-Path $here 'skills'
$skillsDst = Join-Path $env:USERPROFILE '.claude\skills'
if (-not (Test-Path -LiteralPath $skillsSrc)) { throw "skills folder missing in bundle: $skillsSrc" }
New-Item -ItemType Directory -Force -Path $skillsDst | Out-Null
foreach ($d in (Get-ChildItem -LiteralPath $skillsSrc -Directory)) {
    $target = Join-Path $skillsDst $d.Name
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Copy-Item -LiteralPath $d.FullName -Destination $target -Recurse -Force
    Say ("  skill installed: {0}" -f $d.Name) 'Green'
}

# --- 2. extension (VS Code + Antigravity) ---
if ($SkipExtension) {
    Say "skipping extension (-SkipExtension)" 'Yellow'
} else {
    $vsix = Get-ChildItem -LiteralPath $here -Filter 'jira-agent-*.vsix' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
    if (-not $vsix) {
        Say "no .vsix in bundle - skipping extension" 'Yellow'
    } else {
        $installed = $false
        foreach ($cli in @('code', 'antigravity-ide', 'antigravity')) {
            if (Have $cli) {
                try { & $cli --install-extension $vsix.FullName --force *> $null; Say ("  extension installed via {0}: {1}" -f $cli, $vsix.Name) 'Green'; $installed = $true }
                catch { Say ("  {0} install failed: {1}" -f $cli, $_.Exception.Message) 'Yellow' }
            }
        }
        if (-not $installed) {
            Say "no IDE CLI (code / antigravity) on PATH. Install the VSIX manually:" 'Yellow'
            Say ("  Extensions view -> ... -> Install from VSIX -> {0}" -f $vsix.FullName)
        }
    }
}

Say ""
Say "Done. Reload the IDE window (Command Palette -> Reload Window) to activate Jira Agent." 'Cyan'
Say "Then open the Jira Agent side panel and create a workflow."
