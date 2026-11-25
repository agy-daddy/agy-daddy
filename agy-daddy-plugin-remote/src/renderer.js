'use strict';

let disposers = [];

const REMOTE_PANEL_CSS = [
  '.ag-remote-top-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }',
  '.ag-remote-channel-meta { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }',
  '.ag-remote-mode-switch { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 999px; background: var(--ag-bg-segmented); flex-shrink: 0; }',
  '.ag-remote-mode-btn { height: 24px; padding: 0 10px; border-radius: 999px; border: none; background: transparent; color: var(--ag-text-secondary); font-family: inherit; font-size: 11.5px; font-weight: 500; line-height: 1; cursor: pointer; transition: background-color 150ms var(--ag-ease-out), color 150ms var(--ag-ease-out), box-shadow 150ms var(--ag-ease-out); }',
  '.ag-remote-mode-btn:hover { color: var(--ag-text-primary); }',
  '.ag-remote-mode-btn[data-active="true"] { background: var(--ag-bg-segmented-active); color: var(--ag-text-primary); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16); }',
  '.ag-remote-pair-stack { display: flex; flex-direction: column; gap: 10px; }',
  '.ag-qr-box { display: flex; align-items: center; justify-content: center; width: fit-content; margin: 0 auto; padding: 10px; border-radius: 10px; background: #ffffff; border: 1px solid var(--ag-border-card); }',
  '.ag-qr-box svg { display: block; width: 152px; height: 152px; border-radius: 4px; }',
  '.ag-remote-pcweb-stack { display: flex; flex-direction: column; gap: 8px; }',
  '.ag-remote-pcweb-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
  '.ag-remote-pcweb-title { font-size: 12px; font-weight: 600; color: var(--ag-text-primary); }',
  '.ag-remote-pcweb-actions { display: flex; align-items: center; gap: 6px; }',
  '.ag-remote-pcweb-actions .ag-btn { flex: 1 1 0; }',
  '.ag-remote-pcweb-hint { font-size: 11.5px; line-height: 1.45; color: var(--ag-text-muted); }'
].join('\n');

const CHANNEL_PRIORITY = ['cloudflare', 'tailscale', 'lan', 'bonjour', 'loopback'];

const CHANNEL_LABELS = Object.freeze({
  loopback: '本地',
  lan: '局域网',
  bonjour: '局域网',
  tailscale: 'Tailscale',
  cloudflare: 'Cloudflare',
  offline: '离线'
});

function resolvePrimaryChannelKey(status, pairing) {
  const explicit = pairing?.primaryChannel || status?.primaryChannel;
  if (explicit && Object.prototype.hasOwnProperty.call(CHANNEL_LABELS, explicit)) {
    return explicit;
  }
  const channels = status?.channels || {};
  for (const key of CHANNEL_PRIORITY) {
    if (channels[key]) return key;
  }
  return 'offline';
}

function formatPrimaryChannelLabel(status, pairing) {
  const key = resolvePrimaryChannelKey(status, pairing);
  return CHANNEL_LABELS[key] || '本地';
}

function formatChannelSummary(status) {
  if (!status || !status.channels) return '本地';
  const active = [];
  if (status.channels.loopback) active.push('本地');
  if (status.channels.lan || status.channels.bonjour) active.push('局域网');
  if (status.channels.tailscale) active.push('Tailscale');
  if (status.channels.cloudflare) active.push('Cloudflare');
  const writeTag = status.allowRemoteWrite ? '可写' : '只读';
  const portTag = status.port ? `:${status.port}` : '';
  return `${active.join('+') || '离线'}${portTag} (${writeTag})`;
}

function buildRemoteIconSvg() {
  return '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">'
    + '<rect x="3.5" y="1.5" width="7" height="11" rx="1.6" fill="none" stroke="var(--ag-custom-token-accent, currentColor)" stroke-width="1.4"/>'
    + '<circle cx="7" cy="10.2" r="0.8" fill="var(--ag-custom-token-accent, currentColor)"/>'
    + '</svg>';
}

function buildEl(docRef, tag, cls, text) {
  const el = docRef.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function resolvePermissionLevel(status) {
  const raw = String(status?.permissionLevel || '').trim().toUpperCase();
  if (raw === 'L0' || raw === 'L1' || raw === 'L2') return raw;
  return status?.allowRemoteWrite ? 'L1' : 'L0';
}

const PERMISSION_BADGE_LABELS = Object.freeze({
  L0: 'L0 只读',
  L1: 'L1 对话',
  L2: 'L2 工作区'
});

function mergeSettingsIntoStatus(values = {}, prev = null) {
  const base = prev && typeof prev === 'object' ? prev : {
    running: false,
    port: null,
    url: '',
    permissionLevel: 'L0',
    allowRemoteWrite: false,
    channels: { loopback: true, lan: false, tailscale: false, bonjour: false, cloudflare: false },
    tunnelMode: 'quick',
    tunnelHostname: ''
  };
  const nextChannels = { ...(base.channels || {}) };
  for (const chKey of ['loopback', 'lan', 'tailscale', 'bonjour', 'cloudflare']) {
    if (typeof values[chKey] === 'boolean') nextChannels[chKey] = values[chKey];
  }
  const hasPerm = typeof values.permissionLevel === 'string' && ['L0', 'L1', 'L2'].includes(values.permissionLevel.trim().toUpperCase());
  const nextPerm = hasPerm
    ? values.permissionLevel.trim().toUpperCase()
    : (typeof values.allowRemoteWrite === 'boolean'
      ? (values.allowRemoteWrite ? (base.permissionLevel === 'L2' ? 'L2' : 'L1') : 'L0')
      : resolvePermissionLevel(base));
  const nextWrite = nextPerm !== 'L0';
  return {
    ...base,
    primaryChannel: undefined,
    permissionLevel: nextPerm,
    allowRemoteWrite: nextWrite,
    channels: nextChannels,
    tunnelMode: values.tunnelMode === 'named' || values.tunnelMode === 'quick' ? values.tunnelMode : (base.tunnelMode || 'quick'),
    tunnelHostname: typeof values.tunnelHostname === 'string' ? values.tunnelHostname : (base.tunnelHostname || '')
  };
}

async function mount(ctx) {
  let latestStatus = mergeSettingsIntoStatus(ctx.settings.get() || {}, null);
  let latestPairing = null;
  let panelNode = null;
  let popover = null;
  let copyHintTimer = null;
  let pcWebCopyHintTimer = null;
  let pcWebOpenHintTimer = null;

  const stopStyles = ctx.styles.inject(REMOTE_PANEL_CSS, {
    scope: 'shadow',
    id: 'remote-panel-styles'
  });

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

  function setRemoteWrite(nextWrite) {
    const wantWrite = Boolean(nextWrite);
    const curPerm = resolvePermissionLevel(latestStatus);
    if (Boolean(latestStatus?.allowRemoteWrite) === wantWrite) return;
    const nextPerm = wantWrite ? (curPerm === 'L2' ? 'L2' : 'L1') : 'L0';
    void ctx.settings.update({ allowRemoteWrite: wantWrite, permissionLevel: nextPerm })
      .then(() => refreshStatus(true))
      .catch(() => {});
  }

  function renderPanel() {
    if (!panelNode) return;
    const docRef = panelNode.ownerDocument || globalThis.document;
    const primaryKey = resolvePrimaryChannelKey(latestStatus, latestPairing);
    const primaryLabel = formatPrimaryChannelLabel(latestStatus, latestPairing);
    const permLevel = resolvePermissionLevel(latestStatus);
    const isWritable = permLevel !== 'L0' || Boolean(latestStatus?.allowRemoteWrite);
    const pcWeb = latestPairing?.pcWeb || latestStatus?.pcWeb || null;
    const pcWebRunning = Boolean(pcWeb?.running);
    const pcWebUrl = pcWebRunning ? String(pcWeb.pairingUrl || pcWeb.url || '') : '';
    const pcWebChannel = pcWeb?.primaryChannel && Object.prototype.hasOwnProperty.call(CHANNEL_LABELS, pcWeb.primaryChannel)
      ? pcWeb.primaryChannel
      : (pcWebRunning && pcWebUrl ? 'loopback' : 'offline');
    const pcWebChannelLabel = CHANNEL_LABELS[pcWebChannel] || '本地';

    function formatPcWebCloudflareHint(cfState) {
      if (!cfState || typeof cfState !== 'object') return '';
      if (cfState.mode === 'shared_ready') {
        const modeLabel = cfState.tunnelMode === 'named' ? 'Named 固定域名' : 'Quick 临时隧道';
        return `共用远程访问隧道（${modeLabel}）`;
      }
      if (cfState.mode === 'web_disabled') {
        return '远程 Cloudflare 隧道已在线；如需公网访问 PC Web，请开启「Cloudflare Tunnel 通道」开关。';
      }
      if (cfState.mode === 'remote_pending') {
        return 'Cloudflare 隧道连接中...';
      }
      if (cfState.mode === 'remote_error') {
        return `请检查远程访问中的 cloudflared 安装状态或隧道配置${cfState.reasonCode && cfState.reasonCode !== 'CLOUDFLARED_NOT_INSTALLED' ? `（${cfState.reasonCode}）` : ''}`;
      }
      if (cfState.mode === 'remote_tunnel_off') {
        return '远程访问尚未开启 Cloudflare 隧道，请前往「远程访问」开启 Cloudflare Tunnel 后即可自动共用。';
      }
      return '';
    }

    if (!docRef?.createElement) {
      if (!latestStatus) {
        panelNode.textContent = '正在等待远程访问状态...';
        return;
      }
      panelNode.textContent = [
        `通道: ${primaryLabel}`,
        `权限: ${PERMISSION_BADGE_LABELS[permLevel] || permLevel}`,
        `地址: ${latestPairing?.primaryUrl || latestStatus.primaryUrl || latestStatus.url || '(无)'}`,
        `PC Web: ${pcWebRunning && pcWebUrl ? pcWebUrl : '未启动'}`
      ].join('\n');
      return;
    }

    panelNode.textContent = '';

    // 顶部优先通道展示、L0/L1/L2 权限徽章与只读/可写左右切换开关
    const topCard = buildEl(docRef, 'div', 'settings-card-box');
    const topRow = buildEl(docRef, 'div', 'ag-remote-top-row');

    const channelMeta = buildEl(docRef, 'div', 'ag-remote-channel-meta');
    channelMeta.appendChild(buildEl(docRef, 'span', 'ag-muted', '当前通道'));
    const channelChip = buildEl(docRef, 'span', 'ag-chip', primaryLabel);
    channelChip.setAttribute('data-remote-primary-channel', primaryKey);
    if (primaryKey === 'offline') channelChip.setAttribute('data-tone', 'muted');
    channelMeta.appendChild(channelChip);
    const permChip = buildEl(docRef, 'span', 'ag-chip', PERMISSION_BADGE_LABELS[permLevel] || permLevel);
    permChip.setAttribute('data-remote-permission-badge', permLevel);
    if (permLevel === 'L0') permChip.setAttribute('data-tone', 'muted');
    channelMeta.appendChild(permChip);
    topRow.appendChild(channelMeta);

    const modeSwitch = buildEl(docRef, 'div', 'ag-segmented ag-remote-mode-switch');
    modeSwitch.setAttribute('role', 'radiogroup');
    modeSwitch.setAttribute('aria-label', '访问权限');
    modeSwitch.setAttribute('data-remote-write-switch', 'true');

    const readBtn = buildEl(docRef, 'button', 'ag-remote-mode-btn', '只读');
    readBtn.type = 'button';
    readBtn.setAttribute('role', 'radio');
    readBtn.setAttribute('data-remote-mode', 'readonly');
    readBtn.setAttribute('data-active', !isWritable ? 'true' : 'false');
    readBtn.setAttribute('aria-checked', !isWritable ? 'true' : 'false');
    readBtn.addEventListener('click', () => setRemoteWrite(false));

    const writeBtn = buildEl(docRef, 'button', 'ag-remote-mode-btn', '可写');
    writeBtn.type = 'button';
    writeBtn.setAttribute('role', 'radio');
    writeBtn.setAttribute('data-remote-mode', 'writable');
    writeBtn.setAttribute('data-active', isWritable ? 'true' : 'false');
    writeBtn.setAttribute('aria-checked', isWritable ? 'true' : 'false');
    writeBtn.addEventListener('click', () => setRemoteWrite(true));

    modeSwitch.appendChild(readBtn);
    modeSwitch.appendChild(writeBtn);
    topRow.appendChild(modeSwitch);
    topCard.appendChild(topRow);
    panelNode.appendChild(topCard);

    if (!latestStatus) {
      const empty = buildEl(docRef, 'div', 'settings-card-box');
      empty.appendChild(buildEl(docRef, 'div', 'ag-muted', '正在等待远程访问状态...'));
      panelNode.appendChild(empty);
      return;
    }

    // 二维码与链接复制卡片
    const pairCard = buildEl(docRef, 'div', 'settings-card-box ag-remote-pair-stack');
    const qrSvg = latestPairing?.qrSvg || '';
    if (qrSvg) {
      const qrBox = buildEl(docRef, 'div', 'ag-qr-box');
      qrBox.innerHTML = qrSvg;
      pairCard.appendChild(qrBox);
    }

    const urlStr = latestPairing?.primaryUrl || latestStatus.primaryUrl || latestStatus.url || '';
    const urlRow = buildEl(docRef, 'div', 'ag-url-row');
    const urlInput = buildEl(docRef, 'input', 'settings-input');
    urlInput.type = 'text';
    urlInput.value = urlStr;
    urlInput.setAttribute('readonly', 'true');
    urlInput.setAttribute('data-remote-url-input', 'true');

    const copyBtn = buildEl(docRef, 'button', 'ag-btn ag-btn-primary', '复制链接');
    copyBtn.type = 'button';
    copyBtn.setAttribute('data-remote-copy-url', 'true');
    copyBtn.addEventListener('click', () => {
      try { globalThis.navigator?.clipboard?.writeText?.(urlStr); } catch {}
      copyBtn.textContent = '已复制';
      clearTimeout(copyHintTimer);
      copyHintTimer = setTimeout(() => { copyBtn.textContent = '复制链接'; }, 1500);
    });

    urlRow.appendChild(urlInput);
    urlRow.appendChild(copyBtn);
    pairCard.appendChild(urlRow);
    panelNode.appendChild(pairCard);

    // PC Web 工作台卡片
    const pcWebCard = buildEl(docRef, 'div', 'settings-card-box ag-remote-pcweb-stack');
    pcWebCard.setAttribute('data-remote-pcweb-card', 'true');

    const pcWebHead = buildEl(docRef, 'div', 'ag-remote-pcweb-head');
    const pcWebTitleWrap = buildEl(docRef, 'div', 'ag-remote-channel-meta');
    pcWebTitleWrap.appendChild(buildEl(docRef, 'span', 'ag-remote-pcweb-title', 'PC Web 工作台'));
    if (pcWebRunning && pcWebUrl) {
      const pcWebChChip = buildEl(docRef, 'span', 'ag-chip', pcWebChannelLabel);
      pcWebChChip.setAttribute('data-remote-pcweb-channel', pcWebChannel);
      pcWebTitleWrap.appendChild(pcWebChChip);
    }
    pcWebHead.appendChild(pcWebTitleWrap);
    const pcWebStatusChip = buildEl(docRef, 'span', 'ag-chip', pcWebRunning && pcWebUrl ? '运行中' : '未启动');
    if (pcWebRunning && pcWebUrl) {
      pcWebStatusChip.setAttribute('data-remote-pcweb-status', 'running');
    } else {
      pcWebStatusChip.setAttribute('data-remote-pcweb-status', 'offline');
      pcWebStatusChip.setAttribute('data-tone', 'muted');
    }
    pcWebHead.appendChild(pcWebStatusChip);
    pcWebCard.appendChild(pcWebHead);

    if (pcWebRunning && pcWebUrl) {
      const pcWebUrlRow = buildEl(docRef, 'div', 'ag-url-row');
      const pcWebUrlInput = buildEl(docRef, 'input', 'settings-input');
      pcWebUrlInput.type = 'text';
      pcWebUrlInput.value = pcWebUrl;
      pcWebUrlInput.setAttribute('readonly', 'true');
      pcWebUrlInput.setAttribute('data-remote-pcweb-url-input', 'true');
      pcWebUrlRow.appendChild(pcWebUrlInput);
      pcWebCard.appendChild(pcWebUrlRow);

      const pcWebActions = buildEl(docRef, 'div', 'ag-remote-pcweb-actions');

      const openPcWebBtn = buildEl(docRef, 'button', 'ag-btn ag-btn-primary', '浏览器打开');
      openPcWebBtn.type = 'button';
      openPcWebBtn.setAttribute('data-remote-pcweb-open', 'true');
      openPcWebBtn.addEventListener('click', () => {
        void ctx.bridge.post('/open-pc-web', {})
          .then((res) => {
            if (!res?.ok) {
              globalThis.open?.(pcWebUrl, '_blank', 'noopener,noreferrer');
            }
            openPcWebBtn.textContent = '已打开';
            clearTimeout(pcWebOpenHintTimer);
            pcWebOpenHintTimer = setTimeout(() => { openPcWebBtn.textContent = '浏览器打开'; }, 1500);
          })
          .catch(() => {
            try { globalThis.open?.(pcWebUrl, '_blank', 'noopener,noreferrer'); } catch {}
            openPcWebBtn.textContent = '已打开';
            clearTimeout(pcWebOpenHintTimer);
            pcWebOpenHintTimer = setTimeout(() => { openPcWebBtn.textContent = '浏览器打开'; }, 1500);
          });
      });

      const copyPcWebBtn = buildEl(docRef, 'button', 'ag-btn', '复制链接');
      copyPcWebBtn.type = 'button';
      copyPcWebBtn.setAttribute('data-remote-pcweb-copy', 'true');
      copyPcWebBtn.addEventListener('click', () => {
        try { globalThis.navigator?.clipboard?.writeText?.(pcWebUrl); } catch {}
        copyPcWebBtn.textContent = '已复制';
        clearTimeout(pcWebCopyHintTimer);
        pcWebCopyHintTimer = setTimeout(() => { copyPcWebBtn.textContent = '复制链接'; }, 1500);
      });

      pcWebActions.appendChild(openPcWebBtn);
      pcWebActions.appendChild(copyPcWebBtn);
      pcWebCard.appendChild(pcWebActions);

      const cfHintText = formatPcWebCloudflareHint(pcWeb?.cloudflareState);
      if (cfHintText) {
        const cfHintEl = buildEl(docRef, 'div', 'ag-remote-pcweb-hint', cfHintText);
        cfHintEl.setAttribute('data-remote-pcweb-hint', 'true');
        pcWebCard.appendChild(cfHintEl);
      }
    } else {
      const hintEl = buildEl(
        docRef,
        'div',
        'ag-remote-pcweb-hint',
        'PC Web 工作台尚未启动。启用并运行「PC Web 工作台 (agy-daddy.web)」插件后，将自动显示本机访问链接。'
      );
      hintEl.setAttribute('data-remote-pcweb-hint', 'true');
      pcWebCard.appendChild(hintEl);
    }

    panelNode.appendChild(pcWebCard);
  }

  function formatUnitText() {
    return formatPrimaryChannelLabel(latestStatus, latestPairing);
  }

  function renderUnit() {
    void ctx.topbar.updateUnit('remote', {
      label: formatUnitText(),
      iconSvg: buildRemoteIconSvg()
    }).catch(() => {});
  }

  popover = ctx.topbar.registerPopover({
    id: 'remote-panel',
    anchorId: 'remote',
    title: '远程访问',
    render(bodyNode) {
      bodyNode.setAttribute('data-remote-body', 'true');
      panelNode = bodyNode;
      renderPanel();
    },
    onToggle(open) {
      if (open) void refreshStatus(true);
    }
  });

  const stopUnit = ctx.topbar.registerUnit({
    id: 'remote',
    order: 60,
    iconSvg: buildRemoteIconSvg(),
    label: formatUnitText(),
    onClick() {
      popover?.toggle();
    }
  });

  const stopSettingsSub = ctx.settings.onChange((nextValues) => {
    latestStatus = mergeSettingsIntoStatus(nextValues, latestStatus);
    renderUnit();
    renderPanel();
    void refreshStatus(true);
  });

  const stopStateSub = ctx.state.subscribe('state:remote.status@1', (st) => {
    if (st) {
      latestStatus = st;
      renderUnit();
      renderPanel();
    }
  });

  const stopWebStateSub = ctx.state.subscribe('state:web.status@1', () => {
    void refreshStatus(true);
  });

  await refreshStatus(true);

  disposers.push(
    stopStyles,
    stopUnit,
    stopSettingsSub,
    stopStateSub,
    stopWebStateSub,
    () => { clearTimeout(copyHintTimer); copyHintTimer = null; },
    () => { clearTimeout(pcWebCopyHintTimer); pcWebCopyHintTimer = null; },
    () => { clearTimeout(pcWebOpenHintTimer); pcWebOpenHintTimer = null; },
    () => { panelNode = null; },
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
  REMOTE_PANEL_CSS,
  formatPrimaryChannelLabel,
  formatChannelSummary,
  mount,
  dispose
};
