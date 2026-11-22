'use strict';

function renderRemotePanelHtml(snapshot = {}) {
  const panels = snapshot.panels || {};
  const ctx = panels.context?.available ? `Ctx ${panels.context.data?.percent ?? '--'}%` : 'Ctx Unavailable';
  const usage = panels.usage?.available ? `$${Number(panels.usage.data?.totalUsd || 0).toFixed(2)}` : 'Usage Unavailable';
  const quota = panels.quota?.available ? `G:${panels.quota.data?.gemini?.percentText || '--'}` : 'Quota Unavailable';
  return `<div class="agy-remote-client-summary" style="border:1px solid var(--ag-accent-border,rgba(167,139,250,0.34));color:#a78bfa;">${ctx} | ${usage} | ${quota}</div>`;
}

module.exports = {
  renderRemotePanelHtml
};
