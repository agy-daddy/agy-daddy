param(
  [string]$IconPath = "",
  [string]$Tooltip = "Agy-Daddy Launcher"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Text = if ($Tooltip.Length -gt 63) { $Tooltip.Substring(0, 63) } else { $Tooltip }
$notifyIcon.Visible = $true

if ($IconPath -and (Test-Path $IconPath)) {
  try {
    if ($IconPath.ToLower().EndsWith(".ico")) {
      $notifyIcon.Icon = New-Object System.Drawing.Icon($IconPath)
    } else {
      $bmp = New-Object System.Drawing.Bitmap($IconPath)
      $notifyIcon.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    }
  } catch {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
  }
} else {
  $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$notifyIcon.ContextMenuStrip = $contextMenu

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.Size = New-Object System.Drawing.Size(0, 0)

function Emit-Event($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Add-MenuItems($parentCollection, $specs) {
  foreach ($spec in $specs) {
    $t = if ($spec.type) { [string]$spec.type } else { "normal" }
    if ($t -eq "separator") {
      [void]$parentCollection.Add((New-Object System.Windows.Forms.ToolStripSeparator))
      continue
    }
    $label = if ($spec.label) { [string]$spec.label } else { [string]$spec.id }
    if ($spec.icon -and ($spec.icon.Length -le 4)) {
      $label = "$($spec.icon) $label"
    }
    $mi = New-Object System.Windows.Forms.ToolStripMenuItem($label)
    $mi.Tag = [string]$spec.id
    if ($null -ne $spec.enabled) { $mi.Enabled = [bool]$spec.enabled }
    if ($t -eq "checkbox") {
      $mi.Checked = [bool]$spec.checked
    }
    if ($spec.tooltip) {
      $mi.ToolTipText = [string]$spec.tooltip
    }
    if ($spec.icon -and (Test-Path $spec.icon)) {
      try {
        $mi.Image = [System.Drawing.Image]::FromFile($spec.icon)
      } catch {}
    }
    if ($t -eq "submenu" -and $spec.submenu) {
      Add-MenuItems $mi.DropDownItems $spec.submenu
    } else {
      $itemId = [string]$spec.id
      $mi.Add_Click({
        param($sender, $e)
        Emit-Event @{ type = "click"; itemId = [string]$sender.Tag }
      })
    }
    [void]$parentCollection.Add($mi)
  }
}

$stdinQueue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$eofReached = $false

$readerThread = [System.Threading.Thread]::new({
  try {
    while ($true) {
      $line = [Console]::In.ReadLine()
      if ($null -eq $line) {
        $script:eofReached = $true
        break
      }
      if ($line.Trim().Length -gt 0) {
        $stdinQueue.Enqueue($line)
      }
    }
  } catch {
    $script:eofReached = $true
  }
})
$readerThread.IsBackground = $true
$readerThread.Start()

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 50
$timer.Add_Tick({
  $line = $null
  while ($stdinQueue.TryDequeue([ref]$line)) {
    try {
      $cmd = $line | ConvertFrom-Json
      if ($cmd.type -eq "update-menu") {
        $contextMenu.Items.Clear()
        if ($cmd.items) {
          Add-MenuItems $contextMenu.Items $cmd.items
        }
        if ($cmd.tooltip) {
          $tip = [string]$cmd.tooltip
          $notifyIcon.Text = if ($tip.Length -gt 63) { $tip.Substring(0, 63) } else { $tip }
        }
      } elseif ($cmd.type -eq "quit") {
        $timer.Stop()
        $notifyIcon.Visible = $false
        $notifyIcon.Dispose()
        [System.Windows.Forms.Application]::Exit()
      }
    } catch {}
  }
  if ($script:eofReached) {
    $timer.Stop()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()

Emit-Event @{ type = "ready"; platform = "win32" }
[System.Windows.Forms.Application]::Run()
