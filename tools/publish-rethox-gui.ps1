Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$runnerScript = Join-Path $PSScriptRoot 'publish-rethox-runner.ps1'
$publisherDirectory = Join-Path $PSScriptRoot '.publisher'
[System.IO.Directory]::CreateDirectory($publisherDirectory) | Out-Null

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Rethox Publisher'
$form.Size = New-Object System.Drawing.Size(760, 570)
$form.MinimumSize = New-Object System.Drawing.Size(650, 500)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::FromArgb(23, 21, 33)
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Rethox — نشر التحديثات'
$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 18)
$title.ForeColor = [System.Drawing.Color]::FromArgb(176, 138, 255)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(28, 24)
$form.Controls.Add($title)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = 'يفحص المشروع، يطابق GitHub، ويظل مفتوحًا حتى يتأكد أن النسخة نفسها أصبحت Live على Render.'
$hint.AutoSize = $true
$hint.ForeColor = [System.Drawing.Color]::FromArgb(205, 201, 216)
$hint.Location = New-Object System.Drawing.Point(30, 62)
$form.Controls.Add($hint)

$messageLabel = New-Object System.Windows.Forms.Label
$messageLabel.Text = 'رسالة التحديث'
$messageLabel.AutoSize = $true
$messageLabel.Location = New-Object System.Drawing.Point(30, 100)
$form.Controls.Add($messageLabel)

$messageBox = New-Object System.Windows.Forms.TextBox
$messageBox.Text = 'Update rethox'
$messageBox.Location = New-Object System.Drawing.Point(30, 124)
$messageBox.Size = New-Object System.Drawing.Size(680, 30)
$messageBox.Anchor = 'Top,Left,Right'
$form.Controls.Add($messageBox)

$publishButton = New-Object System.Windows.Forms.Button
$publishButton.Text = 'نشر التحديثات الآن'
$publishButton.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
$publishButton.FlatStyle = 'Flat'
$publishButton.BackColor = [System.Drawing.Color]::FromArgb(112, 76, 224)
$publishButton.ForeColor = [System.Drawing.Color]::White
$publishButton.Location = New-Object System.Drawing.Point(30, 178)
$publishButton.Size = New-Object System.Drawing.Size(210, 42)
$form.Controls.Add($publishButton)

$siteButton = New-Object System.Windows.Forms.Button
$siteButton.Text = 'فتح الموقع'
$siteButton.Location = New-Object System.Drawing.Point(252, 178)
$siteButton.Size = New-Object System.Drawing.Size(130, 42)
$form.Controls.Add($siteButton)

$githubButton = New-Object System.Windows.Forms.Button
$githubButton.Text = 'فتح GitHub'
$githubButton.Location = New-Object System.Drawing.Point(394, 178)
$githubButton.Size = New-Object System.Drawing.Size(130, 42)
$form.Controls.Add($githubButton)

$renderButton = New-Object System.Windows.Forms.Button
$renderButton.Text = 'فتح Render'
$renderButton.Location = New-Object System.Drawing.Point(536, 178)
$renderButton.Size = New-Object System.Drawing.Size(130, 42)
$form.Controls.Add($renderButton)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'جاهز للنشر'
$status.AutoSize = $true
$status.ForeColor = [System.Drawing.Color]::FromArgb(117, 220, 170)
$status.Location = New-Object System.Drawing.Point(30, 239)
$form.Controls.Add($status)

$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = 'Vertical'
$log.BackColor = [System.Drawing.Color]::FromArgb(14, 13, 20)
$log.ForeColor = [System.Drawing.Color]::FromArgb(230, 226, 240)
$log.BorderStyle = 'FixedSingle'
$log.Font = New-Object System.Drawing.Font('Cascadia Mono', 9)
$log.Location = New-Object System.Drawing.Point(30, 267)
$log.Size = New-Object System.Drawing.Size(680, 220)
$log.Anchor = 'Top,Bottom,Left,Right'
$form.Controls.Add($log)

$script:publisherProcess = $null
$script:logFile = $null
$script:errorFile = $null
$script:resultFile = $null
$script:lastDisplayedLog = ''

$publishTimer = New-Object System.Windows.Forms.Timer
$publishTimer.Interval = 500
$publishTimer.Add_Tick({
  try {
    $normalLog = if ($script:logFile -and (Test-Path $script:logFile)) {
      Get-Content -LiteralPath $script:logFile -Raw -ErrorAction SilentlyContinue
    } else { '' }
    $errorLog = if ($script:errorFile -and (Test-Path $script:errorFile)) {
      Get-Content -LiteralPath $script:errorFile -Raw -ErrorAction SilentlyContinue
    } else { '' }
    $combinedLog = ($normalLog + $(if ($errorLog) { [Environment]::NewLine + $errorLog } else { '' })).TrimStart()
    if ($combinedLog -ne $script:lastDisplayedLog) {
      $script:lastDisplayedLog = $combinedLog
      $log.Text = $combinedLog
      $log.SelectionStart = $log.TextLength
      $log.ScrollToCaret()
    }

    if ($script:resultFile -and (Test-Path $script:resultFile)) {
      $result = Get-Content -LiteralPath $script:resultFile -Raw | ConvertFrom-Json
      $publishTimer.Stop()
      $publishButton.Enabled = $true
      if ([int]$result.exitCode -eq 0) {
        $status.Text = 'تم التحقق من GitHub وRender والموقع العام.'
        $status.ForeColor = [System.Drawing.Color]::FromArgb(117, 220, 170)
      } else {
        $status.Text = 'لم يكتمل النشر؛ راجع السجل.'
        $status.ForeColor = [System.Drawing.Color]::FromArgb(255, 112, 112)
      }
      if ($script:publisherProcess) { $script:publisherProcess.Dispose() }
      $script:publisherProcess = $null
      return
    }

    if ($script:publisherProcess -and $script:publisherProcess.HasExited) {
      $publishTimer.Stop()
      $publishButton.Enabled = $true
      $status.Text = 'توقفت أداة النشر قبل أن تكتب النتيجة؛ راجع السجل.'
      $status.ForeColor = [System.Drawing.Color]::FromArgb(255, 112, 112)
      $script:publisherProcess.Dispose()
      $script:publisherProcess = $null
    }
  } catch {
    # A transient locked log file must never close the desktop application.
    $status.Text = 'النشر مستمر؛ جارٍ تحديث السجل…'
    $status.ForeColor = [System.Drawing.Color]::FromArgb(255, 202, 87)
  }
})

$form.Add_FormClosing({
  param($sender, $event)
  try {
    if ($script:publisherProcess -and -not $script:publisherProcess.HasExited) {
      $event.Cancel = $true
      [System.Windows.Forms.MessageBox]::Show(
        'النشر ما زال يعمل. انتظر حتى تظهر النتيجة داخل النافذة.',
        'Rethox Publisher'
      ) | Out-Null
    }
  } catch {
    $event.Cancel = $true
  }
})

$siteButton.Add_Click({ Start-Process 'https://rethox.onrender.com/' })
$githubButton.Add_Click({ Start-Process 'https://github.com/yazedalabas-svg/rethox/actions' })
$renderButton.Add_Click({ Start-Process 'https://dashboard.render.com/web/srv-d92plcpkh4rs738si1q0/events' })

$publishButton.Add_Click({
  try {
    $safeMessage = $messageBox.Text.Trim().Replace('"', "'").Replace("`r", ' ').Replace("`n", ' ')
    if (-not $safeMessage) { $safeMessage = 'Update rethox' }
    $messageBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($safeMessage))

    $runId = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $runDirectory = Join-Path $publisherDirectory $runId
    [System.IO.Directory]::CreateDirectory($runDirectory) | Out-Null
    $script:logFile = Join-Path $runDirectory 'publish.log'
    $script:errorFile = Join-Path $runDirectory 'publish.error.log'
    $script:resultFile = Join-Path $runDirectory 'result.json'
    $script:lastDisplayedLog = ''

    $publishButton.Enabled = $false
    $status.Text = 'جارٍ الفحص والبناء والنشر… لا تغلق النافذة.'
    $status.ForeColor = [System.Drawing.Color]::FromArgb(255, 202, 87)
    $log.Clear()

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runnerScript`" -MessageBase64 $messageBase64 -LogFile `"$script:logFile`" -ErrorFile `"$script:errorFile`" -ResultFile `"$script:resultFile`""
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $script:publisherProcess = New-Object System.Diagnostics.Process
    $script:publisherProcess.StartInfo = $psi
    if (-not $script:publisherProcess.Start()) { throw 'تعذر تشغيل عملية النشر.' }
    $publishTimer.Start()
  } catch {
    $publishButton.Enabled = $true
    $status.Text = 'تعذر بدء النشر.'
    $status.ForeColor = [System.Drawing.Color]::FromArgb(255, 112, 112)
    $log.Text = $_.Exception.Message
  }
})

try {
  [void]$form.ShowDialog()
} catch {
  [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Rethox Publisher') | Out-Null
}

