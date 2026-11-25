#!/bin/bash
set -euo pipefail

dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PATH="${PATH:+$PATH:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
shim="${AGY_DADDY_BIN_DIR:-$HOME/.local/bin}/agy-daddy"

if [ -x "$shim" ] && "$shim" --help >/dev/null 2>&1; then
  exec "$shim" launcher
fi

if command -v agy-daddy >/dev/null 2>&1 && agy-daddy --help >/dev/null 2>&1; then
  exec agy-daddy launcher
fi

/bin/bash "$dir/install.sh" --tag "${AGY_DADDY_TAG:-@@INSTALL_TAG@@}" --no-launcher --no-path
exec "$shim" launcher
