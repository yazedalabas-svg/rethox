[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$MessageBase64,
  [Parameter(Mandatory = $true)]
  [string]$LogFile,
  [Parameter(Mandatory = $true)]
  [string]$ErrorFile,
  [Parameter(Mandatory = $true)]
  [string]$ResultFile
)

$ErrorActionPreference = 'Stop'
$publishScript = Join-Path $PSScriptRoot 'publish-rethox.ps1'
$resultDirectory = Split-Path -Parent $ResultFile
[System.IO.Directory]::CreateDirectory($resultDirectory) | Out-Null

Remove-Item -LiteralPath $LogFile, $ErrorFile, $ResultFile -Force -ErrorAction SilentlyContinue

$exitCode = 1
try {
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $publishScript,
    '-MessageBase64', $MessageBase64,
    '-NoPause'
  )
  $child = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments `
    -WorkingDirectory (Split-Path -Parent $PSScriptRoot) `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrorFile `
    -WindowStyle Hidden -Wait -PassThru
  $exitCode = $child.ExitCode
} catch {
  $_.Exception.Message | Out-File -LiteralPath $ErrorFile -Append -Encoding utf8
} finally {
  $result = @{
    exitCode = $exitCode
    finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json -Compress
  $temporaryResult = "$ResultFile.tmp"
  [System.IO.File]::WriteAllText($temporaryResult, $result, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryResult -Destination $ResultFile -Force
}

exit $exitCode
