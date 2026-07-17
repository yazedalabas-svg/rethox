[CmdletBinding()]
param(
  [string]$Message = "Update rethox",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# This file is intentionally local-only.  It may contain a Render deploy-hook URL.
$localConfig = Join-Path $PSScriptRoot "deploy.local.ps1"
if (Test-Path $localConfig) { . $localConfig }

function Run-Git([string[]]$Arguments) {
  & git @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Git command failed: git $($Arguments -join ' ')" }
}

try {
  $branch = (& git branch --show-current).Trim()
  if (-not $branch) { throw "Open the rethox Git repository first." }

  $changed = & git status --porcelain
  if (-not $changed) {
    Write-Host "No changes to publish." -ForegroundColor Yellow
    if (-not $NoPause) { Read-Host "Press Enter to close" }
    exit 0
  }

  # Do not accidentally publish secrets even if a file was force-added before.
  $blocked = $changed | Where-Object {
    $_ -match '(?i)(^|\s)(\.env($|\.)|.*\.(pem|key|p12)$|.*service[-_]?account.*\.json$)'
  }
  if ($blocked) {
    Write-Host "Blocked sensitive-looking files:" -ForegroundColor Red
    $blocked | ForEach-Object { Write-Host $_ }
    throw "Remove those files from Git before publishing."
  }

  Write-Host "Checking build..." -ForegroundColor Cyan
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed. Nothing was uploaded." }

  Run-Git @("add", "-A")
  $staged = & git diff --cached --name-only
  if (-not $staged) { throw "There are no publishable changes after Git ignore rules." }

  Run-Git @("commit", "-m", $Message)
  Run-Git @("push", "origin", $branch)
  $commit = (& git rev-parse --short HEAD).Trim()
  Write-Host "GitHub updated: $commit" -ForegroundColor Green

  # A deploy hook is optional; Render auto-deploy is used when it is not configured.
  if ($deployHook) {
    Write-Host "Requesting Render deploy..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $deployHook -Method Post -UseBasicParsing | Out-Null
    Write-Host "Render deploy requested." -ForegroundColor Green
  } else {
    Write-Host "Render auto-deploy will publish this commit. To force it, add a deploy hook to tools/deploy.local.ps1." -ForegroundColor Yellow
  }
  $exitCode = 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  $exitCode = 1
}

if (-not $NoPause) { Read-Host "Press Enter to close" }
exit $exitCode
