'use strict';

let disposers = [];

function formatChannelSummary(status) {
  if (!status || !status.channels) return '回环待机';
  const active = [];
  if (status.channels.loopback) active.push('Loopback');
  if (status.channels.lan) active.push('LAN');
  if (status.channels.tailscale) active.push('Tailscale');
  if (status.channels.cloudflare) active.push('Cloudflare');
  const writeTag = status.allowRemoteWrite ? '可写' : '只读';
  const portTag = status.port ? `:${status.port}` : '';
  return `${active.join('+') || '离线'}${portTag} (${writeTag})`;
}

function buildRemoteIconSvg() {
  return '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">'
    + '<rect x="3.5" y="1.5" width="7" height="11" rx="1.6" fill="none" stroke="var(--ag-custom-token-accent, #a78bfa)" stroke-width="1.4"/>'
    + '<circle cx="7" cy="10.2" r="0.8" fill="var(--ag-custom-token-accent, #a78bfa)"/>'
    + '</svg>';
}

function buildEl(docRef, tag, cls, text) {
  const el = docRef.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function mount(ctx) {
  let latestStatus = null;
  let latestPairing = null;
  let unitNode = null;
  let panelNode = null;
  let popover = null;
  let copyHintTimer = null;

  async function refreshStatus(withPairing = false) {
    try {
      const [st, pair] = await Promise.all([
        ctx.bridge.post('/status', {}),
        withPairing ? ctx.bridge.post('/pairing', {}).catch(() => null) : Promise.resolve(latestPairing)
      ]);
      if (st) latestStatus = st;
      if (pair) latestPairing = pair;
      renderUnit();
      renderPanel();
      return st;
    } catch {
      return null;
    }
  }

  function renderPanel() {
    if (!panelNode) return;
    const docRef = panelNode.ownerDocument || globalThis.document;
    if (!docRef?.createElement) {
      if (!latestStatus) {
        panelNode.textContent = '正在等待远程控制台状态...';
        return;
      }
      panelNode.textContent = [
        `状态: ${latestStatus.running ? '监听中' : '未启动'}`,
        `通道: ${formatChannelSummary(latestStatus)}`,
        `地址: ${latestStatus.url || '(无)'}`
      ].join('\n');
      return;
    }

    panelNode.textContent = '';

    const head = buildEl(docRef, 'div', 'ag-panel-head');
    const titleWrap = buildEl(docRef, 'div', 'ag-panel-title-wrap');
    titleWrap.appendChild(buildEl(docRef, 'span', 'ag-panel-title', '手机远程控制台'));
    const stChip = buildEl(docRef, 'span', 'ag-chip', latestStatus?.running ? '监听中' : '未启动');
    if (!latestStatus?.running) stChip.setAttribute('data-tone', 'muted');
    titleWrap.appendChild(stChip);
    head.appendChild(titleWrap);

    const actions = buildEl(docRef, 'div', 'ag-panel-actions');
    const writeChip = buildEl(docRef, 'button', 'ag-btn', latestStatus?.allowRemoteWrite ? '可写模式' : '只读快照');
    writeChip.type = 'button';
    writeChip.addEventListener('click', () => {
      void ctx.bridge.post('/set-write', { enabled: !latestStatus?.allowRemoteWrite }).then(() => refreshStatus(true)).catch(() => {});
    });
    const closeBtn = buildEl(docRef, 'button', 'ag-icon-btn', '✕');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => { popover?.toggle(false); });
    actions.appendChild(writeChip);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panelNode.appendChild(head);

    if (!latestStatus) {
      const empty = buildEl(docRef, 'div', 'settings-card-box');
      empty.appendChild(buildEl(docRef, 'div', 'ag-muted', '正在等待远程控制台状态...'));
      panelNode.appendChild(empty);
      return;
    }

    // 二维码卡片
    const pairCard = buildEl(docRef, 'div', 'settings-card-box');
    const qrSvg = latestPairing?.qrSvg || '';
    if (qrSvg) {
      const qrBox = buildEl(docRef, 'div', 'ag-qr-box');
      qrBox.innerHTML = qrSvg;
      pairCard.appendChild(qrBox);
    }
    const urlStr = latestPairing?.primaryUrl || latestStatus.url || '';
    const urlRow = buildEl(docRef, 'div', 'ag-url-row');
    const urlInput = buildEl(docRef, 'input', 'settings-input');
    urlInput.type = 'text';
    urlInput.value = urlStr;
    urlInput.setAttribute('readonly', 'true');
    const copyBtn = buildEl(docRef, 'button', 'ag-btn ag-btn-primary', '复制链接');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => {
      try { globalThis.navigator?.clipboard?.writeText?.(urlStr); } catch {}
      copyBtn.textContent = '已复制';
      clearTimeout(copyHintTimer);
      copyHintTimer = setTimeout(() => { copyBtn.textContent = '复制链接'; }, 1500);
    });
    const rotateBtn = buildEl(docRef, 'button', 'ag-btn', '轮换令牌');
    rotateBtn.type = 'button';
    rotateBtn.addEventListener('click', () => {
      void ctx.bridge.post('/rotate-token', {}).then(() => refreshStatus(true)).catch(() => {});
    });
    urlRow.appendChild(urlInput);
    urlRow.appendChild(copyBtn);
    urlRow.appendChild(rotateBtn);
    pairCard.appendChild(urlRow);
    pairCard.appendChild(buildEl(docRef, 'div', 'ag-muted', `令牌摘要: ${latestStatus.tokenPreview || '--'} · 客户端隔离与只读鉴权已开启`));
    panelNode.appendChild(pairCard);

    // 通道状态卡片
    const chCard = buildEl(docRef, 'div', 'settings-card-box');
    chCard.appendChild(buildEl(docRef, 'div', 'ag-card-title', `访问通道 (${formatChannelSummary(latestStatus)})`));
    const chRow = buildEl(docRef, 'div', 'ag-channels-row');
    for (const chDef of [
      { key: 'loopback', label: 'Loopback' },
      { key: 'lan', label: 'LAN' },
      { key: 'tailscale', label: 'Tailscale' },
      { key: 'cloudflare', label: 'Cloudflare' }
    ]) {
      const enabled = Boolean(latestStatus.channels?.[chDef.key]);
      const chipBtn = buildEl(docRef, 'button', 'qp-pool-chip', chDef.label);
      chipBtn.type = 'button';
      chipBtn.setAttribute('data-active', enabled ? 'true' : 'false');
      chipBtn.addEventListener('click', () => {
        void ctx.bridge.post('/channel', { [chDef.key]: !enabled }).then(() => refreshStatus(true)).catch(() => {});
      });
      chRow.appendChild(chipBtn);
    }
    chCard.appendChild(chRow);
    panelNode.appendChild(chCard);
  }

  function renderUnit() {
    if (!unitNode) return;
    const modeLabel = latestStatus?.allowRemoteWrite ? '可写' : '只读';
    const text = latestStatus?.port ? `远程 :${latestStatus.port} (${modeLabel})` : `远程 (${modeLabel})`;
    const docRef = unitNode.ownerDocument || globalThis.document;
    if (docRef?.createElement) {
      unitNode.textContent = '';
      const iconSpan = buildEl(docRef, 'span');
      iconSpan.innerHTML = buildRemoteIconSvg();
      const lblSpan = buildEl(docRef, 'span', '', text);
      unitNode.appendChild(iconSpan);
      unitNode.appendChild(lblSpan);
    } else {
      unitNode.textContent = text;
    }
  }

  popover = ctx.topbar.registerPopover({
    id: 'remote-panel',
    anchorId: 'remote',
    render(node) {
      node.id = 'agy-remote-panel';
      panelNode = node;
      renderPanel();
    },
    onToggle(open) {
      if (open) void refreshStatus(true);
    }
  });

  const stopUnit = ctx.topbar.registerUnit({
    id: 'remote',
    order: 60,
    label: '远程 (只读)',
    render(node) {
      unitNode = node;
      renderUnit();
    },
    onClick() {
      popover?.toggle();
    }
  });

  const stopSection = ctx.settings.registerSection({
    id: 'remote-settings',
    title: { 'zh-CN': '手机远程控制台', en: 'Mobile Remote Console' },
    values: {
      allowRemoteWrite: false,
      loopback: true,
      lan: false,
      tailscale: false,
      cloudflare: false,
      tunnelMode: 'quick'
    },
    async onChange(key, value) {
      if (key === 'allowRemoteWrite') {
        const res = await ctx.bridge.post('/set-write', { enabled: Boolean(value) });
        if (res?.status) {
          latestStatus = res.status;
          renderUnit();
          renderPanel();
        }
        return;
      }
      const res = await ctx.bridge.post('/channel', { [key]: value });
      if (res?.status) {
        latestStatus = res.status;
        renderUnit();
        renderPanel();
      }
    }
  });

  const stopStateSub = ctx.state.subscribe('state:remote.status@1', (st) => {
    if (st) {
      latestStatus = st;
      renderUnit();
      renderPanel();
    }
  });

  await refreshStatus(true);

  disposers.push(
    stopUnit,
    stopSection,
    stopStateSub,
    () => { clearTimeout(copyHintTimer); },
    () => popover?.dispose?.()
  );
}

async function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  formatChannelSummary,
  mount,
  dispose
};
