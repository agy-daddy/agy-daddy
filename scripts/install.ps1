[CmdletBinding()]
param(
  [string]$Tag = $(if ($env:AGY_DADDY_TAG) { $env:AGY_DADDY_TAG } else { 'latest' }),
  [string]$Version = $env:AGY_DADDY_VERSION,
  [string]$Registry = $(if ($env:AGY_DADDY_NPM_REGISTRY) { $env:AGY_DADDY_NPM_REGISTRY } else { 'https://registry.npmjs.org' }),
  [string]$InstallDir = $(if ($env:AGY_DADDY_INSTALL_DIR) { $env:AGY_DADDY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'AgyDaddy\host' }),
  [string]$BinDir = $(if ($env:AGY_DADDY_BIN_DIR) { $env:AGY_DADDY_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'AgyDaddy\bin' }),
  [string]$FromTarball = '',
  [switch]$HostOnly,
  [switch]$NoLauncher,
  [switch]$NoPath,
  [switch]$Uninstall,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

function Show-Help {
  @"
Agy-Daddy One-Click Installer (Windows PowerShell, zero Node.js required)

Usage:
  install.ps1 [options]

Options:
  -Tag <tag>             npm dist-tag to install (default: latest; e.g. next)
  -Version <semver>      Install an exact @agy-daddy/host semver version
  -Registry <url>        npm registry URL (default: https://registry.npmjs.org)
  -InstallDir <dir>      Host install directory (default: %LOCALAPPDATA%\AgyDaddy\host)
  -BinDir <dir>          CLI shim directory (default: %LOCALAPPDATA%\AgyDaddy\bin)
  -FromTarball <file>    Install offline from a local @agy-daddy/host .tgz tarball
  -HostOnly              Install @agy-daddy/host only (skip official T0 plugins)
  -NoLauncher            Skip creating desktop launcher shortcut
  -NoPath                Skip adding BinDir to User PATH
  -Uninstall             Remove installed host and CLI shim (preserves plugin data)
  -Help                  Show this help message
"@
}

if ($Help) {
  Show-Help
  exit 0
}

$Registry = $Registry.TrimEnd('/')
$CmdShimPath = Join-Path $BinDir 'agy-daddy.cmd'

if ($Uninstall) {
  if (Test-Path $CmdShimPath) {
    try { & $CmdShimPath stop *> $null } catch {}
    Remove-Item -Force $CmdShimPath
  }
  if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
  }
  $DataDir = Join-Path $env:LOCALAPPDATA 'AgyDaddy'
  Write-Host "Uninstalled Agy-Daddy CLI ($InstallDir, $CmdShimPath)"
  Write-Host "Preserved user plugins & state directory: $DataDir"
  exit 0
}

function Test-AgyRuntime {
  param(
    [string]$ExePath,
    [bool]$IsElectron
  )
  if (-not $ExePath -or -not (Test-Path $ExePath)) { return $false }
  $prevElectron = $env:ELECTRON_RUN_AS_NODE
  try {
    if ($IsElectron) {
      $env:ELECTRON_RUN_AS_NODE = '1'
    } else {
      Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
    $probeCode = "const [maj,min]=process.versions.node.split('.').map(Number);if(maj<22||(maj===22&&min<4))process.exit(1);if(typeof WebSocket!=='function'||typeof fetch!=='function')process.exit(1);"
    & $ExePath -e $probeCode *> $null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  } finally {
    if ($null -eq $prevElectron) {
      Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    } else {
      $env:ELECTRON_RUN_AS_NODE = $prevElectron
    }
  }
}

function Find-AgyRuntime {
  if ($env:AGY_DADDY_NODE) {
    $isElec = ($env:AGY_DADDY_NODE_ELECTRON -eq '1')
    if (Test-AgyRuntime -ExePath $env:AGY_DADDY_NODE -IsElectron $isElec) {
      return @{ Path = $env:AGY_DADDY_NODE; IsElectron = $isElec }
    }
  }

  $nodeCandidates = New-Object System.Collections.Generic.List[string]
  if ($env:NVM_SYMLINK) {
    $nodeCandidates.Add((Join-Path $env:NVM_SYMLINK 'node.exe'))
  }
  $nvmHome = if ($env:NVM_HOME) { $env:NVM_HOME } elseif ($env:APPDATA) { Join-Path $env:APPDATA 'nvm' } else { $null }
  if ($nvmHome -and (Test-Path $nvmHome)) {
    Get-ChildItem -Path $nvmHome -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object {
      $nodeCandidates.Add((Join-Path $_.FullName 'node.exe'))
    }
  }
  foreach ($fnmBase in @($env:APPDATA, $env:LOCALAPPDATA)) {
    if ($fnmBase) {
      $fnmDir = Join-Path $fnmBase 'fnm\node-versions'
      if (Test-Path $fnmDir) {
        Get-ChildItem -Path $fnmDir -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object {
          $nodeCandidates.Add((Join-Path $_.FullName 'installation\node.exe'))
        }
      }
    }
  }
  if ($env:LOCALAPPDATA) {
    $nodeCandidates.Add((Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe'))
  }
  if ($env:USERPROFILE) {
    $nodeCandidates.Add((Join-Path $env:USERPROFILE '.volta\bin\node.exe'))
    $nodeCandidates.Add((Join-Path $env:USERPROFILE 'scoop\apps\nodejs\current\node.exe'))
    $nodeCandidates.Add((Join-Path $env:USERPROFILE 'scoop\apps\nodejs-lts\current\node.exe'))
  }
  $cmdNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmdNode -and $cmdNode.Source) {
    $nodeCandidates.Add($cmdNode.Source)
  }

  foreach ($cand in $nodeCandidates) {
    if (Test-AgyRuntime -ExePath $cand -IsElectron $false) {
      return @{ Path = $cand; IsElectron = $false }
    }
  }

  $electronCandidates = New-Object System.Collections.Generic.List[string]
  if ($env:LOCALAPPDATA) {
    $electronCandidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Antigravity\Antigravity.exe'))
    $electronCandidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'))
  }
  if ($env:ProgramFiles) {
    $electronCandidates.Add((Join-Path $env:ProgramFiles 'Antigravity\Antigravity.exe'))
    $electronCandidates.Add((Join-Path $env:ProgramFiles 'Google Antigravity\Antigravity.exe'))
    $electronCandidates.Add((Join-Path $env:ProgramFiles 'Google\Antigravity\Antigravity.exe'))
  }

  foreach ($cand in $electronCandidates) {
    if (Test-AgyRuntime -ExePath $cand -IsElectron $true) {
      return @{ Path = $cand; IsElectron = $true }
    }
  }

  return $null
}

function Invoke-WithRuntime {
  param(
    [hashtable]$Runtime,
    [string[]]$Arguments
  )
  $prevElectron = $env:ELECTRON_RUN_AS_NODE
  try {
    if ($Runtime.IsElectron) {
      $env:ELECTRON_RUN_AS_NODE = '1'
    } else {
      Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
    & $Runtime.Path @Arguments
    return $LASTEXITCODE
  } finally {
    if ($null -eq $prevElectron) {
      Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    } else {
      $env:ELECTRON_RUN_AS_NODE = $prevElectron
    }
  }
}

$Runtime = Find-AgyRuntime
if ($null -eq $Runtime) {
  Write-Error 'No compatible Node.js (>= 22.4.0) or Antigravity.exe runtime found. Install Google Antigravity Desktop or Node.js >= 22.4.0 and retry.'
  exit 1
}

Write-Host "Detected runtime: $($Runtime.Path) (electron=$($Runtime.IsElectron))"

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-daddy-install-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

try {
  $TarballFile = Join-Path $TmpDir 'host.tgz'
  $IntegrityFile = Join-Path $TmpDir 'integrity.txt'
  Set-Content -Path $IntegrityFile -Value '' -Encoding UTF8

  if ($FromTarball) {
    if (-not (Test-Path $FromTarball)) {
      throw "Offline tarball not found: $FromTarball"
    }
    Copy-Item -Force $FromTarball $TarballFile
    $ResolvedVersion = 'local-tarball'
  } else {
    $MetaUrl = "$Registry/@agy-daddy%2Fhost"
    Write-Host "Fetching metadata from $MetaUrl..."
    $Meta = Invoke-RestMethod -Uri $MetaUrl -Headers @{ Accept = 'application/json' }
    $TargetVer = if ($Version) {
      $Version
    } elseif ($Meta.'dist-tags' -and $Meta.'dist-tags'.$Tag) {
      $Meta.'dist-tags'.$Tag
    } elseif ($Meta.'dist-tags' -and $Meta.'dist-tags'.latest) {
      $Meta.'dist-tags'.latest
    } else {
      $null
    }
    if (-not $TargetVer -or -not $Meta.versions.$TargetVer) {
      throw "Could not resolve @agy-daddy/host version (tag=$Tag, version=$Version)"
    }
    $VerObj = $Meta.versions.$TargetVer
    $TarballUrl = $VerObj.dist.tarball
    if (-not $TarballUrl) {
      throw "Missing tarball URL for @agy-daddy/host@$TargetVer"
    }
    if ($VerObj.dist.integrity) {
      Set-Content -Path $IntegrityFile -Value ([string]$VerObj.dist.integrity) -Encoding ASCII
    }
    $ResolvedVersion = [string]$TargetVer
    Write-Host "Downloading @agy-daddy/host@$ResolvedVersion..."
    Invoke-WebRequest -UseBasicParsing -Uri $TarballUrl -OutFile $TarballFile
  }

  $ExtractJs = Join-Path $TmpDir 'extract.js'
  @'
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const [tgzPath, destDir, integrityPath] = process.argv.slice(2);
const buf = fs.readFileSync(tgzPath);
const expectedIntegrity = fs.existsSync(integrityPath)
  ? fs.readFileSync(integrityPath, 'utf8').trim()
  : '';

if (expectedIntegrity && expectedIntegrity.startsWith('sha512-')) {
  const expectedB64 = expectedIntegrity.slice('sha512-'.length);
  const actualB64 = crypto.createHash('sha512').update(buf).digest('base64');
  if (actualB64 !== expectedB64) {
    console.error('SHA-512 integrity check failed!');
    process.exit(1);
  }
}

function parseTar(raw) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    const nameRaw = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const typeFlag = String.fromCharCode(header[156] || 48);
    const prefixRaw = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const fullName = prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw;

    offset += 512;
    const data = raw.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === 'g' || typeFlag === 'x') continue;
    entries.push({ name: fullName, type: typeFlag, data });
  }
  return entries;
}

const gunzipped = zlib.gunzipSync(buf);
const entries = parseTar(gunzipped);
const resolvedDest = path.resolve(destDir);
fs.mkdirSync(resolvedDest, { recursive: true });

let count = 0;
for (const ent of entries) {
  const parts = ent.name.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new Error(`Unsafe path traversal in tarball: ${ent.name}`);
  }
  const stripped = parts.slice(1);
  if (!stripped.length) continue;
  const target = path.resolve(resolvedDest, ...stripped);
  if (!target.startsWith(resolvedDest + path.sep) && target !== resolvedDest) {
    throw new Error(`Unsafe target path in tarball: ${ent.name}`);
  }
  if (ent.type === '5') {
    fs.mkdirSync(target, { recursive: true });
    continue;
  }
  if (ent.type === '0' || ent.type === '\0' || ent.type === '') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ent.data);
    count++;
  }
}
if (count === 0) {
  throw new Error('Extracted tarball contained 0 files');
}
'@ | Set-Content -Path $ExtractJs -Encoding UTF8

  $StageDir = Join-Path $TmpDir 'stage-host'
  $extractExit = Invoke-WithRuntime -Runtime $Runtime -Arguments @($ExtractJs, $TarballFile, $StageDir, $IntegrityFile)
  if ($extractExit -ne 0) {
    throw "Tarball verification or extraction failed (exit=$extractExit)"
  }
  if (-not (Test-Path (Join-Path $StageDir 'src\cli.js'))) {
    throw 'Extracted package is missing src\cli.js'
  }

  $ParentInstallDir = Split-Path -Parent $InstallDir
  if ($ParentInstallDir) { New-Item -ItemType Directory -Force -Path $ParentInstallDir | Out-Null }
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

  $BackupDir = ''
  if (Test-Path $InstallDir) {
    $BackupDir = "$InstallDir.bak.$PID"
    if (Test-Path $BackupDir) { Remove-Item -Recurse -Force $BackupDir }
    Move-Item -Force $InstallDir $BackupDir
  }
  try {
    Move-Item -Force $StageDir $InstallDir
    if ($BackupDir -and (Test-Path $BackupDir)) {
      Remove-Item -Recurse -Force $BackupDir
    }
  } catch {
    if ($BackupDir -and (Test-Path $BackupDir) -and -not (Test-Path $InstallDir)) {
      Move-Item -Force $BackupDir $InstallDir
    }
    throw
  }

  $CmdLines = @(
    '@echo off',
    'setlocal',
    ("set ""AGY_CLI=" + (Join-Path $InstallDir 'bin\agy-daddy.js') + """"),
    'if defined AGY_DADDY_NODE (',
    '  if "%AGY_DADDY_NODE_ELECTRON%"=="1" (',
    '    set "ELECTRON_RUN_AS_NODE=1"',
    '    "%AGY_DADDY_NODE%" "%AGY_CLI%" %*',
    '    exit /b %ERRORLEVEL%',
    '  ) else (',
    '    set "ELECTRON_RUN_AS_NODE="',
    '    "%AGY_DADDY_NODE%" "%AGY_CLI%" %*',
    '    exit /b %ERRORLEVEL%',
    '  )',
    ')',
    'for /f "delims=" %%N in (''where node.exe 2^>nul'') do (',
    '  set "ELECTRON_RUN_AS_NODE="',
    '  "%%N" "%AGY_CLI%" %*',
    '  exit /b %ERRORLEVEL%',
    ')',
    'for %%E in (',
    '  "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe"',
    '  "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"',
    '  "%ProgramFiles%\Antigravity\Antigravity.exe"',
    '  "%ProgramFiles%\Google Antigravity\Antigravity.exe"',
    '  "%ProgramFiles%\Google\Antigravity\Antigravity.exe"',
    ') do (',
    '  if exist "%%~E" (',
    '    set "ELECTRON_RUN_AS_NODE=1"',
    '    "%%~E" "%AGY_CLI%" %*',
    '    exit /b %ERRORLEVEL%',
    '  )',
    ')',
    'echo [agy-daddy] Node.js (>=22.4) or Antigravity.exe not found. >&2',
    'exit /b 1'
  )
  Set-Content -Path $CmdShimPath -Value ($CmdLines -join "`r`n") -Encoding ASCII

  Write-Host "Installed @agy-daddy/host ($ResolvedVersion) -> $InstallDir"
  Write-Host "Created CLI shim -> $CmdShimPath"

  if (-not $NoPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @()
    if ($userPath) {
      $parts = $userPath -split ';' | Where-Object { $_ -and $_.Trim() -ne '' }
    }
    $alreadyInUserPath = $parts | Where-Object { $_.TrimEnd('\').ToLowerInvariant() -eq $BinDir.TrimEnd('\').ToLowerInvariant() }
    if (-not $alreadyInUserPath) {
      $nextUserPath = if ($parts.Count -gt 0) { ($parts + $BinDir) -join ';' } else { $BinDir }
      [Environment]::SetEnvironmentVariable('Path', $nextUserPath, 'User')
      Write-Host "Added $BinDir to User PATH"
    }
    if (-not (($env:PATH -split ';') | Where-Object { $_.TrimEnd('\').ToLowerInvariant() -eq $BinDir.TrimEnd('\').ToLowerInvariant() })) {
      $env:PATH = "$BinDir;$env:PATH"
    }
  }

  if (-not $HostOnly) {
    Write-Host "Installing official T0 plugins (tag=$Tag)..."
    $prevReg = $env:AGY_DADDY_NPM_REGISTRY
    $env:AGY_DADDY_NPM_REGISTRY = $Registry
    try {
      & $CmdShimPath plugin install --official --tag $Tag --registry $Registry
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "Some official plugins failed to install. Retry later with: agy-daddy plugin install --official --tag $Tag"
      }
    } finally {
      if ($null -eq $prevReg) {
        Remove-Item Env:AGY_DADDY_NPM_REGISTRY -ErrorAction SilentlyContinue
      } else {
        $env:AGY_DADDY_NPM_REGISTRY = $prevReg
      }
    }
  }

  if (-not $NoLauncher) {
    try {
      & $CmdShimPath install-launcher *> $null
    } catch {
      Write-Host 'Skipped desktop launcher shortcut (retry manually with: agy-daddy install-launcher)'
    }
  }

  & $CmdShimPath doctor
  Write-Host ''
  Write-Host 'Installation complete! Common commands:'
  Write-Host '  agy-daddy doctor --json'
  Write-Host '  agy-daddy live'
  Write-Host '  agy-daddy launcher'
} finally {
  if (Test-Path $TmpDir) {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
  }
}
