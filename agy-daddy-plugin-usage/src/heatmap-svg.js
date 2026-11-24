'use strict';

const HEAT_LEVEL_VARS = Object.freeze([
  'var(--ag-custom-heat-lvl-0, rgba(113, 113, 122, 0.14))',
  'var(--ag-custom-heat-lvl-1, rgba(113, 113, 122, 0.34))',
  'var(--ag-custom-heat-lvl-2, rgba(113, 113, 122, 0.56))',
  'var(--ag-custom-heat-lvl-3, rgba(113, 113, 122, 0.78))',
  'var(--ag-custom-heat-lvl-4, var(--ag-text-primary, #18181b))'
]);

const HEATMAP_STYLES_CSS = `
.ag-heatmap-box {
  width: 100%;
  overflow-x: auto;
  padding: 8px;
  border-radius: 10px;
  background: var(--ag-bg-subcard);
  border: none;
  box-sizing: border-box;
}

.ag-heatmap-box svg {
  display: block;
  width: 100%;
  height: auto;
}

.ag-usage-tabs {
  display: inline-flex;
  flex-wrap: wrap;
  width: fit-content;
  gap: 2px;
}
`.trim();

function renderHeatmapSvg(heatmapData = {}, options = {}) {
  const weeks = Number(heatmapData.weeks) > 0 ? Number(heatmapData.weeks) : 52;
  const days = Array.isArray(heatmapData.days) ? heatmapData.days : [];
  const cell = Number(options.cellSize) > 0 ? Number(options.cellSize) : 10;
  const gap = Number(options.gap) >= 0 ? Number(options.gap) : 2;
  const step = cell + gap;
  const width = weeks * step - gap;
  const height = 7 * step - gap;

  const rects = [];
  for (let idx = 0; idx < days.length; idx++) {
    const d = days[idx] || {};
    const w = Math.floor(idx / 7);
    const row = idx % 7;
    if (w >= weeks) break;
    const x = w * step;
    const y = row * step;
    const lvl = Math.max(0, Math.min(4, Number(d.level) || 0));
    const fill = HEAT_LEVEL_VARS[lvl];
    const dateAttr = d.date ? ` data-date="${String(d.date).replace(/"/g, '')}"` : '';
    const tokAttr = ` data-tokens="${Number(d.tokens) || 0}"`;
    rects.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${fill}"${dateAttr}${tokAttr}/>`);
  }

  return `<svg class="agy-heatmap-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-weeks="${weeks}" data-days="${days.length}" role="img" aria-label="52-week usage heatmap">${rects.join('')}</svg>`;
}

module.exports = {
  HEAT_LEVEL_VARS,
  HEATMAP_STYLES_CSS,
  renderHeatmapSvg
};
