Agy-Daddy Launcher for Windows

1. Install Google Antigravity Desktop and extract the entire ZIP using
   Extract All.
2. Double-click Agy-Daddy-Launcher.vbs to start without a console, or
   Agy-Daddy-Launcher.cmd to watch startup output. The .cmd also works
   on systems where Windows Script Host is disabled.
3. The first run needs internet access to install the host and official
   plugins. The launcher reuses Antigravity's Electron runtime. It
   requires no separate Node.js or npm installation.

The launcher is unsigned. If Microsoft Defender SmartScreen appears
when starting a launcher from a verified ZIP, choose More info >
Run anyway if it is offered by your system. Hidden launch output goes to
%LOCALAPPDATA%\AgyDaddy\logs\wrapper.log.

To create a desktop shortcut, keep the extracted folder in a permanent
location and run this command in PowerShell from that folder:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Create-Desktop-Shortcut.ps1

Run the shortcut script again if the folder moves.
