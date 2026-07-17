[CmdletBinding()]
param(
  [string]$Message = 'Update rethox',
  [string]$MessageBase64 = '',
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$repository = 'yazedalabas-svg/rethox'
$workflow = 'render-deploy.yml'
$siteUrl = 'https://rethox.onrender.com'
$buildMarker = Join-Path $root 'apps\web\public\deployment.json'
Set-Location $root

if ($MessageBase64) {
  $Message = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($MessageBase64))
}

function Run-Git([string[]]$Arguments) {
  & git @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Git command failed: git $($Arguments -join ' ')"
  }
}

function Get-RemoteSha([string]$Branch) {
  $remoteLine = & git ls-remote origin "refs/heads/$Branch"
  if ($LASTEXITCODE -ne 0 -or -not $remoteLine) {
    throw "Could not read the GitHub branch origin/$Branch."
  }
  return (($remoteLine | Select-Object -First 1) -split '\s+')[0].Trim()
}

function Get-LiveBuildId([string]$ExpectedBuildId) {
  try {
    $nonce = [guid]::NewGuid().ToString('N')
    $live = Invoke-RestMethod -Uri "$siteUrl/deployment.json?expected=$ExpectedBuildId&nonce=$nonce" -TimeoutSec 15
    return [string]$live.buildId
  } catch {
    return ''
  }
}

function Start-GitHubDeployment([string]$Branch, [string]$CommitSha, [bool]$ForceDispatch) {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI is required for the verified Render deployment step.'
  }

  & gh auth status --hostname github.com *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'GitHub CLI is not signed in. Run gh auth login once, then try again.'
  }

  if (-not $ForceDispatch) {
    Write-Host 'Waiting for the GitHub deployment workflow...' -ForegroundColor Cyan
    for ($attempt = 1; $attempt -le 5; $attempt++) {
      Start-Sleep -Seconds 3
      $runsJson = & gh run list --repo $repository --workflow $workflow --branch $Branch --limit 10 `
        --json headSha,status,conclusion,databaseId 2>$null
      if ($LASTEXITCODE -eq 0 -and $runsJson) {
        $runs = $runsJson | ConvertFrom-Json
        if ($runs | Where-Object { $_.headSha -eq $CommitSha }) {
          Write-Host 'GitHub accepted the Render deployment workflow.' -ForegroundColor Green
          return
        }
      }
    }
  }

  Write-Host 'Starting the Render workflow from GitHub...' -ForegroundColor Cyan
  & gh workflow run $workflow --repo $repository --ref $Branch
  if ($LASTEXITCODE -ne 0) {
    throw 'GitHub could not start the Render deployment workflow.'
  }
}

$exitCode = 1
try {
  $branch = (& git branch --show-current).Trim()
  if (-not $branch) { throw 'Open the rethox Git repository first.' }
  if ($branch -ne 'main') { throw "Publishing is allowed only from main; current branch: $branch" }

  $changed = @(& git status --porcelain)
  $createdCommit = $false

  if ($changed.Count -gt 0) {
    $blocked = $changed | Where-Object {
      $_ -match '(?i)(^|\s)(\.env($|\.)|.*\.(pem|key|p12)$|.*service[-_]?account.*\.json$)'
    }
    if ($blocked) {
      Write-Host 'Blocked sensitive-looking files:' -ForegroundColor Red
      $blocked | ForEach-Object { Write-Host $_ }
      throw 'Remove those files from Git before publishing.'
    }

    $buildId = [guid]::NewGuid().ToString('N')
    $marker = @{
      buildId = $buildId
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($buildMarker, $marker, [System.Text.UTF8Encoding]::new($false))

    Write-Host 'Checking the production build...' -ForegroundColor Cyan
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. Nothing was uploaded.' }

    Run-Git @('add', '-A')
    $staged = @(& git diff --cached --name-only)
    if ($staged.Count -eq 0) { throw 'There are no publishable changes after Git ignore rules.' }

    Run-Git @('commit', '-m', $Message)
    Run-Git @('push', 'origin', $branch)
    $createdCommit = $true
  } else {
    Write-Host 'No local changes. Verifying the current GitHub version...' -ForegroundColor Yellow
    if (-not (Test-Path $buildMarker)) { throw 'The deployment marker is missing.' }
    $buildId = [string]((Get-Content -LiteralPath $buildMarker -Raw | ConvertFrom-Json).buildId)
    if (-not $buildId) { throw 'The deployment marker is invalid.' }
  }

  $localSha = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $localSha) { throw 'Could not read the local commit.' }
  $remoteSha = Get-RemoteSha $branch
  if ($remoteSha -ne $localSha) {
    throw 'GitHub verification failed: origin/main does not match the local commit.'
  }
  Write-Host "GitHub verified: $($localSha.Substring(0, 7))" -ForegroundColor Green

  $liveBuildId = Get-LiveBuildId $buildId
  if ($liveBuildId -eq $buildId) {
    Write-Host "The exact version is already live: $siteUrl" -ForegroundColor Green
  } else {
    Start-GitHubDeployment -Branch $branch -CommitSha $localSha -ForceDispatch (-not $createdCommit)
    Write-Host 'Waiting for Render and verifying the exact public version...' -ForegroundColor Cyan
    $isLive = $false
    for ($attempt = 1; $attempt -le 72; $attempt++) {
      Start-Sleep -Seconds 10
      if ((Get-LiveBuildId $buildId) -eq $buildId) {
        $isLive = $true
        break
      }
      Write-Host "Waiting for Render ($attempt/72)..."
    }
    if (-not $isLive) {
      throw 'Render did not publish the expected version within 12 minutes. Check the GitHub Actions and Render logs.'
    }
    Write-Host "Live site verified: $siteUrl" -ForegroundColor Green
  }

  $exitCode = 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  $exitCode = 1
}

if (-not $NoPause) { Read-Host 'Press Enter to close' }
exit $exitCode
