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
$siteUrl = if ($siteUrl) { $siteUrl.TrimEnd('/') } else { 'https://rethox.onrender.com' }

function Run-Git([string[]]$Arguments) {
  & git @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Git command failed: git $($Arguments -join ' ')" }
}

try {
  $branch = (& git branch --show-current).Trim()
  if (-not $branch) { throw "Open the rethox Git repository first." }
  if (-not $deployHook) { throw "Render Deploy Hook is required. Open the publisher and save it in Render settings first." }

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

  # A unique public build marker lets us prove the live site received this exact update.
  $buildId = [guid]::NewGuid().ToString('N')
  $buildMarker = Join-Path $root 'apps\web\public\deployment.json'
  $marker = @{ buildId = $buildId; createdAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($buildMarker, $marker, [System.Text.UTF8Encoding]::new($false))

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

  Write-Host "Requesting Render deploy..." -ForegroundColor Cyan
  $deployResponse = Invoke-WebRequest -Uri $deployHook -Method Post -UseBasicParsing
  if ($deployResponse.StatusCode -lt 200 -or $deployResponse.StatusCode -ge 300) {
    throw "Render rejected the deploy request (HTTP $($deployResponse.StatusCode))."
  }
  Write-Host "Render accepted the deployment. Verifying the live site..." -ForegroundColor Cyan
  $isLive = $false
  for ($try = 1; $try -le 48; $try++) {
    Start-Sleep -Seconds 10
    try {
      $live = Invoke-RestMethod -Uri "$siteUrl/deployment.json?build=$buildId" -TimeoutSec 15
      if ($live.buildId -eq $buildId) { $isLive = $true; break }
    } catch { }
    Write-Host "Waiting for Render ($try/48)..."
  }
  if (-not $isLive) { throw "Render accepted the request but the new version did not appear within 8 minutes." }
  Write-Host "Live site verified: $siteUrl" -ForegroundColor Green
  $exitCode = 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  $exitCode = 1
}

if (-not $NoPause) { Read-Host "Press Enter to close" }
exit $exitCode
