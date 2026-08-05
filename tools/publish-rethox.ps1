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
$siteUrl = 'https://rethox.online'
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

function Get-WorktreeTreeHash {
  $temporaryIndex = Join-Path ([System.IO.Path]::GetTempPath()) `
    ("rethox-publish-{0}.index" -f [guid]::NewGuid().ToString('N'))
  $hadCustomIndex = Test-Path Env:\GIT_INDEX_FILE
  $previousIndex = $env:GIT_INDEX_FILE

  try {
    $env:GIT_INDEX_FILE = $temporaryIndex
    Run-Git @('read-tree', 'HEAD')
    Run-Git @('add', '-A')
    $treeHash = (& git write-tree).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $treeHash) {
      throw 'Could not snapshot the files selected for publishing.'
    }
    return $treeHash
  } finally {
    [System.IO.File]::Delete($temporaryIndex)
    [System.IO.File]::Delete("$temporaryIndex.lock")
    if ($hadCustomIndex) {
      $env:GIT_INDEX_FILE = $previousIndex
    } else {
      Remove-Item Env:\GIT_INDEX_FILE -ErrorAction SilentlyContinue
    }
  }
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
      # Porcelain lines look like "XY path", or "R  old -> new" for renames.
      $path = (($_ -replace '^.{2}\s+', '') -replace '^.* -> ', '').Trim('"')
      $name = Split-Path $path -Leaf
      # Templates are committed on purpose and hold placeholders, not secrets.
      if ($name -match '(?i)\.(example|sample|template)$') { return $false }
      ($name -match '(?i)^\.env($|\.)') -or
      ($path -match '(?i)\.(pem|key|p12)$') -or
      ($path -match '(?i)service[-_]?account.*\.json$')
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

    $validatedTree = Get-WorktreeTreeHash

    Write-Host 'Checking the production build...' -ForegroundColor Cyan
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. Nothing was uploaded.' }

    Write-Host 'Running the complete test suite...' -ForegroundColor Cyan
    & npm test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed. Nothing was uploaded.' }

    if ((Get-WorktreeTreeHash) -ne $validatedTree) {
      Write-Host 'Files changed while validation was running. Waiting for a stable snapshot before publishing.' -ForegroundColor Yellow
      exit 75
    }

    Run-Git @('add', '-A')
    $stagedTree = (& git write-tree).Trim()
    if ($LASTEXITCODE -ne 0 -or $stagedTree -ne $validatedTree) {
      Run-Git @('reset', 'HEAD', '--')
      Write-Host 'Files changed while staging. Waiting for a stable snapshot before publishing.' -ForegroundColor Yellow
      exit 75
    }
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
