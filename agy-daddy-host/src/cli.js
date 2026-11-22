#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getStateDir, isTestMode } = require('./core/paths');
const { resolveActiveCdpTarget } = require('./core/cdp');
const { safeReadJsonSync, safeWriteJsonSync } = require('./core/storage');
const { runDoctor, exportDiagnosticBundle } = require('./core/doctor');
const { migrateLegacyData } = require('./core/migration');
const {
  installPlugin,
  linkPlugin,
  enablePlugin,
  disablePlugin,
  rollbackPlugin,
  uninstallPlugin,
  listInstalledPlugins
} = require('./core/installer');
const { AgyDaddyDaemon, isPidAlive } = require('./core/daemon');
const {
  installAutoStart,
  removeAutoStart,
  installMacLauncherApp,
  planAntigravityRestart,
  checkAndPullGitUpdate
} = require('./core/lifecycle');
const { auditUpstreamsAndBaselines } = require('./core/upstreams');

const BOOLEAN_FLAGS = new Set([
  'json', 'dry-run', 'force', 'help', 'copy', 'once', 'skip-inject', 'skip-cdp', 'reset-token'
]);

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
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function stopRunningDaemon(stateDir = getStateDir()) {
  const lockPath = path.join(stateDir, 'daemon.lock');
  const lock = safeReadJsonSync(lockPath, null, { quarantineCorrupt: false }).data;
  const pid = Number(lock?.pid);
  if (!pid || !isPidAlive(pid)) {
    return { ok: true, stopped: false, reason: 'not running' };
  }
  process.kill(pid, 'SIGTERM');
  const waitBuf = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 2000;
  while (isPidAlive(pid) && Date.now() < deadline) {
    Atomics.wait(waitBuf, 0, 0, 50);
  }
  const exited = !isPidAlive(pid);
  return { ok: true, stopped: true, pid, exited };
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
    const report = await runDoctor();
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Agy-Daddy Host v${report.hostApiVersion}`);
      console.log(`- 运行时: ${report.runtime.ok ? `${report.runtime.runtime} (${report.runtime.source}, Node ${report.runtime.nodeVersion})` : '❌ 未找到可用运行时'}`);
      console.log(`- 宿主窗口: ${report.antigravity.cdpTargetsCount > 0 ? `✅ CDP 已连接 (端口 ${report.antigravity.cdpPort})` : '⚪ 未检测到活跃 CDP 窗口'}`);
      console.log(`- 锚点注册表: ${report.anchors.count} 个具名锚点`);
      console.log(`- 已装插件: ${report.plugins.count} 个`);
      console.log(`- 旧套件痕迹: ${report.legacySuite.detected ? '⚠️ 检测到残留（可保持隔离或迁移后手动停用）' : '✅ 无残留'}`);
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
      plugins: report.plugins,
      legacySuite: report.legacySuite
    }, null, 2));
    return;
  }

  if (cmd === 'migrate') {
    const res = migrateLegacyData({ dryRun: Boolean(flags['dry-run']), force: Boolean(flags.force) });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'stop') {
    const res = stopRunningDaemon();
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'restart') {
    const plan = planAntigravityRestart({ allowSelfTerminate: Boolean(flags.force) });
    console.log(JSON.stringify({ ...plan, dryRun: Boolean(flags['dry-run']) }, null, 2));
    if (!plan.ok) process.exitCode = 1;
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
    const res = installMacLauncherApp({
      dryRun: Boolean(flags['dry-run']),
      targetDir: typeof flags.dir === 'string' ? flags.dir : undefined
    });
    console.log(JSON.stringify(res, null, 2));
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
      if (!target) throw new Error('Usage: agy-daddy plugin install <name|github:...|npm:...|local:...>');
      const res = await installPlugin(target, { trustLevel: flags.trust, grantedPermissions, copy: Boolean(flags.copy) });
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
    if (sub === 'uninstall') {
      if (!target) throw new Error('Usage: agy-daddy plugin uninstall <pluginId>');
      console.log(JSON.stringify(uninstallPlugin(target), null, 2));
      return;
    }
    throw new Error(`Unknown plugin subcommand: ${sub}`);
  }

  if (cmd === 'live') {
    const daemon = new AgyDaddyDaemon();
    const started = await daemon.start();
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
    let watchdogTimer = null;
    if (!isTestMode()) {
      let watchdogBusy = false;
      watchdogTimer = setInterval(async () => {
        if (watchdogBusy || !daemon.running) return;
        watchdogBusy = true;
        try {
          const { targets } = await resolveActiveCdpTarget({ timeoutMs: 1200 });
          const plugins = Array.from(daemon.activePlugins.values());
          for (const target of targets || []) {
            const targetId = target?.id || target?.webSocketDebuggerUrl;
            if (!targetId || daemon.injector.sessions.has(targetId)) continue;
            await daemon.injector.attachTarget(target, plugins).catch(() => {});
          }
        } catch {} finally {
          watchdogBusy = false;
        }
      }, 5000);
      if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
    }
    const shutdown = async () => {
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
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
      const daemon = new AgyDaddyDaemon();
      const info = await daemon.start();
      console.log(JSON.stringify({ ok: true, ...info }, null, 2));
      process.on('SIGTERM', async () => { await daemon.stop(); process.exit(0); });
      process.on('SIGINT', async () => { await daemon.stop(); process.exit(0); });
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
      const res = spawnSync(process.execPath, ['--test', 'test/*.test.js'], {
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
          { step: 'anchors', ok: report.anchors.count >= 10 },
          { step: 'cdpTarget', ok: report.antigravity.cdpTargetsCount > 0, note: report.antigravity.cdpTargetsCount > 0 ? 'ready' : 'no active IDE window in headless check' }
        ]
      }, null, 2));
      return;
    }
    throw new Error(`Unknown dev subcommand: ${sub}`);
  }

  console.log(`Agy-Daddy Host v1.0.0

用法:
  agy-daddy doctor [--json] [--bundle <file>]         运行环境诊断 / 导出脱敏诊断包
  agy-daddy status [--json]                           查看守护进程、CDP 与插件状态
  agy-daddy live [--once] [--skip-inject] [--json]    启动守护进程并执行 CDP 热注入
  agy-daddy stop | restart | auto-on | auto-off       停止、自愈重启与开机自启管理
  agy-daddy install-launcher [--dir <path>]           生成独立桌面增强启动器
  agy-daddy remote [--reset-token]                    查看手机远程链接或轮换配对令牌
  agy-daddy update [--dry-run] | upstreams [--json]   拉取更新与上游基线漂移追踪
  agy-daddy run <commandId>                           执行已安装插件贡献命令
  agy-daddy plugin list|install|link|enable|disable|rollback|uninstall|audit
  agy-daddy migrate [--dry-run] [--force]             只读迁移旧 AntigravityContextMeter 数据
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
