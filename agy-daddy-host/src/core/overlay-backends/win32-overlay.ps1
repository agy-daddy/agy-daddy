param(
  [int]$ParentPid = 0
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class AgyOverlayWin32 {
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const int WM_NCHITTEST = 0x0084;
  public const int HTTRANSPARENT = -1;

  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
"@

function Emit-Event($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

$workArea = [System.Windows.SystemParameters]::WorkArea
$windows = @{}
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

function New-OverlayWindow($windowId, $bounds, $visible) {
  $win = New-Object System.Windows.Window
  $win.WindowStyle = [System.Windows.WindowStyle]::None
  $win.AllowsTransparency = $true
  $win.Background = [System.Windows.Media.Brushes]::Transparent
  $win.Topmost = $true
  $win.ShowInTaskbar = $false
  $win.ShowActivated = $false
  $win.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $win.Width = if ($bounds.width) { [double]$bounds.width } else { 220 }
  $win.Height = if ($bounds.height) { [double]$bounds.height } else { 200 }
  $win.Left = if ($null -ne $bounds.x) { [double]$bounds.x } else { $workArea.Right - $win.Width - 24 }
  $win.Top = if ($null -ne $bounds.y) { [double]$bounds.y } else { $workArea.Bottom - $win.Height - 24 }

  $canvas = New-Object System.Windows.Controls.Canvas
  $canvas.Background = [System.Windows.Media.Brushes]::Transparent
  $win.Content = $canvas

  $stateObj = @{
    window = $win
    canvas = $canvas
    scene = $null
    state = $null
    hitRect = [System.Windows.Rect]::new(40, 40, 140, 120)
    bubbleRect = [System.Windows.Rect]::Empty
    roamDir = 1.0
    isHovered = $false
  }

  $win.Add_SourceInitialized({
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($win)
    $hwnd = $helper.Handle
    $ex = [AgyOverlayWin32]::GetWindowLong($hwnd, [AgyOverlayWin32]::GWL_EXSTYLE)
    [void][AgyOverlayWin32]::SetWindowLong($hwnd, [AgyOverlayWin32]::GWL_EXSTYLE, ($ex -bor [AgyOverlayWin32]::WS_EX_TOOLWINDOW -bor [AgyOverlayWin32]::WS_EX_NOACTIVATE))
    $source = [System.Windows.Interop.HwndSource]::FromHwnd($hwnd)
    $source.AddHook({
      param($hwnd, $msg, $wParam, $lParam, [ref]$handled)
      if ($msg -eq [AgyOverlayWin32]::WM_NCHITTEST) {
        $ptScreen = [System.Windows.Forms.Control]::MousePosition
        $ptClient = $win.PointFromScreen([System.Windows.Point]::new($ptScreen.X, $ptScreen.Y))
        $inPet = $stateObj.hitRect.Contains($ptClient)
        $inBubble = (-not $stateObj.bubbleRect.IsEmpty) -and $stateObj.bubbleRect.Contains($ptClient)
        if (-not $inPet -and -not $inBubble) {
          $handled = $true
          return [IntPtr][AgyOverlayWin32]::HTTRANSPARENT
        }
      }
      return [IntPtr]::Zero
    })
  })

  $win.Add_MouseLeftButtonDown({
    param($s, $e)
    $pt = $e.GetPosition($canvas)
    if ((-not $stateObj.bubbleRect.IsEmpty) -and $stateObj.bubbleRect.Contains($pt) -and $stateObj.state.bubble) {
      Emit-Event @{ type = "interaction"; windowId = $windowId; eventType = "bubble-click"; bubbleId = [string]$stateObj.state.bubble.id }
      return
    }
    try {
      $win.DragMove()
      Emit-Event @{
        type = "interaction"
        windowId = $windowId
        eventType = "position-changed"
        bounds = @{ x = [int]$win.Left; y = [int]$win.Top; width = [int]$win.Width; height = [int]$win.Height }
      }
    } catch {}
  })

  if ($visible) { $win.Show() }
  return $stateObj
}

function Render-OverlayEntry($entry) {
  $canvas = $entry.canvas
  $canvas.Children.Clear()
  $scene = $entry.scene
  if ($null -eq $scene) { return }

  $vbW = [Math]::Max(1.0, [double]$scene.viewBox.width)
  $vbH = [Math]::Max(1.0, [double]$scene.viewBox.height)
  $bubbleH = if ($entry.state -and $entry.state.bubble) { 52.0 } else { 0.0 }
  $availW = [double]$entry.window.Width
  $availH = [Math]::Max(48.0, [double]$entry.window.Height - $bubbleH)
  $scale = [Math]::Min($availW / $vbW, $availH / $vbH)
  $ox = ($availW - ($vbW * $scale)) / 2.0
  $oy = $bubbleH + ($availH - ($vbH * $scale)) / 2.0
  $entry.hitRect = [System.Windows.Rect]::new(
    $ox + ([double]$scene.hitBox.x * $scale),
    $oy + ([double]$scene.hitBox.y * $scale),
    [double]$scene.hitBox.width * $scale,
    [double]$scene.hitBox.height * $scale
  )

  $group = New-Object System.Windows.Controls.Canvas
  $tg = New-Object System.Windows.Media.TransformGroup
  $tg.Children.Add((New-Object System.Windows.Media.ScaleTransform($scale, $scale)))
  $tg.Children.Add((New-Object System.Windows.Media.TranslateTransform($ox, $oy)))
  $group.RenderTransform = $tg

  foreach ($layer in $scene.layers) {
    if ($layer.kind -eq "path" -and $layer.d) {
      $p = New-Object System.Windows.Shapes.Path
      $p.Data = [System.Windows.Media.StreamGeometry]::Parse([string]$layer.d)
      if ($layer.fill -and $layer.fill -ne "none") {
        $p.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString([string]$layer.fill)
      }
      if ($layer.stroke -and $layer.stroke -ne "none") {
        $p.Stroke = [System.Windows.Media.BrushConverter]::new().ConvertFromString([string]$layer.stroke)
        $p.StrokeThickness = if ($layer.strokeWidth) { [double]$layer.strokeWidth } else { 1.5 }
      }
      [void]$group.Children.Add($p)
    } elseif ($layer.kind -eq "circle") {
      $el = New-Object System.Windows.Shapes.Ellipse
      $r = [double]$layer.r
      $el.Width = $r * 2
      $el.Height = $r * 2
      [System.Windows.Controls.Canvas]::SetLeft($el, [double]$layer.cx - $r)
      [System.Windows.Controls.Canvas]::SetTop($el, [double]$layer.cy - $r)
      if ($layer.fill -and $layer.fill -ne "none") {
        $el.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString([string]$layer.fill)
      }
      [void]$group.Children.Add($el)
    }
  }
  [void]$canvas.Children.Add($group)

  if ($entry.state -and $entry.state.bubble) {
    $bBorder = New-Object System.Windows.Controls.Border
    $bBorder.Width = [Math]::Max(80.0, $availW - 16.0)
    $bBorder.Height = 44.0
    $bBorder.CornerRadius = [System.Windows.CornerRadius]::new(10)
    $bBorder.Background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(235, 20, 22, 32))
    $bBorder.Padding = [System.Windows.Thickness]::new(8, 5, 8, 5)
    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = [string]$entry.state.bubble.title
    $tb.Foreground = [System.Windows.Media.Brushes]::White
    $tb.FontSize = 11
    $bBorder.Child = $tb
    [System.Windows.Controls.Canvas]::SetLeft($bBorder, 8)
    [System.Windows.Controls.Canvas]::SetTop($bBorder, 4)
    [void]$canvas.Children.Add($bBorder)
    $entry.bubbleRect = [System.Windows.Rect]::new(8, 4, $bBorder.Width, 44.0)
  } else {
    $entry.bubbleRect = [System.Windows.Rect]::Empty
  }
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(33)
$tickCount = 0
$timer.Add_Tick({
  $tickCount++
  if ($ParentPid -gt 0 -and ($tickCount % 60 -eq 0)) {
    try { [void][System.Diagnostics.Process]::GetProcessById($ParentPid) } catch {
      $timer.Stop()
      [System.Windows.Application]::Current.Shutdown()
      return
    }
  }
  $line = $null
  while ($stdinQueue.TryDequeue([ref]$line)) {
    try {
      $cmd = $line | ConvertFrom-Json
      if ($cmd.type -eq "quit") {
        $timer.Stop()
        [System.Windows.Application]::Current.Shutdown()
        return
      }
      $wid = [string]$cmd.windowId
      if (-not $wid) { continue }
      if ($cmd.type -eq "remove-window") {
        if ($windows.ContainsKey($wid)) {
          $windows[$wid].window.Close()
          $windows.Remove($wid)
        }
      } elseif ($cmd.type -eq "upsert-window") {
        if (-not $windows.ContainsKey($wid)) {
          $windows[$wid] = New-OverlayWindow $wid $cmd.bounds ($cmd.visible -ne $false)
        } else {
          $e = $windows[$wid]
          if ($cmd.bounds.width) { $e.window.Width = [double]$cmd.bounds.width }
          if ($cmd.bounds.height) { $e.window.Height = [double]$cmd.bounds.height }
          if ($null -ne $cmd.bounds.x) { $e.window.Left = [double]$cmd.bounds.x }
          if ($null -ne $cmd.bounds.y) { $e.window.Top = [double]$cmd.bounds.y }
          if ($cmd.visible -eq $false) { $e.window.Hide() } else { $e.window.Show() }
        }
      } elseif ($cmd.type -eq "set-scene" -and $windows.ContainsKey($wid)) {
        $windows[$wid].scene = $cmd.scene
        Render-OverlayEntry $windows[$wid]
      } elseif ($cmd.type -eq "update-state" -and $windows.ContainsKey($wid)) {
        $windows[$wid].state = $cmd.state
        Render-OverlayEntry $windows[$wid]
      }
    } catch {}
  }
  if ($script:eofReached) {
    $timer.Stop()
    [System.Windows.Application]::Current.Shutdown()
  }
})
$timer.Start()

Emit-Event @{
  type = "ready"
  platform = "win32"
  pid = $PID
  workArea = @{
    x = [int]$workArea.Left
    y = [int]$workArea.Top
    width = [int]$workArea.Width
    height = [int]$workArea.Height
  }
}

$app = New-Object System.Windows.Application
[void]$app.Run()
