Agy-Daddy Launcher for macOS

1. Install Google Antigravity Desktop and extract the entire ZIP.
2. Double-click Agy-Daddy Launcher.app in the extracted folder. To see
   installer output, double-click Install & Launch.command instead.
3. The first run needs internet access to install the host and official
   plugins. The launcher reuses Antigravity's Electron runtime. It
   requires no separate Node.js or npm installation.

The release includes an Apple Silicon and Intel tray helper for
macOS 14 or later. If the installed host requires a different helper
version, it builds the helper locally using Apple Command Line Tools
(xcode-select --install).

This wrapper is unsigned. If Gatekeeper blocks a copy you have verified,
open Terminal in the extracted folder and run:

    xattr -cr 'Agy-Daddy Launcher.app' 'Install & Launch.command'

Then open the launcher again. Finder launch output goes to
~/Library/Logs/agy-daddy/wrapper.log.
