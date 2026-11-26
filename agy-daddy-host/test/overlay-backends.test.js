'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { NativeOverlayBackend } = require('../src/core/overlay-manager');

const BACKENDS_DIR = path.resolve(__dirname, '..', 'src', 'core', 'overlay-backends');

test('三端原生透明置顶窗后端文件存在且契约字段完备', () => {
  const macFile = path.join(BACKENDS_DIR, 'macos-overlay.swift');
  const winFile = path.join(BACKENDS_DIR, 'win32-overlay.ps1');
  const linFile = path.join(BACKENDS_DIR, 'linux-overlay.py');

  assert.equal(fs.existsSync(macFile), true);
  assert.equal(fs.existsSync(winFile), true);
  assert.equal(fs.existsSync(linFile), true);

  const macSrc = fs.readFileSync(macFile, 'utf8');
  assert.match(macSrc, /NSPanel/);
  assert.match(macSrc, /nonactivatingPanel/);
  assert.match(macSrc, /canBecomeKey:\s*Bool\s*\{\s*false\s*\}/);
  assert.match(macSrc, /hitTest\(_ point: NSPoint\)/);
  assert.match(macSrc, /Darwin\.kill\(self\.parentPid, 0\)/);

  const winSrc = fs.readFileSync(winFile, 'utf8');
  assert.match(winSrc, /AllowsTransparency\s*=\s*\$true/);
  assert.match(winSrc, /WS_EX_NOACTIVATE/);
  assert.match(winSrc, /WM_NCHITTEST/);
  assert.match(winSrc, /HTTRANSPARENT/);
  assert.match(winSrc, /StreamGeometry/);

  const linSrc = fs.readFileSync(linFile, 'utf8');
  assert.match(linSrc, /get_rgba_visual/);
  assert.match(linSrc, /set_accept_focus\(False\)/);
  assert.match(linSrc, /input_shape_combine_region/);
  assert.match(linSrc, /sys\.exit\(2\)/);
});

test('darwin swiftc -typecheck 与 python3 -B -m py_compile 语法检查通过', () => {
  if (process.platform === 'darwin') {
    const swiftRes = spawnSync('swiftc', ['-typecheck', path.join(BACKENDS_DIR, 'macos-overlay.swift')], {
      encoding: 'utf8',
      timeout: 30000
    });
    assert.equal(swiftRes.status, 0, `swiftc -typecheck failed:\n${swiftRes.stderr}`);
  }

  const pyCheck = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (pyCheck.status === 0) {
    const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pycache-'));
    try {
      const pyRes = spawnSync(
        'python3',
        ['-B', '-m', 'py_compile', path.join(BACKENDS_DIR, 'linux-overlay.py')],
        {
          encoding: 'utf8',
          env: { ...process.env, PYTHONPYCACHEPREFIX: tmpCache }
        }
      );
      assert.equal(pyRes.status, 0, `py_compile failed:\n${pyRes.stderr}`);
    } finally {
      fs.rmSync(tmpCache, { recursive: true, force: true });
    }
  }
});

test('Linux 无 DISPLAY 时 isSupported 优雅降级为 DISPLAY_UNAVAILABLE', () => {
  const b = new NativeOverlayBackend({ platform: 'linux', env: {} });
  const sup = b.isSupported();
  assert.equal(sup.supported, false);
  assert.equal(sup.backend, 'none');
  assert.equal(sup.reason, 'DISPLAY_UNAVAILABLE');
});
