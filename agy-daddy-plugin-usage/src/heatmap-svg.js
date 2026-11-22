'use strict';

const HEAT_LEVEL_VARS = Object.freeze([
  'var(--ag-custom-heat-lvl-0, #27272a)',
  'var(--ag-custom-heat-lvl-1, #3f1e6b)',
  'var(--ag-custom-heat-lvl-2, #652ab7)',
  'var(--ag-custom-heat-lvl-3, #9053f8)',
  'var(--ag-custom-heat-lvl-4, #c084fc)'
]);

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
  renderHeatmapSvg
};
