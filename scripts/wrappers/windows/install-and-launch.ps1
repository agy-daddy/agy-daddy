[CmdletBinding()]
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
$log = $null
$status = 1
try {
  if ($Quiet) {
    $logDir = Join-Path $env:LOCALAPPDATA 'AgyDaddy\logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $log = Join-Path $logDir 'wrapper.log'
    Start-Transcript -LiteralPath $log -Append | Out-Null
  }

  $binDir = if ($env:AGY_DADDY_BIN_DIR) { $env:AGY_DADDY_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'AgyDaddy\bin' }
  $shim = Join-Path $binDir 'agy-daddy.cmd'
  $cli = $null
  $onPath = Get-Command agy-daddy -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  foreach ($candidate in @($shim, $onPath.Source) | Select-Object -Unique) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      try {
        & $candidate --help *> $null
        if ($LASTEXITCODE -eq 0) {
          $cli = $candidate
          break
        }
      } catch {
        continue
      }
    }
  }

  if (-not $cli) {
    $tag = if ($env:AGY_DADDY_TAG) { $env:AGY_DADDY_TAG } else { '@@INSTALL_TAG@@' }
    & (Join-Path $PSScriptRoot 'install.ps1') -Tag $tag -NoLauncher -NoPath
    if (-not (Test-Path -LiteralPath $shim -PathType Leaf)) {
      throw 'The installer did not create the Agy-Daddy CLI.'
    }
    $cli = $shim
  }

  & $cli launcher
  $status = $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine($_.ToString())
  if ($log) {
    Write-Host $_
  }
} finally {
  if ($log) {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
  }
}
exit $status
