$ErrorActionPreference = 'Stop'

$desktop = [Environment]::GetFolderPath('DesktopDirectory')
if (-not $desktop) { throw 'Could not find the current user desktop.' }

$shell = New-Object -ComObject WScript.Shell
$linkPath = Join-Path $desktop 'Agy-Daddy Launcher.lnk'
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = '"' + (Join-Path $PSScriptRoot 'Agy-Daddy-Launcher.vbs') + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.IconLocation = (Join-Path $PSScriptRoot 'agy-daddy-launcher.ico') + ',0'
$shortcut.Save()
Write-Host "Created $linkPath"
