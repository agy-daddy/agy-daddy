'use strict';

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { getStateDir, isTestMode } = require('./paths');

const OVERLAY_PERMISSION = 'ui:desktop-overlay';
const MAX_WINDOWS_PER_PLUGIN = 1;
const MIN_DIM_PX = 64;
const MAX_DIM_PX = 360;
const MIN_VISIBLE_PX = 48;
const MAX_SPRITE_BYTES = 1024 * 1024; // 1 MB
const MAX_SPRITE_DIM = 512;
const UPDATE_THROTTLE_MS = 200; // <= 4-5 Hz coalescing
const DEFAULT_SCENE_VIEWBOX = Object.freeze({ width: 160, height: 160 });

function clampNumber(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function truncateText(val, maxLen) {
  const s = String(val || '').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 1))}…`;
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function inspectRasterHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { format: 'png', width, height };
  }
  // GIF: GIF87a / GIF89a
  if (
    buf.length >= 10 &&
    buf.slice(0, 4).toString('ascii') === 'GIF8' &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return { format: 'gif', width, height };
  }
  // WebP: RIFF....WEBP
  if (
    buf.length >= 30 &&
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    const chunk = buf.slice(12, 16).toString('ascii');
    if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { format: 'webp', width, height };
    }
    if (chunk === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { format: 'webp', width, height };
    }
    if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const b1 = buf[21];
      const b2 = buf[22];
      const b3 = buf[23];
      const b4 = buf[24];
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return { format: 'webp', width, height };
    }
  }
  return null;
}

function resolveConfinedSpritePath(rawPath, pluginDir, pluginDataDir) {
  const input = String(rawPath || '').trim();
  if (!input) throw new Error('OVERLAY_SPRITE_INVALID: empty spritePath');
  if (input.includes('\0') || /^https?:\/\//i.test(input) || /^data:/i.test(input) || /^file:/i.test(input)) {
    throw new Error(`OVERLAY_SPRITE_FORBIDDEN: remote or URI spritePath rejected (${input})`);
  }

  const allowedRoots = [];
  if (pluginDir && fs.existsSync(pluginDir)) {
    allowedRoots.push(fs.realpathSync(pluginDir));
  }
  if (pluginDataDir && fs.existsSync(pluginDataDir)) {
    allowedRoots.push(fs.realpathSync(pluginDataDir));
  }
  if (allowedRoots.length === 0) {
    throw new Error('OVERLAY_SPRITE_CONFINED: no valid plugin directory available');
  }

  let candidate = input;
  if (!path.isAbsolute(candidate)) {
    const baseDir = allowedRoots[0];
    candidate = path.resolve(baseDir, candidate);
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`OVERLAY_SPRITE_MISSING: file not found (${input})`);
  }
  const realFile = fs.realpathSync(candidate);
  const inside = allowedRoots.some((root) => {
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return realFile.startsWith(prefix);
  });
  if (!inside) {
    throw new Error(`OVERLAY_SPRITE_ESCAPE: spritePath escapes plugin confinement (${input})`);
  }

  const stat = fs.statSync(realFile);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SPRITE_BYTES) {
    throw new Error(`OVERLAY_SPRITE_SIZE: sprite exceeds 1MB limit (${stat.size})`);
  }

  const headerBuf = Buffer.alloc(Math.min(64, stat.size));
  const fd = fs.openSync(realFile, 'r');
  try {
    fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const info = inspectRasterHeader(headerBuf);
  if (!info) {
    throw new Error('OVERLAY_SPRITE_FORMAT: invalid raster magic bytes (expected PNG/WebP/GIF)');
  }
  if (info.width <= 0 || info.height <= 0 || info.width > MAX_SPRITE_DIM || info.height > MAX_SPRITE_DIM) {
    throw new Error(`OVERLAY_SPRITE_DIMENSIONS: ${info.width}x${info.height} exceeds 512x512`);
  }
  return realFile;
}

function clampBounds(bounds = {}, prevBounds = null, workArea = null) {
  const prev = prevBounds || { x: 100, y: 100, width: 220, height: 200 };
  const width = Math.round(clampNumber(bounds.width, MIN_DIM_PX, MAX_DIM_PX, prev.width || 220));
  const height = Math.round(clampNumber(bounds.height, MIN_DIM_PX, MAX_DIM_PX, prev.height || 200));

  let x = Number.isFinite(Number(bounds.x)) ? Math.round(Number(bounds.x)) : prev.x;
  let y = Number.isFinite(Number(bounds.y)) ? Math.round(Number(bounds.y)) : prev.y;

  if (workArea && Number.isFinite(Number(workArea.width)) && Number.isFinite(Number(workArea.height))) {
    const wx = Number(workArea.x) || 0;
    const wy = Number(workArea.y) || 0;
    const ww = Math.max(MIN_VISIBLE_PX, Number(workArea.width));
    const wh = Math.max(MIN_VISIBLE_PX, Number(workArea.height));

    if (!Number.isFinite(Number(bounds.x)) && bounds.anchor) {
      x = bounds.anchor === 'bottom-left' ? wx + 24 : wx + ww - width - 24;
    }
    if (!Number.isFinite(Number(bounds.y)) && bounds.anchor) {
      y = wy + wh - height - 24;
    }

    const minX = wx - width + MIN_VISIBLE_PX;
    const maxX = wx + ww - MIN_VISIBLE_PX;
    const minY = wy - height + MIN_VISIBLE_PX;
    const maxY = wy + wh - MIN_VISIBLE_PX;
    x = Math.round(clampNumber(x, minX, maxX, wx + ww - width - 24));
    y = Math.round(clampNumber(y, minY, maxY, wy + wh - height - 24));
  }

  return {
    x: Number.isFinite(x) ? x : 100,
    y: Number.isFinite(y) ? y : 100,
    width,
    height,
    ...(bounds.anchor ? { anchor: String(bounds.anchor) } : {})
  };
}

function sanitizeSceneSpec(rawScene, opts = {}) {
  if (!isPlainObject(rawScene)) {
    throw new Error('OVERLAY_SCENE_INVALID: scene must be an object');
  }
  const sceneId = String(rawScene.sceneId || 'scene').trim() || 'scene';
  const viewBox = {
    width: Math.round(clampNumber(rawScene.viewBox?.width, 32, 512, DEFAULT_SCENE_VIEWBOX.width)),
    height: Math.round(clampNumber(rawScene.viewBox?.height, 32, 512, DEFAULT_SCENE_VIEWBOX.height))
  };
  const hitBox = {
    x: Number(rawScene.hitBox?.x ?? 20),
    y: Number(rawScene.hitBox?.y ?? 20),
    width: clampNumber(rawScene.hitBox?.width, 16, viewBox.width, viewBox.width - 40),
    height: clampNumber(rawScene.hitBox?.height, 16, viewBox.height, viewBox.height - 40)
  };
  const fps = {
    active: Math.round(clampNumber(rawScene.fps?.active, 4, 60, 30)),
    idle: Math.round(clampNumber(rawScene.fps?.idle, 2, 30, 12)),
    sleep: Math.round(clampNumber(rawScene.fps?.sleep, 1, 12, 4))
  };

  const rawLayers = Array.isArray(rawScene.layers) ? rawScene.layers.slice(0, 64) : [];
  const layers = [];
  for (const item of rawLayers) {
    if (!isPlainObject(item)) continue;
    const kind = ['path', 'circle', 'rect', 'ellipse', 'sprite'].includes(item.kind) ? item.kind : 'path';
    const layer = {
      id: String(item.id || `layer-${layers.length}`).trim(),
      kind
    };
    if (kind === 'path') {
      const d = String(item.d || '').trim();
      if (!d || !/^[MLHVCSQTAZmlhvcsqtaz0-9.,\s+-]+$/.test(d)) {
        throw new Error(`OVERLAY_PATH_INVALID: invalid SVG path data on layer ${layer.id}`);
      }
      layer.d = d;
    } else if (kind === 'circle') {
      layer.cx = Number(item.cx || 0);
      layer.cy = Number(item.cy || 0);
      layer.r = Math.max(0.5, Number(item.r || 10));
    } else if (kind === 'ellipse') {
      layer.cx = Number(item.cx || 0);
      layer.cy = Number(item.cy || 0);
      layer.rx = Math.max(0.5, Number(item.rx || 10));
      layer.ry = Math.max(0.5, Number(item.ry || 10));
    } else if (kind === 'rect') {
      layer.x = Number(item.x || 0);
      layer.y = Number(item.y || 0);
      layer.width = Math.max(1, Number(item.width || 10));
      layer.height = Math.max(1, Number(item.height || 10));
      if (item.cornerRadius !== undefined) layer.cornerRadius = Math.max(0, Number(item.cornerRadius));
    } else if (kind === 'sprite') {
      layer.spritePath = resolveConfinedSpritePath(item.spritePath, opts.pluginDir, opts.pluginDataDir);
      layer.x = Number(item.x || 0);
      layer.y = Number(item.y || 0);
      layer.width = Math.max(8, Number(item.width || viewBox.width));
      layer.height = Math.max(8, Number(item.height || viewBox.height));
      if (Array.isArray(item.frameRects)) {
        layer.frameRects = item.frameRects.slice(0, 32).map((r) => ({
          x: Math.max(0, Number(r?.x || 0)),
          y: Math.max(0, Number(r?.y || 0)),
          w: Math.max(1, Number(r?.w || 32)),
          h: Math.max(1, Number(r?.h || 32))
        }));
      }
    }

    if (typeof item.fill === 'string' && item.fill.trim()) layer.fill = item.fill.trim();
    if (typeof item.stroke === 'string' && item.stroke.trim()) layer.stroke = item.stroke.trim();
    if (item.strokeWidth !== undefined) layer.strokeWidth = clampNumber(item.strokeWidth, 0, 24, 1);
    if (item.opacity !== undefined) layer.opacity = clampNumber(item.opacity, 0, 1, 1);
    if (item.pivotX !== undefined) layer.pivotX = Number(item.pivotX);
    if (item.pivotY !== undefined) layer.pivotY = Number(item.pivotY);
    if (isPlainObject(item.motion)) {
      layer.motion = {
        ...(item.motion.bobAmpY !== undefined ? { bobAmpY: clampNumber(item.motion.bobAmpY, -40, 40, 0) } : {}),
        ...(item.motion.bobFreqHz !== undefined ? { bobFreqHz: clampNumber(item.motion.bobFreqHz, 0, 12, 0) } : {}),
        ...(item.motion.swayAmpX !== undefined ? { swayAmpX: clampNumber(item.motion.swayAmpX, -40, 40, 0) } : {}),
        ...(item.motion.swayFreqHz !== undefined ? { swayFreqHz: clampNumber(item.motion.swayFreqHz, 0, 12, 0) } : {}),
        ...(item.motion.rotAmpDeg !== undefined ? { rotAmpDeg: clampNumber(item.motion.rotAmpDeg, -90, 90, 0) } : {}),
        ...(item.motion.rotFreqHz !== undefined ? { rotFreqHz: clampNumber(item.motion.rotFreqHz, 0, 12, 0) } : {}),
        ...(item.motion.phaseRad !== undefined ? { phaseRad: Number(item.motion.phaseRad) || 0 } : {}),
        ...(item.motion.blinkIntervalMs !== undefined ? { blinkIntervalMs: clampNumber(item.motion.blinkIntervalMs, 400, 15000, 3200) } : {}),
        ...(Array.isArray(item.motion.states) ? { states: item.motion.states.map(String) } : {})
      };
    }
    layers.push(layer);
  }

  const validParticles = ['none', 'bubbles', 'sparks', 'pixels', 'stars', 'matrix', 'exhaust'];
  const particles = isPlainObject(rawScene.particles)
    ? {
        preset: validParticles.includes(rawScene.particles.preset) ? rawScene.particles.preset : 'none',
        color: typeof rawScene.particles.color === 'string' && rawScene.particles.color.trim()
          ? rawScene.particles.color.trim()
          : '#a78bfa'
      }
    : { preset: 'none', color: '#a78bfa' };

  return { sceneId, viewBox, fps, hitBox, layers, particles };
}

function sanitizeRuntimeState(patch = {}, prevState = {}) {
  const merged = {
    animState: 'idle',
    speedFactor: 1.0,
    tps: null,
    roam: { enabled: true, mode: 'bottom-edge', baseSpeedPxPerSec: 36 },
    scale: 1.0,
    flipX: false,
    statusPill: null,
    bubble: null,
    ...prevState,
    ...(isPlainObject(patch) ? patch : {})
  };

  const validAnim = new Set(['sleeping', 'idle', 'thinking', 'walking', 'trotting', 'sprinting', 'approval', 'error']);
  const animState = validAnim.has(merged.animState) ? merged.animState : 'idle';
  const speedFactor = clampNumber(merged.speedFactor, 0.25, 4.0, 1.0);
  const tps = merged.tps === null || merged.tps === undefined ? null : clampNumber(merged.tps, 0, 10000, 0);
  const roamMode = ['none', 'bottom-edge', 'screen-edges', 'free-workarea'].includes(merged.roam?.mode)
    ? merged.roam.mode
    : 'bottom-edge';
  const roam = {
    enabled: Boolean(merged.roam?.enabled),
    mode: roamMode,
    baseSpeedPxPerSec: clampNumber(merged.roam?.baseSpeedPxPerSec, 0, 240, 36)
  };
  const scale = clampNumber(merged.scale, 0.6, 2.0, 1.0);
  const flipX = Boolean(merged.flipX);

  let statusPill = null;
  if (isPlainObject(merged.statusPill) && merged.statusPill.text) {
    const tone = ['neutral', 'active', 'warn', 'danger'].includes(merged.statusPill.tone)
      ? merged.statusPill.tone
      : 'neutral';
    statusPill = { text: truncateText(merged.statusPill.text, 28), tone };
  }

  let bubble = null;
  if (isPlainObject(merged.bubble) && merged.bubble.title) {
    const kind = ['approval', 'reply', 'error', 'info'].includes(merged.bubble.kind) ? merged.bubble.kind : 'info';
    bubble = {
      id: String(merged.bubble.id || 'bubble'),
      kind,
      title: truncateText(merged.bubble.title, 48),
      ...(merged.bubble.subtitle ? { subtitle: truncateText(merged.bubble.subtitle, 80) } : {}),
      ...(merged.bubble.badge ? { badge: truncateText(merged.bubble.badge, 24) } : {}),
      ...(typeof merged.bubble.accentHex === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(merged.bubble.accentHex.trim())
        ? { accentHex: merged.bubble.accentHex.trim() }
        : {}),
      dismissible: merged.bubble.dismissible !== false
    };
  }

  let contextMenu = undefined;
  if (Array.isArray(merged.contextMenu)) {
    contextMenu = merged.contextMenu.slice(0, 24).map((item) => ({
      id: String(item?.id || ''),
      type: item?.type === 'separator' ? 'separator' : (item?.type === 'checkbox' ? 'checkbox' : 'normal'),
      label: item?.label ? truncateText(item.label, 48) : '',
      ...(item?.checked !== undefined ? { checked: Boolean(item.checked) } : {}),
      ...(item?.enabled !== undefined ? { enabled: item.enabled !== false } : {})
    }));
  }

  return {
    animState,
    speedFactor,
    tps,
    roam,
    scale,
    flipX,
    statusPill,
    bubble,
    ...(contextMenu ? { contextMenu } : {})
  };
}

class MemoryOverlayBackend {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.workArea = options.workArea || { x: 0, y: 25, width: 1440, height: 875 };
    this.started = false;
    this.windows = new Map();
    this.scenes = new Map();
    this.states = new Map();
    this.commands = [];
    this.interactionHandlers = new Set();
    this.errorHandlers = new Set();
  }

  isSupported() {
    return { supported: true, platform: this.platform, backend: 'memory' };
  }

  onInteraction(fn) {
    if (typeof fn !== 'function') return () => {};
    this.interactionHandlers.add(fn);
    return () => this.interactionHandlers.delete(fn);
  }

  onError(fn) {
    if (typeof fn !== 'function') return () => {};
    this.errorHandlers.add(fn);
    return () => this.errorHandlers.delete(fn);
  }

  async start() {
    this.started = true;
    return { ok: true, backend: 'memory', workArea: this.workArea };
  }

  async sendCommand(cmd) {
    if (!this.started) await this.start();
    this.commands.push(cmd);
    if (cmd.type === 'upsert-window') {
      this.windows.set(cmd.windowId, { bounds: cmd.bounds, visible: Boolean(cmd.visible) });
    } else if (cmd.type === 'set-scene') {
      this.scenes.set(cmd.windowId, cmd.scene);
    } else if (cmd.type === 'update-state') {
      this.states.set(cmd.windowId, cmd.state);
    } else if (cmd.type === 'remove-window') {
      this.windows.delete(cmd.windowId);
      this.scenes.delete(cmd.windowId);
      this.states.delete(cmd.windowId);
    }
    return true;
  }

  simulateInteraction(event) {
    for (const fn of Array.from(this.interactionHandlers)) {
      try { fn(event); } catch {}
    }
  }

  async stop() {
    this.started = false;
    this.windows.clear();
    this.scenes.clear();
    this.states.clear();
  }
}

function ensureMacOverlayAppBundle(options = {}) {
  const swiftSrc = options.swiftSrc || path.join(__dirname, 'overlay-backends', 'macos-overlay.swift');
  if (!fs.existsSync(swiftSrc)) {
    throw new Error(`Missing macOS overlay backend source: ${swiftSrc}`);
  }
  const srcHash = crypto.createHash('sha256').update(fs.readFileSync(swiftSrc)).digest('hex').slice(0, 16);
  const stateDir = options.stateDir || getStateDir(options);
  const bundlePath = options.bundlePathOverride
    ? path.resolve(options.bundlePathOverride)
    : path.join(stateDir, 'bin', 'AgyDaddyOverlay.app');

  const contentsDir = path.join(bundlePath, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const infoPath = path.join(contentsDir, 'Info.plist');
  const exePath = path.join(macOsDir, 'AgyDaddyOverlay');
  const hashMarkerPath = path.join(resourcesDir, 'swift-hash.txt');

  const existingHash = fs.existsSync(hashMarkerPath)
    ? String(fs.readFileSync(hashMarkerPath, 'utf8') || '').trim()
    : '';
  const needsCompile = !fs.existsSync(exePath) || existingHash !== srcHash || !fs.existsSync(infoPath);

  if (needsCompile) {
    fs.mkdirSync(macOsDir, { recursive: true });
    fs.mkdirSync(resourcesDir, { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>AgyDaddyOverlay</string>
  <key>CFBundleIdentifier</key><string>dev.agy-daddy.overlay</string>
  <key>CFBundleName</key><string>Agy-Daddy Overlay</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
    fs.writeFileSync(infoPath, plist, 'utf8');
    const tmpBin = `${exePath}.tmp-${process.pid}`;
    const swiftcBin = fs.existsSync('/usr/bin/swiftc') ? '/usr/bin/swiftc' : 'swiftc';
    const compile = spawnSync(swiftcBin, ['-O', swiftSrc, '-o', tmpBin], {
      encoding: 'utf8',
      timeout: 60000
    });
    if (compile.status !== 0) {
      try { if (fs.existsSync(tmpBin)) fs.unlinkSync(tmpBin); } catch {}
      throw new Error(`Failed to compile macos-overlay.swift: ${String(compile.stderr || compile.stdout || compile.error?.message || '').trim()}`);
    }
    fs.renameSync(tmpBin, exePath);
    fs.chmodSync(exePath, 0o755);
    fs.writeFileSync(hashMarkerPath, srcHash, 'utf8');

    if (process.platform === 'darwin' && !isTestMode()) {
      const codesignBin = fs.existsSync('/usr/bin/codesign') ? '/usr/bin/codesign' : 'codesign';
      try {
        spawnSync(codesignBin, ['--force', '--sign', '-', '--identifier', 'dev.agy-daddy.overlay', bundlePath], {
          encoding: 'utf8',
          timeout: 15000
        });
      } catch {}
    }
  }

  return { ok: true, bundlePath, exePath, srcHash, compiled: needsCompile };
}

class NativeOverlayBackend {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env;
    this.stateDir = options.stateDir || getStateDir(options);
    this.spawnFn = options.spawnFn || spawn;
    this.child = null;
    this.rl = null;
    this.socketServer = null;
    this.socketClient = null;
    this.socketPath = null;
    this.helperPid = null;
    this.workArea = null;
    this.started = false;
    this.stopping = false;
    this.crashTimestamps = [];
    this.restartTimer = null;
    this.interactionHandlers = new Set();
    this.errorHandlers = new Set();
    this.snapshotProvider = typeof options.snapshotProvider === 'function' ? options.snapshotProvider : null;
  }

  isSupported() {
    if (this.platform === 'darwin') {
      return { supported: true, platform: 'darwin', backend: 'macos-appkit' };
    }
    if (this.platform === 'win32') {
      return { supported: true, platform: 'win32', backend: 'win32-wpf' };
    }
    if (this.platform === 'linux') {
      if (!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) {
        return { supported: false, platform: 'linux', backend: 'none', reason: 'DISPLAY_UNAVAILABLE' };
      }
      return { supported: true, platform: 'linux', backend: 'linux-gtk3' };
    }
    return { supported: false, platform: this.platform, backend: 'none', reason: 'UNSUPPORTED_PLATFORM' };
  }

  onInteraction(fn) {
    if (typeof fn !== 'function') return () => {};
    this.interactionHandlers.add(fn);
    return () => this.interactionHandlers.delete(fn);
  }

  onError(fn) {
    if (typeof fn !== 'function') return () => {};
    this.errorHandlers.add(fn);
    return () => this.errorHandlers.delete(fn);
  }

  emitError(err) {
    for (const fn of Array.from(this.errorHandlers)) {
      try { fn(err); } catch {}
    }
  }

  handleIncomingLine(line, onReady) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (msg.type === 'ready') {
      if (Number.isInteger(Number(msg.pid)) && Number(msg.pid) > 0) {
        this.helperPid = Number(msg.pid);
      }
      if (isPlainObject(msg.workArea)) {
        this.workArea = msg.workArea;
      }
      onReady(msg);
      return;
    }
    if (msg.type === 'interaction') {
      const event = {
        type: String(msg.eventType || 'pet-click'),
        windowId: String(msg.windowId || ''),
        ...(msg.bubbleId ? { bubbleId: String(msg.bubbleId) } : {}),
        ...(msg.itemId ? { itemId: String(msg.itemId) } : {}),
        ...(isPlainObject(msg.bounds) ? { bounds: msg.bounds } : {})
      };
      for (const fn of Array.from(this.interactionHandlers)) {
        try { fn(event); } catch {}
      }
    }
  }

  cleanupMacSocket() {
    if (this.rl) { try { this.rl.close(); } catch {} this.rl = null; }
    if (this.socketClient) { try { this.socketClient.destroy(); } catch {} this.socketClient = null; }
    if (this.socketServer) { try { this.socketServer.close(); } catch {} this.socketServer = null; }
    if (this.socketPath) {
      try { if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath); } catch {}
      this.socketPath = null;
    }
  }

  async spawnMacAppChild() {
    this.cleanupMacSocket();
    const { exePath } = ensureMacOverlayAppBundle({ stateDir: this.stateDir });
    const rawTmp = os.tmpdir();
    const sockDir = rawTmp.length <= 65 ? rawTmp : '/tmp';
    const socketPath = path.join(sockDir, `agy-ovl-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sock`);
    try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch {}
    this.socketPath = socketPath;

    let readyResolved = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!readyResolved) {
          readyResolved = true;
          reject(new Error(`Timed out waiting for AgyDaddyOverlay socket ready (${socketPath})`));
        }
      }, 10000);
      if (typeof timer.unref === 'function') timer.unref();

      const server = net.createServer((sock) => {
        if (this.socketClient && !this.socketClient.destroyed) {
          try { sock.destroy(); } catch {}
          return;
        }
        this.socketClient = sock;
        const rl = readline.createInterface({ input: sock, crlfDelay: Infinity });
        this.rl = rl;
        rl.on('error', () => {});
        rl.on('line', (line) => {
          this.handleIncomingLine(line, (readyMsg) => {
            if (!readyResolved) {
              readyResolved = true;
              clearTimeout(timer);
              resolve(readyMsg);
            }
          });
        });
        sock.on('error', (err) => {
          if (!readyResolved) {
            readyResolved = true;
            clearTimeout(timer);
            reject(err);
          } else if (!this.stopping) {
            this.emitError(err);
          }
        });
        sock.on('close', () => {
          if (!readyResolved) {
            readyResolved = true;
            clearTimeout(timer);
            reject(new Error('Overlay app socket closed before ready'));
            return;
          }
          if (!this.stopping && this.started) {
            this.scheduleRestart(new Error('Overlay app socket disconnected unexpectedly'));
          }
        });
      });

      this.socketServer = server;
      server.once('error', (err) => {
        if (!readyResolved) {
          readyResolved = true;
          clearTimeout(timer);
          reject(err);
        } else {
          this.emitError(err);
        }
      });

      server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch {}
        const child = this.spawnFn(exePath, [
          '--socket', socketPath,
          '--parent-pid', String(process.pid)
        ], {
          stdio: 'ignore',
          detached: false
        });
        this.child = child;
        child.once('error', (err) => {
          if (!readyResolved) {
            readyResolved = true;
            clearTimeout(timer);
            reject(err);
          }
        });
      });
    });
  }

  resolveHelperInvocation() {
    const backendsDir = path.join(__dirname, 'overlay-backends');
    if (this.platform === 'win32') {
      return {
        cmd: 'powershell.exe',
        args: [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA',
          '-File', path.join(backendsDir, 'win32-overlay.ps1'),
          '-ParentPid', String(process.pid)
        ]
      };
    }
    return {
      cmd: 'python3',
      args: [
        path.join(backendsDir, 'linux-overlay.py'),
        '--parent-pid', String(process.pid)
      ]
    };
  }

  async spawnStdioChild() {
    const spec = this.resolveHelperInvocation();
    const child = this.spawnFn(spec.cmd, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    this.helperPid = child.pid || null;

    let readyResolved = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!readyResolved) {
          readyResolved = true;
          reject(new Error(`Timed out waiting for overlay helper (${spec.cmd})`));
        }
      }, 10000);
      if (typeof timer.unref === 'function') timer.unref();

      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      this.rl = rl;
      rl.on('error', () => {});
      rl.on('line', (line) => {
        this.handleIncomingLine(line, (readyMsg) => {
          if (!readyResolved) {
            readyResolved = true;
            clearTimeout(timer);
            resolve(readyMsg);
          }
        });
      });

      child.once('error', (err) => {
        if (!readyResolved) {
          readyResolved = true;
          clearTimeout(timer);
          reject(err);
        } else if (!this.stopping) {
          this.scheduleRestart(err);
        }
      });

      child.once('exit', (code, signal) => {
        if (!readyResolved) {
          readyResolved = true;
          clearTimeout(timer);
          reject(new Error(`Overlay helper exited early (code=${code}, signal=${signal})`));
        } else if (!this.stopping && this.started) {
          this.scheduleRestart(new Error(`Overlay helper exited unexpectedly (code=${code}, signal=${signal})`));
        }
      });
    });
  }

  scheduleRestart(err) {
    this.emitError(err);
    if (this.stopping || !this.started || this.restartTimer) return;
    const now = Date.now();
    this.crashTimestamps = this.crashTimestamps.filter((ts) => now - ts < 60000);
    this.crashTimestamps.push(now);
    if (this.crashTimestamps.length >= 5) {
      this.emitError(Object.assign(new Error('OVERLAY_CIRCUIT_OPEN: helper crashed 5 times within 60s'), {
        code: 'OVERLAY_CIRCUIT_OPEN'
      }));
      void this.stop();
      return;
    }
    const backoffMs = Math.min(8000, 300 * Math.pow(2, this.crashTimestamps.length - 1));
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (this.stopping || !this.started) return;
      try {
        await this.spawnChild();
        if (this.snapshotProvider) {
          const cmds = this.snapshotProvider();
          for (const cmd of cmds) {
            await this.sendCommand(cmd);
          }
        }
      } catch (spawnErr) {
        this.scheduleRestart(spawnErr);
      }
    }, backoffMs);
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
  }

  async spawnChild() {
    if (this.platform === 'darwin') {
      await this.spawnMacAppChild();
    } else {
      await this.spawnStdioChild();
    }
  }

  async start() {
    if (this.started) return { ok: true, workArea: this.workArea };
    const sup = this.isSupported();
    if (!sup.supported) {
      throw Object.assign(new Error(`OVERLAY_UNSUPPORTED: ${sup.reason || sup.platform}`), {
        code: sup.reason || 'OVERLAY_UNSUPPORTED'
      });
    }
    this.stopping = false;
    this.started = true;
    await this.spawnChild();
    return { ok: true, backend: sup.backend, workArea: this.workArea };
  }

  async sendCommand(cmd) {
    if (!this.started) return false;
    const line = `${JSON.stringify(cmd)}\n`;
    if (this.platform === 'darwin') {
      if (this.socketClient && !this.socketClient.destroyed) {
        this.socketClient.write(line);
        return true;
      }
      return false;
    }
    if (this.child?.stdin && !this.child.stdin.destroyed) {
      this.child.stdin.write(line);
      return true;
    }
    return false;
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      await this.sendCommand({ type: 'quit' });
    } catch {}
    if (this.rl) { try { this.rl.close(); } catch {} this.rl = null; }
    this.cleanupMacSocket();
    if (this.child) {
      const c = this.child;
      this.child = null;
      try { c.kill('SIGTERM'); } catch {}
    }
    this.helperPid = null;
  }
}

class OverlayManager {
  constructor(options = {}) {
    this.bus = options.bus || null;
    this.stateDir = options.stateDir || getStateDir(options);
    this.backend = options.backend || new NativeOverlayBackend({
      platform: options.platform,
      env: options.env,
      stateDir: this.stateDir,
      spawnFn: options.spawnFn,
      snapshotProvider: () => this.buildReplayCommands()
    });
    this.minUpdateIntervalMs = Number(options.minUpdateIntervalMs) > 0
      ? Number(options.minUpdateIntervalMs)
      : UPDATE_THROTTLE_MS;
    this.windows = new Map(); // fullId -> windowRecord
    this.throttleTimers = new Map(); // fullId -> timer
    this.lastStateSendAt = new Map(); // fullId -> timestamp
    this.pendingStatePatch = new Map(); // fullId -> runtimeState

    this.backend.onInteraction((event) => this._dispatchInteraction(event));
    this.backend.onError((err) => {
      try {
        this.bus?.emitEvent?.('host', 'overlay:backend-error@1', {
          code: err?.code || 'OVERLAY_BACKEND_ERROR',
          message: err?.message || String(err),
          at: Date.now()
        });
      } catch {}
    });
  }

  isSupported() {
    return this.backend.isSupported();
  }

  buildReplayCommands() {
    const cmds = [];
    for (const rec of this.windows.values()) {
      if (!rec.visible) continue;
      cmds.push({ type: 'upsert-window', windowId: rec.fullId, bounds: rec.bounds, visible: true });
      if (rec.scene) cmds.push({ type: 'set-scene', windowId: rec.fullId, scene: rec.scene });
      if (rec.state) cmds.push({ type: 'update-state', windowId: rec.fullId, state: rec.state });
    }
    return cmds;
  }

  _dispatchInteraction(event) {
    if (!event || !event.windowId) return;
    const rec = this.windows.get(event.windowId);
    if (!rec) return;
    if (event.type === 'position-changed' && isPlainObject(event.bounds)) {
      rec.bounds = clampBounds(event.bounds, rec.bounds, this.backend.workArea || null);
    }
    const payload = { ...event, windowId: rec.id };
    for (const fn of Array.from(rec.handlers)) {
      try { fn(payload); } catch {}
    }
  }

  _requirePermission(pluginId, permissions = []) {
    if (!Array.isArray(permissions) || !permissions.includes(OVERLAY_PERMISSION)) {
      throw Object.assign(
        new Error(`OVERLAY_PERMISSION_DENIED: ${pluginId} lacks ${OVERLAY_PERMISSION}`),
        { code: 'OVERLAY_PERMISSION_DENIED' }
      );
    }
  }

  async _syncBackendLifecycle() {
    let anyVisible = false;
    for (const rec of this.windows.values()) {
      if (rec.visible) {
        anyVisible = true;
        break;
      }
    }
    if (anyVisible && !this.backend.started) {
      await this.backend.start();
    } else if (!anyVisible && this.backend.started) {
      await this.backend.stop();
    }
  }

  listPluginWindows(pluginId) {
    const out = [];
    for (const rec of this.windows.values()) {
      if (rec.pluginId === pluginId) {
        out.push({
          id: rec.id,
          fullId: rec.fullId,
          visible: rec.visible,
          bounds: { ...rec.bounds }
        });
      }
    }
    return out;
  }

  async createWindow(pluginId, def = {}, ctx = {}) {
    this._requirePermission(pluginId, ctx.permissions);
    const localId = String(def.id || '').trim();
    if (!localId) throw new Error('Overlay window id must be a non-empty string');

    const existing = this.listPluginWindows(pluginId);
    if (existing.length >= MAX_WINDOWS_PER_PLUGIN) {
      throw Object.assign(
        new Error(`OVERLAY_WINDOW_LIMIT: ${pluginId} already owns ${existing.length} window (max ${MAX_WINDOWS_PER_PLUGIN})`),
        { code: 'OVERLAY_WINDOW_LIMIT' }
      );
    }

    const fullId = `${pluginId}:${localId}`;
    const bounds = clampBounds(def.bounds || {}, null, this.backend.workArea || null);
    const visible = def.visible === true;
    const rec = {
      id: localId,
      fullId,
      pluginId,
      pluginDir: ctx.pluginDir || null,
      pluginDataDir: ctx.pluginDataDir || path.join(this.stateDir, 'plugin-data', pluginId),
      bounds,
      visible,
      scene: null,
      state: sanitizeRuntimeState({}, {}),
      handlers: new Set()
    };
    this.windows.set(fullId, rec);

    if (visible) {
      await this._syncBackendLifecycle();
      await this.backend.sendCommand({
        type: 'upsert-window',
        windowId: fullId,
        bounds: rec.bounds,
        visible: true
      });
    }

    return {
      id: localId,
      fullId,
      setScene: (scene) => this.setScene(fullId, scene),
      updateState: (patch) => this.updateState(fullId, patch),
      setBounds: (nextBounds) => this.setBounds(fullId, nextBounds),
      setVisible: (nextVisible) => this.setVisible(fullId, nextVisible),
      onInteraction: (fn) => this.onWindowInteraction(fullId, fn),
      dispose: () => this.disposeWindow(fullId)
    };
  }

  onWindowInteraction(fullId, fn) {
    const rec = this.windows.get(fullId);
    if (!rec || typeof fn !== 'function') return () => {};
    rec.handlers.add(fn);
    return () => rec.handlers.delete(fn);
  }

  async setScene(fullId, rawScene) {
    const rec = this.windows.get(fullId);
    if (!rec) throw new Error(`OVERLAY_WINDOW_NOT_FOUND: ${fullId}`);
    const scene = sanitizeSceneSpec(rawScene, {
      pluginDir: rec.pluginDir,
      pluginDataDir: rec.pluginDataDir
    });
    rec.scene = scene;
    if (rec.visible && this.backend.started) {
      await this.backend.sendCommand({ type: 'set-scene', windowId: fullId, scene });
    }
    return true;
  }

  async _flushState(fullId) {
    const timer = this.throttleTimers.get(fullId);
    if (timer) {
      clearTimeout(timer);
      this.throttleTimers.delete(fullId);
    }
    const rec = this.windows.get(fullId);
    const pending = this.pendingStatePatch.get(fullId);
    this.pendingStatePatch.delete(fullId);
    if (!rec || !pending) return false;
    rec.state = pending;
    this.lastStateSendAt.set(fullId, Date.now());
    if (rec.visible && this.backend.started) {
      await this.backend.sendCommand({ type: 'update-state', windowId: fullId, state: rec.state });
    }
    return true;
  }

  async updateState(fullId, patch = {}) {
    const rec = this.windows.get(fullId);
    if (!rec) throw new Error(`OVERLAY_WINDOW_NOT_FOUND: ${fullId}`);
    const baseState = this.pendingStatePatch.get(fullId) || rec.state;
    const nextState = sanitizeRuntimeState(patch, baseState);
    this.pendingStatePatch.set(fullId, nextState);

    const immediate = nextState.animState === 'approval' || nextState.bubble?.kind === 'approval';
    const lastSent = this.lastStateSendAt.get(fullId) || 0;
    const elapsed = Date.now() - lastSent;
    if (immediate || elapsed >= this.minUpdateIntervalMs) {
      await this._flushState(fullId);
      return true;
    }

    if (!this.throttleTimers.has(fullId)) {
      const waitMs = Math.max(10, this.minUpdateIntervalMs - elapsed);
      const timer = setTimeout(() => {
        void this._flushState(fullId);
      }, waitMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.throttleTimers.set(fullId, timer);
    }
    return true;
  }

  async setBounds(fullId, nextBounds = {}) {
    const rec = this.windows.get(fullId);
    if (!rec) throw new Error(`OVERLAY_WINDOW_NOT_FOUND: ${fullId}`);
    rec.bounds = clampBounds(nextBounds, rec.bounds, this.backend.workArea || null);
    if (rec.visible && this.backend.started) {
      await this.backend.sendCommand({
        type: 'upsert-window',
        windowId: fullId,
        bounds: rec.bounds,
        visible: true
      });
    }
    return true;
  }

  async setVisible(fullId, visible) {
    const rec = this.windows.get(fullId);
    if (!rec) throw new Error(`OVERLAY_WINDOW_NOT_FOUND: ${fullId}`);
    const next = Boolean(visible);
    if (rec.visible === next) return true;
    rec.visible = next;
    await this._syncBackendLifecycle();
    if (next && this.backend.started) {
      rec.bounds = clampBounds(rec.bounds, rec.bounds, this.backend.workArea || null);
      await this.backend.sendCommand({ type: 'upsert-window', windowId: fullId, bounds: rec.bounds, visible: true });
      if (rec.scene) await this.backend.sendCommand({ type: 'set-scene', windowId: fullId, scene: rec.scene });
      await this._flushState(fullId);
      if (rec.state) await this.backend.sendCommand({ type: 'update-state', windowId: fullId, state: rec.state });
    } else if (!next && this.backend.started) {
      await this.backend.sendCommand({ type: 'remove-window', windowId: fullId });
    }
    return true;
  }

  async disposeWindow(fullId) {
    const rec = this.windows.get(fullId);
    if (!rec) return false;
    const timer = this.throttleTimers.get(fullId);
    if (timer) {
      clearTimeout(timer);
      this.throttleTimers.delete(fullId);
    }
    this.pendingStatePatch.delete(fullId);
    this.lastStateSendAt.delete(fullId);
    rec.handlers.clear();
    this.windows.delete(fullId);
    if (this.backend.started) {
      try { await this.backend.sendCommand({ type: 'remove-window', windowId: fullId }); } catch {}
    }
    await this._syncBackendLifecycle();
    return true;
  }

  async disposePluginWindows(pluginId) {
    const ids = this.listPluginWindows(pluginId).map((w) => w.fullId);
    for (const fullId of ids) {
      await this.disposeWindow(fullId);
    }
    return ids.length;
  }

  createScopedApi(pluginId, ctx = {}) {
    return {
      isSupported: async () => this.isSupported(),
      createWindow: (def) => this.createWindow(pluginId, def, ctx),
      listWindows: () => this.listPluginWindows(pluginId),
      disposeAll: async () => {
        await this.disposePluginWindows(pluginId);
        return true;
      }
    };
  }

  async dispose() {
    for (const timer of this.throttleTimers.values()) {
      clearTimeout(timer);
    }
    this.throttleTimers.clear();
    this.pendingStatePatch.clear();
    this.lastStateSendAt.clear();
    for (const rec of this.windows.values()) {
      rec.handlers.clear();
    }
    this.windows.clear();
    await this.backend.stop();
  }
}

module.exports = {
  OVERLAY_PERMISSION,
  MAX_WINDOWS_PER_PLUGIN,
  inspectRasterHeader,
  resolveConfinedSpritePath,
  clampBounds,
  sanitizeSceneSpec,
  sanitizeRuntimeState,
  MemoryOverlayBackend,
  NativeOverlayBackend,
  ensureMacOverlayAppBundle,
  OverlayManager
};
