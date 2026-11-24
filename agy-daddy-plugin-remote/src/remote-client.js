'use strict';

function fmtTokShort(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '--';
  const n = Math.max(0, Number(v));
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

function renderRemotePanelHtml(snapshot = {}) {
  const panels = snapshot.panels || {};
  let ctx = 'Ctx Unavailable';
  if (panels.context?.available) {
    const d = panels.context.data || {};
    const winPart = d.used != null && d.budget ? `${fmtTokShort(d.used)}/${fmtTokShort(d.budget)} (${d.percent ?? '--'}%)` : `Ctx ${d.percent ?? '--'}%`;
    const sessTotal = d.sessionUsage?.totalTokens;
    const sessPart = sessTotal != null ? ` · 对话 ${fmtTokShort(sessTotal)}` : '';
    const tps = d.speed?.tps ?? d.tokPerSec;
    const spdPart = tps ? ` · ${tps}/s` : '';
    ctx = `${winPart}${sessPart}${spdPart}`;
  }
  const usage = panels.usage?.available ? `$${Number(panels.usage.data?.totalUsd || 0).toFixed(2)}` : 'Usage Unavailable';
  const quota = panels.quota?.available ? `G:${panels.quota.data?.gemini?.percentText || '--'}` : 'Quota Unavailable';
  return `<div class="agy-remote-client-summary" style="border:1px solid var(--ag-border-card,rgba(113,113,122,0.22));border-radius:10px;padding:8px 10px;color:var(--ag-text-primary,inherit);">${ctx} | ${usage} | ${quota}</div>`;
}

module.exports = {
  renderRemotePanelHtml
};
