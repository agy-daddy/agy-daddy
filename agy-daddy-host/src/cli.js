#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync, spawn } = require('child_process');
const HOST_PKG_VERSION = require('../package.json').version;
const { getStateDir, isTestMode } = require('./core/paths');
const { resolveActiveCdpTarget, inspectAntigravityHostProcess } = require('./core/cdp');
const { safeReadJsonSync, safeWriteJsonSync } = require('./core/storage');
const { runDoctor, exportDiagnosticBundle } = require('./core/doctor');
const {
  installPlugin,
  installOfficialPlugins,
  linkPlugin,
  enablePlugin,
  disablePlugin,
  rollbackPlugin,
  updatePluginNativeConfig,
  rollbackPluginNativeRules,
  inspectPluginNativeStatus,
  readInstalledIndex,
  readManifestFromDir,
  uninstallPlugin,
  listInstalledPlugins
} = require('./core/installer');
const { AgyDaddyDaemon, isPidAlive } = require('./core/daemon');
const {
  installAutoStart,
  removeAutoStart,
  installMacLauncherApp,
  installLauncherApp,
  isolateResidentEnv,
  planAntigravityRestart,
  relaunchAntigravityWithCdp,
  checkAndPullGitUpdate
} = require('./core/lifecycle');
const { createLiveWatchdog } = require('./core/live-watchdog');
const { createLauncherController, readLauncherLock } = require('./core/launcher');
const { auditUpstreamsAndBaselines } = require('./core/upstreams');

const BOOLEAN_FLAGS = new Set([
  'json', 'dry-run', 'force', 'yes', 'y', 'help', 'copy', 'once', 'skip-inject', 'skip-cdp', 'reset-token', 'no-open', 'no-auto-relaunch', 'replace', 'rollback-rules', 'no-native', 'tray', 'launch-app', 'dock-icon', 'no-takeover', 'official'
]);

function openBrowserUrl(url) {
  try {
    const spec = process.platform === 'darwin'
      ? { bin: 'open', args: [url] }
      : (process.platform === 'win32'
        ? { bin: 'cmd', args: ['/c', 'start', '', url], windowsHide: true }
        : { bin: 'xdg-open', args: [url] });
    const child = spawn(spec.bin, spec.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: Boolean(spec.windowsHide)
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--') && !BOOLEAN_FLAGS.has(key)) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (a === '-h') {
      flags.help = true;
    } else if (a === '-y') {
      flags.yes = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function promptConfirm(questionText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr
    });
    rl.question(questionText, (answer) => {
      rl.close();
      const norm = String(answer || '').trim().toLowerCase();
      resolve(norm === 'y' || norm === 'yes');
    });
  });
}

function parseBoolFlagValue(raw) {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  throw new Error(`Invalid boolean flag value: ${String(raw)}`);
}

function stopProcessByPid(pid, timeoutMs = 2500) {
  if (!pid || !isPidAlive(pid)) {
    return { ok: true, stopped: false, reason: 'not running' };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  const waitBuf = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid) && Date.now() < deadline) {
    Atomics.wait(waitBuf, 0, 0, 50);
  }
  const exited = !isPidAlive(pid);
  return { ok: true, stopped: true, pid, exited };
}

function stopRunningDaemon(stateDir = getStateDir()) {
  const lockPath = path.join(stateDir, 'daemon.lock');
  const lock = safeReadJsonSync(lockPath, null, { quarantineCorrupt: false }).data;
  const pid = Number(lock?.pid);
  return stopProcessByPid(pid, 2000);
}

async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseFlags(argv);
  const cmd = (positional[0] || (flags.help ? 'help' : 'status')).toLowerCase();

  if (cmd === 'doctor') {
    if (flags.bundle) {
      const outPath = typeof flags.bundle === 'string' ? path.resolve(flags.bundle) : path.resolve(process.cwd(), 'agy-daddy-diagnostic-bundle.json');
      const res = await exportDiagnosticBundle(outPath);
      if (flags.json) console.log(JSON.stringify(res, null, 2));
      else console.log(`✅ 已导出脱敏诊断包: ${outPath}`);
      return;
    }
    const report = await runDoctor({ skipCdp: Boolean(flags['skip-cdp']) });
    const { daemon, antigravity, cdp, injection, plugins, fault } = report.hostHealth;
    if (flags.json) {
      console.log(JSON.stringify(report.hostHealth, null, 2));
    } else {
      console.log(`Agy-Daddy Host v${report.hostApiVersion}`);
      console.log(`- 运行时: ${report.runtime.ok ? `${report.runtime.runtime} (${report.runtime.source}, Node ${report.runtime.nodeVersion})` : '❌ 未找到可用运行时'}`);
      console.log(`- Daemon: PID ${daemon.pid ?? '—'}, Bridge ${daemon.bridgePort ?? '—'}, 已运行 ${daemon.uptimeMs} ms, 会话变量 ${daemon.inheritedSessionVars.join(', ') || '无'}, 污染 ${daemon.hasSessionEnvPollution ? '是' : '否'}`);
      console.log(`- Antigravity: ${antigravity.version ?? '未知版本'}, PID ${antigravity.pid ?? '—'}, 调试参数 ${antigravity.hasDebugSwitch ? '有' : '无'}, 上次注入 ${antigravity.lastInjectedVersion ?? '—'}`);
      if (antigravity.lastRelaunch.status) console.log(`  补参 ${antigravity.lastRelaunch.status} ${antigravity.lastRelaunch.reason || ''}`);
      for (const event of antigravity.upgradeEvents) {
        console.log(`  ${event.at} ${event.fromVersion} → ${event.toVersion} (PID ${event.pid}) ${event.outcome} ${event.reason || ''}`);
      }
      console.log(`- CDP: 端口 ${cdp.port ?? '—'}, 已探测 ${cdp.portsTried.join(', ') || '无'}, 可达 ${cdp.reachable ? '是' : '否'}, 匹配 ${cdp.targets.matched.length}，过滤 ${cdp.targets.filtered.length}`);
      for (const target of [...cdp.targets.matched, ...cdp.targets.filtered]) {
        console.log(`  ${target.url ?? '—'}${target.filterReason ? ` [${target.filterReason}]` : ''}`);
      }
      console.log(`- 注入: ${injection.injectedCount} 个窗口, 探活 ${injection.probeSource}, 锚点 ${injection.anchors.healthyCount}/${injection.anchors.total}`);
      if (injection.lastInjectError) console.log(`  ${injection.lastInjectError}`);
      for (const anchor of injection.anchors.items) {
        console.log(`  ${anchor.name} ${anchor.matchedSelector || 'MISSING'}${anchor.affectedPlugins.length ? ` (${anchor.affectedPlugins.join(', ')})` : ''}`);
      }
      console.log(`- 插件: ${plugins.length} 个`);
      for (const plugin of plugins) {
        console.log(`  ${plugin.name} (${plugin.id}) ${plugin.nodeState}, 渲染 ${plugin.rendererMounted ? '已挂载' : '未挂载'}`);
        if (plugin.lastErrorStack || plugin.lastError) console.log(`  ${plugin.lastErrorStack || plugin.lastError}`);
      }
      if (fault.active) console.log(`- 故障: ${fault.code} — ${fault.reason} (${fault.durationMs} ms)`);
    }
    return;
  }

  if (cmd === 'status') {
    const report = await runDoctor({ skipCdp: Boolean(flags['skip-cdp']) });
    console.log(JSON.stringify({
      ok: true,
      hostApiVersion: report.hostApiVersion,
      runtime: {
        source: report.runtime.source,
        nodeVersion: report.runtime.nodeVersion,
        isElectron: report.runtime.isElectron
      },
      daemon: report.daemon,
      antigravity: report.antigravity,
      plugins: report.plugins
    }, null, 2));
    return;
  }

  if (cmd === 'stop') {
    const res = stopRunningDaemon();
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'restart') {
    const plan = planAntigravityRestart({ allowSelfTerminate: Boolean(flags.force) });
    if (flags['dry-run'] || isTestMode()) {
      console.log(JSON.stringify({ ...plan, dryRun: Boolean(flags['dry-run']) }, null, 2));
      if (!plan.ok) process.exitCode = 1;
      return;
    }
    if (!plan.ok) {
      console.log(JSON.stringify(plan, null, 2));
      process.exitCode = 1;
      return;
    }
    const res = await relaunchAntigravityWithCdp({ allowSelfTerminate: Boolean(flags.force) });
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.ok) {
      console.log(`✅ 已带调试端口重启 Antigravity (CDP :${res.port || '?'}, 目标 ${res.targetsCount || 0} 个)`);
    } else {
      console.error(`❌ 重启失败 (${res.reason || 'UNKNOWN'}): ${res.message || res.error || ''}`);
    }
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'auto-on') {
    const res = installAutoStart({
      dryRun: Boolean(flags['dry-run']),
      targetDir: typeof flags.dir === 'string' ? flags.dir : undefined
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'auto-off') {
    const stopped = flags['dry-run'] ? { stopped: false, dryRun: true } : stopRunningDaemon();
    const removed = removeAutoStart({
      dryRun: Boolean(flags['dry-run']),
      targetDir: typeof flags.dir === 'string' ? flags.dir : undefined
    });
    console.log(JSON.stringify({ ok: true, daemon: stopped, autostart: removed }, null, 2));
    return;
  }

  if (cmd === 'install-launcher') {
    const res = installLauncherApp({
      dryRun: Boolean(flags['dry-run']),
      targetDir: typeof flags.dir === 'string' ? flags.dir : undefined,
      platform: typeof flags.platform === 'string' ? flags.platform : undefined,
      dockIcon: Boolean(flags['dock-icon']),
      launchApp: Boolean(flags['launch-app'])
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'launcher') {
    isolateResidentEnv();
    const stateDir = getStateDir();
    if (!flags.once) {
      const existingLauncher = readLauncherLock(stateDir);
      if (existingLauncher.running && existingLauncher.pid && existingLauncher.pid !== process.pid) {
        if (!flags.replace) {
          const info = {
            ok: true,
            alreadyRunning: true,
            hasTray: true,
            pid: existingLauncher.pid,
            port: existingLauncher.lock?.port || null
          };
          if (flags.json) {
            console.log(JSON.stringify(info, null, 2));
          } else {
            console.log(`✅ Agy-Daddy Launcher 已在通知栏运行中 (PID ${info.pid})`);
          }
          return;
        }
        const stopLauncherRes = stopProcessByPid(existingLauncher.pid, 2500);
        if (stopLauncherRes.stopped && !stopLauncherRes.exited) {
          throw new Error(`停止旧 Agy-Daddy Launcher (PID ${stopLauncherRes.pid}) 超时，请先退出后再试`);
        }
      }
    }

    if (flags.replace || (!flags['no-takeover'] && !flags.once)) {
      const daemonLockPath = path.join(stateDir, 'daemon.lock');
      const daemonLock = safeReadJsonSync(daemonLockPath, null, { quarantineCorrupt: false }).data;
      const daemonPid = Number(daemonLock?.pid);
      if (daemonPid && daemonPid !== process.pid && isPidAlive(daemonPid)) {
        if (!flags.json && !flags.replace) {
          console.log(`🔄 检测到后台无托盘守护进程 (PID ${daemonPid})，正在平滑接管至 Agy-Daddy Launcher 托盘模式...`);
        }
        const stopRes = stopRunningDaemon(stateDir);
        if (stopRes.stopped && !stopRes.exited) {
          throw new Error(`停止旧守护进程 (PID ${stopRes.pid}) 超时，请先手动停止后再试`);
        }
      }
    }

    const controller = createLauncherController({
      stateDir,
      skipInject: Boolean(flags['skip-inject']),
      autoRelaunch: !flags['no-auto-relaunch'],
      launchAppOnStart: Boolean(flags['launch-app']),
      silent: Boolean(flags.json),
      json: Boolean(flags.json),
      headless: Boolean(flags.once || isTestMode()),
      exitProcess: !flags.once && !isTestMode()
    });
    const summary = await controller.start();
    if (flags.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`✅ Agy-Daddy Launcher 已启动 (Bridge :${summary.port}, 插件 ${summary.activePlugins.length} 个, 托盘菜单项 ${summary.trayItems} 个)`);
    }
    if (flags.once) {
      await controller.stop();
      return;
    }
    const shutdown = async () => {
      await controller.quit();
    };
    process.on('SIGTERM', () => { void shutdown(); });
    process.on('SIGINT', () => { void shutdown(); });
    return;
  }

  if (cmd === 'remote') {
    const crypto = require('crypto');
    const cfgPath = path.join(getStateDir(), 'plugins-data', 'agy-daddy.remote', 'remote-config.json');
    const cfg = safeReadJsonSync(cfgPath, {
      port: 18765,
      allowRemoteWrite: false,
      channels: { loopback: true, lan: false, tailscale: false, bonjour: false, cloudflare: false }
    }).data || {};
    if (flags['reset-token']) {
      cfg.token = crypto.randomBytes(24).toString('hex');
      cfg.updatedAt = new Date().toISOString();
      safeWriteJsonSync(cfgPath, cfg);
    }
    const localUrl = `http://127.0.0.1:${cfg.port || 18765}/${cfg.token ? `?t=${cfg.token}` : ''}`;
    console.log(JSON.stringify({
      ok: true,
      url: localUrl,
      allowRemoteWrite: cfg.allowRemoteWrite === true,
      channels: cfg.channels || {},
      tokenRotated: Boolean(flags['reset-token'])
    }, null, 2));
    return;
  }

  if (cmd === 'web') {
    const crypto = require('crypto');
    const cfgPath = path.join(getStateDir(), 'plugins-data', 'agy-daddy.web', 'web-config.json');
    const existed = fs.existsSync(cfgPath);
    const cfg = safeReadJsonSync(cfgPath, {}, { quarantineCorrupt: false }).data || {};
    const tokenRotated = Boolean(flags['reset-token']);
    let dirty = !existed;

    if (tokenRotated || typeof cfg.token !== 'string' || !cfg.token.trim()) {
      cfg.token = crypto.randomBytes(24).toString('hex');
      dirty = true;
    }

    let port = Number.isInteger(cfg.port) && cfg.port >= 1 && cfg.port <= 65535 ? cfg.port : 18767;
    if (flags.port !== undefined) {
      if (flags.port === true || !/^\d+$/.test(String(flags.port).trim())) {
        throw new Error(`Invalid port: ${String(flags.port)}`);
      }
      const parsedPort = Number(flags.port);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error(`Port out of range (1-65535): ${parsedPort}`);
      }
      if (cfg.port !== parsedPort) {
        dirty = true;
      }
      port = parsedPort;
    }

    if (cfg.port !== port) {
      cfg.port = port;
      dirty = true;
    }
    if (dirty) {
      cfg.updatedAt = new Date().toISOString();
      safeWriteJsonSync(cfgPath, cfg);
    }

    const url = `http://127.0.0.1:${port}/?token=${cfg.token}`;
    const shouldOpen = !flags['no-open'] && !isTestMode();
    const opened = shouldOpen ? openBrowserUrl(url) : false;

    console.log(JSON.stringify({
      ok: true,
      url,
      port,
      opened,
      tokenRotated,
      configPath: cfgPath
    }, null, 2));
    return;
  }

  if (cmd === 'update') {
    const repoDir = typeof flags.repo === 'string' ? flags.repo : path.resolve(__dirname, '..');
    const res = checkAndPullGitUpdate(repoDir, { dryRun: Boolean(flags['dry-run']) });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'upstreams') {
    const report = auditUpstreamsAndBaselines({
      hostRoot: path.resolve(__dirname, '..'),
      workspaceRoot: typeof flags.workspace === 'string' ? flags.workspace : undefined
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === 'run') {
    const commandId = positional[1];
    if (!commandId) throw new Error('Usage: agy-daddy run <commandId>');
    const installed = listInstalledPlugins();
    let matched = null;
    for (const p of installed) {
      const mPath = path.join(p.installPath, 'agy-plugin.json');
      if (!fs.existsSync(mPath)) continue;
      try {
        const man = JSON.parse(fs.readFileSync(mPath, 'utf8'));
        const cmds = Array.isArray(man?.contributes?.commands) ? man.contributes.commands : [];
        const found = cmds.find((c) => c.id === commandId);
        if (found) {
          matched = { pluginId: p.id, command: found };
          break;
        }
      } catch {}
    }
    if (!matched) {
      console.log(JSON.stringify({ ok: false, error: 'COMMAND_NOT_FOUND', commandId }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: true, commandId, ...matched }, null, 2));
    return;
  }

  if (cmd === 'plugin') {
    const sub = (positional[1] || 'list').toLowerCase();
    const target = positional[2];
    const grantedPermissions = typeof flags.grant === 'string'
      ? flags.grant.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    if (sub === 'list') {
      console.log(JSON.stringify({ ok: true, plugins: listInstalledPlugins() }, null, 2));
      return;
    }
    if (sub === 'audit') {
      const items = listInstalledPlugins().map((p) => {
        let manifest = null;
        try { manifest = JSON.parse(fs.readFileSync(path.join(p.installPath, 'agy-plugin.json'), 'utf8')); } catch {}
        return {
          id: p.id,
          trustLevel: p.trustLevel,
          world: manifest?.world || 'isolated',
          permissions: manifest?.permissions || [],
          native: Boolean(manifest?.contributes?.native)
        };
      });
      console.log(JSON.stringify({ ok: true, count: items.length, audit: items }, null, 2));
      return;
    }
    if (sub === 'install') {
      const registryUrl = typeof flags.registry === 'string' ? flags.registry : undefined;
      if (flags.official || target === '--official' || target === 'official') {
        const res = await installOfficialPlugins({
          tag: typeof flags.tag === 'string' ? flags.tag : undefined,
          npmRegistryUrl: registryUrl,
          copy: Boolean(flags.copy),
          defaultNativeEnabled: flags['no-native'] ? false : undefined
        });
        console.log(JSON.stringify(res, null, 2));
        if (!res.ok) process.exitCode = 1;
        return;
      }
      if (!target) throw new Error('Usage: agy-daddy plugin install <name|github:...|npm:...|local:...> | --official');
      const res = await installPlugin(target, {
        trustLevel: flags.trust,
        grantedPermissions,
        npmRegistryUrl: registryUrl,
        copy: Boolean(flags.copy),
        defaultNativeEnabled: flags['no-native'] ? false : undefined
      });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (sub === 'link') {
      if (!target) throw new Error('Usage: agy-daddy plugin link <localPath>');
      const res = await linkPlugin(target, { trustLevel: flags.trust || 'T2', grantedPermissions });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (sub === 'enable') {
      if (!target) throw new Error('Usage: agy-daddy plugin enable <pluginId>');
      console.log(JSON.stringify({ ok: true, plugin: enablePlugin(target) }, null, 2));
      return;
    }
    if (sub === 'disable') {
      if (!target) throw new Error('Usage: agy-daddy plugin disable <pluginId>');
      console.log(JSON.stringify({ ok: true, plugin: disablePlugin(target) }, null, 2));
      return;
    }
    if (sub === 'rollback') {
      if (!target) throw new Error('Usage: agy-daddy plugin rollback <pluginId>');
      console.log(JSON.stringify(rollbackPlugin(target), null, 2));
      return;
    }
    if (sub === 'native') {
      if (!target) throw new Error('Usage: agy-daddy plugin native <pluginId> [--rules=true|false] [--skills=...] [--mcp=...] [--hooks=...] [--rollback-rules]');
      if (flags['rollback-rules']) {
        const rbRes = rollbackPluginNativeRules(target, {
          backupId: typeof flags.backup === 'string' ? flags.backup : undefined
        });
        console.log(JSON.stringify(rbRes, null, 2));
        if (!rbRes.ok) process.exitCode = 1;
        return;
      }
      const patch = {};
      for (const kind of ['rules', 'skills', 'mcp', 'hooks']) {
        if (flags[kind] !== undefined) {
          patch[kind] = parseBoolFlagValue(flags[kind]);
        }
      }
      if (Object.keys(patch).length > 0) {
        const updRes = updatePluginNativeConfig(target, patch);
        console.log(JSON.stringify(updRes, null, 2));
        if (!updRes.ok) process.exitCode = 1;
        return;
      }
      const idx = readInstalledIndex();
      const rec = idx.plugins?.[target];
      if (!rec) throw new Error(`Plugin not installed: ${target}`);
      let manifest = null;
      if (rec.installPath && fs.existsSync(rec.installPath)) {
        try { manifest = readManifestFromDir(rec.installPath); } catch {}
      }
      const status = inspectPluginNativeStatus(target, manifest, {
        pluginDir: rec.installPath,
        nativeConfig: rec.nativeConfig
      });
      console.log(JSON.stringify({ ok: true, id: target, nativeInfo: status }, null, 2));
      return;
    }
    if (sub === 'uninstall') {
      if (!target) throw new Error('Usage: agy-daddy plugin uninstall <pluginId> [--yes]');
      const confirmed = Boolean(flags.yes || flags.y || flags.force);
      const res = uninstallPlugin(target, {
        requireNativeConfirm: true,
        confirmNativeDelete: confirmed
      });
      if (res.needsNativeUninstallConfirm) {
        if (process.stdin.isTTY && process.stdout.isTTY) {
          const info = res.nativeInfo || {};
          console.error(`⚠️ 插件 ${target} 包含原生扩展，卸载将同步删除：${info.targetDir}`);
          if (info.declared) {
            const parts = [];
            if (info.declared.rules?.length) parts.push(`Rules(${info.declared.rules.join(', ')})`);
            if (info.declared.skills?.length) parts.push(`Skills(${info.declared.skills.join(', ')})`);
            if (info.declared.mcp?.length) parts.push(`MCP(${info.declared.mcp.join(', ')})`);
            if (info.declared.hooks?.length) parts.push(`Hooks(${info.declared.hooks.join(', ')})`);
            if (parts.length) console.error(`   包含原生项：${parts.join(' · ')}`);
          }
          const agreed = await promptConfirm(`确认删除上述原生扩展并卸载 ${target}? [y/N] `);
          if (!agreed) {
            console.log(JSON.stringify({ ok: false, cancelled: true, id: target }, null, 2));
            process.exitCode = 1;
            return;
          }
          console.log(JSON.stringify(uninstallPlugin(target, { confirmNativeDelete: true }), null, 2));
          return;
        }
        console.log(JSON.stringify({
          ...res,
          hint: 'Re-run with --yes to confirm deleting native extension artifacts.'
        }, null, 2));
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    throw new Error(`Unknown plugin subcommand: ${sub}`);
  }

  if (cmd === 'live') {
    if (!flags.once) isolateResidentEnv();
    let watchdog = null;
    const daemon = new AgyDaddyDaemon({
      onRestartDaemon: async () => {
        if (watchdog) {
          watchdog.stop();
          watchdog = null;
        }
        if (process.env.AGY_DADDY_LAUNCHD === '1') {
          await daemon.stop().catch(() => {});
          process.exit(75);
        }
        const args = [
          __filename,
          'live',
          '--replace',
          ...(flags['no-auto-relaunch'] ? ['--no-auto-relaunch'] : [])
        ];
        const child = spawn(process.execPath, args, {
          detached: true,
          stdio: 'ignore',
          env: isolateResidentEnv({ ...process.env })
        });
        child.unref();
      }
    });
    if (flags.replace) {
      const stopRes = stopRunningDaemon(daemon.stateDir);
      if (stopRes.stopped && !stopRes.exited) {
        throw new Error(`停止旧守护进程 (PID ${stopRes.pid}) 超时，请先手动停止后再试`);
      }
    }
    let started;
    try {
      started = await daemon.start();
    } catch (err) {
      if (err?.code === 'DAEMON_ALREADY_RUNNING') {
        if (process.env.AGY_DADDY_LAUNCHD === '1') {
          return;
        }
        const liveSession = safeReadJsonSync(
          path.join(daemon.stateDir, '.live-session.json'),
          null,
          { quarantineCorrupt: false }
        ).data;
        const samePid = liveSession && Number(liveSession.pid) === Number(err.existingPid);
        const port = samePid && liveSession.port ? Number(liveSession.port) : null;
        const activePlugins = samePid && Array.isArray(liveSession.activePlugins) ? liveSession.activePlugins : [];
        const cdp = (flags['skip-cdp'] || isTestMode())
          ? { port: null, targets: [] }
          : await resolveActiveCdpTarget({ timeoutMs: 1200 }).catch(() => ({ port: null, targets: [] }));
        const hostProc = inspectAntigravityHostProcess();
        const cdpTargetsCount = Array.isArray(cdp?.targets) ? cdp.targets.length : 0;
        const info = {
          ok: true,
          alreadyRunning: true,
          pid: err.existingPid,
          port,
          activePlugins,
          antigravity: {
            hostProcess: hostProc,
            cdpPort: cdp?.port || null,
            cdpTargetsCount
          }
        };
        if (flags.json) {
          console.log(JSON.stringify(info, null, 2));
        } else {
          console.log(`✅ Agy-Daddy Live 已在后台运行中 (PID ${info.pid}${info.port ? `, Bridge :${info.port}` : ''}, 插件 ${info.activePlugins.length} 个, CDP 窗口 ${cdpTargetsCount} 个)`);
          if (cdpTargetsCount === 0 && hostProc.running && !hostProc.hasDebugSwitch) {
            const quitHint = process.platform === 'darwin'
              ? '请按 ⌘Q 退出并重开 Antigravity'
              : '请关闭并重开 Antigravity';
            console.log(`⚠️ 检测到运行中的 Antigravity (PID ${hostProc.pid}) 未开启 CDP 调试端口；${quitHint}（后台 Live 将自动补参注入），或在外部终端运行 agy-daddy restart。`);
          }
          console.log('💡 如需在前台重启并查看实时日志，可运行: agy-daddy live --replace');
        }
        return;
      }
      throw err;
    }
    let inject = { ok: true, skipped: true, targetsInjected: 0, pluginsInjected: 0, errors: [] };
    if (!flags['skip-inject']) {
      inject = await daemon.injectActiveTargets();
    }
    const summary = {
      ok: true,
      port: started.port,
      activePlugins: Array.from(daemon.activePlugins.keys()),
      activationErrors: started.activationErrors || [],
      inject,
      once: Boolean(flags.once)
    };
    if (flags.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`✅ Agy-Daddy Live 已就绪 (Bridge :${started.port}, 插件 ${summary.activePlugins.length} 个, 目标注入 ${inject.targetsInjected || 0} 个)`);
    }
    if (flags.once) {
      await daemon.stop();
      return;
    }
    if (!isTestMode()) {
      watchdog = createLiveWatchdog(daemon, {
        autoRelaunch: !flags['no-auto-relaunch'],
        silent: Boolean(flags.json)
      });
      watchdog.start();
      if ((inject.targetsInjected || 0) === 0) {
        await watchdog.tick();
      }
    }
    const shutdown = async () => {
      if (watchdog) {
        watchdog.stop();
        watchdog = null;
      }
      await daemon.stop();
      process.exit(0);
    };
    process.on('SIGTERM', () => { void shutdown(); });
    process.on('SIGINT', () => { void shutdown(); });
    return;
  }

  if (cmd === 'daemon') {
    const sub = (positional[1] || 'status').toLowerCase();
    const lockPath = path.join(getStateDir(), 'daemon.lock');
    if (sub === 'status') {
      const lock = safeReadJsonSync(lockPath, null, { quarantineCorrupt: false }).data;
      const alive = Boolean(lock?.pid && isPidAlive(Number(lock.pid)));
      console.log(JSON.stringify({ ok: true, running: alive, lock }, null, 2));
      return;
    }
    if (sub === 'stop') {
      console.log(JSON.stringify(stopRunningDaemon(), null, 2));
      return;
    }
    if (sub === 'start') {
      isolateResidentEnv();
      let watchdog = null;
      const daemon = new AgyDaddyDaemon({
        onRestartDaemon: async () => {
          watchdog?.stop();
          await daemon.stop().catch(() => {});
          const child = spawn(process.execPath, [__filename, 'daemon', 'start'], {
            detached: true,
            stdio: 'ignore',
            env: isolateResidentEnv({ ...process.env })
          });
          child.unref();
          process.exit(0);
        }
      });
      const info = await daemon.start();
      if (!isTestMode()) {
        watchdog = createLiveWatchdog(daemon, {
          autoRelaunch: !flags['no-auto-relaunch'],
          silent: true
        });
        watchdog.start();
        void watchdog.tick().catch(() => {});
      }
      console.log(JSON.stringify({ ok: true, ...info }, null, 2));
      const shutdown = async () => {
        watchdog?.stop();
        await daemon.stop();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
      return;
    }
    throw new Error(`Unknown daemon subcommand: ${sub}`);
  }

  if (cmd === 'dev') {
    const sub = (positional[1] || '').toLowerCase();
    const hostRoot = path.resolve(__dirname, '..');
    const workspaceRoot = path.resolve(hostRoot, '..');
    const allDirs = fs.existsSync(workspaceRoot)
      ? fs.readdirSync(workspaceRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name.startsWith('agy-daddy-') && fs.existsSync(path.join(workspaceRoot, d.name, 'package.json')))
          .map((d) => path.join(workspaceRoot, d.name))
      : [hostRoot];

    if (sub === 'test-all') {
      if (flags['dry-run']) {
        console.log(JSON.stringify({ ok: true, dryRun: true, repos: allDirs }, null, 2));
        return;
      }
      const testFiles = fs.readdirSync(path.join(hostRoot, 'test'))
        .filter((f) => f.endsWith('.test.js'))
        .sort()
        .map((f) => path.join('test', f));
      const res = spawnSync(process.execPath, ['--test', ...testFiles], {
        cwd: hostRoot,
        stdio: 'inherit',
        env: { ...process.env, AGY_DADDY_TEST_MODE: '1' }
      });
      process.exitCode = res.status || 0;
      return;
    }
    if (sub === 'link-all') {
      const pluginDirs = allDirs.filter(
        (d) => path.basename(d).startsWith('agy-daddy-plugin-') && path.basename(d) !== 'agy-daddy-plugin-template'
      );
      if (flags['dry-run']) {
        console.log(JSON.stringify({ ok: true, dryRun: true, pluginDirs }, null, 2));
        return;
      }
      const linked = [];
      for (const dir of pluginDirs) {
        const manPath = path.join(dir, 'agy-plugin.json');
        let manifestId = '';
        try {
          manifestId = String(JSON.parse(fs.readFileSync(manPath, 'utf8')).id || '');
        } catch {}
        const isOfficial = manifestId.startsWith('agy-daddy.');
        const linkOpts = isOfficial
          ? { trustLevel: flags.trust || 'T0' }
          : { trustLevel: 'T1', grantedPermissions: ['dom:read', 'dom:write', 'bridge:route'] };
        linked.push(await linkPlugin(dir, linkOpts));
      }
      console.log(JSON.stringify({ ok: true, linkedCount: linked.length, linked: linked.map((r) => ({ id: r.plugin?.id, trustLevel: r.plugin?.trustLevel, nativeSynced: Boolean(r.nativeSync?.synced) })) }, null, 2));
      return;
    }
    if (sub === 'clone-all') {
      const regPath = path.join(hostRoot, 'data', 'registry.json');
      const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      const list = Array.isArray(reg.plugins) ? reg.plugins : Object.values(reg.plugins || {});
      console.log(JSON.stringify({
        ok: true,
        dryRun: true,
        repos: list.map((p) => p.repo || p.id)
      }, null, 2));
      return;
    }
    if (sub === 'capture-fixture') {
      const version = String(flags.version || '2.33.0');
      const anchorsPath = path.join(hostRoot, 'data', 'anchors.json');
      const anchorsData = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
      console.log(JSON.stringify({
        ok: true,
        antigravityVersion: version,
        anchorsCount: Object.keys(anchorsData.anchors || {}).length,
        sanitized: true
      }, null, 2));
      return;
    }
    if (sub === 'smoke') {
      const report = await runDoctor({ skipCdp: true });
      console.log(JSON.stringify({
        ok: report.runtime.ok,
        checklist: [
          { step: 'runtime', ok: report.runtime.ok },
          { step: 'anchors', ok: report.anchors.count >= 14 },
          { step: 'cdpTarget', ok: report.antigravity.cdpTargetsCount > 0, note: report.antigravity.cdpTargetsCount > 0 ? 'ready' : 'no active IDE window in headless check' }
        ]
      }, null, 2));
      return;
    }
    throw new Error(`Unknown dev subcommand: ${sub}`);
  }

  console.log(`Agy-Daddy Launcher & Host v${HOST_PKG_VERSION}

用法:
  agy-daddy doctor [--json] [--bundle <file>]         运行环境诊断 / 导出脱敏诊断包
  agy-daddy status [--json]                           查看守护进程、CDP 与插件状态
  agy-daddy launcher [--launch-app] [--once] [--skip-inject] [--replace] [--json]  启动 Agy-Daddy Launcher 系统托盘与守护进程
  agy-daddy live [--once] [--skip-inject] [--no-auto-relaunch] [--replace] [--json]    启动守护进程并执行 CDP 热注入
  agy-daddy stop | restart | auto-on | auto-off       停止、自愈重启与开机自启管理
  agy-daddy install-launcher [--dir <path>]           生成桌面端 Agy-Daddy Launcher 启动器与图标
  agy-daddy remote [--reset-token]                    查看手机远程链接或轮换配对令牌
  agy-daddy web [--port <n>] [--no-open] [--reset-token] 查看或打开 PC Web 工作台链接
  agy-daddy update [--dry-run] | upstreams [--json]   拉取更新与上游基线漂移追踪
  agy-daddy run <commandId>                           执行已安装插件贡献命令
  agy-daddy plugin list|install|link|enable|disable|rollback|native|uninstall|audit
  agy-daddy plugin install --official [--tag latest|next] [--registry <url>]
  agy-daddy daemon start|stop|status                  管理 agy-daddyd 单实例守护进程
  agy-daddy dev test-all|link-all|clone-all|capture-fixture|smoke`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ 执行失败:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main, parseFlags };
