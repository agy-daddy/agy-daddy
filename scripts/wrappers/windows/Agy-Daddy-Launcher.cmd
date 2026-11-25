@echo off
setlocal DisableDelayedExpansion
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-and-launch.ps1"
set "status=%errorlevel%"
if not "%status%"=="0" pause
exit /b %status%
