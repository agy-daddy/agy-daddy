#!/usr/bin/env bash
set -euo pipefail

TAG="${AGY_DADDY_TAG:-latest}"
VERSION="${AGY_DADDY_VERSION:-}"
REGISTRY="${AGY_DADDY_NPM_REGISTRY:-https://registry.npmjs.org}"
INSTALL_DIR="${AGY_DADDY_INSTALL_DIR:-$HOME/.local/share/agy-daddy/host}"
BIN_DIR="${AGY_DADDY_BIN_DIR:-$HOME/.local/bin}"
FROM_TARBALL=""
HOST_ONLY=0
NO_LAUNCHER=0
NO_PATH=0
UNINSTALL=0

print_help() {
  cat <<'EOF'
Agy-Daddy One-Click Installer (macOS / Linux, zero Node.js required)

Usage:
  install.sh [options]

Options:
  --tag <tag>             npm dist-tag to install (default: latest; e.g. next)
  --version <semver>      Install an exact @agy-daddy/host semver version
  --registry <url>        npm registry URL (default: https://registry.npmjs.org)
  --install-dir <dir>     Host install directory (default: ~/.local/share/agy-daddy/host)
  --bin-dir <dir>         CLI shim directory (default: ~/.local/bin)
  --from-tarball <file>   Install offline from a local @agy-daddy/host .tgz tarball
  --host-only             Install @agy-daddy/host only (skip official T0 plugins)
  --no-launcher           Skip creating desktop launcher / app bundle
  --no-path               Skip PATH guidance output
  --uninstall             Remove installed host and CLI shim (preserves plugin data)
  -h, --help              Show this help message
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      [ "$#" -ge 2 ] || { echo "❌ Missing value for --tag" >&2; exit 1; }
      TAG="$2"; shift 2 ;;
    --version)
      [ "$#" -ge 2 ] || { echo "❌ Missing value for --version" >&2; exit 1; }
      VERSION="$2"; shift 2 ;;
    --registry)
      [ "$#" -ge 2 ] || { echo "❌ Missing value for --registry" >&2; exit 1; }
      REGISTRY="$2"; shift 2 ;;
    --install-dir)
      [ "$#" -ge 2 ] || { echo "❌ Missing value for --install-dir" >&2; exit 1; }
      INSTALL_DIR="$2"; shift 2 ;;
    --bin-dir)
      [ "$#" -ge 2 ] || { echo "❌ Missing value for --bin-dir" >&2; exit 1; }
      BIN_DIR="$2"; shift 2 ;;
    --from-tarball)
      [ "$#" -ge 2 ] || { echo "❌ Missing value for --from-tarball" >&2; exit 1; }
      FROM_TARBALL="$2"; shift 2 ;;
    --host-only)
      HOST_ONLY=1; shift ;;
    --no-launcher)
      NO_LAUNCHER=1; shift ;;
    --no-path)
      NO_PATH=1; shift ;;
    --uninstall)
      UNINSTALL=1; shift ;;
    -h|--help)
      print_help; exit 0 ;;
    *)
      echo "❌ Unknown option: $1" >&2
      print_help >&2
      exit 1 ;;
  esac
done

REGISTRY="${REGISTRY%/}"

if [ "$UNINSTALL" = "1" ]; then
  if [ -x "$BIN_DIR/agy-daddy" ]; then
    "$BIN_DIR/agy-daddy" stop >/dev/null 2>&1 || true
    rm -f "$BIN_DIR/agy-daddy"
  fi
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
  fi
  OS_NAME="$(uname -s 2>/dev/null || echo Unknown)"
  if [ "$OS_NAME" = "Darwin" ]; then
    DATA_DIR="$HOME/Library/Application Support/AgyDaddy"
  else
    DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agy-daddy"
  fi
  echo "✅ Agy-Daddy CLI 已卸载 ($INSTALL_DIR, $BIN_DIR/agy-daddy)"
  echo "ℹ️ 用户插件与数据目录已保留: $DATA_DIR"
  exit 0
fi

RUNTIME_BIN=""
RUNTIME_IS_ELECTRON=0

probe_runtime() {
  local bin="$1"
  local is_electron="${2:-0}"
  [ -n "$bin" ] && [ -x "$bin" ] || return 1
  if [ "$is_electron" = "1" ]; then
    ELECTRON_RUN_AS_NODE=1 "$bin" -e '
      const [maj, min] = process.versions.node.split(".").map(Number);
      if (maj < 22 || (maj === 22 && min < 4)) process.exit(1);
      if (typeof WebSocket !== "function" || typeof fetch !== "function") process.exit(1);
    ' >/dev/null 2>&1
  else
    env -u ELECTRON_RUN_AS_NODE "$bin" -e '
      const [maj, min] = process.versions.node.split(".").map(Number);
      if (maj < 22 || (maj === 22 && min < 4)) process.exit(1);
      if (typeof WebSocket !== "function" || typeof fetch !== "function") process.exit(1);
    ' >/dev/null 2>&1
  fi
}

find_runtime() {
  local cand
  if [ -n "${AGY_DADDY_NODE:-}" ] && probe_runtime "$AGY_DADDY_NODE" "${AGY_DADDY_NODE_ELECTRON:-0}"; then
    RUNTIME_BIN="$AGY_DADDY_NODE"
    RUNTIME_IS_ELECTRON="${AGY_DADDY_NODE_ELECTRON:-0}"
    return 0
  fi

  for cand in $(ls -r "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null || true) \
              $(ls -r "$HOME"/.fnm/node-versions/*/installation/bin/node 2>/dev/null || true) \
              "$HOME/.volta/bin/node"; do
    if probe_runtime "$cand" 0; then
      RUNTIME_BIN="$cand"
      RUNTIME_IS_ELECTRON=0
      return 0
    fi
  done

  if command -v node >/dev/null 2>&1; then
    cand="$(command -v node)"
    if probe_runtime "$cand" 0; then
      RUNTIME_BIN="$cand"
      RUNTIME_IS_ELECTRON=0
      return 0
    fi
  fi

  local linux_antigravity=""
  linux_antigravity="$(command -v antigravity 2>/dev/null || true)"
  for cand in \
    "/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper" \
    "$HOME/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper" \
    "/opt/antigravity/antigravity" \
    "/opt/Antigravity/antigravity" \
    "/usr/lib/antigravity/antigravity" \
    "/usr/share/antigravity/antigravity" \
    "$HOME/.local/share/antigravity/antigravity" \
    "$linux_antigravity"; do
    if [ -n "$cand" ] && probe_runtime "$cand" 1; then
      RUNTIME_BIN="$cand"
      RUNTIME_IS_ELECTRON=1
      return 0
    fi
  done

  return 1
}

run_with_runtime() {
  if [ "$RUNTIME_IS_ELECTRON" = "1" ]; then
    env ELECTRON_RUN_AS_NODE=1 "$RUNTIME_BIN" "$@"
  else
    env -u ELECTRON_RUN_AS_NODE "$RUNTIME_BIN" "$@"
  fi
}

download_to_file() {
  local url="$1"
  local out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url"
  else
    echo "❌ 需要 curl 或 wget 来下载安装包" >&2
    exit 1
  fi
}

if ! find_runtime; then
  echo "❌ 未找到可用的 Node.js (>= 22.4.0) 或 Antigravity Desktop 内置运行时。" >&2
  echo "   请先安装 Google Antigravity Desktop 或 Node.js >= 22.4.0 后重试。" >&2
  exit 1
fi

echo "🔍 检测到运行时: $RUNTIME_BIN (electron=$RUNTIME_IS_ELECTRON)"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agy-daddy-install.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

TARBALL_FILE="$TMP_DIR/host.tgz"
INTEGRITY_FILE="$TMP_DIR/integrity.txt"
: > "$INTEGRITY_FILE"

if [ -n "$FROM_TARBALL" ]; then
  [ -f "$FROM_TARBALL" ] || { echo "❌ 找不到离线包: $FROM_TARBALL" >&2; exit 1; }
  cp "$FROM_TARBALL" "$TARBALL_FILE"
  RESOLVED_VERSION="local-tarball"
else
  META_FILE="$TMP_DIR/meta.json"
  META_URL="${REGISTRY}/@agy-daddy%2Fhost"
  echo "📦 正在获取 @agy-daddy/host 元数据 ($META_URL)..."
  download_to_file "$META_URL" "$META_FILE"

  cat > "$TMP_DIR/resolve-meta.js" <<'EOF'
const fs = require('node:fs');
const [metaPath, tag, exactVersion, outJsonPath] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const distTags = (meta && meta['dist-tags']) || {};
const targetVer = exactVersion || distTags[tag] || distTags.latest;
if (!targetVer || !meta.versions || !meta.versions[targetVer]) {
  console.error(`❌ 无法解析目标版本 (tag=${tag}, version=${exactVersion || ''})`);
  process.exit(1);
}
const verObj = meta.versions[targetVer];
const tarballUrl = verObj && verObj.dist && verObj.dist.tarball;
const integrity = (verObj && verObj.dist && verObj.dist.integrity) || '';
if (!tarballUrl) {
  console.error(`❌ 版本 ${targetVer} 缺少 tarball 下载地址`);
  process.exit(1);
}
fs.writeFileSync(outJsonPath, JSON.stringify({ version: targetVer, tarballUrl, integrity }), 'utf8');
EOF

  RESOLVED_JSON="$TMP_DIR/resolved.json"
  run_with_runtime "$TMP_DIR/resolve-meta.js" "$META_FILE" "$TAG" "$VERSION" "$RESOLVED_JSON"
  RESOLVED_VERSION="$(run_with_runtime -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(d.version)' "$RESOLVED_JSON")"
  TARBALL_URL="$(run_with_runtime -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(d.tarballUrl)' "$RESOLVED_JSON")"
  run_with_runtime -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(d.integrity||"")' "$RESOLVED_JSON" > "$INTEGRITY_FILE"

  echo "⬇️  正在下载 @agy-daddy/host@${RESOLVED_VERSION}..."
  download_to_file "$TARBALL_URL" "$TARBALL_FILE"
fi

cat > "$TMP_DIR/extract.js" <<'EOF'
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
    console.error('❌ SHA-512 完整性校验失败，已中止安装！');
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
    const modeOctal = header.subarray(100, 108).toString('utf8').replace(/\0.*$/, '').trim();
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const typeFlag = String.fromCharCode(header[156] || 48);
    const prefixRaw = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const mode = modeOctal ? parseInt(modeOctal, 8) : 0o644;
    const fullName = prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw;

    offset += 512;
    const data = raw.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === 'g' || typeFlag === 'x') continue;
    entries.push({ name: fullName, type: typeFlag, mode, data });
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
    const rel = stripped.join('/');
    if (rel === 'bin/agy-daddy' || rel === 'bin/agy-daddy.js' || (ent.mode & 0o111) !== 0) {
      fs.chmodSync(target, 0o755);
    }
    count++;
  }
}
if (count === 0) {
  throw new Error('Extracted tarball contained 0 files');
}
EOF

STAGE_DIR="$TMP_DIR/stage-host"
run_with_runtime "$TMP_DIR/extract.js" "$TARBALL_FILE" "$STAGE_DIR" "$INTEGRITY_FILE"

[ -f "$STAGE_DIR/src/cli.js" ] || { echo "❌ 解压后的安装包缺少 src/cli.js" >&2; exit 1; }
chmod +x "$STAGE_DIR/bin/agy-daddy" "$STAGE_DIR/bin/agy-daddy.js" 2>/dev/null || true

mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"
BACKUP_DIR=""
if [ -e "$INSTALL_DIR" ]; then
  BACKUP_DIR="${INSTALL_DIR}.bak.$$"
  mv "$INSTALL_DIR" "$BACKUP_DIR"
fi
if ! mv "$STAGE_DIR" "$INSTALL_DIR"; then
  if [ -n "$BACKUP_DIR" ] && [ -e "$BACKUP_DIR" ]; then
    mv "$BACKUP_DIR" "$INSTALL_DIR" || true
  fi
  echo "❌ 写入安装目录失败: $INSTALL_DIR" >&2
  exit 1
fi
if [ -n "$BACKUP_DIR" ] && [ -e "$BACKUP_DIR" ]; then
  rm -rf "$BACKUP_DIR"
fi

cat > "$BIN_DIR/agy-daddy" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$INSTALL_DIR/bin/agy-daddy" "\$@"
EOF
chmod +x "$BIN_DIR/agy-daddy"

echo "✅ 已安装 @agy-daddy/host (${RESOLVED_VERSION}) -> $INSTALL_DIR"
echo "✅ 已创建命令入口 -> $BIN_DIR/agy-daddy"

if [ "$HOST_ONLY" != "1" ]; then
  echo "📦 正在安装官方内置插件 (tag=$TAG)..."
  if ! AGY_DADDY_NPM_REGISTRY="$REGISTRY" "$BIN_DIR/agy-daddy" plugin install --official --tag "$TAG" --registry "$REGISTRY"; then
    echo "⚠️ 部分或全部官方插件安装失败，可稍后重试: agy-daddy plugin install --official --tag $TAG" >&2
  fi
fi

if [ "$NO_LAUNCHER" != "1" ]; then
  if ! "$BIN_DIR/agy-daddy" install-launcher >/dev/null 2>&1; then
    echo "ℹ️ 桌面启动器创建已跳过或未完成（可稍后手动运行: agy-daddy install-launcher）"
  fi
fi

"$BIN_DIR/agy-daddy" doctor || true

if [ "$NO_PATH" != "1" ]; then
  case ":${PATH:-}:" in
    *":$BIN_DIR:"*) ;;
    *)
      echo ""
      echo "⚠️ $BIN_DIR 尚未加入 PATH，请将以下内容添加到 ~/.zshrc 或 ~/.bashrc："
      echo "   export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
fi

echo ""
echo "🎉 安装完成！常用命令："
echo "   agy-daddy doctor --json"
echo "   agy-daddy live"
echo "   agy-daddy launcher"
