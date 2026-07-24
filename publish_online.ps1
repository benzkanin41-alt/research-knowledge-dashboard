param(
    [Parameter(Mandatory = $true)]
    [string]$LocalRoot,
    [switch]$BuildOnly
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Baseline = Join-Path $ProjectRoot "work\local-baseline.json"
$IntegrityReport = Join-Path $ProjectRoot "work\local-integrity-after.json"
$Site = Join-Path $ProjectRoot "work\site"

python -X utf8 (Join-Path $ProjectRoot "tools\local_integrity.py") capture --root $LocalRoot --output $Baseline
python -X utf8 (Join-Path $ProjectRoot "tools\export_snapshot.py") --local-root $LocalRoot --output $Site
python -X utf8 (Join-Path $ProjectRoot "tools\local_integrity.py") compare --root $LocalRoot --baseline $Baseline --output $IntegrityReport
python -X utf8 (Join-Path $ProjectRoot "tools\validate_snapshot.py") --site $Site

if (-not $BuildOnly) {
    python -X utf8 (Join-Path $ProjectRoot "tools\push_snapshot.py") --site $Site
    $RunOutput = gh workflow run deploy-pages.yml --repo benzkanin41-alt/research-knowledge-dashboard --ref main 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($RunOutput -join "`n") }
    $RunText = $RunOutput -join "`n"
    if ($RunText -notmatch "/actions/runs/(?<RunId>\d+)") {
        throw "อ่าน GitHub Actions run id ไม่สำเร็จ: $RunText"
    }
    gh run watch $Matches.RunId --repo benzkanin41-alt/research-knowledge-dashboard --exit-status
    if ($LASTEXITCODE -ne 0) { throw "GitHub Pages workflow ล้มเหลว: $($Matches.RunId)" }
    $Manifest = Get-Content -LiteralPath (Join-Path $Site "data\manifest.json") -Raw | ConvertFrom-Json
    python -X utf8 (Join-Path $ProjectRoot "tools\check_live_site.py") --expected-digest $Manifest.content_digest --wait-seconds 300
}
