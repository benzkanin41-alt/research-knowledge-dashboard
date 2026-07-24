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
    gh workflow run deploy-pages.yml --repo benzkanin41-alt/research-knowledge-dashboard --ref main
}
