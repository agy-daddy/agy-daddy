(function (root) {
  'use strict';

  const DEFAULT_TOKEN_BUDGET = 20000;
  const DEFAULT_WARN_RATIO = 0.8;

  const ASSET_KIND_META = {
    all: { id: 'all', label: '全部类型', badge: 'All' },
    skills: { id: 'skills', label: 'Skills', badge: 'Skill' },
    rules: { id: 'rules', label: 'Rules', badge: 'Rule' },
    mcp: { id: 'mcp', label: 'MCP', badge: 'MCP' },
    plugins: { id: 'plugins', label: 'Plugins', badge: 'Plugin' }
  };

  const ASSET_SCOPE_META = {
    all: { id: 'all', label: '全部来源' },
    global: { id: 'global', label: '全局 Global' },
    workspace: { id: 'workspace', label: '工作区 .agents' }
  };

  function isPlainObject(val) {
    return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
  }

  function createIconSvg(doc, svgMarkup, extraClass = '') {
    const span = doc.createElement('span');
    span.className = extraClass ? `ag-svg-icon ${extraClass}` : 'ag-svg-icon';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = svgMarkup;
    return span;
  }

  const CUSTOM_ICONS = {
    layers: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
    plus: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    refresh: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    alertTriangle: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    bolt: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    folderSync: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 10v6"/><path d="m9.5 13.5 2.5 2.5 2.5-2.5"/></svg>',
    trash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
    chevronDown: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
  };

  function createCustomizationState() {
    return {
      loading: false,
      loaded: false,
      busyId: null,
      error: '',
      sourceMode: 'empty', // 'bridge' | 'fallback' | 'empty'
      workspacePath: '',
      workspaceName: '',
      scopeFilter: 'all',  // 'all' | 'global' | 'workspace'
      typeFilter: 'all',   // 'all' | 'skills' | 'rules' | 'mcp' | 'plugins'
      items: [],
      budgets: {
        customizations: {
          limit: DEFAULT_TOKEN_BUDGET,
          used: 0,
          warnThreshold: Math.round(DEFAULT_TOKEN_BUDGET * DEFAULT_WARN_RATIO),
          excludedCount: 0
        },
        rules: {
          limit: DEFAULT_TOKEN_BUDGET,
          used: 0,
          warnThreshold: Math.round(DEFAULT_TOKEN_BUDGET * DEFAULT_WARN_RATIO),
          excludedCount: 0
        }
      },
      confirmUninstallId: null,
      expandedMcpIds: new Set(),
      installModal: null
    };
  }

  function normalizeKind(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'skill' || s === 'skills') return 'skills';
    if (s === 'rule' || s === 'rules') return 'rules';
    if (s === 'mcp' || s === 'mcp_server' || s === 'mcp-server' || s === 'server') return 'mcp';
    return 'plugins';
  }

  function normalizeScope(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'workspace' || s === 'project' || s === 'local' || s === '.agents') return 'workspace';
    return 'global';
  }

  function formatNumber(n) {
    const num = Math.max(0, Math.round(Number(n) || 0));
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function clampPct(val) {
    const num = Number(val);
    if (!Number.isFinite(num) || num <= 0) return 0;
    if (num >= 100) return 100;
    return Math.round(num * 10) / 10;
  }

  function normalizeMcpDetails(rawMcp, itemTokens) {
    if (!isPlainObject(rawMcp)) return null;
    const rawTools = Array.isArray(rawMcp.tools) ? rawMcp.tools : [];
    const tools = rawTools.map((t) => {
      const name = String(t?.name || t?.id || '').trim();
      const tokens = Math.max(0, Math.round(Number(t?.tokens) || 0));
      const eager = t?.eager !== false;
      const excluded = Boolean(t?.excluded);
      return { name, tokens, eager, excluded };
    }).filter((t) => t.name);

    const excludedTools = Array.isArray(rawMcp.excludedTools)
      ? rawMcp.excludedTools.map((x) => String(x)).filter(Boolean)
      : tools.filter((t) => t.excluded).map((t) => t.name);

    const totalTools = Number.isFinite(Number(rawMcp.totalTools))
      ? Math.max(tools.length, Math.round(Number(rawMcp.totalTools)))
      : tools.length;
    const eagerTools = Number.isFinite(Number(rawMcp.eagerTools))
      ? Math.max(0, Math.round(Number(rawMcp.eagerTools)))
      : tools.filter((t) => t.eager).length;
    const lazyTools = Number.isFinite(Number(rawMcp.lazyTools))
      ? Math.max(0, Math.round(Number(rawMcp.lazyTools)))
      : Math.max(0, totalTools - eagerTools);

    let policy = String(rawMcp.policy || '').trim().toLowerCase();
    if (policy !== 'eager' && policy !== 'lazy' && policy !== 'mixed') {
      if (totalTools > 0 && eagerTools === 0) policy = 'lazy';
      else if (totalTools > 0 && eagerTools < totalTools) policy = 'mixed';
      else policy = 'eager';
    }

    return {
      serverName: String(rawMcp.serverName || rawMcp.name || ''),
      configPath: String(rawMcp.configPath || ''),
      policy,
      totalTools,
      eagerTools,
      lazyTools,
      excludedTools,
      tools,
      estimatedTokens: Number.isFinite(Number(itemTokens)) ? Math.round(Number(itemTokens)) : 0
    };
  }

  function normalizeAssetItem(raw, budgetLimit = DEFAULT_TOKEN_BUDGET) {
    if (!isPlainObject(raw)) return null;
    const kind = normalizeKind(raw.kind || raw.type);
    const scope = normalizeScope(raw.scope || raw.sourceScope);
    const id = String(raw.id || `${kind}:${scope}:${raw.name || raw.displayName || 'item'}`).trim();
    const name = String(raw.name || raw.displayName || id).trim();
    const displayName = String(raw.displayName || raw.name || id).trim();
    const tokens = Math.max(0, Math.round(Number(raw.tokens ?? raw.tokenCount ?? 0) || 0));
    const mcp = kind === 'mcp' ? normalizeMcpDetails(raw.mcp || raw.mcpMeta, tokens) : null;
    const excluded = Boolean(raw.excluded || (mcp && mcp.excludedTools.length > 0));
    const rawShare = Number(raw.tokenShare);
    const tokenShare = Number.isFinite(rawShare)
      ? clampPct(rawShare)
      : (budgetLimit > 0 ? clampPct((tokens / budgetLimit) * 100) : 0);

    return {
      id,
      name,
      displayName,
      kind,
      scope,
      version: String(raw.version || '1.0.0'),
      description: String(raw.description || ''),
      sourcePath: String(raw.sourcePath || raw.path || ''),
      pluginId: raw.pluginId ? String(raw.pluginId) : '',
      enabled: raw.enabled !== false,
      tokens,
      tokenShare,
      excluded,
      excludedReason: String(raw.excludedReason || (excluded ? '超出 20,000 Token 上下文上限' : '')),
      promotedToWorkspace: Boolean(raw.promotedToWorkspace),
      canToggle: raw.canToggle !== false,
      canUninstall: raw.canUninstall !== false,
      canPromote: raw.canPromote !== undefined ? Boolean(raw.canPromote) : (scope === 'global'),
      mcp
    };
  }

  function computeBudgetsFromItems(items, rawBudgets = null) {
    const customLimit = Math.max(1000, Math.round(Number(rawBudgets?.customizations?.limit) || DEFAULT_TOKEN_BUDGET));
    const rulesLimit = Math.max(1000, Math.round(Number(rawBudgets?.rules?.limit) || DEFAULT_TOKEN_BUDGET));

    let computedCustomUsed = 0;
    let computedCustomExcluded = 0;
    let computedRulesUsed = 0;
    let computedRulesExcluded = 0;

    for (const item of items) {
      if (!item || item.enabled === false) continue;
      if (item.kind === 'rules') {
        computedRulesUsed += item.tokens;
        if (item.excluded) computedRulesExcluded++;
      } else {
        computedCustomUsed += item.tokens;
        if (item.excluded) {
          computedCustomExcluded += (item.mcp?.excludedTools?.length || 1);
        }
      }
    }

    const customUsed = Number.isFinite(Number(rawBudgets?.customizations?.used))
      ? Math.max(0, Math.round(Number(rawBudgets.customizations.used)))
      : computedCustomUsed;
    const customExcluded = Number.isFinite(Number(rawBudgets?.customizations?.excludedCount))
      ? Math.max(0, Math.round(Number(rawBudgets.customizations.excludedCount)))
      : computedCustomExcluded;
    const rulesUsed = Number.isFinite(Number(rawBudgets?.rules?.used))
      ? Math.max(0, Math.round(Number(rawBudgets.rules.used)))
      : computedRulesUsed;
    const rulesExcluded = Number.isFinite(Number(rawBudgets?.rules?.excludedCount))
      ? Math.max(0, Math.round(Number(rawBudgets.rules.excludedCount)))
      : computedRulesExcluded;

    return {
      customizations: {
        limit: customLimit,
        used: customUsed,
        warnThreshold: Math.round(Number(rawBudgets?.customizations?.warnThreshold) || customLimit * DEFAULT_WARN_RATIO),
        excludedCount: customExcluded
      },
      rules: {
        limit: rulesLimit,
        used: rulesUsed,
        warnThreshold: Math.round(Number(rawBudgets?.rules?.warnThreshold) || rulesLimit * DEFAULT_WARN_RATIO),
        excludedCount: rulesExcluded
      }
    };
  }

  function buildFallbackItemsFromPlugins(plugins = [], pickLocaleText) {
    const out = [];
    for (const p of plugins) {
      if (!p || !p.id) continue;
      const dName = typeof pickLocaleText === 'function' ? pickLocaleText(p.displayName, p.id) : (p.displayName || p.id);
      const desc = typeof pickLocaleText === 'function' ? pickLocaleText(p.description, '') : (p.description || '');
      const declared = p.nativeInfo?.declared || {};
      const nativeCfg = p.nativeInfo?.config || {};

      out.push(normalizeAssetItem({
        id: `plugin:global:${p.id}`,
        name: p.id,
        displayName: dName,
        kind: 'plugins',
        scope: 'global',
        version: p.version || '1.0.0',
        description: desc || p.id,
        sourcePath: p.sourceSpec || `~/.gemini/config/plugins/${p.id}`,
        pluginId: p.id,
        enabled: p.enabled !== false,
        tokens: 0,
        canPromote: true
      }));

      for (const sName of (Array.isArray(declared.skills) ? declared.skills : [])) {
        out.push(normalizeAssetItem({
          id: `skills:global:${p.id}:${sName}`,
          name: sName,
          displayName: sName,
          kind: 'skills',
          scope: 'global',
          version: p.version || '1.0.0',
          description: `来自插件 ${dName} 的原生 Skill`,
          sourcePath: `~/.gemini/config/plugins/${p.id}/skills/${sName}`,
          pluginId: p.id,
          enabled: p.enabled !== false && nativeCfg.skills !== false,
          tokens: 0,
          canPromote: true
        }));
      }

      for (const rName of (Array.isArray(declared.rules) ? declared.rules : [])) {
        out.push(normalizeAssetItem({
          id: `rules:global:${p.id}:${rName}`,
          name: rName,
          displayName: rName,
          kind: 'rules',
          scope: 'global',
          version: p.version || '1.0.0',
          description: `来自插件 ${dName} 的原生 Rule`,
          sourcePath: `~/.gemini/config/plugins/${p.id}/rules/${rName}`,
          pluginId: p.id,
          enabled: p.enabled !== false && nativeCfg.rules !== false,
          tokens: 0,
          canPromote: true
        }));
      }

      for (const mName of (Array.isArray(declared.mcp) ? declared.mcp : [])) {
        out.push(normalizeAssetItem({
          id: `mcp:global:${p.id}:${mName}`,
          name: mName,
          displayName: `${dName} · ${mName}`,
          kind: 'mcp',
          scope: 'global',
          version: p.version || '1.0.0',
          description: `来自插件 ${dName} 的 MCP Server`,
          sourcePath: `~/.gemini/config/plugins/${p.id}/mcp_config.json`,
          pluginId: p.id,
          enabled: p.enabled !== false && nativeCfg.mcp !== false,
          tokens: 0,
          canPromote: true,
          mcp: {
            serverName: mName,
            policy: 'eager',
            totalTools: 0,
            eagerTools: 0,
            lazyTools: 0,
            excludedTools: [],
            tools: []
          }
        }));
      }
    }
    return out.filter(Boolean);
  }

  function normalizeCustomizationPayload(rawPayload, fallbackPlugins = [], pickLocaleText = null) {
    const hasPayloadItems = Array.isArray(rawPayload?.items);
    const limit = Math.max(1000, Math.round(Number(rawPayload?.budgets?.customizations?.limit) || DEFAULT_TOKEN_BUDGET));
    const items = hasPayloadItems
      ? rawPayload.items.map((it) => normalizeAssetItem(it, limit)).filter(Boolean)
      : buildFallbackItemsFromPlugins(fallbackPlugins, pickLocaleText);

    const budgets = computeBudgetsFromItems(items, rawPayload?.budgets || null);
    const wsPath = String(rawPayload?.workspacePath || '').trim();
    let wsName = String(rawPayload?.workspaceName || '').trim();
    if (!wsName && wsPath) {
      const parts = wsPath.replace(/[\\/]+$/, '').split(/[\\/]/);
      wsName = parts[parts.length - 1] || wsPath;
    }

    return {
      sourceMode: hasPayloadItems ? 'bridge' : (items.length > 0 ? 'fallback' : 'empty'),
      workspacePath: wsPath,
      workspaceName: wsName,
      items,
      budgets
    };
  }

  function filterCustomizationItems(items = [], filters = {}) {
    const scopeFilter = filters.scopeFilter || 'all';
    const typeFilter = filters.typeFilter || 'all';
    const queryLower = String(filters.queryLower || '').trim().toLowerCase();

    return items.filter((item) => {
      if (!item) return false;
      if (scopeFilter !== 'all' && item.scope !== scopeFilter) return false;
      if (typeFilter !== 'all' && item.kind !== typeFilter) return false;
      if (!queryLower) return true;
      const toolNames = (item.mcp?.tools || []).map((t) => t.name).join(' ');
      const hay = `${item.id} ${item.name} ${item.displayName} ${item.description} ${item.sourcePath} ${item.kind} ${item.scope} ${item.mcp?.serverName || ''} ${toolNames}`.toLowerCase();
      return hay.includes(queryLower);
    });
  }

  function resolveBudgetTone(budget) {
    const limit = Math.max(1, Number(budget?.limit) || DEFAULT_TOKEN_BUDGET);
    const used = Math.max(0, Number(budget?.used) || 0);
    const warnAt = Number(budget?.warnThreshold) > 0 ? Number(budget.warnThreshold) : limit * DEFAULT_WARN_RATIO;
    if (Number(budget?.excludedCount) > 0 || used >= limit) return 'danger';
    if (used >= warnAt) return 'warn';
    return 'ok';
  }

  function getScopeCounts(items = []) {
    let globalCount = 0;
    let workspaceCount = 0;
    for (const it of items) {
      if (!it) continue;
      if (it.scope === 'workspace') workspaceCount++;
      else globalCount++;
    }
    return { all: items.length, global: globalCount, workspace: workspaceCount };
  }

  function getTypeCounts(items = [], scopeFilter = 'all') {
    const counts = { all: 0, skills: 0, rules: 0, mcp: 0, plugins: 0 };
    for (const it of items) {
      if (!it) continue;
      if (scopeFilter !== 'all' && it.scope !== scopeFilter) continue;
      counts.all++;
      if (counts[it.kind] !== undefined) counts[it.kind]++;
    }
    return counts;
  }

  function renderBudgetDashboard(doc, customState, hasBridge, handlers) {
    const card = doc.createElement('div');
    card.id = 'agy-custom-budget-card';
    card.className = 'settings-card-box ag-custom-budget-card';

    const mainBudget = customState.budgets?.customizations || {
      limit: DEFAULT_TOKEN_BUDGET,
      used: 0,
      warnThreshold: 16000,
      excludedCount: 0
    };
    const rulesBudget = customState.budgets?.rules || {
      limit: DEFAULT_TOKEN_BUDGET,
      used: 0,
      warnThreshold: 16000,
      excludedCount: 0
    };

    const pct = clampPct((mainBudget.used / Math.max(1, mainBudget.limit)) * 100);
    const tone = resolveBudgetTone(mainBudget);
    const excludedItems = (customState.items || []).filter((it) => it && it.excluded);
    const mcpItems = (customState.items || []).filter((it) => it && it.kind === 'mcp');
    const mcpExcludedCount = mcpItems.reduce((sum, it) => sum + (it.mcp?.excludedTools?.length || (it.excluded ? 1 : 0)), 0);
    const scopeCounts = getScopeCounts(customState.items || []);

    const head = doc.createElement('div');
    head.className = 'ag-custom-budget-head';

    const titleWrap = doc.createElement('div');
    titleWrap.className = 'ag-sv-row-info';
    const titleLine = doc.createElement('div');
    titleLine.className = 'ag-plugin-info';
    const titleEl = doc.createElement('span');
    titleEl.className = 'ag-sv-row-title';
    titleEl.textContent = '上下文预算（Customizations Token Budget）';
    const statusChip = doc.createElement('span');
    statusChip.id = 'agy-custom-budget-status-chip';
    statusChip.className = 'ag-chip';
    statusChip.setAttribute('data-tone', tone === 'ok' ? 'accent' : tone);
    statusChip.textContent = tone === 'danger'
      ? `已触发排除 (${mainBudget.excludedCount || excludedItems.length})`
      : (tone === 'warn' ? '接近上限' : '预算充裕');
    titleLine.appendChild(titleEl);
    titleLine.appendChild(statusChip);

    const descEl = doc.createElement('span');
    descEl.className = 'ag-sv-row-desc';
    descEl.textContent = rulesBudget.used > 0
      ? `Skills / Plugins / Eager MCP 共享 20,000 Token 预算池 · Rules 独立预算已用 ${formatNumber(rulesBudget.used)} / ${formatNumber(rulesBudget.limit)}`
      : 'Skills / Plugins / Eager MCP 共享当前会话 20,000 Token 预算上限，超标工具将被 Antigravity 自动排除。';
    titleWrap.appendChild(titleLine);
    titleWrap.appendChild(descEl);

    const figureEl = doc.createElement('div');
    figureEl.id = 'agy-custom-budget-figure';
    figureEl.className = 'ag-custom-budget-figure';
    figureEl.setAttribute('data-tone', tone);
    figureEl.textContent = `${formatNumber(mainBudget.used)} / ${formatNumber(mainBudget.limit)} Token (${pct}%)`;

    head.appendChild(titleWrap);
    head.appendChild(figureEl);
    card.appendChild(head);

    const track = doc.createElement('div');
    track.className = 'ag-progress-track ag-custom-budget-track';
    const fill = doc.createElement('div');
    fill.id = 'agy-custom-budget-fill';
    fill.className = 'ag-progress-fill';
    fill.setAttribute('data-tone', tone);
    fill.style.setProperty('width', `${Math.min(100, pct)}%`);
    track.appendChild(fill);
    card.appendChild(track);

    const kpiRow = doc.createElement('div');
    kpiRow.className = 'ag-custom-kpi-row';
    const kpis = [
      { label: '全局扩展 (Global)', value: `${scopeCounts.global} 项` },
      { label: '工作区 (.agents)', value: `${scopeCounts.workspace} 项` },
      { label: 'MCP 服务', value: mcpExcludedCount > 0 ? `${mcpItems.length} 项 · ${mcpExcludedCount} 排除` : `${mcpItems.length} 项` },
      { label: 'Rules 独立池', value: `${formatNumber(rulesBudget.used)} Tok` }
    ];
    for (const k of kpis) {
      const cell = doc.createElement('div');
      cell.className = 'ag-kpi-cell';
      const lbl = doc.createElement('span');
      lbl.className = 'ag-kpi-label';
      lbl.textContent = k.label;
      const val = doc.createElement('span');
      val.className = 'ag-kpi-value';
      val.textContent = k.value;
      cell.appendChild(lbl);
      cell.appendChild(val);
      kpiRow.appendChild(cell);
    }
    card.appendChild(kpiRow);

    if (excludedItems.length > 0 || mainBudget.used >= mainBudget.warnThreshold) {
      const alertBox = doc.createElement('div');
      alertBox.id = 'agy-custom-exclusion-alert';
      alertBox.className = tone === 'danger' ? 'ag-custom-alert ag-custom-alert-danger' : 'ag-custom-alert ag-custom-alert-warn';

      const alertMain = doc.createElement('div');
      alertMain.className = 'ag-custom-alert-main';
      alertMain.appendChild(createIconSvg(doc, CUSTOM_ICONS.alertTriangle, 'ag-custom-alert-icon'));

      const alertTextWrap = doc.createElement('div');
      alertTextWrap.className = 'ag-sv-row-info';
      const alertTitle = doc.createElement('span');
      alertTitle.className = 'ag-sv-row-title';
      const fixableMcp = excludedItems.find((it) => it.kind === 'mcp' && it.mcp && it.mcp.policy !== 'lazy')
        || mcpItems.find((it) => it.mcp && it.mcp.policy !== 'lazy' && it.tokens > 0);
      alertTitle.textContent = excludedItems.length > 0
        ? `检测到 ${excludedItems.length} 项资产因超出 20,000 Token 预算被排除`
        : '自定义项上下文占用已超过 80% 警戒线，继续启用 Eager 工具可能触发排除';

      const alertDesc = doc.createElement('span');
      alertDesc.className = 'ag-sv-row-desc';
      if (excludedItems.length > 0) {
        const names = excludedItems.map((it) => {
          const exTools = it.mcp?.excludedTools || [];
          return exTools.length > 0 ? `${it.displayName} (排除 ${exTools.join(', ')})` : it.displayName;
        }).join('；');
        alertDesc.textContent = `受影响项：${names}`;
      } else {
        alertDesc.textContent = '建议将大型 MCP 服务切换为 Smart Lazy 按需加载，或将非通用技能迁入工作区 .agents 隔离。';
      }
      alertTextWrap.appendChild(alertTitle);
      alertTextWrap.appendChild(alertDesc);
      alertMain.appendChild(alertTextWrap);
      alertBox.appendChild(alertMain);

      if (fixableMcp && typeof handlers.onSetMcpPolicy === 'function') {
        const fixBtn = doc.createElement('button');
        fixBtn.type = 'button';
        fixBtn.className = 'ag-btn ag-btn-primary';
        fixBtn.setAttribute('data-custom-fix-lazy', fixableMcp.id);
        fixBtn.disabled = Boolean(customState.busyId) || !hasBridge;
        fixBtn.appendChild(createIconSvg(doc, CUSTOM_ICONS.bolt));
        const lbl = doc.createElement('span');
        lbl.textContent = `将 ${fixableMcp.name} 转为 Smart Lazy`;
        fixBtn.appendChild(lbl);
        fixBtn.addEventListener('click', () => {
          handlers.onSetMcpPolicy(fixableMcp, 'lazy');
        });
        alertBox.appendChild(fixBtn);
      }

      card.appendChild(alertBox);
    }

    return card;
  }

  function renderAssetCard(doc, item, customState, budgetLimit, hasBridge, handlers) {
    const card = doc.createElement('article');
    card.className = 'ag-asset-card';
    card.setAttribute('data-custom-card-id', item.id);
    card.setAttribute('data-asset-kind', item.kind);
    card.setAttribute('data-asset-scope', item.scope);
    card.setAttribute('data-enabled', item.enabled ? 'true' : 'false');
    if (item.excluded) card.setAttribute('data-excluded', 'true');

    const isBusy = customState.busyId === item.id;
    const kindMeta = ASSET_KIND_META[item.kind] || ASSET_KIND_META.plugins;

    // 1. Header: title + version + badges
    const head = doc.createElement('div');
    head.className = 'ag-asset-card-head';

    const titleRow = doc.createElement('div');
    titleRow.className = 'ag-asset-title-row';
    const titleGroup = doc.createElement('div');
    titleGroup.className = 'ag-asset-title-group';
    const nameEl = doc.createElement('span');
    nameEl.className = 'ag-asset-title';
    nameEl.textContent = item.displayName || item.name;
    const verEl = doc.createElement('span');
    verEl.className = 'ag-asset-version';
    verEl.textContent = `v${item.version || '1.0.0'}`;
    titleGroup.appendChild(nameEl);
    titleGroup.appendChild(verEl);

    const badgeGroup = doc.createElement('div');
    badgeGroup.className = 'ag-asset-badges';
    const kindChip = doc.createElement('span');
    kindChip.className = 'ag-chip ag-asset-kind-chip';
    kindChip.setAttribute('data-kind', item.kind);
    kindChip.textContent = kindMeta.badge;
    const scopeChip = doc.createElement('span');
    scopeChip.className = 'ag-chip ag-asset-scope-chip';
    scopeChip.setAttribute('data-scope', item.scope);
    scopeChip.setAttribute('data-tone', item.scope === 'workspace' ? 'accent' : 'muted');
    scopeChip.textContent = item.scope === 'workspace' ? 'Workspace .agents' : 'Global';
    badgeGroup.appendChild(kindChip);
    badgeGroup.appendChild(scopeChip);

    if (item.excluded) {
      const exChip = doc.createElement('span');
      exChip.className = 'ag-chip';
      exChip.setAttribute('data-tone', 'danger');
      exChip.textContent = item.mcp?.excludedTools?.length
        ? `已排除 ${item.mcp.excludedTools.length} 工具`
        : '超出预算已排除';
      badgeGroup.appendChild(exChip);
    } else if (!item.enabled) {
      const offChip = doc.createElement('span');
      offChip.className = 'ag-chip';
      offChip.setAttribute('data-tone', 'muted');
      offChip.textContent = '已禁用';
      badgeGroup.appendChild(offChip);
    }

    titleRow.appendChild(titleGroup);
    titleRow.appendChild(badgeGroup);
    head.appendChild(titleRow);

    const descEl = doc.createElement('div');
    descEl.className = 'ag-asset-desc';
    descEl.textContent = item.description || item.name;
    head.appendChild(descEl);

    if (item.sourcePath) {
      const pathEl = doc.createElement('div');
      pathEl.className = 'ag-asset-path';
      pathEl.setAttribute('title', item.sourcePath);
      pathEl.textContent = item.sourcePath;
      head.appendChild(pathEl);
    }
    card.appendChild(head);

    // 2. Token footprint & share bar
    const tokenSection = doc.createElement('div');
    tokenSection.className = 'ag-asset-token-box';
    const tokenMeta = doc.createElement('div');
    tokenMeta.className = 'ag-bar-meta';
    const tokenLabel = doc.createElement('span');
    tokenLabel.textContent = item.kind === 'rules' ? 'Rules 预算占用' : '上下文占用';
    const tokenVal = doc.createElement('span');
    tokenVal.className = 'ag-asset-token-val';
    const sharePct = item.tokenShare || clampPct((item.tokens / Math.max(1, budgetLimit)) * 100);
    tokenVal.textContent = `${formatNumber(item.tokens)} Token · ${sharePct}%`;
    tokenMeta.appendChild(tokenLabel);
    tokenMeta.appendChild(tokenVal);

    const track = doc.createElement('div');
    track.className = 'ag-progress-track';
    const fill = doc.createElement('div');
    fill.className = 'ag-progress-fill';
    const itemTone = item.excluded ? 'danger' : (sharePct >= 15 ? 'warn' : 'ok');
    fill.setAttribute('data-tone', itemTone);
    fill.style.setProperty('width', `${Math.min(100, sharePct)}%`);
    track.appendChild(fill);
    tokenSection.appendChild(tokenMeta);
    tokenSection.appendChild(track);
    card.appendChild(tokenSection);

    // 3. Dedicated MCP Strategy Control (Force Eager / Smart Lazy)
    if (item.kind === 'mcp' && item.mcp) {
      const mcpBox = doc.createElement('div');
      mcpBox.className = 'ag-mcp-strategy-box';
      mcpBox.setAttribute('data-mcp-policy', item.mcp.policy);

      const mcpTop = doc.createElement('div');
      mcpTop.className = 'ag-mcp-strategy-top';

      const mcpInfo = doc.createElement('div');
      mcpInfo.className = 'ag-sv-row-info';
      const mcpTitle = doc.createElement('span');
      mcpTitle.className = 'ag-mcp-strategy-title';
      const totalTools = item.mcp.totalTools || item.mcp.tools.length;
      mcpTitle.textContent = `加载策略 · ${totalTools} 个工具${item.mcp.excludedTools.length > 0 ? ` (${item.mcp.excludedTools.length} 个被排除)` : ''}`;
      const mcpHint = doc.createElement('span');
      mcpHint.className = 'ag-mcp-strategy-hint';
      mcpHint.textContent = item.mcp.policy === 'lazy'
        ? 'Smart Lazy：按需加载工具 Schema，突破 20,000 Token 排除限制'
        : (item.mcp.excludedTools.length > 0
            ? 'Force Eager 常驻模式因总预算超出，部分大 Schema 工具已被排除'
            : 'Force Eager：全部工具 Schema 随每轮 Prompt 常驻注入');
      mcpInfo.appendChild(mcpTitle);
      mcpInfo.appendChild(mcpHint);

      const policySeg = doc.createElement('div');
      policySeg.className = 'ag-segmented ag-mcp-policy-seg';
      policySeg.setAttribute('role', 'group');
      policySeg.setAttribute('aria-label', `${item.displayName} MCP 加载策略`);

      const lazyBtn = doc.createElement('button');
      lazyBtn.type = 'button';
      lazyBtn.className = item.mcp.policy === 'lazy' ? 'switch-pill-btn active' : 'switch-pill-btn';
      lazyBtn.setAttribute('data-custom-mcp-policy', `${item.id}:lazy`);
      lazyBtn.setAttribute('data-active', item.mcp.policy === 'lazy' ? 'true' : 'false');
      lazyBtn.disabled = isBusy || !hasBridge;
      lazyBtn.textContent = 'Smart Lazy';
      lazyBtn.addEventListener('click', () => {
        if (item.mcp.policy !== 'lazy') handlers.onSetMcpPolicy(item, 'lazy');
      });

      const eagerBtn = doc.createElement('button');
      eagerBtn.type = 'button';
      eagerBtn.className = item.mcp.policy === 'eager' ? 'switch-pill-btn active' : 'switch-pill-btn';
      eagerBtn.setAttribute('data-custom-mcp-policy', `${item.id}:eager`);
      eagerBtn.setAttribute('data-active', item.mcp.policy === 'eager' ? 'true' : 'false');
      eagerBtn.disabled = isBusy || !hasBridge;
      eagerBtn.textContent = 'Force Eager';
      eagerBtn.addEventListener('click', () => {
        if (item.mcp.policy !== 'eager') handlers.onSetMcpPolicy(item, 'eager');
      });

      policySeg.appendChild(lazyBtn);
      policySeg.appendChild(eagerBtn);
      mcpTop.appendChild(mcpInfo);
      mcpTop.appendChild(policySeg);
      mcpBox.appendChild(mcpTop);

      if (item.mcp.tools.length > 0) {
        const isExpanded = customState.expandedMcpIds?.has?.(item.id);
        const expandBtn = doc.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'ag-mcp-expand-btn';
        expandBtn.setAttribute('data-custom-mcp-expand', item.id);
        expandBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        const expandLbl = doc.createElement('span');
        expandLbl.textContent = isExpanded ? '收起工具清单' : `查看 ${item.mcp.tools.length} 个工具 Schema 明细`;
        expandBtn.appendChild(expandLbl);
        expandBtn.appendChild(createIconSvg(doc, CUSTOM_ICONS.chevronDown));
        expandBtn.addEventListener('click', () => handlers.onToggleMcpExpand(item.id));
        mcpBox.appendChild(expandBtn);

        if (isExpanded || item.mcp.excludedTools.length > 0) {
          const toolsList = doc.createElement('div');
          toolsList.className = 'ag-mcp-tools-list';
          const visibleTools = isExpanded ? item.mcp.tools : item.mcp.tools.filter((t) => t.excluded);
          for (const tool of visibleTools) {
            const pill = doc.createElement('span');
            pill.className = 'ag-chip ag-mcp-tool-chip';
            pill.setAttribute('data-tone', tool.excluded ? 'danger' : (tool.eager ? 'accent' : 'muted'));
            pill.textContent = `${tool.name} · ${formatNumber(tool.tokens)}t${tool.excluded ? ' (已排除)' : (tool.eager ? '' : ' · lazy')}`;
            toolsList.appendChild(pill);
          }
          mcpBox.appendChild(toolsList);
        }
      }

      card.appendChild(mcpBox);
    }

    // 4. Footer: Toggle + Promote to Workspace + Uninstall
    const foot = doc.createElement('div');
    foot.className = 'ag-asset-card-foot';

    const leftBtns = doc.createElement('div');
    leftBtns.className = 'ag-asset-foot-actions';

    if (item.scope === 'global' && item.canPromote) {
      const promoteBtn = doc.createElement('button');
      promoteBtn.type = 'button';
      promoteBtn.className = 'ag-btn ag-btn-compact';
      promoteBtn.setAttribute('data-custom-promote', item.id);
      const noWorkspace = !customState.workspacePath;
      promoteBtn.disabled = isBusy || !hasBridge || noWorkspace || item.promotedToWorkspace;
      promoteBtn.setAttribute('title', noWorkspace
        ? '未检测到激活工作区路径'
        : (item.promotedToWorkspace ? '已同步至当前工作区 .agents' : '复制到当前工作区 .agents/ 隔离使用'));
      promoteBtn.appendChild(createIconSvg(doc, CUSTOM_ICONS.folderSync));
      const pLbl = doc.createElement('span');
      pLbl.textContent = item.promotedToWorkspace ? '已在工作区' : '落位工作区';
      promoteBtn.appendChild(pLbl);
      promoteBtn.addEventListener('click', () => handlers.onPromote(item));
      leftBtns.appendChild(promoteBtn);
    }

    if (item.canUninstall) {
      const confirming = customState.confirmUninstallId === item.id;
      const unBtn = doc.createElement('button');
      unBtn.type = 'button';
      unBtn.className = confirming ? 'ag-btn ag-btn-compact ag-btn-danger' : 'ag-btn ag-btn-compact';
      unBtn.setAttribute('data-custom-uninstall', item.id);
      unBtn.disabled = isBusy || !hasBridge;
      if (!confirming) {
        unBtn.appendChild(createIconSvg(doc, CUSTOM_ICONS.trash));
      }
      const uLbl = doc.createElement('span');
      uLbl.textContent = confirming ? '确认卸载?' : '卸载';
      unBtn.appendChild(uLbl);
      unBtn.addEventListener('click', () => handlers.onUninstall(item));
      leftBtns.appendChild(unBtn);
    }

    const rightControls = doc.createElement('div');
    rightControls.className = 'ag-asset-foot-right';
    if (isBusy) {
      const sp = doc.createElement('span');
      sp.className = 'ag-spinner';
      rightControls.appendChild(sp);
    }

    const toggleWrap = doc.createElement('label');
    toggleWrap.className = 'ag-toggle-label';
    toggleWrap.setAttribute('title', item.enabled ? '点击禁用此自定义项' : '点击启用此自定义项');
    const toggleInput = doc.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = Boolean(item.enabled);
    toggleInput.disabled = isBusy || !hasBridge || !item.canToggle;
    toggleInput.setAttribute('data-custom-toggle', item.id);
    toggleInput.setAttribute('aria-label', `启停 ${item.displayName || item.name}`);
    toggleInput.addEventListener('change', () => {
      handlers.onToggle(item, Boolean(toggleInput.checked));
    });
    toggleWrap.appendChild(toggleInput);
    rightControls.appendChild(toggleWrap);

    foot.appendChild(leftBtns);
    foot.appendChild(rightControls);
    card.appendChild(foot);

    return card;
  }

  function renderCustomizationCenterView(ctx) {
    const {
      doc,
      body,
      customState,
      queryLower,
      hasBridge,
      createSectionBlock,
      handlers
    } = ctx;

    const wrap = doc.createElement('div');
    wrap.id = 'agy-customization-center';
    wrap.className = 'ag-custom-center';

    // 1. Source mode notice when backend /host/customizations route is unavailable
    if (customState.sourceMode === 'fallback') {
      const notice = doc.createElement('div');
      notice.id = 'agy-custom-fallback-banner';
      notice.className = 'ag-manage-toast';
      notice.setAttribute('data-tone', 'info');
      notice.textContent = '当前显示已安装插件的内置资产预览；接入宿主扫描接口后将自动呈现工作区 .agents/ 资产、实时 Token 统计与 MCP 策略改写。';
      wrap.appendChild(notice);
    }

    // 2. Context Budget Dashboard
    const budgetSec = createSectionBlock(
      '上下文预算与 MCP 策略',
      customState.workspacePath
        ? `当前工作区：${customState.workspaceName || customState.workspacePath}（${customState.workspacePath}）`
        : '全局 (~/.gemini/config) 与当前工作区 (.agents/) 统一上下文管理'
    );
    budgetSec.appendChild(renderBudgetDashboard(doc, customState, hasBridge, handlers));
    wrap.appendChild(budgetSec);

    // 3. Scope + Type Filter Toolbar & Actions
    const scopeCounts = getScopeCounts(customState.items || []);
    const typeCounts = getTypeCounts(customState.items || [], customState.scopeFilter);

    const toolbarActions = doc.createElement('div');
    toolbarActions.className = 'ag-plugin-actions';

    const installBtn = doc.createElement('button');
    installBtn.type = 'button';
    installBtn.id = 'agy-custom-open-install-btn';
    installBtn.className = 'ag-btn ag-btn-primary';
    installBtn.disabled = Boolean(customState.busyId);
    installBtn.appendChild(createIconSvg(doc, CUSTOM_ICONS.plus));
    const installLbl = doc.createElement('span');
    installLbl.textContent = '导入 / 安装';
    installBtn.appendChild(installLbl);
    installBtn.addEventListener('click', () => handlers.onOpenInstallModal());
    toolbarActions.appendChild(installBtn);

    if (hasBridge) {
      const refreshBtn = doc.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.id = 'agy-custom-refresh-btn';
      refreshBtn.className = 'ag-btn';
      refreshBtn.disabled = Boolean(customState.loading || customState.busyId);
      refreshBtn.appendChild(createIconSvg(doc, CUSTOM_ICONS.refresh));
      const rLbl = doc.createElement('span');
      rLbl.textContent = '刷新';
      refreshBtn.appendChild(rLbl);
      refreshBtn.addEventListener('click', () => handlers.onRefresh());
      toolbarActions.appendChild(refreshBtn);
    }

    const filteredItems = filterCustomizationItems(customState.items || [], {
      scopeFilter: customState.scopeFilter,
      typeFilter: customState.typeFilter,
      queryLower
    });

    const assetsSec = createSectionBlock(
      '自定义资产目录',
      `共 ${filteredItems.length} 项匹配资产${customState.scopeFilter === 'workspace' ? '（当前工作区 .agents/ 私有隔离）' : ''}`,
      toolbarActions
    );

    const filterBar = doc.createElement('div');
    filterBar.id = 'agy-custom-filter-bar';
    filterBar.className = 'ag-custom-filter-bar';

    const scopeSeg = doc.createElement('div');
    scopeSeg.id = 'agy-custom-scope-tabs';
    scopeSeg.className = 'ag-segmented';
    scopeSeg.setAttribute('role', 'tablist');
    scopeSeg.setAttribute('aria-label', '作用域筛选');

    const scopeOptions = [
      { id: 'all', label: `全部 (${scopeCounts.all})` },
      { id: 'global', label: `全局扩展 (${scopeCounts.global})` },
      { id: 'workspace', label: `当前工作区 .agents (${scopeCounts.workspace})` }
    ];
    for (const sOpt of scopeOptions) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      const active = customState.scopeFilter === sOpt.id;
      btn.className = active ? 'switch-pill-btn active' : 'switch-pill-btn';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.setAttribute('data-custom-scope', sOpt.id);
      btn.setAttribute('data-active', active ? 'true' : 'false');
      btn.textContent = sOpt.label;
      btn.addEventListener('click', () => handlers.onSelectScope(sOpt.id));
      scopeSeg.appendChild(btn);
    }
    filterBar.appendChild(scopeSeg);

    const typeRow = doc.createElement('div');
    typeRow.id = 'agy-custom-type-chips';
    typeRow.className = 'ag-custom-type-chips';
    for (const kindKey of ['all', 'skills', 'rules', 'mcp', 'plugins']) {
      const meta = ASSET_KIND_META[kindKey];
      const chipBtn = doc.createElement('button');
      chipBtn.type = 'button';
      const active = customState.typeFilter === kindKey;
      chipBtn.className = 'qp-pool-chip';
      chipBtn.setAttribute('data-custom-type', kindKey);
      chipBtn.setAttribute('data-active', active ? 'true' : 'false');
      chipBtn.textContent = `${meta.label} (${typeCounts[kindKey] || 0})`;
      chipBtn.addEventListener('click', () => handlers.onSelectType(kindKey));
      typeRow.appendChild(chipBtn);
    }
    filterBar.appendChild(typeRow);
    assetsSec.appendChild(filterBar);

    if (customState.loading && !customState.loaded) {
      const loadCard = doc.createElement('div');
      loadCard.className = 'settings-card-box';
      const loadMsg = doc.createElement('div');
      loadMsg.className = 'ag-sv-empty';
      loadMsg.textContent = '正在扫描全局配置与工作区 .agents/ 资产...';
      loadCard.appendChild(loadMsg);
      assetsSec.appendChild(loadCard);
    } else if (filteredItems.length === 0) {
      const emptyCard = doc.createElement('div');
      emptyCard.className = 'settings-card-box';
      emptyCard.id = 'agy-custom-empty-state';
      const emptyBox = doc.createElement('div');
      emptyBox.className = 'ag-custom-empty-box';
      const emptyTitle = doc.createElement('div');
      emptyTitle.className = 'ag-sv-row-title';
      emptyTitle.textContent = queryLower
        ? `未找到匹配「${queryLower}」的自定义项`
        : (customState.scopeFilter === 'workspace'
            ? '当前工作区 .agents/ 目录下暂无自定义项'
            : '当前筛选条件下暂无自定义项');
      const emptyDesc = doc.createElement('div');
      emptyDesc.className = 'ag-sv-row-desc';
      emptyDesc.textContent = customState.scopeFilter === 'workspace'
        ? '可点击「导入 / 安装」向工作区 .agents/ 添加项目私有 Skill / Rule / MCP，或从「全局扩展」卡片点击「落位工作区」。'
        : '点击右上角「导入 / 安装」从本地路径、GitHub 或市场安装扩展资产。';
      emptyBox.appendChild(emptyTitle);
      emptyBox.appendChild(emptyDesc);
      emptyCard.appendChild(emptyBox);
      assetsSec.appendChild(emptyCard);
    } else {
      const grid = doc.createElement('div');
      grid.id = 'agy-custom-asset-grid';
      grid.className = 'ag-asset-grid';
      const limit = customState.budgets?.customizations?.limit || DEFAULT_TOKEN_BUDGET;
      for (const item of filteredItems) {
        grid.appendChild(renderAssetCard(doc, item, customState, limit, hasBridge, handlers));
      }
      assetsSec.appendChild(grid);
    }

    wrap.appendChild(assetsSec);
    body.appendChild(wrap);
  }

  function renderCustomInstallModal(ctx) {
    const {
      doc,
      container,
      customState,
      catalogEntries,
      hasBridge,
      handlers
    } = ctx;

    if (!container) return;
    const stale = container.querySelector?.('#agy-custom-install-modal-backdrop');
    if (stale?.remove) stale.remove();

    const modalState = customState.installModal;
    if (!modalState) return;

    const backdrop = doc.createElement('div');
    backdrop.id = 'agy-custom-install-modal-backdrop';
    backdrop.className = 'ag-field-modal-backdrop';
    backdrop.addEventListener('click', (ev) => {
      if (!ev || ev.target === backdrop) {
        handlers.onClose();
      }
    });

    const dialog = doc.createElement('div');
    dialog.id = 'agy-custom-install-modal';
    dialog.className = 'ag-field-modal-dialog ag-custom-install-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '导入或安装自定义项');

    const header = doc.createElement('div');
    header.className = 'ag-field-modal-header';
    const titleWrap = doc.createElement('div');
    titleWrap.className = 'ag-field-modal-title-wrap';
    const titleEl = doc.createElement('h2');
    titleEl.className = 'ag-field-modal-title';
    titleEl.textContent = '导入 / 安装自定义项';
    const descEl = doc.createElement('p');
    descEl.className = 'ag-field-modal-desc';
    descEl.textContent = '支持从本地目录导入或市场安装，并指定落位到全局 ~/.gemini 或当前工作区 .agents/';
    titleWrap.appendChild(titleEl);
    titleWrap.appendChild(descEl);

    const headerActions = doc.createElement('div');
    headerActions.className = 'ag-field-modal-header-actions';
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.id = 'agy-custom-install-close';
    closeBtn.className = 'ag-icon-btn';
    closeBtn.setAttribute('title', '关闭');
    closeBtn.setAttribute('aria-label', '关闭导入弹窗');
    closeBtn.appendChild(createIconSvg(doc, CUSTOM_ICONS.close));
    closeBtn.addEventListener('click', () => handlers.onClose());
    headerActions.appendChild(closeBtn);

    header.appendChild(titleWrap);
    header.appendChild(headerActions);
    dialog.appendChild(header);

    const body = doc.createElement('div');
    body.className = 'ag-field-modal-body ag-custom-install-body';

    // Source Tab Switcher (Local vs Market) + Target Scope Selector
    const topControls = doc.createElement('div');
    topControls.className = 'ag-custom-install-controls';

    const modeSeg = doc.createElement('div');
    modeSeg.className = 'ag-segmented';
    for (const t of [
      { id: 'local', label: '本地路径 / 仓库' },
      { id: 'market', label: '从市场安装' }
    ]) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      const active = modalState.tab === t.id;
      btn.className = active ? 'switch-pill-btn active' : 'switch-pill-btn';
      btn.setAttribute('data-install-tab', t.id);
      btn.setAttribute('data-active', active ? 'true' : 'false');
      btn.textContent = t.label;
      btn.addEventListener('click', () => handlers.onUpdateModal({ tab: t.id }));
      modeSeg.appendChild(btn);
    }

    const scopeSeg = doc.createElement('div');
    scopeSeg.className = 'ag-segmented';
    scopeSeg.setAttribute('aria-label', '目标安装作用域');
    for (const s of [
      { id: 'global', label: '全局 Global' },
      { id: 'workspace', label: '当前工作区 .agents' }
    ]) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      const active = modalState.scope === s.id;
      btn.className = active ? 'switch-pill-btn active' : 'switch-pill-btn';
      btn.setAttribute('data-install-scope', s.id);
      btn.setAttribute('data-active', active ? 'true' : 'false');
      if (s.id === 'workspace' && !customState.workspacePath) {
        btn.setAttribute('title', '未检测到活动工作区路径，安装时将提示或由宿主选择');
      }
      btn.textContent = s.label;
      btn.addEventListener('click', () => handlers.onUpdateModal({ scope: s.id }));
      scopeSeg.appendChild(btn);
    }

    topControls.appendChild(modeSeg);
    topControls.appendChild(scopeSeg);
    body.appendChild(topControls);

    if (modalState.tab === 'local') {
      const formCard = doc.createElement('div');
      formCard.className = 'settings-card-box';

      const specRow = doc.createElement('div');
      specRow.className = 'ag-field-row';
      const specLbl = doc.createElement('label');
      specLbl.className = 'ag-field-label';
      specLbl.textContent = '来源路径或仓库标识';
      const specInput = doc.createElement('input');
      specInput.type = 'text';
      specInput.id = 'agy-custom-install-spec';
      specInput.className = 'settings-input ag-custom-install-input';
      specInput.placeholder = '/path/to/skill-or-plugin、github:owner/repo 或 npm:pkg';
      specInput.value = modalState.spec || '';
      specInput.addEventListener('input', () => {
        modalState.spec = String(specInput.value || '');
      });
      specInput.addEventListener('keydown', (ev) => {
        if (ev?.key === 'Enter') {
          handlers.onInstallLocal();
        }
      });
      specRow.appendChild(specLbl);
      specRow.appendChild(specInput);
      formCard.appendChild(specRow);

      const kindRow = doc.createElement('div');
      kindRow.className = 'settings-pref-row';
      const kindInfo = doc.createElement('div');
      kindInfo.className = 'ag-sv-row-info';
      const kTitle = doc.createElement('span');
      kTitle.className = 'ag-sv-row-title';
      kTitle.textContent = '资产类型';
      const kDesc = doc.createElement('span');
      kDesc.className = 'ag-sv-row-desc';
      kDesc.textContent = '自动识别（SKILL.md / agy-plugin.json / mcp_config.json）或手动指定';
      kindInfo.appendChild(kTitle);
      kindInfo.appendChild(kDesc);

      const kindSel = doc.createElement('select');
      kindSel.id = 'agy-custom-install-kind';
      kindSel.className = 'settings-input';
      for (const opt of [
        { value: 'auto', label: '自动识别' },
        { value: 'skills', label: 'Skill 技能' },
        { value: 'rules', label: 'Rule 规则' },
        { value: 'mcp', label: 'MCP Server' },
        { value: 'plugins', label: 'Plugin 插件' }
      ]) {
        const o = doc.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        kindSel.appendChild(o);
      }
      kindSel.value = modalState.kind || 'auto';
      kindSel.addEventListener('change', () => {
        modalState.kind = String(kindSel.value || 'auto');
      });
      kindRow.appendChild(kindInfo);
      kindRow.appendChild(kindSel);
      formCard.appendChild(kindRow);

      const modeRow = doc.createElement('div');
      modeRow.className = 'settings-pref-row';
      const modeInfo = doc.createElement('div');
      modeInfo.className = 'ag-sv-row-info';
      const mTitle = doc.createElement('span');
      mTitle.className = 'ag-sv-row-title';
      mTitle.textContent = '导入方式';
      const mDesc = doc.createElement('span');
      mDesc.className = 'ag-sv-row-desc';
      mDesc.textContent = modalState.copy !== false
        ? '复制到目标目录（独立副本，推荐用于工作区隔离）'
        : '本地软链（保持与源目录实时同步）';
      modeInfo.appendChild(mTitle);
      modeInfo.appendChild(mDesc);

      const copyBtn = doc.createElement('button');
      copyBtn.type = 'button';
      copyBtn.id = 'agy-custom-install-copy-btn';
      copyBtn.className = 'ag-btn';
      copyBtn.textContent = modalState.copy !== false ? '复制安装' : '本地软链';
      copyBtn.addEventListener('click', () => {
        handlers.onUpdateModal({ copy: modalState.copy === false });
      });
      modeRow.appendChild(modeInfo);
      modeRow.appendChild(copyBtn);
      formCard.appendChild(modeRow);

      body.appendChild(formCard);
    } else {
      const mSearch = doc.createElement('input');
      mSearch.type = 'text';
      mSearch.id = 'agy-custom-market-search';
      mSearch.className = 'settings-input ag-custom-install-input';
      mSearch.placeholder = '筛选市场目录中的扩展与插件...';
      mSearch.value = modalState.marketQuery || '';
      mSearch.addEventListener('input', () => {
        handlers.onUpdateModal({ marketQuery: String(mSearch.value || '') });
      });
      body.appendChild(mSearch);

      const q = String(modalState.marketQuery || '').trim().toLowerCase();
      const filteredMarket = (catalogEntries || []).filter((entry) => {
        if (!entry) return false;
        if (!q) return true;
        return `${entry.id} ${entry.displayName} ${entry.description}`.toLowerCase().includes(q);
      });

      const listCard = doc.createElement('div');
      listCard.className = 'settings-card-box ag-custom-market-list';
      if (filteredMarket.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'ag-sv-empty';
        empty.textContent = '暂无匹配的市场可安装项';
        listCard.appendChild(empty);
      } else {
        for (const entry of filteredMarket) {
          const row = doc.createElement('div');
          row.className = 'settings-pref-row';
          row.setAttribute('data-custom-market-item', entry.id);

          const info = doc.createElement('div');
          info.className = 'ag-sv-row-info';
          const tLine = doc.createElement('div');
          tLine.className = 'ag-plugin-info';
          const title = doc.createElement('span');
          title.className = 'ag-sv-row-title';
          title.textContent = entry.displayName || entry.id;
          const ver = doc.createElement('span');
          ver.className = 'ag-plugin-ver';
          ver.textContent = `v${entry.version || '1.0.0'}`;
          tLine.appendChild(title);
          tLine.appendChild(ver);
          const desc = doc.createElement('span');
          desc.className = 'ag-sv-row-desc';
          desc.textContent = entry.description || entry.recommendedSpec || entry.id;
          info.appendChild(tLine);
          info.appendChild(desc);

          const actBtn = doc.createElement('button');
          actBtn.type = 'button';
          actBtn.className = entry.installed ? 'ag-btn' : 'ag-btn ag-btn-primary';
          actBtn.setAttribute('data-custom-market-install', entry.id);
          actBtn.disabled = Boolean(customState.busyId) || !hasBridge;
          actBtn.textContent = entry.installed
            ? (modalState.scope === 'workspace' ? '安装到工作区' : '已安装')
            : (modalState.scope === 'workspace' ? '安装到 .agents' : '安装');
          actBtn.addEventListener('click', () => handlers.onInstallMarket(entry));

          row.appendChild(info);
          row.appendChild(actBtn);
          listCard.appendChild(row);
        }
      }
      body.appendChild(listCard);
    }

    dialog.appendChild(body);

    const footer = doc.createElement('div');
    footer.className = 'ag-field-modal-footer';
    const footerLeft = doc.createElement('div');
    footerLeft.className = 'ag-field-modal-footer-left';
    const targetDesc = doc.createElement('span');
    targetDesc.className = 'ag-field-modal-meta';
    targetDesc.textContent = modalState.scope === 'workspace'
      ? `目标目录：${customState.workspaceName || '当前工作区'}/.agents/`
      : '目标目录：~/.gemini/config/';
    footerLeft.appendChild(targetDesc);

    const footerRight = doc.createElement('div');
    footerRight.className = 'ag-field-modal-footer-right';
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.id = 'agy-custom-install-cancel';
    cancelBtn.className = 'ag-btn';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', () => handlers.onClose());
    footerRight.appendChild(cancelBtn);

    if (modalState.tab === 'local') {
      const submitBtn = doc.createElement('button');
      submitBtn.type = 'button';
      submitBtn.id = 'agy-custom-install-submit';
      submitBtn.className = 'ag-btn ag-btn-primary';
      submitBtn.disabled = Boolean(customState.busyId) || !hasBridge;
      submitBtn.textContent = customState.busyId === '__custom_install__' ? '导入中...' : '确认导入';
      submitBtn.addEventListener('click', () => handlers.onInstallLocal());
      footerRight.appendChild(submitBtn);
    }

    footer.appendChild(footerLeft);
    footer.appendChild(footerRight);
    dialog.appendChild(footer);

    backdrop.appendChild(dialog);
    container.appendChild(backdrop);
  }

  function renderCustomizationPopoverBody(ctx) {
    const { doc, listEl, customState, hasBridge, handlers } = ctx;
    if (!listEl) return;
    listEl.innerHTML = '';
    if (Array.isArray(listEl.children)) listEl.children.length = 0;

    const mainBudget = customState.budgets?.customizations || {
      limit: DEFAULT_TOKEN_BUDGET,
      used: 0,
      warnThreshold: 16000,
      excludedCount: 0
    };
    const pct = clampPct((mainBudget.used / Math.max(1, mainBudget.limit)) * 100);
    const tone = resolveBudgetTone(mainBudget);
    const scopeCounts = getScopeCounts(customState.items || []);

    const summaryCard = doc.createElement('div');
    summaryCard.className = 'ag-custom-pop-summary';

    const metaRow = doc.createElement('div');
    metaRow.className = 'ag-bar-meta';
    const lbl = doc.createElement('span');
    lbl.textContent = '20K 上下文预算';
    const val = doc.createElement('span');
    val.className = 'ag-asset-token-val';
    val.textContent = `${formatNumber(mainBudget.used)} / ${formatNumber(mainBudget.limit)} (${pct}%)`;
    metaRow.appendChild(lbl);
    metaRow.appendChild(val);

    const track = doc.createElement('div');
    track.className = 'ag-progress-track';
    const fill = doc.createElement('div');
    fill.className = 'ag-progress-fill';
    fill.setAttribute('data-tone', tone);
    fill.style.setProperty('width', `${Math.min(100, pct)}%`);
    track.appendChild(fill);

    const miniGrid = doc.createElement('div');
    miniGrid.className = 'ag-panel-mini-grid';
    for (const cellInfo of [
      { l: '全局', v: `${scopeCounts.global}` },
      { l: '工作区', v: `${scopeCounts.workspace}` },
      { l: '已排除', v: `${mainBudget.excludedCount || 0}` }
    ]) {
      const c = doc.createElement('div');
      c.className = 'ag-panel-mini-cell';
      const cl = doc.createElement('span');
      cl.className = 'ag-panel-mini-label';
      cl.textContent = cellInfo.l;
      const cv = doc.createElement('span');
      cv.className = 'ag-panel-mini-value';
      cv.textContent = cellInfo.v;
      c.appendChild(cl);
      c.appendChild(cv);
      miniGrid.appendChild(c);
    }

    summaryCard.appendChild(metaRow);
    summaryCard.appendChild(track);
    summaryCard.appendChild(miniGrid);
    listEl.appendChild(summaryCard);

    const mcpItems = (customState.items || []).filter((it) => it && it.kind === 'mcp' && it.mcp);
    if (mcpItems.length > 0) {
      const secTitle = doc.createElement('div');
      secTitle.className = 'ag-panel-section-title';
      secTitle.textContent = 'MCP 策略快捷切换';
      listEl.appendChild(secTitle);

      for (const mItem of mcpItems.slice(0, 4)) {
        const row = doc.createElement('div');
        row.className = 'ag-custom-pop-row';
        const info = doc.createElement('div');
        info.className = 'ag-sv-row-info';
        const name = doc.createElement('span');
        name.className = 'ag-sv-row-title';
        name.textContent = mItem.displayName || mItem.name;
        const sub = doc.createElement('span');
        sub.className = 'ag-muted';
        sub.textContent = `${mItem.mcp.policy === 'lazy' ? 'Smart Lazy' : 'Force Eager'} · ${formatNumber(mItem.tokens)} Tok`;
        info.appendChild(name);
        info.appendChild(sub);

        const toggleBtn = doc.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = mItem.mcp.policy === 'lazy' ? 'ag-btn ag-btn-compact' : 'ag-btn ag-btn-compact ag-btn-primary';
        toggleBtn.setAttribute('data-pop-mcp-toggle', mItem.id);
        toggleBtn.disabled = Boolean(customState.busyId) || !hasBridge;
        toggleBtn.textContent = mItem.mcp.policy === 'lazy' ? '切为 Eager' : '转为 Lazy';
        toggleBtn.addEventListener('click', () => {
          handlers.onSetMcpPolicy(mItem, mItem.mcp.policy === 'lazy' ? 'eager' : 'lazy');
        });

        row.appendChild(info);
        row.appendChild(toggleBtn);
        listEl.appendChild(row);
      }
    }

    const openFullBtn = doc.createElement('button');
    openFullBtn.type = 'button';
    openFullBtn.id = 'agy-custom-pop-open-center';
    openFullBtn.className = 'ag-btn ag-btn-primary ag-custom-pop-open-btn';
    openFullBtn.appendChild(createIconSvg(doc, CUSTOM_ICONS.layers));
    const lblBtn = doc.createElement('span');
    lblBtn.textContent = '打开自定义项增强中心';
    openFullBtn.appendChild(lblBtn);
    openFullBtn.addEventListener('click', () => handlers.onOpenCenter());
    listEl.appendChild(openFullBtn);
  }

  const api = {
    DEFAULT_TOKEN_BUDGET,
    ASSET_KIND_META,
    ASSET_SCOPE_META,
    createCustomizationState,
    normalizeCustomizationPayload,
    filterCustomizationItems,
    resolveBudgetTone,
    getScopeCounts,
    getTypeCounts,
    renderCustomizationCenterView,
    renderCustomInstallModal,
    renderCustomizationPopoverBody
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.__AGYCustomizationCenter = api;
  }
})(globalThis);
