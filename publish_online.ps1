param(
    [Parameter(Mandatory = $true)]
    [string]$LocalRoot,
    [ValidateRange(1, 32)]
    [int]$Workers = 24,
    [switch]$BuildOnly
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Baseline = Join-Path $ProjectRoot "work\local-baseline.json"
$IntegrityReport = Join-Path $ProjectRoot "work\local-integrity-after.json"
$Site = Join-Path $ProjectRoot "work\site"
$PythonExecutable = "C:\Users\USER\AppData\Local\Programs\Python\Python314\python.exe"

if (-not (Test-Path -LiteralPath $PythonExecutable)) {
    throw "ไม่พบ Python runtime ที่กำหนด: $PythonExecutable"
}

function Invoke-PythonScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [string[]]$Arguments = @()
    )
    & $PythonExecutable -X utf8 $ScriptPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Python step ล้มเหลว (exit $LASTEXITCODE): $ScriptPath"
    }
}

Invoke-PythonScript -ScriptPath (Join-Path $ProjectRoot "tools\local_integrity.py") -Arguments @("capture", "--root", $LocalRoot, "--output", $Baseline)
Invoke-PythonScript -ScriptPath (Join-Path $ProjectRoot "tools\export_snapshot.py") -Arguments @("--local-root", $LocalRoot, "--output", $Site, "--workers", "$Workers")
Invoke-PythonScript -ScriptPath (Join-Path $ProjectRoot "tools\local_integrity.py") -Arguments @("compare", "--root", $LocalRoot, "--baseline", $Baseline, "--output", $IntegrityReport)
Invoke-PythonScript -ScriptPath (Join-Path $ProjectRoot "tools\validate_snapshot.py") -Arguments @("--site", $Site)

if (-not $BuildOnly) {
    Invoke-PythonScript -ScriptPath (Join-Path $ProjectRoot "tools\push_snapshot.py") -Arguments @("--site", $Site)
    $RunOutput = gh workflow run deploy-pages.yml --repo benzkanin41-alt/research-knowledge-dashboard --ref main 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($RunOutput -join "`n") }
    $RunText = $RunOutput -join "`n"
    if ($RunText -notmatch "/actions/runs/(?<RunId>\d+)") {
        throw "อ่าน GitHub Actions run id ไม่สำเร็จ: $RunText"
    }
    gh run watch $Matches.RunId --repo benzkanin41-alt/research-knowledge-dashboard --exit-status
    if ($LASTEXITCODE -ne 0) { throw "GitHub Pages workflow ล้มเหลว: $($Matches.RunId)" }
    $Manifest = Get-Content -LiteralPath (Join-Path $Site "data\manifest.json") -Raw | ConvertFrom-Json
    Invoke-PythonScript -ScriptPath (Join-Path $ProjectRoot "tools\check_live_site.py") -Arguments @("--expected-digest", $Manifest.content_digest, "--wait-seconds", "300")
}
