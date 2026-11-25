#!/bin/bash
set -euo pipefail

dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source="$dir/../../../agy-daddy-host/src/core/tray-backends/macos-tray.swift"
app="${1:?usage: prepare-tray.sh path/to/Agy-Daddy Tray.app}"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

# Match the minimum OS supported by the host's native tray helper.
xcrun swiftc -O -target arm64-apple-macos14.0 "$source" -o "$tmp/arm64"
xcrun swiftc -O -target x86_64-apple-macos14.0 "$source" -o "$tmp/x86_64"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
xcrun lipo -create "$tmp/arm64" "$tmp/x86_64" -output "$app/Contents/MacOS/AgyDaddyTray"
shasum -a 256 "$source" | cut -c 1-12 > "$app/Contents/Resources/swift-hash.txt"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>AgyDaddyTray</string>
  <key>CFBundleIdentifier</key><string>dev.agy-daddy.launcher.bootstrap.tray</string>
  <key>CFBundleName</key><string>Agy-Daddy Tray</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$app"
codesign --verify --strict "$app"
