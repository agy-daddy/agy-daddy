(function (root) {
  'use strict';

  const HOST_VERSION = '1.0.0';
  const HOST_ELEMENT_ID = 'agy-daddy-host';
  const DEFAULT_ACCENT = '#a78bfa';

  function getThemeEngine() {
    if (root && root.__AGYThemeEngine) return root.__AGYThemeEngine;
    if (typeof require === 'function') {
      try { return require('./theme'); } catch {}
    }
    return null;
  }

  function createHostRuntime(envOptions = {}) {
    const win = envOptions.window || root;
    const bootOpts = (win && win.__AGY_DADDY_BOOT_OPTIONS__ && typeof win.__AGY_DADDY_BOOT_OPTIONS__ === 'object')
      ? win.__AGY_DADDY_BOOT_OPTIONS__
      : {};
    try {
      if (win && '__AGY_DADDY_BOOT_OPTIONS__' in win) {
        delete win.__AGY_DADDY_BOOT_OPTIONS__;
      }
    } catch {}

    const mergedOpts = { ...bootOpts, ...envOptions };
    const doc = mergedOpts.document || root.document;
    let hostToken = String(mergedOpts.hostToken || '');
    const fetchFn = mergedOpts.fetch || win.fetch || globalThis.fetch;

    // 防重复挂载：清理已有宿主实例
    if (win.__AGYDaddyHost && typeof win.__AGYDaddyHost.dispose === 'function') {
      try { win.__AGYDaddyHost.dispose(); } catch {}
    }

    const state = {
      disposed: false,
      themeMode: mergedOpts.themeMode || 'auto',
      heatPreset: mergedOpts.heatPreset || 'purple',
      customColors: mergedOpts.customColors || {},
      locale: mergedOpts.locale || 'zh-CN',
      antigravityVersion: mergedOpts.antigravityVersion || '2.33.0',
      anchorsRegistry: mergedOpts.anchorsRegistry || { anchors: {} },
      bridgePort: Number(mergedOpts.bridgePort || 0),
      activeSettingsTab: 'plugins',
      updateInfo: { hasUpdate: false, currentVersion: HOST_VERSION, latestVersion: HOST_VERSION },
      manageLoading: false,
      manageBusyId: null,
      manageError: '',
      manageToast: null,
      managePlugins: [],
      manageCatalog: [],
      manageInstallSpec: '',
      manageCopyMode: false,
      managePendingPerm: null,
      manageConfirmUninstallId: null,
      units: new Map(),       // unitKey -> { pluginId, id, order, label, node, onClick, overflowItem }
      popovers: new Map(),    // popKey -> { pluginId, id, anchorId, node, onToggle }
      settingsTabs: new Map(),// tabKey -> { pluginId, id, title, schema, values }
      services: new Map(),    // svcName -> { pluginId, methods }
      events: new Map(),      // topic -> Set<{ pluginId, fn }>
      stickyState: new Map(), // key -> { value, version }
      stateSubs: new Map(),   // key -> Set<{ pluginId, fn }>
      timers: new Map(),      // pluginId -> Set<{ kind, id }>
      anchorSubs: new Map(),  // subId -> { pluginId, anchorName, fn, lastHit }
      pluginInstances: new Map(), // pluginId -> { mount, dispose, ctx, stats }
      crashCounts: new Map(), // pluginId -> number[]
      metrics: new Map(),     // pluginId -> { mountMs, observerMs, timersCount, crashes }
      xworldNonce: mergedOpts.xworldNonce || (String(Math.random()).slice(2) + Date.now().toString(36))
    };

    function getMetric(pluginId) {
      if (!state.metrics.has(pluginId)) {
        state.metrics.set(pluginId, { mountMs: 0, observerMs: 0, timersCount: 0, crashes: 0 });
      }
      return state.metrics.get(pluginId);
    }

    function disposeLegacyGlobals() {
      const cleaned = [];
      try {
        if (win.__AGEnhancer?.dispose) { win.__AGEnhancer.dispose(); cleaned.push('__AGEnhancer'); }
        delete win.__AGEnhancer;
      } catch {}
      try {
        if (typeof win.__AGY_CTX_CAPSULE_DISPOSE__ === 'function') { win.__AGY_CTX_CAPSULE_DISPOSE__(); cleaned.push('__AGY_CTX_CAPSULE__'); }
        win.__AGY_CTX_CAPSULE_ACTIVE__ = false;
      } catch {}
      try {
        if (typeof win.__antigravityZhPatchCleanup === 'function') { win.__antigravityZhPatchCleanup(); cleaned.push('__antigravityZhPatch'); }
        delete win.__antigravityZhPatchInstalled;
      } catch {}
      try {
        if (win.__AGContextMeter?.dispose) { win.__AGContextMeter.dispose(); cleaned.push('__AGContextMeter'); }
        delete win.__AGContextMeter;
      } catch {}
      try { delete win.__AGContextMeterLive; } catch {}
      return cleaned;
    }

    // Shadow DOM 宿主页壳与 Light DOM 共享样式
    let hostEl = null;
    let shadow = null;
    let barEl = null;
    let settingsBtnEl = null;
    let settingsPanelEl = null;
    let lightDomStyleEl = null;
    let themeObserver = null;
    let removeMediaListener = null;
    let activePopoverId = null;

    function ensureLightDomStyles() {
      if (!doc?.createElement) return;
      if (typeof __AGY_LIGHTDOM_CSS__ !== 'string' || !__AGY_LIGHTDOM_CSS__) return;
      const existing = doc.getElementById ? doc.getElementById('agy-daddy-lightdom-styles') : null;
      if (existing && existing.remove) existing.remove();
      lightDomStyleEl = doc.createElement('style');
      lightDomStyleEl.id = 'agy-daddy-lightdom-styles';
      lightDomStyleEl.textContent = __AGY_LIGHTDOM_CSS__;
      const styleHost = doc.head || doc.documentElement || doc.body;
      styleHost?.appendChild?.(lightDomStyleEl);
    }

    function startThemeWatchers() {
      if (!themeObserver && typeof MutationObserver === 'function') {
        themeObserver = new MutationObserver(() => {
          if (state.themeMode === 'auto') applyThemeVars();
        });
        for (const el of [doc?.body, doc?.documentElement]) {
          if (el) {
            try { themeObserver.observe(el, { attributes: true, attributeFilter: ['class', 'data-theme'] }); } catch {}
          }
        }
      }
      if (!removeMediaListener && typeof win?.matchMedia === 'function') {
        try {
          const mql = win.matchMedia('(prefers-color-scheme: light)');
          const onMql = () => { if (state.themeMode === 'auto') applyThemeVars(); };
          if (typeof mql?.addEventListener === 'function') {
            mql.addEventListener('change', onMql);
            removeMediaListener = () => mql.removeEventListener('change', onMql);
          }
        } catch {}
      }
    }

    function ensureDomShell() {
      if (!doc || typeof doc.createElement !== 'function') return null;
      if (hostEl && shadow) return shadow;
      const existing = doc.getElementById ? doc.getElementById(HOST_ELEMENT_ID) : null;
      if (existing && existing.remove) existing.remove();

      ensureLightDomStyles();

      hostEl = doc.createElement('div');
      hostEl.id = HOST_ELEMENT_ID;
      hostEl.setAttribute('data-agy-daddy', HOST_VERSION);
      hostEl.setAttribute('data-theme', state.themeMode === 'light' ? 'light' : 'dark');

      if (typeof hostEl.attachShadow === 'function') {
        shadow = hostEl.attachShadow({ mode: 'open' });
      } else {
        shadow = hostEl;
      }

      const styleEl = doc.createElement('style');
      styleEl.textContent = typeof __AGY_HOST_CSS__ === 'string' ? __AGY_HOST_CSS__ : '';
      shadow.appendChild(styleEl);

      barEl = doc.createElement('div');
      barEl.id = 'agy-topbar-slots';
      barEl.className = 'ag-bar';
      shadow.appendChild(barEl);

      const settingsBtn = doc.createElement('button');
      settingsBtnEl = settingsBtn;
      settingsBtn.id = 'agy-btn-settings';
      settingsBtn.type = 'button';
      settingsBtn.className = 'ag-unit';
      settingsBtn.textContent = 'Agy';
      const dot = doc.createElement('span');
      dot.id = 'agy-update-dot';
      dot.className = 'ag-update-dot';
      dot.hidden = !state.updateInfo?.hasUpdate;
      if (dot.hidden) dot.setAttribute?.('hidden', '');
      settingsBtn.appendChild(dot);
      settingsBtn.addEventListener('click', () => toggleSettingsPanel());
      barEl.appendChild(settingsBtn);

      settingsPanelEl = doc.createElement('section');
      settingsPanelEl.id = 'agy-settings-panel';
      settingsPanelEl.className = 'ag-panel';
      settingsPanelEl.hidden = true;
      shadow.appendChild(settingsPanelEl);

      const dockFlow = hostEl.getAttribute?.('data-dock') === 'flow';
      const anchorEl = dockFlow ? queryAnchor('topbar.rightCluster') : null;
      const isInteractive = anchorEl && /^(BUTTON|INPUT|A|SELECT|TEXTAREA)$/i.test(String(anchorEl.tagName || anchorEl.nodeName || ''));
      const mountTarget = (anchorEl && !isInteractive) ? anchorEl : (doc.body || doc.documentElement);
      if (mountTarget && typeof mountTarget.appendChild === 'function') {
        mountTarget.appendChild(hostEl);
      }
      applyThemeVars();
      startThemeWatchers();
      return shadow;
    }

    function applyThemeVars(accent = DEFAULT_ACCENT) {
      const themeEngine = getThemeEngine();
      let resolved = { accent, effectiveMode: state.themeMode === 'light' ? 'light' : 'dark', heatPreset: state.heatPreset };
      if (themeEngine && typeof themeEngine.applyThemeVariables === 'function') {
        resolved = themeEngine.applyThemeVariables(doc, hostEl, {
          window: win,
          themeMode: state.themeMode,
          heatPreset: state.heatPreset,
          customColors: {
            ...(state.customColors || {}),
            ...(accent && accent !== DEFAULT_ACCENT ? { tokenAccent: accent } : {})
          }
        });
      } else {
        if (doc?.documentElement?.style?.setProperty) {
          doc.documentElement.style.setProperty('--ag-effective-accent', accent);
        }
        if (hostEl?.style?.setProperty) {
          hostEl.style.setProperty('--ag-custom-token-accent', accent);
          hostEl.setAttribute('data-theme', state.themeMode === 'light' ? 'light' : 'dark');
        }
      }
      const nextSticky = {
        value: {
          themeMode: state.themeMode,
          heatPreset: resolved.heatPreset,
          effectiveMode: resolved.effectiveMode,
          accent: resolved.accent
        },
        version: (state.stickyState.get('state:host.theme@1')?.version || 0) + 1
      };
      state.stickyState.set('state:host.theme@1', nextSticky);
      const subs = state.stateSubs.get('state:host.theme@1');
      if (subs) {
        for (const s of Array.from(subs)) {
          try { s.fn(nextSticky.value, { version: nextSticky.version }); } catch {}
        }
      }
      return resolved;
    }

    function renderUnits() {
      if (!barEl) return;
      const sorted = Array.from(state.units.values()).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
      const settingsBtn = barEl.querySelector ? barEl.querySelector('#agy-btn-settings') : settingsBtnEl;
      const expectedNodes = sorted.map((u) => u.node).filter(Boolean);
      const kids = Array.isArray(barEl.children) ? barEl.children : [];
      const needsReorder = expectedNodes.some((node, idx) => kids[idx] !== node || node.parentElement !== barEl);
      if (!needsReorder) return;
      for (const node of expectedNodes) {
        if (settingsBtn && typeof barEl.insertBefore === 'function') {
          barEl.insertBefore(node, settingsBtn);
        } else if (typeof barEl.appendChild === 'function') {
          barEl.appendChild(node);
        }
      }
    }

    const FRIENDLY_SETTING_LABELS = {
      lang: '界面语言',
      brandTitle: '品牌标题显示',
      englishLabels: '保留英文专业标签',
      enableRemoteThinkingTranslation: '允许远程翻译思考片段',
      terminalApp: '首选终端',
      customTerminalPath: '自定义终端路径',
      cliMuxHost: '复用器 / 会话主机',
      cliDefaultModel: 'CLI 默认模型',
      cliSkipPermissions: '跳过交互权限确认（谨慎）',
      gatewayEnabled: '启用本地代理网关 (18766)',
      mode: '代理模式 (direct/upstream)',
      upstreamUrl: '上游代理地址',
      noProxy: '绕过直连规则 (NO_PROXY)',
      gatewayPort: '代理网关端口',
      fallbackToDirectOnUpstreamError: '上游异常时自动回退直连',
      showPulseCapsule: '显示底部能量胶囊',
      showSpeedInTopbar: '顶栏显示输出速率',
      pollIntervalMs: '采样周期 (ms)',
      warnThresholdTokens: '缓存预警阈值 (Tokens)',
      cliffThresholdTokens: '断崖警示阈值 (Tokens)',
      showCostInTopbar: '顶栏显示参考费用',
      ultraSubTier: '订阅档位',
      currency: '显示币种',
      showFloatDock: '显示右侧对话悬浮导航',
      keepThinkingExpanded: '自动保持思考过程展开',
      enableInlineFileEditor: '允许文件查看器内联编辑',
      enableCmdClickLinks: 'Cmd+点击打开安全外链',
      showCountdownInTopbar: '顶栏显示重置倒计时',
      showQuickBar: '显示输入框快捷指令栏',
      ghostSuggest: '启用下一步幽灵建议 (Tab)',
      autoAccept: '安全步骤自动确认',
      autoCompact: '超过 240K 自动压缩 (/compact)',
      autoCompactThresholdTokens: '自动压缩阈值 (Tokens)',
      autoCompactCooldownMs: '自动压缩冷却时间 (ms)',
      allowRemoteWrite: '允许手机端远程写入（默认仅只读）',
      loopback: '本机回环通道 (127.0.0.1)',
      lan: '局域网通道 (LAN)',
      tailscale: 'Tailscale 内网穿透通道',
      cloudflare: 'Cloudflare 公网隧道',
      tunnelMode: '隧道模式 (quick/named)',
      regexMode: '正则匹配检索',
      caseSensitive: '区分大小写'
    };

    const PRESET_LABELS = {
      purple: '梦幻紫',
      yellow: '暖阳黄',
      green: '森系绿',
      blue: '晴空蓝',
      red: '烈焰红'
    };

    function inferSchemaFromTab(tab) {
      if (tab.schema) return tab.schema;
      const entries = Object.entries(tab.values || {}).filter(([, v]) => (
        typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string'
      ));
      if (!entries.length) return null;
      return {
        title: tab.title || tab.pluginId,
        fields: entries.map(([key, val]) => ({
          key,
          label: FRIENDLY_SETTING_LABELS[key] || key,
          type: typeof val === 'boolean' ? 'boolean' : (typeof val === 'number' ? 'number' : 'string'),
          default: val
        }))
      };
    }

    function renderSettingsSchemaFields(schema, currentValues, onChange) {
      const wrap = doc.createElement('div');
      wrap.className = 'settings-card-box';
      const title = doc.createElement('div');
      title.className = 'ag-card-title';
      title.textContent = typeof schema.title === 'object' ? (schema.title[state.locale] || schema.title.en || '') : (schema.title || '');
      wrap.appendChild(title);

      for (const field of schema.fields || []) {
        const row = doc.createElement('label');
        row.className = 'settings-pref-row';
        const lbl = doc.createElement('span');
        lbl.textContent = typeof field.label === 'object' ? (field.label[state.locale] || field.label.en || field.key) : (field.label || field.key);
        row.appendChild(lbl);

        const val = currentValues[field.key] !== undefined ? currentValues[field.key] : field.default;
        if (field.type === 'boolean') {
          const toggleWrap = doc.createElement('span');
          toggleWrap.className = 'ag-toggle-label';
          const input = doc.createElement('input');
          input.type = 'checkbox';
          input.checked = Boolean(val);
          input.setAttribute('data-setting-key', field.key);
          input.addEventListener('change', () => onChange(field.key, Boolean(input.checked)));
          toggleWrap.appendChild(input);
          row.appendChild(toggleWrap);
        } else if (field.type === 'enum') {
          const sel = doc.createElement('select');
          sel.className = 'settings-input';
          sel.setAttribute('data-setting-key', field.key);
          for (const opt of field.options || []) {
            const o = doc.createElement('option');
            const optVal = typeof opt === 'object' ? opt.value : opt;
            o.value = String(optVal);
            o.textContent = typeof opt === 'object' ? String(opt.label || optVal) : String(optVal);
            if (optVal === val) o.selected = true;
            sel.appendChild(o);
          }
          sel.addEventListener('change', () => onChange(field.key, sel.value));
          row.appendChild(sel);
        } else {
          const input = doc.createElement('input');
          input.type = field.type === 'number' ? 'number' : 'text';
          input.className = 'settings-input';
          input.value = val !== undefined ? String(val) : '';
          input.setAttribute('data-setting-key', field.key);
          input.addEventListener('change', () => onChange(field.key, field.type === 'number' ? Number(input.value) : input.value));
          row.appendChild(input);
        }
        wrap.appendChild(row);
      }
      return wrap;
    }

    const SETTINGS_TABS = [
      { id: 'plugins', label: '插件设置' },
      { id: 'theme', label: '外观与主题' },
      { id: 'health', label: '健康与诊断' },
      { id: 'manage', label: '插件管理' },
      { id: 'general', label: '更新与通用' }
    ];

    function setAnchorButtonActive(pluginId, anchorId, active) {
      if (!anchorId) return;
      const exactKey = `${pluginId}:${anchorId}`;
      const unit = state.units.get(exactKey)
        || Array.from(state.units.values()).find((u) => u.id === anchorId);
      if (unit?.node?.setAttribute) {
        unit.node.setAttribute('data-active', active ? 'true' : 'false');
      }
    }

    function positionPopoverNearAnchor(panelNode, pluginId, anchorId) {
      if (!panelNode?.style?.setProperty || !anchorId) return;
      const exactKey = `${pluginId}:${anchorId}`;
      const unit = state.units.get(exactKey)
        || Array.from(state.units.values()).find((u) => u.id === anchorId);
      const rect = unit?.node?.getBoundingClientRect ? unit.node.getBoundingClientRect() : null;
      const vw = Number(win?.innerWidth || doc?.documentElement?.clientWidth || 0);
      if (rect && rect.width > 0 && vw > 0) {
        const rightPx = Math.max(12, Math.min(vw - 220, Math.round(vw - rect.right)));
        panelNode.style.setProperty('right', `${rightPx}px`);
        panelNode.style.setProperty('left', 'auto');
        panelNode.style.setProperty('top', `${Math.max(36, Math.round(rect.bottom + 8))}px`);
      }
    }

    function closeAllPopovers(exceptKey = null) {
      if (exceptKey !== '__settings__' && settingsPanelEl && !settingsPanelEl.hidden) {
        settingsPanelEl.hidden = true;
        settingsBtnEl?.setAttribute?.('data-active', 'false');
      }
      for (const [k, p] of state.popovers.entries()) {
        if (k === exceptKey) continue;
        if (p.node && !p.node.hidden) {
          p.node.hidden = true;
          setAnchorButtonActive(p.pluginId, p.anchorId, false);
          if (typeof p.onToggle === 'function') {
            try { p.onToggle(false); } catch {}
          }
        }
      }
      if (!exceptKey || exceptKey === '__settings__') {
        activePopoverId = null;
      }
      const anyOpen = (settingsPanelEl && !settingsPanelEl.hidden)
        || Array.from(state.popovers.values()).some((p) => p.node && !p.node.hidden);
      hostEl?.setAttribute?.('data-elevated', anyOpen ? 'true' : 'false');
    }

    async function hostBridgePost(routePath, payload = {}) {
      if (!state.bridgePort || !hostToken || typeof fetchFn !== 'function') {
        throw new Error('HOST_BRIDGE_UNAVAILABLE');
      }
      const cleanRoute = routePath.startsWith('/') ? routePath : `/${routePath}`;
      const resp = await fetchFn(`http://127.0.0.1:${state.bridgePort}${cleanRoute}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AGY-Host-Token': hostToken
        },
        body: JSON.stringify(payload || {})
      });
      const data = await resp.json();
      if (!resp.ok && !data?.needsPermissionConfirm) {
        throw new Error(data?.error || `HTTP ${resp.status}`);
      }
      return data;
    }

    function applyManagePayload(data) {
      if (Array.isArray(data?.plugins)) state.managePlugins = data.plugins;
      if (Array.isArray(data?.catalog)) state.manageCatalog = data.catalog;
    }

    async function fetchManagePlugins() {
      if (!state.bridgePort || !hostToken) return;
      state.manageLoading = true;
      state.manageError = '';
      if (state.activeSettingsTab === 'manage' && settingsPanelEl && !settingsPanelEl.hidden) {
        renderSettingsPanel();
      }
      try {
        const res = await hostBridgePost('/host/plugins', {});
        applyManagePayload(res);
      } catch (err) {
        state.manageError = err?.message || String(err);
      } finally {
        state.manageLoading = false;
        if (state.activeSettingsTab === 'manage' && settingsPanelEl && !settingsPanelEl.hidden) {
          renderSettingsPanel();
        }
      }
    }

    async function runManageAction(busyId, pendingMsg, fn) {
      if (state.manageBusyId) return;
      state.manageBusyId = busyId;
      state.manageError = '';
      state.manageToast = { tone: 'info', spinning: true, text: pendingMsg };
      renderSettingsPanel();
      try {
        await fn();
      } catch (err) {
        state.manageToast = { tone: 'error', spinning: false, text: `操作失败：${err?.message || String(err)}` };
      } finally {
        state.manageBusyId = null;
        if (settingsPanelEl && !settingsPanelEl.hidden) {
          renderSettingsPanel();
        }
      }
    }

    function renderManageTab() {
      const hasBridge = Boolean(state.bridgePort && hostToken && typeof fetchFn === 'function');
      const items = state.managePlugins.length
        ? state.managePlugins
        : Array.from(state.pluginInstances.keys()).map((id) => ({
            id,
            displayName: id,
            description: '',
            version: '1.0.0',
            trustLevel: id.startsWith('agy-daddy.') ? 'T0' : (id.startsWith('community.') ? 'T1' : 'T2'),
            enabled: true,
            active: true,
            hasNative: false,
            hasRollback: false,
            sourceKind: 'memory'
          }));

      if (state.manageToast || state.manageError || state.manageLoading) {
        const toast = doc.createElement('div');
        toast.id = 'agy-manage-toast';
        toast.className = 'ag-manage-toast';
        const tone = state.manageError ? 'error' : (state.manageToast?.tone || 'info');
        toast.setAttribute('data-tone', tone);
        if (state.manageLoading || state.manageToast?.spinning) {
          const sp = doc.createElement('span');
          sp.className = 'ag-spinner';
          toast.appendChild(sp);
        }
        const txt = doc.createElement('span');
        txt.textContent = state.manageError
          ? `加载失败：${state.manageError}`
          : (state.manageToast?.text || '正在加载插件列表...');
        toast.appendChild(txt);
        settingsPanelEl.appendChild(toast);
      }

      // 1. 安装插件卡片
      const installCard = doc.createElement('div');
      installCard.className = 'settings-card-box';
      installCard.id = 'agy-plugin-install-box';
      const installHead = doc.createElement('div');
      installHead.className = 'ag-card-title';
      installHead.textContent = '安装外部或本地插件';
      const modeBtn = doc.createElement('button');
      modeBtn.type = 'button';
      modeBtn.id = 'agy-install-mode-btn';
      modeBtn.className = 'ag-btn';
      modeBtn.textContent = state.manageCopyMode ? '模式：复制安装' : '模式：本地软链';
      modeBtn.addEventListener('click', () => {
        state.manageCopyMode = !state.manageCopyMode;
        renderSettingsPanel();
      });
      installHead.appendChild(modeBtn);
      installCard.appendChild(installHead);

      const installRow = doc.createElement('div');
      installRow.className = 'ag-install-row';
      const installInput = doc.createElement('input');
      installInput.type = 'text';
      installInput.id = 'agy-plugin-install-input';
      installInput.className = 'settings-input';
      installInput.placeholder = '本地目录路径、github:作者/仓库 或 npm:包名';
      installInput.value = state.manageInstallSpec;
      installInput.addEventListener('input', () => { state.manageInstallSpec = installInput.value; });
      installInput.addEventListener('change', () => { state.manageInstallSpec = installInput.value; });
      installInput.addEventListener('keydown', (e) => {
        if (e?.key === 'Enter') triggerInstall(installInput.value);
      });

      const installBtn = doc.createElement('button');
      installBtn.type = 'button';
      installBtn.id = 'agy-plugin-install-btn';
      installBtn.className = 'ag-btn ag-btn-primary';
      const isInstalling = state.manageBusyId === '__install__';
      installBtn.disabled = Boolean(state.manageBusyId) || !hasBridge;
      if (isInstalling) {
        const sp = doc.createElement('span');
        sp.className = 'ag-spinner';
        installBtn.appendChild(sp);
      }
      const installBtnLbl = doc.createElement('span');
      installBtnLbl.textContent = isInstalling ? '安装中...' : '安装';
      installBtn.appendChild(installBtnLbl);

      const triggerInstall = (specVal, extraOpts = {}) => {
        const spec = String(specVal || '').trim();
        if (!spec) {
          state.manageToast = { tone: 'warn', spinning: false, text: '请输入插件目录路径、github: 或 npm: 地址' };
          renderSettingsPanel();
          return;
        }
        state.manageInstallSpec = spec;
        state.manageConfirmUninstallId = null;
        void runManageAction(extraOpts.busyId || '__install__', `正在安装 ${spec}...`, async () => {
          const res = await hostBridgePost('/host/plugins/install', {
            spec,
            copy: extraOpts.copy !== undefined ? extraOpts.copy : state.manageCopyMode,
            trustLevel: extraOpts.trustLevel,
            grantedPermissions: extraOpts.grantedPermissions || []
          });
          if (res?.needsPermissionConfirm) {
            state.managePendingPerm = {
              spec: res.spec || spec,
              trustLevel: res.trustPolicy?.trustLevel || 'T2',
              denied: res.trustPolicy?.denied || [],
              granted: res.trustPolicy?.granted || [],
              warnings: res.trustPolicy?.warnings || [],
              copy: extraOpts.copy !== undefined ? extraOpts.copy : state.manageCopyMode
            };
            state.manageToast = { tone: 'warn', spinning: false, text: `安装 ${spec} 需要确认授权以下权限` };
            return;
          }
          state.managePendingPerm = null;
          state.manageInstallSpec = '';
          applyManagePayload(res);
          state.manageToast = { tone: 'info', spinning: false, text: `已安装并热加载 ${res.plugin?.id || spec}` };
        });
      };

      installBtn.addEventListener('click', () => triggerInstall(installInput.value));
      installRow.appendChild(installInput);
      installRow.appendChild(installBtn);
      installCard.appendChild(installRow);

      if (state.managePendingPerm) {
        const pInfo = state.managePendingPerm;
        const permBox = doc.createElement('div');
        permBox.id = 'agy-perm-confirm-box';
        permBox.className = 'ag-perm-confirm-box';
        const permTitle = doc.createElement('div');
        permTitle.className = 'ag-card-title';
        permTitle.textContent = `需要授权 (${pInfo.trustLevel})：${pInfo.spec}`;
        permBox.appendChild(permTitle);

        const permTags = doc.createElement('div');
        permTags.className = 'ag-channels-row';
        for (const perm of pInfo.denied) {
          const chip = doc.createElement('span');
          chip.className = 'ag-chip';
          chip.setAttribute('data-tone', 'warn');
          chip.textContent = perm;
          permTags.appendChild(chip);
        }
        permBox.appendChild(permTags);

        const permActions = doc.createElement('div');
        permActions.className = 'ag-panel-actions';
        const confirmBtn = doc.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.id = 'agy-perm-confirm-btn';
        confirmBtn.className = 'ag-btn ag-btn-primary';
        confirmBtn.textContent = '授权并安装';
        confirmBtn.addEventListener('click', () => {
          triggerInstall(pInfo.spec, {
            trustLevel: pInfo.trustLevel,
            grantedPermissions: pInfo.denied,
            copy: pInfo.copy
          });
        });
        const cancelPermBtn = doc.createElement('button');
        cancelPermBtn.type = 'button';
        cancelPermBtn.id = 'agy-perm-cancel-btn';
        cancelPermBtn.className = 'ag-btn';
        cancelPermBtn.textContent = '取消';
        cancelPermBtn.addEventListener('click', () => {
          state.managePendingPerm = null;
          state.manageToast = null;
          renderSettingsPanel();
        });
        permActions.appendChild(confirmBtn);
        permActions.appendChild(cancelPermBtn);
        permBox.appendChild(permActions);
        installCard.appendChild(permBox);
      }

      settingsPanelEl.appendChild(installCard);

      // 2. 已安装插件列表卡片
      const card = doc.createElement('div');
      card.className = 'settings-card-box';
      card.id = 'agy-manage-settings-card';
      const cTitle = doc.createElement('div');
      cTitle.className = 'ag-card-title';
      const enabledCount = items.filter((p) => p.enabled !== false).length;
      cTitle.textContent = `已安装插件 (${enabledCount}/${items.length} 启用)`;
      if (hasBridge) {
        const refreshListBtn = doc.createElement('button');
        refreshListBtn.type = 'button';
        refreshListBtn.id = 'agy-manage-refresh-btn';
        refreshListBtn.className = 'ag-btn';
        refreshListBtn.textContent = '↻ 刷新列表';
        refreshListBtn.disabled = Boolean(state.manageLoading || state.manageBusyId);
        refreshListBtn.addEventListener('click', () => { void fetchManagePlugins(); });
        cTitle.appendChild(refreshListBtn);
      }
      card.appendChild(cTitle);

      for (const p of items) {
        const item = doc.createElement('div');
        item.className = 'ag-plugin-item';
        item.setAttribute('data-plugin-id', p.id);
        item.setAttribute('data-enabled', p.enabled !== false ? 'true' : 'false');

        const top = doc.createElement('div');
        top.className = 'ag-plugin-top';

        const info = doc.createElement('div');
        info.className = 'ag-plugin-info';
        const nameSpan = doc.createElement('span');
        nameSpan.className = 'ag-plugin-name';
        nameSpan.textContent = p.displayName || p.id;
        const verSpan = doc.createElement('span');
        verSpan.className = 'ag-muted';
        verSpan.textContent = `v${p.version || '1.0.0'}`;
        const badge = doc.createElement('span');
        badge.className = 'agy-trust-badge';
        const tLevel = p.trustLevel || (p.id.startsWith('agy-daddy.') ? 'T0' : (p.id.startsWith('community.') ? 'T1' : 'T2'));
        const tText = tLevel === 'T0' ? 'T0 官方' : (tLevel === 'T1' ? 'T1 社区' : 'T2');
        badge.setAttribute('data-trust', tLevel);
        badge.textContent = tText;
        info.appendChild(nameSpan);
        info.appendChild(verSpan);
        info.appendChild(badge);
        if (p.hasNative) {
          const nChip = doc.createElement('span');
          nChip.className = 'ag-chip';
          nChip.textContent = '原生扩展';
          info.appendChild(nChip);
        }
        top.appendChild(info);

        const actions = doc.createElement('div');
        actions.className = 'ag-plugin-actions';
        const isBusy = state.manageBusyId === p.id;
        if (isBusy) {
          const sp = doc.createElement('span');
          sp.className = 'ag-spinner';
          actions.appendChild(sp);
        }

        if (hasBridge) {
          const toggleWrap = doc.createElement('label');
          toggleWrap.className = 'ag-toggle-label';
          toggleWrap.setAttribute('title', p.enabled !== false ? '点击停用插件' : '点击启用插件');
          const toggleInput = doc.createElement('input');
          toggleInput.type = 'checkbox';
          toggleInput.checked = p.enabled !== false;
          toggleInput.disabled = Boolean(state.manageBusyId);
          toggleInput.setAttribute('data-plugin-toggle', p.id);
          toggleInput.addEventListener('change', () => {
            const want = Boolean(toggleInput.checked);
            state.manageConfirmUninstallId = null;
            void runManageAction(p.id, `正在${want ? '启用' : '停用'} ${p.id}...`, async () => {
              const res = await hostBridgePost('/host/plugins/toggle', { pluginId: p.id, enabled: want });
              applyManagePayload(res);
              state.manageToast = { tone: 'info', spinning: false, text: `已${want ? '启用' : '停用'} ${p.id}` };
            });
          });
          toggleWrap.appendChild(toggleInput);
          actions.appendChild(toggleWrap);

          const reloadBtn = doc.createElement('button');
          reloadBtn.type = 'button';
          reloadBtn.className = 'ag-btn';
          reloadBtn.textContent = '↻';
          reloadBtn.setAttribute('title', '热重载插件');
          reloadBtn.setAttribute('data-plugin-reload', p.id);
          reloadBtn.disabled = Boolean(state.manageBusyId) || p.enabled === false;
          reloadBtn.addEventListener('click', () => {
            state.manageConfirmUninstallId = null;
            void runManageAction(p.id, `正在热重载 ${p.id}...`, async () => {
              const res = await hostBridgePost('/host/reload', { pluginId: p.id });
              applyManagePayload(res);
              state.manageToast = { tone: 'info', spinning: false, text: `已热重载 ${p.id}` };
            });
          });
          actions.appendChild(reloadBtn);

          if (p.hasRollback) {
            const rbBtn = doc.createElement('button');
            rbBtn.type = 'button';
            rbBtn.className = 'ag-btn';
            rbBtn.textContent = '回滚';
            rbBtn.setAttribute('data-plugin-rollback', p.id);
            rbBtn.disabled = Boolean(state.manageBusyId);
            rbBtn.addEventListener('click', () => {
              state.manageConfirmUninstallId = null;
              void runManageAction(p.id, `正在回滚 ${p.id}...`, async () => {
                const res = await hostBridgePost('/host/plugins/rollback', { pluginId: p.id });
                applyManagePayload(res);
                state.manageToast = { tone: 'info', spinning: false, text: `已回滚 ${p.id}` };
              });
            });
            actions.appendChild(rbBtn);
          }

          if (p.sourceKind !== 'memory') {
            const confirming = state.manageConfirmUninstallId === p.id;
            const unBtn = doc.createElement('button');
            unBtn.type = 'button';
            unBtn.className = 'ag-btn ag-btn-danger';
            unBtn.textContent = confirming ? '确认卸载?' : '卸载';
            unBtn.setAttribute('data-plugin-uninstall', p.id);
            unBtn.disabled = Boolean(state.manageBusyId);
            unBtn.addEventListener('click', () => {
              if (!confirming) {
                state.manageConfirmUninstallId = p.id;
                state.manageToast = { tone: 'warn', spinning: false, text: `再次点击「确认卸载?」将移除 ${p.id}${p.hasNative ? ' 及其原生扩展' : ''}` };
                renderSettingsPanel();
                return;
              }
              state.manageConfirmUninstallId = null;
              void runManageAction(p.id, `正在卸载 ${p.id}...`, async () => {
                const res = await hostBridgePost('/host/plugins/uninstall', { pluginId: p.id });
                applyManagePayload(res);
                state.manageToast = {
                  tone: 'info',
                  spinning: false,
                  text: `已卸载 ${p.id}${res.nativeCleanup?.removed ? '（已同步清理原生扩展）' : ''}`
                };
              });
            });
            actions.appendChild(unBtn);
          }
        }
        top.appendChild(actions);
        item.appendChild(top);

        const meta = doc.createElement('div');
        meta.className = 'ag-plugin-meta';
        const statusTxt = p.enabled === false ? '已停用' : (p.active ? '运行中' : '未激活');
        meta.textContent = `${p.id} · ${statusTxt}${p.world ? ` · ${p.world}` : ''}${p.description ? ` · ${p.description}` : ''}`;
        item.appendChild(meta);
        card.appendChild(item);
      }
      settingsPanelEl.appendChild(card);

      // 3. 可一键安装（本机未安装候选）
      if (hasBridge && state.manageCatalog.length > 0) {
        const catCard = doc.createElement('div');
        catCard.className = 'settings-card-box';
        catCard.id = 'agy-plugin-catalog-card';
        const catTitle = doc.createElement('div');
        catTitle.className = 'ag-card-title';
        catTitle.textContent = `可一键安装 (${state.manageCatalog.length})`;
        catCard.appendChild(catTitle);

        for (const cat of state.manageCatalog) {
          const item = doc.createElement('div');
          item.className = 'ag-plugin-item';
          item.setAttribute('data-catalog-id', cat.id);
          const top = doc.createElement('div');
          top.className = 'ag-plugin-top';
          const info = doc.createElement('div');
          info.className = 'ag-plugin-info';
          const catName = doc.createElement('span');
          catName.className = 'ag-plugin-name';
          catName.textContent = cat.displayName || cat.id;
          info.appendChild(catName);
          const badge = doc.createElement('span');
          badge.className = 'agy-trust-badge';
          badge.setAttribute('data-trust', cat.trustLevel || 'T0');
          badge.textContent = cat.trustLevel === 'T1' ? 'T1 社区' : (cat.trustLevel === 'T0' ? 'T0 官方' : 'T2');
          info.appendChild(badge);
          top.appendChild(info);

          const addBtn = doc.createElement('button');
          addBtn.type = 'button';
          addBtn.className = 'ag-btn ag-btn-primary';
          addBtn.setAttribute('data-catalog-install', cat.id);
          addBtn.disabled = Boolean(state.manageBusyId);
          addBtn.textContent = state.manageBusyId === cat.id ? '安装中...' : '+ 安装';
          addBtn.addEventListener('click', () => {
            triggerInstall(cat.recommendedSpec, {
              busyId: cat.id,
              trustLevel: cat.trustLevel,
              copy: state.manageCopyMode
            });
          });
          top.appendChild(addBtn);
          item.appendChild(top);

          const meta = doc.createElement('div');
          meta.className = 'ag-plugin-meta';
          meta.textContent = `${cat.id} · ${cat.description || cat.recommendedSpec}`;
          item.appendChild(meta);
          catCard.appendChild(item);
        }
        settingsPanelEl.appendChild(catCard);
      }
    }

    function renderSettingsPanel() {
      if (!settingsPanelEl) return;
      settingsPanelEl.innerHTML = '';
      if (Array.isArray(settingsPanelEl.children)) settingsPanelEl.children.length = 0;

      const header = doc.createElement('div');
      header.className = 'ag-panel-head';
      const titleWrap = doc.createElement('div');
      titleWrap.className = 'ag-panel-title-wrap';
      const titleSpan = doc.createElement('span');
      titleSpan.className = 'ag-panel-title';
      titleSpan.textContent = 'Agy-Daddy 开放底座设置中心';
      const verChip = doc.createElement('span');
      verChip.className = 'ag-chip';
      verChip.textContent = `v${HOST_VERSION}`;
      titleWrap.appendChild(titleSpan);
      titleWrap.appendChild(verChip);
      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ag-icon-btn';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', () => toggleSettingsPanel(false));
      header.appendChild(titleWrap);
      header.appendChild(closeBtn);
      settingsPanelEl.appendChild(header);

      const tabBar = doc.createElement('div');
      tabBar.id = 'agy-settings-tab-bar';
      tabBar.className = 'ag-settings-tabs';
      for (const tabDef of SETTINGS_TABS) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.id = `agy-tab-${tabDef.id}`;
        btn.className = tabDef.id === state.activeSettingsTab ? 'switch-pill-btn active' : 'switch-pill-btn';
        btn.textContent = tabDef.label;
        btn.addEventListener('click', () => {
          state.activeSettingsTab = tabDef.id;
          state.manageConfirmUninstallId = null;
          renderSettingsPanel();
          if (tabDef.id === 'manage') {
            void fetchManagePlugins();
          }
        });
        tabBar.appendChild(btn);
      }
      settingsPanelEl.appendChild(tabBar);

      if (state.activeSettingsTab === 'theme') {
        const modeCard = doc.createElement('div');
        modeCard.className = 'settings-card-box';
        const modeTitle = doc.createElement('div');
        modeTitle.className = 'ag-card-title';
        modeTitle.textContent = '外观模式';
        modeCard.appendChild(modeTitle);
        const modeRow = doc.createElement('div');
        modeRow.className = 'ag-swatch-row';
        for (const mOpt of [
          { id: 'auto', label: '跟随客户端 (自动)' },
          { id: 'light', label: '浅色模式' },
          { id: 'dark', label: '深色模式' }
        ]) {
          const mBtn = doc.createElement('button');
          mBtn.type = 'button';
          mBtn.id = `agy-theme-mode-${mOpt.id}`;
          mBtn.className = 'qp-pool-chip';
          mBtn.setAttribute('data-active', state.themeMode === mOpt.id ? 'true' : 'false');
          mBtn.textContent = mOpt.label;
          mBtn.addEventListener('click', () => {
            state.themeMode = mOpt.id;
            applyThemeVars();
            renderSettingsPanel();
          });
          modeRow.appendChild(mBtn);
        }
        modeCard.appendChild(modeRow);
        settingsPanelEl.appendChild(modeCard);

        const card = doc.createElement('div');
        card.className = 'settings-card-box';
        card.id = 'agy-theme-settings-card';
        const presetTitle = doc.createElement('div');
        presetTitle.className = 'ag-card-title';
        presetTitle.textContent = '强调色与热力图色板（5 套主题）';
        card.appendChild(presetTitle);

        const swatchRow = doc.createElement('div');
        swatchRow.className = 'ag-swatch-row';
        const engine = getThemeEngine();
        const presetsMap = engine?.HEAT_PRESETS || {};
        const presetKeys = Object.keys(presetsMap).length ? Object.keys(presetsMap) : ['purple', 'yellow', 'green', 'blue', 'red'];
        for (const pKey of presetKeys) {
          const pBtn = doc.createElement('button');
          pBtn.type = 'button';
          pBtn.id = `agy-preset-${pKey}`;
          pBtn.className = 'qp-pool-chip';
          pBtn.setAttribute('data-active', pKey === state.heatPreset ? 'true' : 'false');
          const dotEl = doc.createElement('span');
          dotEl.className = 'ag-swatch-dot';
          if (dotEl.style?.setProperty && presetsMap[pKey]?.accentDark) {
            dotEl.style.setProperty('background', presetsMap[pKey].accentDark);
          }
          const lblEl = doc.createElement('span');
          lblEl.textContent = PRESET_LABELS[pKey] || pKey;
          pBtn.appendChild(dotEl);
          pBtn.appendChild(lblEl);
          pBtn.addEventListener('click', () => {
            state.heatPreset = pKey;
            applyThemeVars();
            renderSettingsPanel();
          });
          swatchRow.appendChild(pBtn);
        }
        card.appendChild(swatchRow);
        settingsPanelEl.appendChild(card);
        return;
      }

      if (state.activeSettingsTab === 'health') {
        const card = doc.createElement('div');
        card.className = 'settings-card-box';
        card.id = 'agy-health-settings-card';
        const cTitle = doc.createElement('div');
        cTitle.className = 'ag-card-title';
        cTitle.textContent = `运行时健康度（${state.pluginInstances.size} 个已挂载插件）`;
        card.appendChild(cTitle);
        for (const [id] of state.pluginInstances.entries()) {
          const row = doc.createElement('div');
          row.className = 'settings-pref-row';
          const metric = getMetric(id);
          row.textContent = `${id} · mount=${metric.mountMs}ms · obs=${metric.observerMs || 0}ms · timers=${metric.timersCount} · crashes=${metric.crashes}`;
          card.appendChild(row);
        }
        settingsPanelEl.appendChild(card);
        return;
      }

      if (state.activeSettingsTab === 'manage') {
        renderManageTab();
        return;
      }

      if (state.activeSettingsTab === 'general') {
        const card = doc.createElement('div');
        card.className = 'settings-card-box';
        card.id = 'agy-general-settings-card';
        const cTitle = doc.createElement('div');
        cTitle.className = 'ag-card-title';
        cTitle.textContent = '版本与宿主环境';
        const bodyTxt = doc.createElement('div');
        bodyTxt.className = 'ag-muted';
        bodyTxt.textContent = state.updateInfo?.hasUpdate
          ? `发现新版本 ${state.updateInfo.latestVersion}（当前 ${state.updateInfo.currentVersion}）`
          : `当前已为最新版本 v${HOST_VERSION} · Antigravity v${state.antigravityVersion}`;
        card.appendChild(cTitle);
        card.appendChild(bodyTxt);
        settingsPanelEl.appendChild(card);
        return;
      }

      for (const tab of state.settingsTabs.values()) {
        const effSchema = inferSchemaFromTab(tab);
        if (effSchema) {
          const node = renderSettingsSchemaFields(effSchema, tab.values || {}, (k, v) => {
            tab.values[k] = v;
            if (typeof tab.onChange === 'function') tab.onChange(k, v, { ...tab.values });
          });
          settingsPanelEl.appendChild(node);
        }
      }
      if (state.settingsTabs.size === 0) {
        const emptyCard = doc.createElement('div');
        emptyCard.className = 'settings-card-box';
        emptyCard.textContent = `已挂载 ${state.pluginInstances.size} 个插件（暂无可配置字段）`;
        settingsPanelEl.appendChild(emptyCard);
      }
    }

    function toggleSettingsPanel(force) {
      if (!settingsPanelEl && force !== false) ensureDomShell();
      if (!settingsPanelEl) return false;
      const nextOpen = typeof force === 'boolean' ? force : Boolean(settingsPanelEl.hidden);
      if (nextOpen) {
        closeAllPopovers('__settings__');
        settingsPanelEl.hidden = false;
        renderSettingsPanel();
        settingsBtnEl?.setAttribute?.('data-active', 'true');
        if (state.activeSettingsTab === 'manage') {
          void fetchManagePlugins();
        }
      } else {
        settingsPanelEl.hidden = true;
        settingsBtnEl?.setAttribute?.('data-active', 'false');
      }
      const anyOpen = !settingsPanelEl.hidden || Array.from(state.popovers.values()).some((p) => p.node && !p.node.hidden);
      if (hostEl) hostEl.setAttribute('data-elevated', anyOpen ? 'true' : 'false');
      return nextOpen;
    }

    // 锚点解析与共享 MutationObserver 中心
    function resolveAnchorSelectors(anchorName) {
      const def = state.anchorsRegistry?.anchors?.[anchorName];
      if (!def || !Array.isArray(def.versions) || !def.versions.length) return [];
      return def.versions[0].selectors || [];
    }

    function queryAnchor(anchorName) {
      if (!doc || typeof doc.querySelector !== 'function') return null;
      const selectors = resolveAnchorSelectors(anchorName);
      for (const sel of selectors) {
        try {
          const el = doc.querySelector(sel);
          if (el) return el;
        } catch {}
      }
      return null;
    }

    function queryAnchorAll(anchorName) {
      if (!doc || typeof doc.querySelectorAll !== 'function') return [];
      const selectors = resolveAnchorSelectors(anchorName);
      for (const sel of selectors) {
        try {
          const list = Array.from(doc.querySelectorAll(sel));
          if (list.length > 0) return list;
        } catch {}
      }
      return [];
    }

    let sharedObserver = null;
    let observerRafPending = false;
    const prevAnchorMatches = new Map();

    function flushSharedAnchorObservers() {
      observerRafPending = false;
      if (state.disposed) return;
      for (const sub of Array.from(state.anchorSubs.values())) {
        const el = queryAnchor(sub.anchorName);
        if (el !== sub.lastHit) {
          sub.lastHit = el;
          const t0 = Date.now();
          try {
            sub.fn(el);
          } catch (err) {
            recordPluginRuntimeError(sub.pluginId, err);
          } finally {
            getMetric(sub.pluginId).observerMs += (Date.now() - t0);
          }
        }
      }
    }

    function ensureSharedObserver() {
      if (sharedObserver || typeof MutationObserver !== 'function' || !doc?.documentElement) return;
      sharedObserver = new MutationObserver(() => {
        if (observerRafPending) return;
        observerRafPending = true;
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(flushSharedAnchorObservers);
        } else {
          setTimeout(flushSharedAnchorObservers, 16);
        }
      });
      try {
        sharedObserver.observe(doc.documentElement, { childList: true, subtree: true });
      } catch {}
    }

    function recordPluginRuntimeError(pluginId, err) {
      const now = Date.now();
      const arr = (state.crashCounts.get(pluginId) || []).filter((t) => now - t <= 60000);
      arr.push(now);
      state.crashCounts.set(pluginId, arr);
      const metric = getMetric(pluginId);
      metric.crashes = arr.length;
      if (arr.length >= 3) {
        void disposePlugin(pluginId);
      }
      return { crashes: arr.length, circuitOpen: arr.length >= 3, error: err?.message || String(err) };
    }

    // 跨世界私有通道（主世界与隔离世界经 nonce CustomEvent 通信）
    const xworldChannelName = `__agy_xworld_${state.xworldNonce}`;
    function dispatchToIsolated(payload) {
      if (!doc || typeof doc.dispatchEvent !== 'function') return;
      const detail = { direction: 'to-isolated', ...payload };
      const ev = typeof CustomEvent === 'function'
        ? new CustomEvent(xworldChannelName, { detail })
        : { type: xworldChannelName, detail };
      doc.dispatchEvent(ev);
    }

    function handleCrossWorldRequest(ev) {
      const detail = ev?.detail;
      if (!detail || detail.direction !== 'to-main') return;
      void (async () => {
        let reply;
        try {
          const action = detail.action || (detail.service ? 'service.call' : '');
          let val = null;
          if (action === 'service.call') {
            const svc = state.services.get(detail.service);
            if (!svc || typeof svc.methods?.[detail.method] !== 'function') {
              throw new Error(`SERVICE_UNAVAILABLE: ${detail.service}.${detail.method}`);
            }
            const raw = await svc.methods[detail.method](...(detail.args || []));
            val = raw === undefined ? null : JSON.parse(JSON.stringify(raw));
          } else if (action === 'topbar.registerUnit') {
            if (!detail.pluginId || !detail.unit?.id) {
              throw new Error('Invalid unit payload');
            }
            const unitCtx = createPluginContext(detail.pluginId);
            unitCtx.topbar.registerUnit({
              id: detail.unit.id,
              order: detail.unit.order,
              label: detail.unit.label,
              icon: detail.unit.icon || null,
              onClick: () => dispatchToIsolated({
                event: 'unit.click',
                pluginId: detail.pluginId,
                unitId: detail.unit.id
              })
            });
            val = { ok: true };
          } else if (action === 'topbar.disposeUnit') {
            const key = `${detail.pluginId}:${detail.unitId}`;
            const existing = state.units.get(key);
            state.units.delete(key);
            if (existing?.node?.remove) existing.node.remove();
            val = { ok: true };
          } else if (action === 'settings.registerSection') {
            if (!detail.pluginId || !detail.section) {
              throw new Error('Invalid settings section payload');
            }
            const secId = detail.section.id || 'default';
            const secCtx = createPluginContext(detail.pluginId);
            secCtx.settings.registerSection({
              ...detail.section,
              id: secId,
              onChange: (key, value, values) => dispatchToIsolated({
                event: 'settings.change',
                pluginId: detail.pluginId,
                sectionId: secId,
                key,
                value,
                values
              })
            });
            val = { ok: true };
          } else if (action === 'events.emit') {
            const evCtx = createPluginContext(detail.pluginId || 'isolated');
            val = { delivered: evCtx.events.emit(detail.topic, detail.payload) };
          } else if (action === 'state.set') {
            const stCtx = createPluginContext(detail.pluginId || 'isolated');
            val = stCtx.state.set(detail.key, detail.value);
          } else if (action === 'state.get') {
            val = state.stickyState.get(detail.key) || null;
          } else if (action === 'plugin.dispose') {
            await disposePlugin(detail.pluginId);
            val = { ok: true };
          } else {
            throw new Error(`UNKNOWN_XWORLD_ACTION: ${action}`);
          }
          reply = { ok: true, value: val };
        } catch (err) {
          reply = { ok: false, error: err?.message || String(err) };
        }
        if (detail.reqId) {
          dispatchToIsolated({ reqId: detail.reqId, reply });
        }
      })();
    }
    if (doc?.addEventListener) {
      doc.addEventListener(xworldChannelName, handleCrossWorldRequest);
    }

    const hostDom = {
      getSessionId() {
        const href = String(win?.location?.href || '');
        const m = href.match(/([0-9a-f]{8}-[0-9a-f-]{27,})/i);
        return m ? m[1] : null;
      },
      getComposer() {
        return queryAnchor('composer.editor') || queryAnchor('composer.root');
      },
      getScrollViewport() {
        return queryAnchor('chat.scrollViewport');
      },
      getSidebarRows() {
        return queryAnchorAll('sidebar.conversationRows');
      },
      isAssistantBusy() {
        const cancelBtn = doc?.querySelector?.('.surface-composer [data-testid="input-cancel-button"], [data-testid="input-cancel-button"]');
        if (cancelBtn && !cancelBtn.disabled) return true;
        return false;
      },
      sendText(text) {
        const editor = queryAnchor('composer.editor');
        if (!editor) return false;
        if ('textContent' in editor) editor.textContent = String(text || '');
        const sendBtn = queryAnchor('composer.sendButton');
        if (sendBtn && !sendBtn.disabled && typeof sendBtn.click === 'function') {
          sendBtn.click();
          return true;
        }
        return false;
      }
    };

    function createPluginContext(pluginId, pluginOptions = {}) {
      const privateToken = pluginOptions.pluginToken || '';
      const fetchFn = pluginOptions.fetch || win.fetch || globalThis.fetch;
      if (!state.timers.has(pluginId)) state.timers.set(pluginId, new Set());

      return {
        pluginId,
        hostVersion: HOST_VERSION,
        hostDom,
        anchors: {
          query: queryAnchor,
          queryAll: queryAnchorAll,
          observe(anchorName, fn) {
            ensureSharedObserver();
            const subId = `${pluginId}:${anchorName}:${Math.random().toString(36).slice(2)}`;
            state.anchorSubs.set(subId, { pluginId, anchorName, fn, lastHit: null });
            const initial = queryAnchor(anchorName);
            if (initial) {
              state.anchorSubs.get(subId).lastHit = initial;
              try { fn(initial); } catch {}
            }
            return () => state.anchorSubs.delete(subId);
          }
        },
        topbar: {
          registerUnit(def) {
            ensureDomShell();
            const key = `${pluginId}:${def.id}`;
            const prev = state.units.get(key);
            if (prev && prev.node && prev.node !== def.node && prev.node.remove) {
              prev.node.remove();
            }
            let node = def.node;
            if (!node && doc?.createElement) {
              node = doc.createElement('button');
              node.type = 'button';
              node.className = 'ag-unit';
              node.id = `agy-unit-${pluginId}-${def.id}`;
              if (def.icon === 'terminal') {
                const iconSpan = doc.createElement('span');
                iconSpan.innerHTML = '<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><rect x="1.2" y="2.2" width="11.6" height="9.6" rx="2" fill="none" stroke="var(--ag-custom-token-accent, #a78bfa)" stroke-width="1.3"/><path d="M4 5.3L6.2 7L4 8.7M7.2 8.7H10" fill="none" stroke="var(--ag-custom-token-accent, #a78bfa)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                const lblSpan = doc.createElement('span');
                lblSpan.textContent = def.label || def.id;
                node.appendChild(iconSpan);
                node.appendChild(lblSpan);
              } else {
                node.textContent = def.label || def.id;
              }
              if (typeof def.onClick === 'function') node.addEventListener('click', def.onClick);
              if (typeof def.render === 'function') def.render(node);
            }
            state.units.set(key, { pluginId, ...def, node });
            renderUnits();
            return () => {
              state.units.delete(key);
              if (node?.remove) node.remove();
            };
          },
          registerPopover(def) {
            ensureDomShell();
            const key = `${pluginId}:${def.id}`;
            let node = def.node;
            if (!node && doc?.createElement) {
              node = doc.createElement('section');
              node.className = 'ag-panel';
              node.hidden = true;
              if (typeof def.render === 'function') def.render(node);
              shadow?.appendChild?.(node);
            }
            state.popovers.set(key, { pluginId, ...def, node });
            return {
              toggle(force) {
                const open = typeof force === 'boolean' ? force : Boolean(node.hidden);
                if (open) {
                  closeAllPopovers(key);
                  positionPopoverNearAnchor(node, pluginId, def.anchorId);
                }
                node.hidden = !open;
                activePopoverId = open ? key : null;
                setAnchorButtonActive(pluginId, def.anchorId, open);
                hostEl?.setAttribute?.('data-elevated', open ? 'true' : 'false');
                if (typeof def.onToggle === 'function') def.onToggle(open);
                return open;
              },
              dispose() {
                state.popovers.delete(key);
                setAnchorButtonActive(pluginId, def.anchorId, false);
                if (activePopoverId === key) activePopoverId = null;
                if (node?.remove) node.remove();
              }
            };
          }
        },
        settings: {
          registerSection(def) {
            const key = `${pluginId}:${def.id || 'default'}`;
            state.settingsTabs.set(key, { pluginId, ...def, values: { ...(def.values || {}) } });
            return () => state.settingsTabs.delete(key);
          }
        },
        schedule: {
          every(ms, fn) {
            const intervalMs = Math.max(50, Number(ms) || 1000);
            const id = setInterval(() => {
              if (doc?.hidden && intervalMs < 2000) return;
              try { fn(); } catch (err) { recordPluginRuntimeError(pluginId, err); }
            }, intervalMs);
            const rec = { kind: 'interval', id };
            state.timers.get(pluginId).add(rec);
            getMetric(pluginId).timersCount = state.timers.get(pluginId).size;
            return () => {
              clearInterval(id);
              state.timers.get(pluginId)?.delete(rec);
              getMetric(pluginId).timersCount = state.timers.get(pluginId)?.size || 0;
            };
          },
          idle(fn) {
            const id = setTimeout(() => {
              state.timers.get(pluginId)?.delete(rec);
              getMetric(pluginId).timersCount = state.timers.get(pluginId)?.size || 0;
              try { fn(); } catch (err) { recordPluginRuntimeError(pluginId, err); }
            }, 50);
            const rec = { kind: 'timeout', id };
            state.timers.get(pluginId).add(rec);
            getMetric(pluginId).timersCount = state.timers.get(pluginId).size;
            return () => {
              clearTimeout(id);
              state.timers.get(pluginId)?.delete(rec);
              getMetric(pluginId).timersCount = state.timers.get(pluginId)?.size || 0;
            };
          }
        },
        services: {
          provide(name, methods) {
            state.services.set(name, { pluginId, methods });
            return () => {
              if (state.services.get(name)?.pluginId === pluginId) state.services.delete(name);
            };
          },
          get(name) {
            return state.services.get(name)?.methods || null;
          }
        },
        events: {
          emit(topic, payload) {
            const set = state.events.get(topic);
            if (!set) return 0;
            let count = 0;
            for (const item of Array.from(set)) {
              try { item.fn(payload); count++; } catch {}
            }
            return count;
          },
          on(topic, fn) {
            if (!state.events.has(topic)) state.events.set(topic, new Set());
            const entry = { pluginId, fn };
            state.events.get(topic).add(entry);
            return () => state.events.get(topic)?.delete(entry);
          }
        },
        state: {
          set(key, val) {
            const prev = state.stickyState.get(key);
            const next = { value: val, version: prev ? prev.version + 1 : 1 };
            state.stickyState.set(key, next);
            const subs = state.stateSubs.get(key);
            if (subs) {
              for (const s of Array.from(subs)) {
                try { s.fn(next.value, { version: next.version }); } catch {}
              }
            }
            return next;
          },
          get(key) {
            return state.stickyState.get(key) || null;
          },
          subscribe(key, fn) {
            if (!state.stateSubs.has(key)) state.stateSubs.set(key, new Set());
            const entry = { pluginId, fn };
            state.stateSubs.get(key).add(entry);
            const cur = state.stickyState.get(key);
            if (cur) try { fn(cur.value, { version: cur.version, replay: true }); } catch {}
            return () => state.stateSubs.get(key)?.delete(entry);
          }
        },
        bridge: {
          async post(subPath, payload = {}) {
            if (!state.bridgePort || typeof fetchFn !== 'function') {
              throw new Error('Bridge unavailable in renderer');
            }
            const clean = subPath.startsWith('/') ? subPath : `/${subPath}`;
            const resp = await fetchFn(`http://127.0.0.1:${state.bridgePort}/plugins/${pluginId}${clean}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-AGY-Plugin-Token': privateToken
              },
              body: JSON.stringify(payload)
            });
            return resp.json();
          }
        }
      };
    }

    async function mountPlugin(pluginId, pluginObj, pluginOptions = {}) {
      ensureDomShell();
      if (state.pluginInstances.has(pluginId)) {
        await disposePlugin(pluginId);
      }
      const ctx = createPluginContext(pluginId, pluginOptions);
      const t0 = Date.now();
      try {
        if (typeof pluginObj?.mount === 'function') {
          await pluginObj.mount(ctx, pluginOptions.mountOptions || {});
        }
        getMetric(pluginId).mountMs = Date.now() - t0;
        state.pluginInstances.set(pluginId, { pluginObj, ctx });
        return { ok: true };
      } catch (err) {
        const health = recordPluginRuntimeError(pluginId, err);
        await disposePlugin(pluginId);
        return { ok: false, error: err?.message || String(err), ...health };
      }
    }

    async function disposePlugin(pluginId) {
      const inst = state.pluginInstances.get(pluginId);
      state.pluginInstances.delete(pluginId);
      if (inst && typeof inst.pluginObj?.dispose === 'function') {
        try { await inst.pluginObj.dispose(); } catch {}
      }

      for (const [k, u] of Array.from(state.units.entries())) {
        if (u.pluginId === pluginId) {
          state.units.delete(k);
          if (u.node?.remove) u.node.remove();
        }
      }
      for (const [k, p] of Array.from(state.popovers.entries())) {
        if (p.pluginId === pluginId) {
          state.popovers.delete(k);
          if (p.node?.remove) p.node.remove();
        }
      }
      for (const [k, s] of Array.from(state.settingsTabs.entries())) {
        if (s.pluginId === pluginId) state.settingsTabs.delete(k);
      }
      for (const [k, svc] of Array.from(state.services.entries())) {
        if (svc.pluginId === pluginId) state.services.delete(k);
      }
      for (const [topic, set] of state.events.entries()) {
        for (const e of Array.from(set)) if (e.pluginId === pluginId) set.delete(e);
        if (set.size === 0) state.events.delete(topic);
      }
      for (const [key, set] of state.stateSubs.entries()) {
        for (const e of Array.from(set)) if (e.pluginId === pluginId) set.delete(e);
        if (set.size === 0) state.stateSubs.delete(key);
      }
      for (const [subId, sub] of Array.from(state.anchorSubs.entries())) {
        if (sub.pluginId === pluginId) state.anchorSubs.delete(subId);
      }
      const timerSet = state.timers.get(pluginId);
      if (timerSet) {
        for (const t of timerSet) {
          if (t.kind === 'interval') clearInterval(t.id);
          else clearTimeout(t.id);
        }
        timerSet.clear();
        state.timers.delete(pluginId);
      }
      if (state.metrics.has(pluginId)) {
        state.metrics.get(pluginId).timersCount = 0;
      }
    }

    function getPluginUsageStats(pluginId) {
      let domNodes = 0;
      for (const u of state.units.values()) if (u.pluginId === pluginId) domNodes++;
      for (const p of state.popovers.values()) if (p.pluginId === pluginId) domNodes++;
      let observers = 0;
      for (const s of state.anchorSubs.values()) if (s.pluginId === pluginId) observers++;
      let events = 0;
      for (const set of state.events.values()) for (const e of set) if (e.pluginId === pluginId) events++;
      for (const set of state.stateSubs.values()) for (const e of set) if (e.pluginId === pluginId) events++;
      let services = 0;
      for (const svc of state.services.values()) if (svc.pluginId === pluginId) services++;
      const timers = state.timers.get(pluginId)?.size || 0;
      return { domNodes, observers, timers, events, services };
    }

    const onKeyDown = (e) => {
      if (e?.key === 'Escape') {
        closeAllPopovers(null);
      }
    };
    const onOutsideMouseDown = (ev) => {
      const hasOpen = (settingsPanelEl && !settingsPanelEl.hidden)
        || Array.from(state.popovers.values()).some((p) => p.node && !p.node.hidden);
      if (!hasOpen || !hostEl) return;
      const path = typeof ev?.composedPath === 'function' ? ev.composedPath() : null;
      if (path && path.includes(hostEl)) return;
      if (typeof hostEl.contains === 'function' && hostEl.contains(ev?.target)) return;
      closeAllPopovers(null);
    };
    if (doc?.addEventListener) {
      doc.addEventListener('keydown', onKeyDown);
      doc.addEventListener('mousedown', onOutsideMouseDown);
    }

    const api = {
      version: HOST_VERSION,
      configure(nextOpts = {}) {
        if (nextOpts.anchorsRegistry) state.anchorsRegistry = nextOpts.anchorsRegistry;
        if (nextOpts.bridgePort !== undefined) state.bridgePort = Number(nextOpts.bridgePort || 0);
        if (nextOpts.hostToken !== undefined) hostToken = String(nextOpts.hostToken || '');
        if (nextOpts.antigravityVersion) state.antigravityVersion = nextOpts.antigravityVersion;
        if (nextOpts.locale) state.locale = nextOpts.locale;
        if (nextOpts.themeMode) {
          state.themeMode = nextOpts.themeMode;
          applyThemeVars(nextOpts.accent || DEFAULT_ACCENT);
        }
      },
      disposeLegacyGlobals,
      queryAnchor,
      queryAnchorAll,
      mountPlugin,
      disposePlugin,
      toggleSettingsPanel,
      getPluginUsageStats,
      getMetrics: (id) => (id ? getMetric(id) : Object.fromEntries(state.metrics.entries())),
      setTheme(mode, accent = DEFAULT_ACCENT, heatPreset) {
        if (mode) state.themeMode = mode;
        if (heatPreset) state.heatPreset = heatPreset;
        return applyThemeVars(accent);
      },
      setUpdateInfo(info = {}) {
        state.updateInfo = {
          hasUpdate: Boolean(info.hasUpdate),
          currentVersion: info.currentVersion || HOST_VERSION,
          latestVersion: info.latestVersion || HOST_VERSION
        };
        const dot = shadow?.querySelector ? shadow.querySelector('#agy-update-dot') : null;
        if (dot) {
          dot.hidden = !state.updateInfo.hasUpdate;
          if (dot.hidden) dot.setAttribute?.('hidden', '');
          else dot.removeAttribute?.('hidden');
        }
        return { ...state.updateInfo };
      },
      reEnablePlugin(pluginId) {
        state.crashCounts.delete(pluginId);
        const m = getMetric(pluginId);
        m.crashes = 0;
        return { ok: true, pluginId };
      },
      async dispose() {
        if (state.disposed) return;
        state.disposed = true;
        for (const id of Array.from(state.pluginInstances.keys())) {
          await disposePlugin(id);
        }
        if (sharedObserver) {
          try { sharedObserver.disconnect(); } catch {}
          sharedObserver = null;
        }
        if (themeObserver) {
          try { themeObserver.disconnect(); } catch {}
          themeObserver = null;
        }
        if (typeof removeMediaListener === 'function') {
          try { removeMediaListener(); } catch {}
          removeMediaListener = null;
        }
        if (doc?.removeEventListener) {
          doc.removeEventListener('keydown', onKeyDown);
          doc.removeEventListener('mousedown', onOutsideMouseDown);
          doc.removeEventListener(xworldChannelName, handleCrossWorldRequest);
        }
        if (lightDomStyleEl?.remove) lightDomStyleEl.remove();
        lightDomStyleEl = null;
        if (hostEl?.remove) hostEl.remove();
        hostEl = null;
        shadow = null;
      }
    };

    if (win) {
      win.__AGYDaddyHost = api;
    }
    return api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createHostRuntime };
  } else {
    const api = createHostRuntime();
    try { api.disposeLegacyGlobals(); } catch {}
  }
})(globalThis);
