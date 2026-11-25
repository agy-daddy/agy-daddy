#!/bin/bash
set -euo pipefail

dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$dir/Agy-Daddy Launcher.app/Contents/MacOS/agy-daddy-launcher" --terminal
