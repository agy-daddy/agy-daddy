'use strict';

let disposers = [];

function formatUnitLabel(status) {
  if (!status || !status.listening) return '代理关';
  return status.mode === 'upstream' ? '转发' : '直连';
}

async function mount(ctx) {
  let latestStatus = { listening: false, mode: 'direct', hasUpstream: false };
  let stopUnit = null;

  const refreshUnit = (st) => {
    latestStatus = st || latestStatus;
    const label = formatUnitLabel(latestStatus);
    if (stopUnit) stopUnit();
    stopUnit = ctx.topbar.registerUnit({
      id: 'proxy-badge',
      order: 85,
      label,
      onClick: () => {
        void (async () => {
          try {
            if (!latestStatus.hasUpstream && latestStatus.mode !== 'upstream') return;
            const res = await ctx.bridge.post('/switch-mode', {});
            refreshUnit(res);
          } catch {}
        })();
      }
    });
  };

  try {
    const initial = await ctx.bridge.post('/status', {});
    refreshUnit(initial);
  } catch {
    refreshUnit(latestStatus);
  }

  const stopSection = ctx.settings.registerSection({
    id: 'proxy-settings',
    title: { 'zh-CN': '免重启网络代理网关', en: 'Hot-Switch Proxy Gateway' },
    values: {
      gatewayEnabled: latestStatus.gatewayEnabled !== false,
      mode: latestStatus.mode || 'direct',
      upstreamUrl: latestStatus.upstreamUrl || '',
      noProxy: latestStatus.noProxy || '',
      gatewayPort: latestStatus.gatewayPort || 18766,
      fallbackToDirectOnUpstreamError: Boolean(latestStatus.fallbackToDirectOnUpstreamError)
    },
    onChange(key, value) {
      void (async () => {
        try {
          const updated = await ctx.bridge.post('/set-config', { [key]: value });
          refreshUnit(updated);
        } catch {}
      })();
    }
  });

  const stopTimer = ctx.schedule.every(15000, () => {
    void ctx.bridge.post('/status', {}).then(refreshUnit).catch(() => {});
  });

  disposers.push(
    () => { if (stopUnit) { stopUnit(); stopUnit = null; } },
    stopSection,
    stopTimer
  );
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  formatUnitLabel,
  mount,
  dispose
};
