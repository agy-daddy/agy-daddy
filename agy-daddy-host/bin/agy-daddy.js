#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function isCurrentRuntimeCompatible() {
  const parts = String(process.versions && process.versions.node ? process.versions.node : '0.0.0').split('.');
  const maj = Number(parts[0] || 0);
  const min = Number(parts[1] || 0);
  if (maj < 22 || (maj === 22 && min < 4)) return false;
  if (typeof globalThis.WebSocket !== 'function') return false;
  if (typeof globalThis.fetch !== 'function') return false;
  return true;
}

if (isCurrentRuntimeCompatible()) {
  const cli = require('../src/cli');
  cli.main(process.argv.slice(2)).catch((err) => {
    console.error('❌ 执行失败:', err && err.message ? err.message : String(err));
    process.exitCode = 1;
  });
} else {
  if (process.env.AGY_DADDY_REEXEC === '1') {
    console.error(
      '❌ 当前 Node.js 版本不满足要求 (>= 22.4.0，需内置 WebSocket 与 fetch)，且未找到可用的备用运行时。\n' +
      '   请安装 Node.js >= 22.4.0，设置 AGY_DADDY_NODE，或先安装 Google Antigravity Desktop。'
    );
    process.exit(1);
  }

  let resolveRuntime;
  try {
    ({ resolveRuntime } = require('../src/core/runtime-resolver'));
  } catch (err) {
    console.error('❌ 无法加载运行时探测器:', err && err.message ? err.message : String(err));
    process.exit(1);
  }

  const resolved = resolveRuntime();
  if (!resolved || !resolved.ok || !resolved.runtime) {
    console.error(
      '❌ 未找到可用的 Node.js (>= 22.4.0) 或 Antigravity Electron Helper 运行时。\n' +
      '   请安装 Node.js >= 22.4.0，设置环境变量 AGY_DADDY_NODE，或先安装 Google Antigravity Desktop。'
    );
    process.exit(1);
  }

  const childEnv = Object.assign({}, process.env, resolved.envPatch || {}, {
    AGY_DADDY_REEXEC: '1'
  });
  if (!resolved.isElectron) {
    delete childEnv.ELECTRON_RUN_AS_NODE;
  }

  const cliPath = path.resolve(__dirname, '..', 'src', 'cli.js');
  const res = spawnSync(resolved.runtime, [cliPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: childEnv
  });
  if (res.error) {
    console.error('❌ 启动运行时失败:', res.error.message || String(res.error));
    process.exit(1);
  }
  process.exit(typeof res.status === 'number' ? res.status : 1);
}
