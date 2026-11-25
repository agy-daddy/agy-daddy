'use strict';

const { cdpTargetFilterReason } = require('./cdp');
const { checkAnchorHealth, checkPluginAnchors, loadHealthAnchorsRegistry, resolveAnchorSelectors } = require('./anchors');
const { detectInsideAntigravitySession, inheritedSessionVars } = require('./lifecycle');
const { makeHostRelaunchRecord, readHostHealthState, readHostRelaunch, writeHostHealthState } = require('./storage');
const { parseSemver, compareSemver } = require('../contracts/semver');

const FAULT_CHANGED = 'host-health:fault-changed';
const UPGRADE_TAKEOVER_FAILED = 'host-health:upgrade-takeover-failed';
const FAULT_THRESHOLD_MS = 5000;
const RUNTIME_REPORT_TTL_MS = 15000;
const CORE_ANCHORS = ['topbar.rightCluster', 'settings.dialog', 'settings.nav'];

const emptyFault = () => ({
  active: false, code: null, reason: null, since: null, durationMs: 0, exceeded5s: false, pid: null
});

function isNewerVersion(version, previous) {
  const parse = (value) => parseSemver(String(value || '').replace(/^\d+(?:\.\d+)?$/, (parts) =>
    parts.split('.').length === 1 ? parts + '.0.0' : parts + '.0'
  ));
  const next = parse(version);
  const last = parse(previous);
  return Boolean(next && last && compareSemver(next, last) > 0);
}

function cdpTargetDetails(page) {
  const string = (value) => typeof value === 'string' ? value : null;
  return { id: string(page?.id), title: string(page?.title), url: string(page?.url), type: string(page?.type) };
}

function buildCdpHealth(discovery = {}) {
  const matched = (discovery.targets || []).map(cdpTargetDetails);
  const filteredPages = discovery.filtered || (discovery.pages || [])
    .map((page) => ({ ...page, filterReason: cdpTargetFilterReason(page) }))
    .filter((page) => page.filterReason);
  const filtered = filteredPages.map((page) => ({ ...cdpTargetDetails(page), filterReason: page.filterReason }));
  return {
    port: discovery.port || null,
    portsTried: discovery.portsTried || (discovery.port ? [discovery.port] : []),
    reachable: discovery.reachable ?? Boolean(discovery.port),
    targets: { total: matched.length + filtered.length, matched, filtered }
  };
}

function collectHealthObservations({ registry, version, sessions, plugins, now }) {
  const observations = sessions.map((session) => {
    const report = session.runtimeHealthReport;
    return {
      session,
      report: report && now - report.at <= RUNTIME_REPORT_TTL_MS ? report : null
    };
  }).map(({ session, report }) => {
    const probe = report || session.healthProbe;
    const matched = new Map((probe?.items || []).map((item) => [item.name, item.matchedSelector]));
    return {
      session,
      report,
      probe,
      anchors: checkAnchorHealth(registry, version, (selector, name) => matched.get(name) === selector)
    };
  });

  const matched = Object.assign(Object.create(null), ...observations.map(({ anchors }) => anchors.matched));
  const found = Object.create(null);
  const pluginHealth = plugins.map(({ manifest, lastErrorAt, ...plugin }) => {
    const missing = checkPluginAnchors(manifest, { matched }).missing;
    for (const anchor of missing) {
      (found[anchor] ||= []).push(plugin.id);
    }
    const rendererStates = observations.map(({ session, report }) => {
      const state = report?.plugins.get(plugin.id);
      const mountError = session.mountErrors?.get(plugin.id);
      return {
        mounted: state?.rendererMounted ?? Boolean(session.mountedPlugins?.has(plugin.id)),
        error: state?.lastError || mountError?.message || null,
        stack: state?.lastError ? state.lastErrorStack : mountError?.stack || null,
        at: state?.lastError ? report.at : (mountError?.at || 0)
      };
    });
    const latestError = rendererStates.reduce((latest, state) =>
      state.error && state.at >= latest.at ? state : latest,
    { error: plugin.lastError, stack: plugin.lastErrorStack, at: lastErrorAt || 0 });
    return {
      ...plugin,
      rendererMounted: plugin.enabled && rendererStates.some(({ mounted }) => mounted),
      lastError: latestError.error,
      lastErrorStack: latestError.stack,
      affectedByMissingAnchors: missing
    };
  });

  const items = Object.keys(registry.anchors).map((name) => ({
    name,
    status: matched[name] ? 'ok' : 'missing',
    matchedSelector: matched[name] || null,
    affectedPlugins: found[name] || []
  }));
  const healthyCount = items.filter(({ status }) => status === 'ok').length;
  const coreMissing = CORE_ANCHORS.filter((name) => {
    const relevant = observations.filter(({ probe }) =>
      probe && (name === 'topbar.rightCluster' || probe.settingsExpected)
    );
    return relevant.length > 0 && relevant.every(({ anchors }) => anchors.missing.includes(name));
  });

  return {
    probeSource: observations.some(({ probe }) => probe) ? 'runtime' : 'static',
    anchors: { total: items.length, healthyCount, missingCount: items.length - healthyCount, items },
    plugins: pluginHealth,
    coreMissing
  };
}

class HostHealth {
  constructor(options = {}) {
    this.options = options;
    this.now = options.now || Date.now;
    this.stateDir = options.stateDir;
    this.registry = loadHealthAnchorsRegistry(options);
    this.reset();
  }

  reset({ startedAt = null, pid = null } = {}) {
    this.dispose();
    this.history = readHostHealthState(this.stateDir);
    this.historyDirty = false;
    this.pid = pid;
    this.startedAt = startedAt;
    this.host = {};
    this.cdp = {};
    this.lastRelaunch = { at: null, status: null, reason: null, blockedBy: null };
    this.relaunchFailurePid = null;
    this.injectionFailures = new Map();
    this.fault = emptyFault();
  }

  observe(host, cdp) {
    if (this.host.pid !== host.pid) this.injectionFailures.clear();
    this.host = host;
    if (cdp) {
      this.cdp = cdp;
      const targetIds = new Set((cdp.targets || []).map((target) => target.id || target.webSocketDebuggerUrl));
      for (const id of this.injectionFailures.keys()) {
        if (!targetIds.has(id)) this.injectionFailures.delete(id);
      }
    }
  }

  recordInjection({ targetId, error }) {
    if (error) this.injectionFailures.set(targetId, error);
    else this.injectionFailures.delete(targetId);
  }

  recordRelaunch(result, pid = this.host.pid) {
    this.lastRelaunch = makeHostRelaunchRecord(result, this.now());
    const { status } = this.lastRelaunch;
    this.relaunchFailurePid = ['blocked', 'failed'].includes(status) ? pid : null;
  }

  saveHistory() {
    const result = writeHostHealthState(this.stateDir, this.history);
    this.historyDirty = !result.ok;
    if (!result.ok) this.options.onHistoryError?.(result);
  }

  recordInjectedVersion(version) {
    if (!version || (version === this.history.lastInjectedVersion && !this.historyDirty)) return;
    this.history.lastInjectedVersion = version;
    this.saveHistory();
  }

  recordUpgrade({ fromVersion, toVersion, pid, outcome, reason = null }) {
    const event = { at: new Date(this.now()).toISOString(), fromVersion, toVersion, pid, outcome, reason };
    this.history.upgradeEvents = [...this.history.upgradeEvents, event].slice(-20);
    this.saveHistory();
    if (outcome === 'failed' || outcome === 'blocked') {
      this.options.emit?.(UPGRADE_TAKEOVER_FAILED, { pid, reason, version: toVersion });
    }
    return event;
  }

  sessions() {
    return (this.cdp.targets || []).flatMap((target) => {
      const session = this.options.getSession?.(target.id || target.webSocketDebuggerUrl);
      return session && !session.closed && !session.reinjectInFlight && session.readyForNavEvents !== false &&
        session.target?.webSocketDebuggerUrl === target.webSocketDebuggerUrl ? [session] : [];
    });
  }

  acceptRuntimeReport(body = {}) {
    const session = typeof body?.targetId === 'string' ? this.options.getSession?.(body.targetId) : null;
    if (!session || session.closed || !session.xworldNonce || body.reportId !== session.xworldNonce) {
      throw Object.assign(new Error('Runtime report does not match an active document'), { statusCode: 409 });
    }

    const entries = body.anchors?.items;
    const names = Object.keys(this.registry.anchors);
    if (!Array.isArray(entries) || entries.length !== names.length ||
        (body.plugins !== undefined && !Array.isArray(body.plugins))) {
      throw Object.assign(new Error('Expected one observation per health anchor and a plugin array'), { statusCode: 400 });
    }
    const version = this.host.version || this.options.antigravityVersion || '2.33.0';
    const byName = new Map(entries.map((item) => [item?.name, item]));
    const items = names.map((name) => {
      const entry = byName.get(name);
      const match = entry?.matchedSelector;
      const valid = (entry?.status === 'missing' && match === null) ||
        (entry?.status === 'ok' && typeof match === 'string' &&
          resolveAnchorSelectors(name, version, this.registry).selectors.includes(match));
      if (!valid) throw Object.assign(new Error(`Invalid observation for ${name}`), { statusCode: 400 });
      return { name, matchedSelector: match };
    });

    const text = (value, limit) => typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : null;
    const known = new Set((session.activePlugins || []).map(({ id }) => id));
    const plugins = new Map();
    for (const item of body.plugins || []) {
      if (!known.has(item?.id) || typeof item.rendererMounted !== 'boolean') continue;
      plugins.set(item.id, {
        rendererMounted: item.rendererMounted,
        lastError: text(item.lastError, 2048),
        lastErrorStack: text(item.lastErrorStack, 8192)
      });
    }
    session.runtimeHealthReport = { at: this.now(), items, plugins, settingsExpected: body.settingsExpected === true };
    return { ok: true };
  }

  updateFault(code, reason, pid) {
    const now = this.now();
    const prev = this.fault;
    const same = prev.active && code === prev.code && pid === prev.pid;
    const since = same ? prev.since : new Date(now).toISOString();
    const durationMs = Math.max(0, now - Date.parse(since));
    const exceeded5s = durationMs > FAULT_THRESHOLD_MS;
    const next = code ? { active: true, code, reason, since, durationMs, exceeded5s, pid } : emptyFault();
    this.fault = next;

    if (!next.active || !same || exceeded5s) this.dispose();
    if (next.active && !exceeded5s && !this.timer && this.pid) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.snapshot();
      }, FAULT_THRESHOLD_MS + 1 - durationMs);
      this.timer.unref();
    }

    if (prev.active !== next.active || prev.code !== next.code || prev.pid !== next.pid ||
        prev.reason !== next.reason || prev.exceeded5s !== next.exceeded5s) {
      this.options.emit?.(FAULT_CHANGED, { ...next });
    }
  }

  snapshot() {
    const now = this.now();
    const host = this.host;
    const cdp = buildCdpHealth(this.cdp);
    const sessions = this.sessions();
    const version = host.version || this.options.antigravityVersion || null;
    const observations = collectHealthObservations({
      now, version: version || '2.33.0', registry: this.registry, sessions,
      plugins: this.options.getPlugins?.() || []
    });
    const mountError = sessions.find((session) => session.mountErrors?.size)?.mountErrors.values().next().value;
    const lastInjectError = this.injectionFailures.values().next().value || mountError?.message || null;

    let code = null;
    let reason = null;
    if (host.running && this.relaunchFailurePid === host.pid &&
        (host.hasDebugSwitch === false || cdp.targets.matched.length === 0)) {
      code = 'relaunch_blocked_or_timeout';
      reason = this.lastRelaunch.reason;
    } else if (host.running && host.hasDebugSwitch === false) {
      code = 'missing_cdp_switch';
      reason = 'Antigravity is missing the CDP debug switch';
    } else if (host.running && cdp.targets.matched.length === 0) {
      code = 'cdp_zero_targets';
      reason = cdp.reachable ? 'CDP has no matching targets' : 'CDP is unreachable';
    } else if (lastInjectError) {
      code = 'injection_error';
      reason = lastInjectError;
    } else if (observations.coreMissing.length > 0) {
      code = 'core_anchor_missing';
      reason = observations.coreMissing.join(', ');
    }
    this.updateFault(code, reason, host.pid || null);

    const env = this.options.env || process.env;
    const persistedRelaunch = readHostRelaunch(this.stateDir);
    const lastRelaunch = persistedRelaunch?.at > (this.lastRelaunch.at || '') ? persistedRelaunch : this.lastRelaunch;
    return {
      ok: true,
      daemon: {
        pid: this.pid,
        bridgePort: this.options.getBridgePort?.() || null,
        inheritedSessionVars: inheritedSessionVars(env),
        hasSessionEnvPollution: detectInsideAntigravitySession(env),
        startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
        uptimeMs: this.startedAt === null ? 0 : Math.max(0, now - this.startedAt)
      },
      antigravity: {
        running: Boolean(host.running),
        pid: host.pid || null,
        version: host.version || null,
        lastInjectedVersion: this.history.lastInjectedVersion,
        hasDebugSwitch: Boolean(host.hasDebugSwitch),
        lastRelaunch: { ...lastRelaunch },
        upgradeEvents: this.history.upgradeEvents.map((event) => ({ ...event }))
      },
      cdp,
      injection: {
        injectedCount: sessions.length,
        lastInjectError,
        probeSource: observations.probeSource,
        antigravityVersion: version,
        anchors: observations.anchors
      },
      plugins: observations.plugins,
      fault: { ...this.fault }
    };
  }

  dispose() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { FAULT_CHANGED, UPGRADE_TAKEOVER_FAILED, HostHealth, isNewerVersion };
