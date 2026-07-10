<#
.SYNOPSIS
    Assemble the distributable Jira Agent (Option 1) bundle: compile + package the extension, gather
    the two Option-1 skills and the installer, and produce jira-agent-bundle-<version>.zip.

.DESCRIPTION
    Run from anywhere. Paths are derived from this script's location:
      <root>           = jira-agent-generic
      <ext>            = <root>\extension  (this script is in <ext>\packaging)
      <skills source>  = <root>\skills
    A leak-check gate fails the build if any forbidden string slips into the staged bundle. The
    forbidden patterns are loaded from an EXTERNAL maintainer file (default: leak-patterns.txt one
    level above the generic root) so no internal names live inside the generic source tree. Override
    with -LeakPatternsFile; if the file is absent the gate is skipped with a warning.
    Output: <ext>\jira-agent-bundle-<version>.zip  (also leaves the staged folder for inspection)
#>
param(
    [switch]$SkipVsce,
    [string]$LeakPatternsFile = ''
)

$ErrorActionPreference = 'Stop'
$pkgDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ext    = Split-Path -Parent $pkgDir
$root   = Split-Path -Parent $ext
$skillsSrc = Join-Path $root 'skills'

$pkg = Get-Content -LiteralPath (Join-Path $ext 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
Write-Host ("building bundle for jira-agent v{0}" -f $version) -ForegroundColor Cyan

# 1. compile + package the VSIX (unless told to reuse an existing one)
Push-Location $ext
try {
    if (-not $SkipVsce) {
        & npx tsc -p ./ ; if ($LASTEXITCODE -ne 0) { throw "tsc failed" }
        & npx vsce package --allow-missing-repository --skip-license ; if ($LASTEXITCODE -ne 0) { throw "vsce package failed" }
    }
} finally { Pop-Location }
$vsix = Join-Path $ext ("jira-agent-{0}.vsix" -f $version)
if (-not (Test-Path -LiteralPath $vsix)) { throw "vsix not found: $vsix" }

# 2. stage the bundle
$stage = Join-Path $ext ("dist\jira-agent-bundle-{0}" -f $version)
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'skills') | Out-Null

foreach ($s in @('jira-poller', 'implement-task')) {
    $src = Join-Path $skillsSrc $s
    if (-not (Test-Path -LiteralPath $src)) { throw "skill missing: $src" }
    Copy-Item -LiteralPath $src -Destination (Join-Path $stage 'skills') -Recurse -Force
    Write-Host ("  staged skill: {0}" -f $s) -ForegroundColor Green
}
Copy-Item -LiteralPath $vsix -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $pkgDir 'install.ps1') -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $pkgDir 'install.cmd') -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $pkgDir 'README.md')   -Destination $stage -Force
Write-Host ("  staged vsix + installer + README") -ForegroundColor Green

# 3. leak-check gate: no forbidden strings may reach the staged bundle. Patterns come from an
# external maintainer file so the generic source tree itself contains none of them.
$patFile = if ($LeakPatternsFile) { $LeakPatternsFile } else { Join-Path (Split-Path -Parent $root) 'leak-patterns.txt' }
if (-not (Test-Path -LiteralPath $patFile)) {
    Write-Host ("  WARNING: leak-patterns file not found ({0}) - leak check SKIPPED" -f $patFile) -ForegroundColor Yellow
} else {
    $forbidden = @(Get-Content -LiteralPath $patFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
    $hits = @()
    foreach ($f in (Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object { $_.Extension -match '\.(ts|js|json|jsonc|md|ps1|cmd)$' })) {
        $text = Get-Content -LiteralPath $f.FullName -Raw
        foreach ($p in $forbidden) { if ($text -match $p) { $hits += ("{0}: matches /{1}/" -f $f.FullName, $p) } }
    }
    if ($hits.Count) {
        Write-Host "LEAK CHECK FAILED - forbidden strings found in the bundle:" -ForegroundColor Red
        $hits | ForEach-Object { Write-Host ("  " + $_) -ForegroundColor Red }
        throw "leak check failed ($($hits.Count) hit(s)); fix before packaging."
    }
    Write-Host ("  leak check passed ({0} patterns)" -f $forbidden.Count) -ForegroundColor Green
}

# 4. zip it
$zip = Join-Path $ext ("jira-agent-bundle-{0}.zip" -f $version)
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Write-Host ("bundle: {0}" -f $zip) -ForegroundColor Cyan
