'use strict';

let disposers = [];

const TERMINAL_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
  + '<rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" stroke-width="1.4"/>'
  + '<path d="M4.5 6.2L6.8 8.2L4.5 10.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<line x1="8.2" y1="10.2" x2="11.5" y2="10.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
  + '</svg>';

function parseQuickCommands(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  rawList.forEach((rawItem, idx) => {
    let name = '';
    let command = '';
    let pinToTopbar = true;
    let id = `quick-${idx}`;
    if (rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem)) {
      command = String(rawItem.command || '').trim();
      name = String(rawItem.name || '').trim();
      pinToTopbar = rawItem.pinToTopbar !== false;
      if (rawItem.id) id = String(rawItem.id);
    } else {
      const rawStr = String(rawItem ?? '').trim();
      if (!rawStr) return;
      if (rawStr.startsWith('{')) {
        try {
          const parsed = JSON.parse(rawStr);
          if (parsed && typeof parsed === 'object') {
            command = String(parsed.command || '').trim();
            name = String(parsed.name || '').trim();
            pinToTopbar = parsed.pinToTopbar !== false;
            if (parsed.id) id = String(parsed.id);
          }
        } catch {}
      }
      if (!command) command = rawStr;
    }
    if (!command) return;
    if (!name) name = command.split(/\s+/)[0] || `命令 ${idx + 1}`;
    out.push({ id, name, command, pinToTopbar });
  });
  return out;
}

function getPermissionLabel(mode) {
  switch (mode) {
    case 'plan': return '规划只读';
    case 'accept-edits': return '自动接受编辑';
    case 'auto': return '自动执行';
    case 'skip-permissions': return '免审核';
    default: return '默认权限';
  }
}

function isAbsoluteWorkspaceHint(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 512) return false;
  if (/^file:\/\//i.test(s)) return true;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  if (s.startsWith('/') && !s.startsWith('//') && s.length > 1) return true;
  return false;
}

function collectClickWorkspaceContext(ctx, docRef, contextCascadeId = '') {
  const doc = docRef || globalThis.document;
  const cascadeId = String(ctx?.hostDom?.getSessionId?.() || '').trim();
  const ctxCid = String(contextCascadeId || '').trim();
  const pageUrl = String((globalThis.location && globalThis.location.href) || doc?.URL || '').trim();
  const pageTitle = String(doc?.title || '').trim();

  let activeConversationTitle = '';
  const sidebarRows = [];
  try {
    const fromHostDom = ctx?.hostDom?.getSidebarRows?.();
    if (Array.isArray(fromHostDom)) sidebarRows.push(...fromHostDom);
  } catch {}
  if (sidebarRows.length === 0 && typeof doc?.querySelectorAll === 'function') {
    try {
      const queried = doc.querySelectorAll('[data-testid="conversation-row-sidebar"]');
      if (queried) sidebarRows.push(...Array.from(queried));
    } catch {}
  }
  for (const row of sidebarRows) {
    if (!row || typeof row.getAttribute !== 'function') continue;
    const isActive = row.getAttribute('aria-selected') === 'true'
      || row.getAttribute('aria-current') === 'true'
      || row.getAttribute('data-active') === 'true'
      || row.getAttribute('data-selected') === 'true'
      || row.getAttribute('data-state') === 'active';
    if (!isActive) continue;
    const txt = String(row.textContent || '').trim().split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
    if (txt) {
      activeConversationTitle = txt.slice(0, 200);
      break;
    }
  }

  const domPaths = [];
  const pushDomPath = (raw) => {
    const s = String(raw || '').trim();
    if (!isAbsoluteWorkspaceHint(s) || domPaths.includes(s)) return;
    if (domPaths.length < 8) domPaths.push(s);
  };

  if (typeof doc?.querySelectorAll === 'function') {
    try {
      const wsNodes = doc.querySelectorAll('[data-workspace-path], [data-workspace-uri], [data-project-path], [data-cwd]');
      for (const el of Array.from(wsNodes || [])) {
        for (const attr of ['data-workspace-path', 'data-workspace-uri', 'data-project-path', 'data-cwd']) {
          pushDomPath(el?.getAttribute?.(attr));
        }
      }
    } catch {}
    try {
      const titlebarEls = doc.querySelectorAll('[class*="@container/titlebar"] [title], [class*="@container/titlebar"] [aria-label]');
      for (const el of Array.from(titlebarEls || [])) {
        if (typeof el?.closest === 'function' && el.closest('#agy-daddy-host')) continue;
        pushDomPath(el?.getAttribute?.('title'));
        pushDomPath(el?.getAttribute?.('aria-label'));
      }
    } catch {}
  }

  const titlebarTexts = [];
  const pushTitlebarText = (raw) => {
    const s = String(raw || '').trim();
    if (!s || s.length > 120 || titlebarTexts.includes(s)) return;
    if (titlebarTexts.length < 12) titlebarTexts.push(s);
  };

  if (typeof doc?.querySelectorAll === 'function') {
    try {
      const bars = doc.querySelectorAll('[class*="@container/titlebar"]');
      for (const bar of Array.from(bars || [])) {
        if (typeof bar?.closest === 'function' && bar.closest('#agy-daddy-host')) continue;
        const leafCandidates = typeof bar.querySelectorAll === 'function'
          ? Array.from(bar.querySelectorAll('span, div, button, a, h1, h2'))
          : [];
        for (const node of leafCandidates) {
          if (typeof node?.closest === 'function' && node.closest('#agy-daddy-host')) continue;
          if (Array.isArray(node.children) && node.children.length > 0) continue;
          const txt = String(node.textContent || '').trim();
          if (txt && txt.length >= 2) pushTitlebarText(txt);
        }
        if (leafCandidates.length === 0) {
          const barText = String(bar.textContent || '').trim();
          if (barText) {
            for (const line of barText.split(/\r?\n/)) {
              if (line.trim().length >= 2) pushTitlebarText(line.trim());
            }
          }
        }
      }
    } catch {}
  }

  const workspaceNameHints = [];
  const pushWsName = (raw) => {
    const s = String(raw || '').trim();
    if (!s || s.length < 2 || s.length > 120 || workspaceNameHints.includes(s)) return;
    if (workspaceNameHints.length < 12) workspaceNameHints.push(s);
  };
  for (const t of titlebarTexts) pushWsName(t);
  if (pageTitle) {
    for (const seg of pageTitle.split(/\s+[—–\-|·]\s+|\s+-\s+/)) {
      pushWsName(seg);
    }
  }

  return {
    cascadeId: cascadeId || undefined,
    contextCascadeId: ctxCid || undefined,
    workspaceHints: {
      pageUrl,
      pageTitle,
      activeConversationTitle,
      domPaths,
      titlebarTexts,
      workspaceNameHints
    }
  };
}

async function mount(ctx) {
  let settings = {
    terminalApp: 'auto',
    customTerminalPath: '',
    cliMuxHost: '',
    cliLabel: 'CLI',
    cliDefaultModel: '',
    cliPermissionMode: 'default',
    cliDefaultCommand: '',
    quickCommands: [],
    ...(ctx.settings.get() || {})
  };
  const quickUnits = new Map();
  const feedbackTimers = new Map();
  let contextCascadeId = '';
  let popoverNode = null;
  let popover = null;

  const stopContextSub = typeof ctx.state?.subscribe === 'function'
    ? ctx.state.subscribe('state:context.snapshot@1', (snap) => {
      const cid = typeof snap?.cascadeId === 'string' ? snap.cascadeId.trim() : '';
      if (cid) contextCascadeId = cid;
    })
    : () => {};

  const getCliLabel = () => String(settings.cliLabel || '').trim() || 'CLI';
  const getDefaultCommandPreview = () => String(settings.cliDefaultCommand || '').trim() || 'agy';

  const getUnitNormalTitle = (unitId) => {
    if (unitId === 'cli') return getDefaultCommandPreview();
    const rec = quickUnits.get(unitId);
    return rec ? rec.command : '';
  };

  const setUnitFeedbackTimer = (unitId, ms) => {
    const prev = feedbackTimers.get(unitId);
    if (prev) clearTimeout(prev);
    const tid = setTimeout(() => {
      feedbackTimers.delete(unitId);
      void ctx.topbar.updateUnit(unitId, { tone: '', title: getUnitNormalTitle(unitId) }).catch?.(() => {});
    }, ms);
    feedbackTimers.set(unitId, tid);
  };

  const launchCli = async (payload = {}, unitId = 'cli') => {
    const targetUnitId = unitId || 'cli';
    const prevTimer = feedbackTimers.get(targetUnitId);
    if (prevTimer) {
      clearTimeout(prevTimer);
      feedbackTimers.delete(targetUnitId);
    }
    try {
      void ctx.topbar.updateUnit(targetUnitId, { tone: 'accent' }).catch?.(() => {});
    } catch {}
    const docRef = popoverNode?.ownerDocument || globalThis.document;
    const clickCtx = collectClickWorkspaceContext(ctx, docRef, contextCascadeId);
    const body = {
      ...payload,
      ...(clickCtx.cascadeId ? { cascadeId: clickCtx.cascadeId } : {}),
      ...(clickCtx.contextCascadeId ? { contextCascadeId: clickCtx.contextCascadeId } : {}),
      workspaceHints: clickCtx.workspaceHints
    };
    try {
      const res = await ctx.bridge.post('/launch', body);
      if (!res || res.ok === false) {
        const errMsg = res?.error || '启动终端失败';
        console.warn('[agy-daddy.cli] launch failed:', errMsg);
        void ctx.topbar.updateUnit(targetUnitId, { tone: 'danger', title: `启动失败: ${errMsg}` }).catch?.(() => {});
        setUnitFeedbackTimer(targetUnitId, 4000);
        return;
      }
      setUnitFeedbackTimer(targetUnitId, 400);
    } catch (err) {
      const errMsg = err?.message || String(err);
      console.warn('[agy-daddy.cli] launch error:', errMsg);
      void ctx.topbar.updateUnit(targetUnitId, { tone: 'danger', title: `启动失败: ${errMsg}` }).catch?.(() => {});
      setUnitFeedbackTimer(targetUnitId, 4000);
    }
  };

  const renderPopover = () => {
    if (!popoverNode) return;
    const docRef = popoverNode.ownerDocument || globalThis.document;
    const commands = parseQuickCommands(settings.quickCommands);
    const cliLabel = getCliLabel();
    const defaultCmd = getDefaultCommandPreview();
    if (!docRef?.createElement) {
      popoverNode.textContent = [cliLabel, defaultCmd, ...commands.map((c) => `${c.name}: ${c.command}`)].join('\n');
      return;
    }
    popoverNode.textContent = '';

    const defaultCard = docRef.createElement('div');
    defaultCard.className = 'settings-card-box';
    const metaRow = docRef.createElement('div');
    metaRow.className = 'ag-card-title';
    const titleSpan = docRef.createElement('span');
    titleSpan.textContent = cliLabel;
    const permChip = docRef.createElement('span');
    permChip.className = 'ag-chip';
    permChip.textContent = getPermissionLabel(settings.cliPermissionMode);
    metaRow.appendChild(titleSpan);
    metaRow.appendChild(permChip);
    defaultCard.appendChild(metaRow);

    const infoLine = docRef.createElement('div');
    infoLine.className = 'ag-muted';
    const parts = [`终端: ${settings.terminalApp || 'auto'}`];
    if (settings.cliDefaultModel) parts.push(`模型: ${settings.cliDefaultModel}`);
    if (settings.cliMuxHost) parts.push(`SSH: ${settings.cliMuxHost}`);
    parts.push(`命令: ${defaultCmd}`);
    infoLine.textContent = parts.join(' · ');
    defaultCard.appendChild(infoLine);

    const cwdLine = docRef.createElement('div');
    cwdLine.className = 'ag-muted';
    cwdLine.setAttribute('data-cli-workspace-preview', 'true');
    cwdLine.textContent = '工作区: 探测中...';
    defaultCard.appendChild(cwdLine);
    if (typeof ctx.bridge?.post === 'function') {
      const clickCtx = collectClickWorkspaceContext(ctx, docRef, contextCascadeId);
      void ctx.bridge.post('/workspace', clickCtx).then((wsRes) => {
        if (wsRes?.ok && wsRes.cwd) {
          cwdLine.textContent = `工作区: ${wsRes.cwd}`;
        } else {
          cwdLine.textContent = '工作区: 将在点击时自动探测';
        }
      }).catch(() => {
        cwdLine.textContent = '工作区: 将在点击时自动探测';
      });
    }

    const launchBtn = docRef.createElement('button');
    launchBtn.type = 'button';
    launchBtn.className = 'ag-btn ag-btn-primary';
    launchBtn.setAttribute('data-cli-launch-default', 'true');
    launchBtn.textContent = `启动 ${cliLabel}`;
    launchBtn.addEventListener('click', () => {
      popover?.toggle?.(false);
      void launchCli({ commandName: cliLabel }, 'cli');
    });
    defaultCard.appendChild(launchBtn);
    popoverNode.appendChild(defaultCard);

    if (commands.length > 0) {
      const cmdCard = docRef.createElement('div');
      cmdCard.className = 'settings-card-box';
      const cmdHead = docRef.createElement('div');
      cmdHead.className = 'ag-card-title';
      const cmdTitle = docRef.createElement('span');
      cmdTitle.textContent = '自定义快捷命令';
      cmdHead.appendChild(cmdTitle);
      cmdCard.appendChild(cmdHead);

      for (const cmd of commands) {
        const itemBtn = docRef.createElement('button');
        itemBtn.type = 'button';
        itemBtn.className = 'ag-btn';
        itemBtn.setAttribute('data-cli-quick-launch', cmd.id);
        itemBtn.setAttribute('title', cmd.command);
        itemBtn.textContent = `${cmd.name} (${cmd.command})`;
        itemBtn.addEventListener('click', () => {
          popover?.toggle?.(false);
          void launchCli({ rawCommand: cmd.command, commandName: cmd.name }, cmd.id);
        });
        cmdCard.appendChild(itemBtn);
      }
      popoverNode.appendChild(cmdCard);
    }
  };

  const syncQuickUnits = () => {
    const commands = parseQuickCommands(settings.quickCommands);
    const desired = new Map();
    commands.forEach((cmd, idx) => {
      if (cmd.pinToTopbar === false) return;
      desired.set(cmd.id, {
        id: cmd.id,
        order: 41 + idx,
        label: cmd.name,
        command: cmd.command
      });
    });

    for (const [id, rec] of Array.from(quickUnits.entries())) {
      if (!desired.has(id)) {
        try { if (typeof rec.dispose === 'function') rec.dispose(); } catch {}
        quickUnits.delete(id);
      }
    }

    for (const [id, spec] of desired.entries()) {
      const existing = quickUnits.get(id);
      const clickHandler = () => {
        void launchCli({ rawCommand: spec.command, commandName: spec.label }, id);
      };
      if (existing) {
        existing.label = spec.label;
        existing.command = spec.command;
        existing.order = spec.order;
        void ctx.topbar.updateUnit(id, {
          label: spec.label,
          title: spec.command,
          order: spec.order,
          onClick: clickHandler
        });
      } else {
        const stopQuick = ctx.topbar.registerUnit({
          id,
          order: spec.order,
          label: spec.label,
          iconSvg: TERMINAL_ICON_SVG,
          title: spec.command,
          onClick: clickHandler
        });
        quickUnits.set(id, {
          dispose: stopQuick,
          label: spec.label,
          command: spec.command,
          order: spec.order
        });
      }
    }
  };

  const stopUnit = ctx.topbar.registerUnit({
    id: 'cli',
    order: 40,
    label: getCliLabel(),
    title: getDefaultCommandPreview(),
    iconSvg: TERMINAL_ICON_SVG,
    onClick() {
      const commands = parseQuickCommands(settings.quickCommands);
      const hasMenuItems = commands.some((c) => c.pinToTopbar === false);
      if (hasMenuItems && popover) {
        popover.toggle();
      } else {
        void launchCli({ commandName: getCliLabel() }, 'cli');
      }
    }
  });

  if (typeof ctx.topbar.registerPopover === 'function') {
    popover = ctx.topbar.registerPopover({
      id: 'cli-launcher',
      anchorId: 'cli',
      title: 'CLI 快速启动',
      render(bodyEl) {
        popoverNode = bodyEl;
        renderPopover();
      }
    });
  }

  syncQuickUnits();

  const stopSettingsSub = ctx.settings.onChange((nextValues) => {
    if (nextValues && typeof nextValues === 'object') {
      settings = { ...settings, ...nextValues };
      void ctx.topbar.updateUnit('cli', {
        label: getCliLabel(),
        title: getDefaultCommandPreview()
      });
      syncQuickUnits();
      renderPopover();
    }
  });

  disposers.push(
    () => {
      for (const tid of feedbackTimers.values()) {
        clearTimeout(tid);
      }
      feedbackTimers.clear();
    },
    () => {
      for (const rec of quickUnits.values()) {
        try { if (typeof rec.dispose === 'function') rec.dispose(); } catch {}
      }
      quickUnits.clear();
    },
    () => {
      try { popover?.dispose?.(); } catch {}
      popover = null;
      popoverNode = null;
    },
    stopUnit,
    stopSettingsSub,
    stopContextSub
  );
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  TERMINAL_ICON_SVG,
  parseQuickCommands,
  collectClickWorkspaceContext,
  mount,
  dispose
};
