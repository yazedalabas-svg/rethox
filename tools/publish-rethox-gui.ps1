Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$publishScript = Join-Path $PSScriptRoot 'publish-rethox.ps1'
$localConfig = Join-Path $PSScriptRoot 'deploy.local.ps1'
$deployHook = ''
if (Test-Path $localConfig) { . $localConfig }

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Rethox Publisher'
$form.Size = New-Object System.Drawing.Size(760, 600)
$form.MinimumSize = New-Object System.Drawing.Size(650, 510)
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
$hint.Text = 'يفحص المشروع، يبنيه، يرفعه إلى GitHub، ثم يطلب النشر من Render عند إعداد Deploy Hook.'
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
$hookLabel = New-Object System.Windows.Forms.Label
$hookLabel.Text = 'Render Deploy Hook (required)'
$hookLabel.AutoSize = $true
$hookLabel.Location = New-Object System.Drawing.Point(30, 174)
$form.Controls.Add($hookLabel)

$hookBox = New-Object System.Windows.Forms.TextBox
$hookBox.Text = $deployHook
$hookBox.Location = New-Object System.Drawing.Point(30, 198)
$hookBox.Size = New-Object System.Drawing.Size(540, 30)
$hookBox.Anchor = 'Top,Left,Right'
$form.Controls.Add($hookBox)

$saveHookButton = New-Object System.Windows.Forms.Button
$saveHookButton.Text = 'حفظ الرابط'
$saveHookButton.Location = New-Object System.Drawing.Point(580, 197)
$saveHookButton.Size = New-Object System.Drawing.Size(130, 32)
$form.Controls.Add($saveHookButton)

$publishButton.Location = New-Object System.Drawing.Point(30, 250)
$publishButton.Size = New-Object System.Drawing.Size(210, 42)
$form.Controls.Add($publishButton)

$siteButton = New-Object System.Windows.Forms.Button
$siteButton.Text = 'فتح الموقع'
$siteButton.Location = New-Object System.Drawing.Point(252, 250)
$siteButton.Size = New-Object System.Drawing.Size(130, 42)
$form.Controls.Add($siteButton)

$githubButton = New-Object System.Windows.Forms.Button
$githubButton.Text = 'فتح GitHub'
$githubButton.Location = New-Object System.Drawing.Point(394, 250)
$githubButton.Size = New-Object System.Drawing.Size(130, 42)
$form.Controls.Add($githubButton)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'جاهز للنشر'
$status.AutoSize = $true
$status.ForeColor = [System.Drawing.Color]::FromArgb(117, 220, 170)
$status.Location = New-Object System.Drawing.Point(30, 311)
$form.Controls.Add($status)

$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = 'Vertical'
$log.BackColor = [System.Drawing.Color]::FromArgb(14, 13, 20)
$log.ForeColor = [System.Drawing.Color]::FromArgb(230, 226, 240)
$log.BorderStyle = 'FixedSingle'
$log.Font = New-Object System.Drawing.Font('Cascadia Mono', 9)
$log.Location = New-Object System.Drawing.Point(30, 339)
$log.Size = New-Object System.Drawing.Size(680, 160)
$log.Anchor = 'Top,Bottom,Left,Right'
$form.Controls.Add($log)

$activeProcess = $null
$publishTimer = New-Object System.Windows.Forms.Timer
$publishTimer.Interval = 500
$publishTimer.Add_Tick({
  if (-not $activeProcess -or -not $activeProcess.HasExited) { return }
  $publishTimer.Stop()
  $publishButton.Enabled = $true
  if ($activeProcess.ExitCode -eq 0) {
    $status.Text = 'تم التحقق من GitHub وRender والموقع العام.'
    $status.ForeColor = [System.Drawing.Color]::FromArgb(117, 220, 170)
  } else {
    $status.Text = 'لم يكتمل النشر؛ راجع السجل أعلاه.'
    $status.ForeColor = [System.Drawing.Color]::FromArgb(255, 112, 112)
  }
  $activeProcess = $null
})

$form.Add_FormClosing({
  param($sender, $event)
  if ($activeProcess -and -not $activeProcess.HasExited) {
    $event.Cancel = $true
    [System.Windows.Forms.MessageBox]::Show('النشر ما زال يعمل. انتظر حتى تظهر النتيجة داخل النافذة.', 'Rethox Publisher')
  }
})

$siteButton.Add_Click({ Start-Process 'https://rethox.onrender.com/' })
$githubButton.Add_Click({ Start-Process 'https://github.com/yazedalabas-svg/rethox' })
$saveHookButton.Add_Click({
  $hook = $hookBox.Text.Trim()
  if (-not $hook -or -not $hook.StartsWith('https://')) {
    [System.Windows.Forms.MessageBox]::Show('ألصق رابط Deploy Hook من Render، ويجب أن يبدأ بـ https://', 'Rethox Publisher')
    return
  }
  $safeHook = $hook.Replace("'", "''")
  [System.IO.File]::WriteAllText($localConfig, "`$deployHook = '$safeHook'`r`n`$siteUrl = 'https://rethox.onrender.com'`r`n", [System.Text.UTF8Encoding]::new($true))
  $status.Text = 'تم حفظ رابط Render محليًا.'
  $status.ForeColor = [System.Drawing.Color]::FromArgb(117, 220, 170)
})

$publishButton.Add_Click({
  if (-not $hookBox.Text.Trim() -or -not $hookBox.Text.Trim().StartsWith('https://')) {
    [System.Windows.Forms.MessageBox]::Show('أضف رابط Deploy Hook واحفظه أولًا. الأداة لن تدّعي نجاح النشر بدونه.', 'Rethox Publisher')
    return
  }
  $saveHookButton.PerformClick()
  $publishButton.Enabled = $false
  $status.Text = 'جارٍ الفحص والبناء والنشر… لا تغلق النافذة.'
  $status.ForeColor = [System.Drawing.Color]::FromArgb(255, 202, 87)
  $log.Clear()

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell.exe'
  $safeMessage = $messageBox.Text.Replace('"', '\"')
  $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$publishScript`" -Message `"$safeMessage`" -NoPause"
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  $process.add_OutputDataReceived({ param($sender, $event) if ($event.Data) { $form.BeginInvoke([Action]{ $log.AppendText($event.Data + [Environment]::NewLine) }) } })
  $process.add_ErrorDataReceived({ param($sender, $event) if ($event.Data) { $form.BeginInvoke([Action]{ $log.AppendText('ERROR: ' + $event.Data + [Environment]::NewLine) }) } })
  $activeProcess = $process
  [void]$process.Start()
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()
  $publishTimer.Start()
})

[void]$form.ShowDialog()
