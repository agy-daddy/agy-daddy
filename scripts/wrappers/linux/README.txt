Agy-Daddy Launcher for Linux

1. Install Google Antigravity Desktop and extract the entire tar.gz.
2. In the extracted folder, run ./agy-daddy-launcher.sh from a terminal.
   If your extractor stripped executable permissions, run:
   chmod +x agy-daddy-launcher.sh install-desktop-entry.sh
3. The first run needs internet access to install the host and official
   plugins. The launcher reuses Antigravity's Electron runtime. It
   requires no separate Node.js or npm installation.

The native tray requires a graphical desktop with tray support and
python3 with PyGObject and GTK 3. For example, Debian/Ubuntu packages
these as python3-gi and gir1.2-gtk-3.0. An AppIndicator-compatible panel
can also use the AyatanaAppIndicator3 bindings.

To add the launcher to your applications menu, keep the extracted
folder in a permanent location and run ./install-desktop-entry.sh.
Run it again if you move the folder. The menu entry opens a terminal
to show startup output.
