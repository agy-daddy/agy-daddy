#!/bin/bash
set -euo pipefail

dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
applications="$data_dir/applications"
icons="$data_dir/icons/hicolor/256x256/apps"
entry="$applications/agy-daddy-launcher.desktop"
launcher="$dir/agy-daddy-launcher.sh"

# Exec quoting is decoded after the desktop entry's string escapes.
launcher="${launcher//\\/\\\\\\\\}"
launcher="${launcher//\"/\\\\\"}"
launcher="${launcher//\$/\\\\\$}"
launcher="${launcher//\`/\\\\\`}"
launcher="${launcher//%/%%}"
launcher="${launcher//$'\n'/\\n}"
launcher="${launcher//$'\r'/\\r}"
launcher="${launcher//$'\t'/\\t}"

mkdir -p -- "$applications" "$icons"
cp -- "$dir/icon-256.png" "$icons/agy-daddy-launcher.png"

tmp="$(mktemp "$applications/.agy-daddy-launcher.XXXXXX")"
trap 'rm -f -- "$tmp"' EXIT
while IFS= read -r line; do
  case "$line" in
    Exec=*) printf 'Exec="%s"\n' "$launcher" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < "$dir/agy-daddy-launcher.desktop" > "$tmp"
chmod 644 "$tmp"
mv -f -- "$tmp" "$entry"
printf 'Installed application menu entry at %s\n' "$entry"
