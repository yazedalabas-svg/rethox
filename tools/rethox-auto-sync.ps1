[CmdletBinding()]
param(
  [ValidateRange(3, 120)]
  [int]$QuietSeconds = 8
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$runnerScript = Join-Path $PSScriptRoot 'publish-rethox-runner.ps1'
$publisherDirectory = Join-Path $PSScriptRoot '.publisher'
[System.IO.Directory]::CreateDirectory($publisherDirectory) | Out-Null

$createdNew = $false
$instanceMutex = New-Object System.Threading.Mutex($true, 'Local\RethoxAutoSync', [ref]$createdNew)
if (-not $createdNew) {
  [System.Windows.Forms.MessageBox]::Show(
    'أداة Rethox Auto Sync تعمل بالفعل.',
    'Rethox Auto Sync'
  ) | Out-Null
  $instanceMutex.Dispose()
  exit 0
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Rethox Auto Sync'
$form.Size = New-Object System.Drawing.Size(820, 650)
$form.MinimumSize = New-Object System.Drawing.Size(720, 560)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::FromArgb(20, 18, 29)
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.RightToLeft = 'Yes'
$form.RightToLeftLayout = $true

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Rethox — المزامنة التلقائية'
$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 20)
$title.ForeColor = [System.Drawing.Color]::FromArgb(183, 148, 255)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(28, 24)
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "يراقب المشروع، ينتظر $QuietSeconds ثوانٍ بعد آخر تعديل، ثم يختبر ويرفع وينشر ويتحقق من الدومين."
$subtitle.AutoSize = $true
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(205, 201, 216)
$subtitle.Location = New-Object System.Drawing.Point(30, 68)
$form.Controls.Add($subtitle)

$statusPanel = New-Object System.Windows.Forms.Panel
$statusPanel.Location = New-Object System.Drawing.Point(30, 105)
$statusPanel.Size = New-Object System.Drawing.Size(744, 92)
$statusPanel.Anchor = 'Top,Left,Right'
$statusPanel.BackColor = [System.Drawing.Color]::FromArgb(31, 28, 44)
$form.Controls.Add($statusPanel)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = '● المراقبة تعمل'
$statusLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 14)
$statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(117, 220, 170)
$statusLabel.AutoSize = $true
$statusLabel.Location = New-Object System.Drawing.Point(22, 17)
$statusPanel.Controls.Add($statusLabel)

$detailLabel = New-Object System.Windows.Forms.Label
$detailLabel.Text = 'بانتظار أي تعديل جديد داخل المشروع.'
$detailLabel.ForeColor = [System.Drawing.Color]::FromArgb(195, 190, 207)
$detailLabel.AutoSize = $true
$detailLabel.Location = New-Object System.Drawing.Point(24, 54)
$statusPanel.Controls.Add($detailLabel)

$publishButton = New-Object System.Windows.Forms.Button
$publishButton.Text = 'نشر الآن'
$publishButton.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
$publishButton.FlatStyle = 'Flat'
$publishButton.BackColor = [System.Drawing.Color]::FromArgb(112, 76, 224)
$publishButton.ForeColor = [System.Drawing.Color]::White
$publishButton.Location = New-Object System.Drawing.Point(30, 216)
$publishButton.Size = New-Object System.Drawing.Size(140, 42)
$form.Controls.Add($publishButton)

$monitorButton = New-Object System.Windows.Forms.Button
$monitorButton.Text = 'إيقاف المراقبة'
$monitorButton.FlatStyle = 'Flat'
$monitorButton.BackColor = [System.Drawing.Color]::FromArgb(53, 48, 70)
$monitorButton.ForeColor = [System.Drawing.Color]::White
$monitorButton.Location = New-Object System.Drawing.Point(182, 216)
$monitorButton.Size = New-Object System.Drawing.Size(145, 42)
$form.Controls.Add($monitorButton)

$siteButton = New-Object System.Windows.Forms.Button
$siteButton.Text = 'فتح الموقع'
$siteButton.FlatStyle = 'Flat'
$siteButton.BackColor = [System.Drawing.Color]::FromArgb(53, 48, 70)
$siteButton.ForeColor = [System.Drawing.Color]::White
$siteButton.Location = New-Object System.Drawing.Point(339, 216)
$siteButton.Size = New-Object System.Drawing.Size(130, 42)
$form.Controls.Add($siteButton)

$githubButton = New-Object System.Windows.Forms.Button
$githubButton.Text = 'فتح GitHub'
$githubButton.FlatStyle = 'Flat'
$githubButton.BackColor = [System.Drawing.Color]::FromArgb(53, 48, 70)
$githubButton.ForeColor = [System.Drawing.Color]::White
$githubButton.Location = New-Object System.Drawing.Point(481, 216)
$githubButton.Size = New-Object System.Drawing.Size(130, 42)
$form.Controls.Add($githubButton)

$renderButton = New-Object System.Windows.Forms.Button
$renderButton.Text = 'فتح Render'
$renderButton.FlatStyle = 'Flat'
$renderButton.BackColor = [System.Drawing.Color]::FromArgb(53, 48, 70)
$renderButton.ForeColor = [System.Drawing.Color]::White
$renderButton.Location = New-Object System.Drawing.Point(623, 216)
$renderButton.Size = New-Object System.Drawing.Size(130, 42)
$form.Controls.Add($renderButton)

$logLabel = New-Object System.Windows.Forms.Label
$logLabel.Text = 'سجل العمل'
$logLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
$logLabel.AutoSize = $true
$logLabel.Location = New-Object System.Drawing.Point(30, 280)
$form.Controls.Add($logLabel)

$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = 'Vertical'
$log.BackColor = [System.Drawing.Color]::FromArgb(12, 11, 18)
$log.ForeColor = [System.Drawing.Color]::FromArgb(230, 226, 240)
$log.BorderStyle = 'FixedSingle'
$log.Font = New-Object System.Drawing.Font('Cascadia Mono', 9)
$log.RightToLeft = 'No'
$log.Location = New-Object System.Drawing.Point(30, 310)
$log.Size = New-Object System.Drawing.Size(744, 250)
$log.Anchor = 'Top,Bottom,Left,Right'
$form.Controls.Add($log)

$footer = New-Object System.Windows.Forms.Label
$footer.Text = 'اترك النافذة مفتوحة أثناء عملك. لن يتم رفع ملفات الأسرار أو ملفات التشغيل المؤقتة.'
$footer.ForeColor = [System.Drawing.Color]::FromArgb(150, 145, 165)
$footer.AutoSize = $true
$footer.Location = New-Object System.Drawing.Point(30, 578)
$footer.Anchor = 'Bottom,Left'
$form.Controls.Add($footer)

$script:monitoring = $true
$script:publishing = $false
$script:pending = $false
$script:lastChangeAt = [datetime]::MinValue
$script:lastChangePath = ''
$script:publisherProcess = $null
$script:logFile = $null
$script:errorFile = $null
$script:resultFile = $null
$script:lastDisplayedLog = ''
$script:exitObservedAt = $null
$changeQueue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()

function Get-RelativeProjectPath([string]$FullPath) {
  if (-not $FullPath) { return '' }
  $fullRoot = $root.TrimEnd('\') + '\'
  if ($FullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $FullPath.Substring($fullRoot.Length).Replace('\', '/')
  }
  return $FullPath.Replace('\', '/')
}

function Test-IgnoredChange([string]$FullPath) {
  $relative = Get-RelativeProjectPath $FullPath
  if (-not $relative) { return $true }

  $ignoredPrefixes = @(
    '.git/',
    'node_modules/',
    'apps/api/dist/',
    'apps/web/dist/',
    'apps/api/data/tts-cache/',
    'tools/.publisher/',
    '.tmp-local/',
    '.vite/',
    'wild-paper-877c/'
  )
  foreach ($prefix in $ignoredPrefixes) {
    if ($relative.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }

  if ($relative -eq 'apps/web/public/deployment.json') { return $true }
  if ($relative -eq '.dev.pid' -or $relative -like '.prod-*') { return $true }
  if ($relative -match '(?i)(^|/)\.env($|\.)') { return $true }
  if ($relative -match '(?i)\.(log|tmp|tsbuildinfo)$') { return $true }
  if ($relative -eq 'apps/api/data/runtime-store.json') { return $true }
  return $false
}

function Queue-Publish([string]$PathDescription) {
  $script:pending = $true
  $script:lastChangeAt = [datetime]::UtcNow
  $script:lastChangePath = $PathDescription
  if (-not $script:publishing) {
    $statusLabel.Text = '● تم رصد تحديث'
    $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(255, 202, 87)
    $detailLabel.Text = "بانتظار هدوء الملفات: $PathDescription"
  }
}

function Get-CombinedLog {
  $normalLog = if ($script:logFile -and (Test-Path -LiteralPath $script:logFile)) {
    Get-Content -LiteralPath $script:logFile -Raw -ErrorAction SilentlyContinue
  } else { '' }
  $errorLog = if ($script:errorFile -and (Test-Path -LiteralPath $script:errorFile)) {
    Get-Content -LiteralPath $script:errorFile -Raw -ErrorAction SilentlyContinue
  } else { '' }
  return ($normalLog + $(if ($errorLog) { [Environment]::NewLine + $errorLog } else { '' })).TrimStart()
}

function Complete-Publish([int]$ExitCode, [string]$FailureMessage = '') {
  $script:publishing = $false
  $publishButton.Enabled = $true
  $script:exitObservedAt = $null

  if ($script:publisherProcess) {
    $script:publisherProcess.Dispose()
    $script:publisherProcess = $null
  }

  if ($ExitCode -eq 0) {
    $statusLabel.Text = '● تم النشر والتحقق بنجاح'
    $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(117, 220, 170)
    $detailLabel.Text = "آخر نجاح: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
  } else {
    $script:pending = $false
    $statusLabel.Text = '● لم يكتمل النشر'
    $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(255, 112, 112)
    $detailLabel.Text = if ($FailureMessage) { $FailureMessage } else { 'راجع السجل، ثم عدّل ملفًا أو اضغط نشر الآن لإعادة المحاولة.' }
  }
}

function Start-AutomaticPublish {
  if ($script:publishing) { return }

  $script:pending = $false
  $script:publishing = $true
  $script:lastDisplayedLog = ''
  $script:exitObservedAt = $null
  $publishButton.Enabled = $false
  $statusLabel.Text = '● جارٍ الاختبار والنشر'
  $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(183, 148, 255)
  $detailLabel.Text = 'يبني المشروع ويختبره ثم يرفع GitHub ويتحقق من Render.'
  $log.Clear()

  try {
    $message = "Auto sync $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
    $messageBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($message))
    $runId = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $runDirectory = Join-Path $publisherDirectory $runId
    [System.IO.Directory]::CreateDirectory($runDirectory) | Out-Null
    $script:logFile = Join-Path $runDirectory 'publish.log'
    $script:errorFile = Join-Path $runDirectory 'publish.error.log'
    $script:resultFile = Join-Path $runDirectory 'result.json'

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runnerScript`" -MessageBase64 $messageBase64 -LogFile `"$script:logFile`" -ErrorFile `"$script:errorFile`" -ResultFile `"$script:resultFile`""
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $script:publisherProcess = New-Object System.Diagnostics.Process
    $script:publisherProcess.StartInfo = $psi
    if (-not $script:publisherProcess.Start()) { throw 'تعذر بدء عملية النشر.' }
  } catch {
    Complete-Publish 1 $_.Exception.Message
    $log.Text = $_.Exception.Message
  }
}

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $root
$watcher.Filter = '*'
$watcher.IncludeSubdirectories = $true
$watcher.NotifyFilter = [System.IO.NotifyFilters]'FileName, DirectoryName, LastWrite, Size'

$eventPrefix = 'RethoxAutoSync.' + [guid]::NewGuid().ToString('N')
$eventJobs = @(
  Register-ObjectEvent -InputObject $watcher -EventName Changed -SourceIdentifier "$eventPrefix.Changed" -MessageData $changeQueue -Action {
    $event.MessageData.Enqueue([string]$event.SourceEventArgs.FullPath)
  }
  Register-ObjectEvent -InputObject $watcher -EventName Created -SourceIdentifier "$eventPrefix.Created" -MessageData $changeQueue -Action {
    $event.MessageData.Enqueue([string]$event.SourceEventArgs.FullPath)
  }
  Register-ObjectEvent -InputObject $watcher -EventName Deleted -SourceIdentifier "$eventPrefix.Deleted" -MessageData $changeQueue -Action {
    $event.MessageData.Enqueue([string]$event.SourceEventArgs.FullPath)
  }
  Register-ObjectEvent -InputObject $watcher -EventName Renamed -SourceIdentifier "$eventPrefix.Renamed" -MessageData $changeQueue -Action {
    $event.MessageData.Enqueue([string]$event.SourceEventArgs.FullPath)
  }
)

$uiTimer = New-Object System.Windows.Forms.Timer
$uiTimer.Interval = 500
$uiTimer.Add_Tick({
  try {
    $changedPath = $null
    while ($changeQueue.TryDequeue([ref]$changedPath)) {
      if ($script:monitoring -and -not (Test-IgnoredChange $changedPath)) {
        Queue-Publish (Get-RelativeProjectPath $changedPath)
      }
      $changedPath = $null
    }

    if ($script:publishing) {
      $combinedLog = Get-CombinedLog
      if ($combinedLog -ne $script:lastDisplayedLog) {
        $script:lastDisplayedLog = $combinedLog
        $log.Text = $combinedLog
        $log.SelectionStart = $log.TextLength
        $log.ScrollToCaret()
      }

      if ($script:resultFile -and (Test-Path -LiteralPath $script:resultFile)) {
        $result = Get-Content -LiteralPath $script:resultFile -Raw | ConvertFrom-Json
        Complete-Publish ([int]$result.exitCode)
      } elseif ($script:publisherProcess -and $script:publisherProcess.HasExited) {
        if (-not $script:exitObservedAt) { $script:exitObservedAt = [datetime]::UtcNow }
        if (([datetime]::UtcNow - $script:exitObservedAt).TotalSeconds -ge 2) {
          Complete-Publish 1 'توقفت عملية النشر قبل كتابة النتيجة؛ راجع السجل.'
        }
      }
    }

    if ($script:monitoring -and $script:pending -and -not $script:publishing) {
      $remaining = [math]::Ceiling($QuietSeconds - ([datetime]::UtcNow - $script:lastChangeAt).TotalSeconds)
      if ($remaining -le 0) {
        Start-AutomaticPublish
      } else {
        $detailLabel.Text = "سيبدأ النشر خلال $remaining ثوانٍ إذا لم يحدث تعديل جديد — $($script:lastChangePath)"
      }
    }
  } catch {
    $statusLabel.Text = '● خطأ في المراقبة'
    $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(255, 112, 112)
    $detailLabel.Text = $_.Exception.Message
  }
})

$publishButton.Add_Click({
  if (-not $script:publishing) {
    $script:pending = $true
    $script:lastChangeAt = [datetime]::UtcNow.AddSeconds(-$QuietSeconds)
    $script:lastChangePath = 'طلب نشر يدوي'
  }
})

$monitorButton.Add_Click({
  $script:monitoring = -not $script:monitoring
  $watcher.EnableRaisingEvents = $script:monitoring
  if ($script:monitoring) {
    $monitorButton.Text = 'إيقاف المراقبة'
    $statusLabel.Text = '● المراقبة تعمل'
    $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(117, 220, 170)
    $detailLabel.Text = 'بانتظار أي تعديل جديد داخل المشروع.'
  } else {
    $script:pending = $false
    $monitorButton.Text = 'تشغيل المراقبة'
    $statusLabel.Text = '● المراقبة متوقفة'
    $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(150, 145, 165)
    $detailLabel.Text = 'لن يبدأ نشر تلقائي حتى تعيد تشغيل المراقبة.'
  }
})

$siteButton.Add_Click({ Start-Process 'https://rethox.online/' })
$githubButton.Add_Click({ Start-Process 'https://github.com/yazedalabas-svg/rethox/actions' })
$renderButton.Add_Click({ Start-Process 'https://dashboard.render.com/web/srv-d92plcpkh4rs738si1q0/events' })

$form.Add_Shown({
  Set-Location $root
  $watcher.EnableRaisingEvents = $true
  $uiTimer.Start()

  $initialChanges = @(& git status --porcelain --untracked-files=normal)
  if ($LASTEXITCODE -eq 0 -and $initialChanges.Count -gt 0) {
    Queue-Publish 'تغييرات موجودة عند تشغيل الأداة'
  }
})

$form.Add_FormClosing({
  param($sender, $eventArgs)
  if ($script:publishing) {
    $eventArgs.Cancel = $true
    [System.Windows.Forms.MessageBox]::Show(
      'النشر ما زال يعمل. انتظر اكتماله قبل إغلاق الأداة.',
      'Rethox Auto Sync'
    ) | Out-Null
  }
})

try {
  [void]$form.ShowDialog()
} finally {
  $uiTimer.Stop()
  $watcher.EnableRaisingEvents = $false
  $watcher.Dispose()
  foreach ($job in $eventJobs) {
    Unregister-Event -SourceIdentifier $job.Name -ErrorAction SilentlyContinue
    Remove-Job -Id $job.Id -Force -ErrorAction SilentlyContinue
  }
  $instanceMutex.ReleaseMutex()
  $instanceMutex.Dispose()
}
