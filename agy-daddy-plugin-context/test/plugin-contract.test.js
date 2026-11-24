'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

test('插件契约：极简 icon+数字 互斥胶囊、就近向上弹窗、详情面板解释、流式 ~tok/s 方案 A 与零泄漏 dispose', async () => {
  // 1. 全 src 目录禁用色静态门禁
  const forbidden = [
    /#10b981/i,
    /16,\s*185,\s*129/,
    /#34d399/i,
    /#059669/i,
    /#38bdf8/i,
    /56,\s*189,\s*248/,
    /2,\s*132,\s*199/,
    /#7dd3fc/i,
    /#(?:0369a1|0c4a6e)/i,
    /#(?:fb923c|c2410c)|249,\s*115,\s*22|234,\s*88,\s*12/i
  ];
  for (const fileName of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const full = path.join(PLUGIN_ROOT, 'src', fileName);
    const src = fs.readFileSync(full, 'utf8');
    for (const re of forbidden) {
      assert.equal(re.test(src), false, `${fileName} violated theme color gate: ${re}`);
    }
  }

  const telemetryEvents = [];
  const sampleRpcHandler = (method) => {
    if (method === 'GetAvailableModels') {
      return {
        models: {
          'claude-opus-5-5': { model: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', maxTokens: 1000000 }
        }
      };
    }
    if (method === 'GetAllCascadeTrajectories') {
      return {
        trajectorySummaries: {
          '11111111-2222-3333-4444-555555555555': {
            lastModifiedTime: '2026-11-21T10:00:00Z',
            annotations: { title: '测试会话' }
          }
        }
      };
    }
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      return {
        generatorMetadata: [
          {
            stepIndices: [0],
            createdAt: '2026-11-21T09:59:00Z',
            chatModel: {
              model: 'claude-opus-5-5',
              modelDisplayName: 'Claude Opus 5.5',
              timeToFirstToken: '0.5s',
              streamingDuration: '1.5s',
              usage: { responseId: 'call-ctx-0', inputTokens: 8000, cacheReadTokens: 2000, outputTokens: 200 },
              chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 1000000 } }
            }
          },
          {
            stepIndices: [1],
            createdAt: '2026-11-21T10:00:00Z',
            chatModel: {
              model: 'claude-opus-5-5',
              modelDisplayName: 'Claude Opus 5.5',
              timeToFirstToken: '0.5s',
              streamingDuration: '1.5s',
              usage: { responseId: 'call-ctx-1', inputTokens: 2000, cacheReadTokens: 18000, outputTokens: 400 },
              chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 1000000 } }
            }
          }
        ]
      };
    }
    if (method === 'GetCascadeTrajectory') {
      return {
        steps: [
          { userInput: { userResponse: '测试提问' } },
          { plannerResponse: { response: '测试回答', thinking: '思考' } }
        ]
      };
    }
    return {};
  };

  const harness = createMockHostHarness({ onRpc: sampleRpcHandler });
  try {
    // 种子对话区与流式取消按钮以验证方案 A 实时测速
    const msgList = harness.mockDoc.createElement('div');
    msgList.setAttribute('data-testid', 'turn-cards-container');
    const agentResp = harness.mockDoc.createElement('div');
    agentResp.setAttribute('data-testid', 'agent-response');
    agentResp.textContent = '';
    msgList.appendChild(agentResp);
    harness.mockDoc.body.appendChild(msgList);

    const cancelBtn = harness.mockDoc.createElement('button');
    cancelBtn.setAttribute('data-testid', 'input-cancel-button');
    cancelBtn.disabled = true;

    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    harness.bus.onEvent('test', 'telemetry:generator-calls@1', (p) => telemetryEvents.push(p));

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, {
      trustLevel: 'T0'
    });
    assert.equal(loaded.manifest.id, 'agy-daddy.context');
    assert.equal(loaded.manifest.world, 'isolated');
    assert.equal(loaded.trust.world, 'isolated');
    assert.equal((loaded.manifest.permissions || []).includes('page:main-world'), false);
    assert.equal('migrations' in (loaded.manifest.contributes || {}), false);

    // 验证私有 /settings 路由已彻底删除
    const deadSettingsResp = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.context/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AGY-Plugin-Token': loaded.pluginToken
      },
      body: JSON.stringify({ action: 'get' })
    });
    assert.equal(deadSettingsResp.status, 404);

    // 验证 Pulse 胶囊样式与 Shadow 面板样式均已注入并可清洁回收
    const injectedStyle = harness.mockDoc.querySelector('style[data-agy-style="agy-daddy.context"][data-agy-style-id="context-pulse-styles"]');
    assert.ok(injectedStyle, 'Expected context-pulse-styles injected into document');
    assert.match(injectedStyle.textContent, /#agy-pulse-context-capsule/);
    assert.match(injectedStyle.textContent, /#agy-pulse-context-wrap[\s\S]*display:\s*flex/);
    assert.match(injectedStyle.textContent, /#agy-pulse-context-wrap[\s\S]*justify-content:\s*flex-end/);
    assert.match(injectedStyle.textContent, /#agy-pulse-context-wrap[\s\S]*padding:\s*5px 2px 0 2px/);
    assert.match(injectedStyle.textContent, /#agy-pulse-context-wrap[\s\S]*margin:\s*4px 0 0 0/);

    const shadowRoot = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
    const shadowPanelStyle = shadowRoot.querySelector('style[data-agy-style="agy-daddy.context"][data-agy-style-id="context-panel-styles"]');
    assert.ok(shadowPanelStyle, 'Expected context-panel-styles injected into shadowRoot');
    assert.match(shadowPanelStyle.textContent, /@container/);

    // 默认 displayLocation === 'composer'：仅输入框下方极简 icon+数字 胶囊挂载，顶栏不挂载
    const barChildren = shadowRoot.querySelector('#agy-topbar-slots').children;
    assert.equal(barChildren.find((c) => c.id === 'agy-unit-agy-daddy.context-ring'), undefined);

    const pulseWrap = harness.mockDoc.getElementById('agy-pulse-context-wrap');
    assert.ok(pulseWrap, 'Expected #agy-pulse-context-wrap to be mounted');
    assert.equal(pulseWrap.getAttribute('data-position'), 'below-composer');
    const composerRootInitial = harness.mockDoc.querySelector('.surface-composer');
    assert.equal(pulseWrap.parentElement, composerRootInitial.parentElement, 'Pulse wrap must mount outside .surface-composer');
    const initialParentChildren = Array.from(composerRootInitial.parentElement.children);
    assert.equal(
      initialParentChildren.indexOf(pulseWrap),
      initialParentChildren.indexOf(composerRootInitial) + 1,
      'Pulse wrap must be mounted immediately after .surface-composer'
    );

    const pulseBtn = harness.mockDoc.querySelector('[data-agy-context-capsule="1"]');
    assert.ok(pulseBtn);
    assert.equal(pulseBtn.querySelectorAll('.agy-pulse-seg').length, 3);
    assert.match(pulseBtn.textContent, /20\.4k\/1M/);
    assert.match(pulseBtn.textContent, /30\.6k/);
    assert.match(pulseBtn.textContent, /200\/s/);
    assert.doesNotMatch(pulseBtn.textContent, /窗口|本对话|5h:/);
    assert.match(pulseBtn.getAttribute('title') || '', /上下文窗口/);
    assert.match(pulseBtn.getAttribute('data-dual-svg') || '', /<svg[^>]*data-occ=/);

    // 点击底部胶囊应向上就近弹出（data-placement="top", top="auto", bottom 非空）
    pulseBtn.getBoundingClientRect = () => ({ top: 700, left: 820, right: 1180, bottom: 726, width: 360, height: 26 });
    pulseBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    const outerPopover = shadowRoot.querySelector('[data-agy-popover="agy-daddy.context:context-panel"]');
    assert.ok(outerPopover);
    assert.equal(outerPopover.hidden, false);
    assert.equal(outerPopover.getAttribute('data-placement'), 'top');
    assert.equal(outerPopover.style.getPropertyValue('top'), 'auto');
    assert.ok(outerPopover.style.getPropertyValue('bottom'));
    assert.ok(outerPopover.querySelector('.ag-popover-settings-btn'));
    assert.ok(outerPopover.querySelector('.ag-popover-close-btn'));

    // 面板采用扁平分割线布局与渐进披露：无嵌套卡片、无原始英文 reported、含中文标签与折叠指标说明
    const panelEl = shadowRoot.querySelector('#agy-context-panel');
    assert.ok(panelEl);
    assert.equal(panelEl.querySelector('.ag-panel-head'), null, 'Plugin body must not duplicate .ag-panel-head');
    assert.equal(panelEl.querySelectorAll('.settings-card-box').length, 0, 'Panel must avoid nested cards');
    assert.ok(panelEl.querySelectorAll('.ag-ctx-section').length >= 4);
    assert.doesNotMatch(panelEl.textContent, /\breported\b/);
    assert.match(panelEl.textContent, /上下文窗口/);
    assert.match(panelEl.textContent, /本对话累计/);
    assert.match(panelEl.textContent, /30\.6k/);
    assert.match(panelEl.textContent, /2 次调用/);
    assert.match(panelEl.textContent, /生成速度/);
    assert.match(panelEl.textContent, /200\/s/);
    assert.match(panelEl.textContent, /上下文构成/);
    assert.match(panelEl.textContent, /回复|用户|思考/);
    assert.match(panelEl.textContent, /指标说明/);
    assert.match(panelEl.textContent, /刷新/);
    assert.equal(panelEl.textContent.includes('$'), false, 'Context panel should not display billing currency');

    // 验证方案 A 流式实时测速：出现 cancelBtn 且正文增长 -> ~tok/s，结束后恢复精确值
    const composerRoot = harness.mockDoc.querySelector('.surface-composer');
    composerRoot.appendChild(cancelBtn);
    cancelBtn.disabled = false;
    agentResp.textContent = '';
    await new Promise((r) => setTimeout(r, 450));
    assert.match(pulseBtn.textContent, /…|~[\d.]+\/s/);
    assert.equal(pulseBtn.getAttribute('data-streaming'), 'true');
    agentResp.textContent = 'A'.repeat(480);
    await new Promise((r) => setTimeout(r, 900));
    assert.match(pulseBtn.textContent, /~[\d.]+\/s/);
    assert.match(panelEl.textContent, /流式估算/);

    // 结束流式 -> 自动切回 RPC 精确 200/s
    cancelBtn.disabled = true;
    cancelBtn.remove();
    await new Promise((r) => setTimeout(r, 480));
    assert.equal(pulseBtn.getAttribute('data-streaming'), 'false');
    assert.match(pulseBtn.textContent, /200\/s/);
    assert.match(panelEl.textContent, /实测/);

    // 切换为顶栏模式：底部胶囊卸载，顶栏单元挂载多段 icon+数字，点击顶栏向下弹出；支持百分比阈值
    await harness.updatePluginSettings('agy-daddy.context', {
      displayLocation: 'topbar',
      warnThreshold: '50%'
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(harness.mockDoc.getElementById('agy-pulse-context-wrap'), null);
    assert.equal(harness.mockDoc.querySelector('[data-agy-context-capsule="1"]'), null);
    const ringBtn = shadowRoot.querySelector('#agy-topbar-slots').children.find((c) => c.id === 'agy-unit-agy-daddy.context-ring');
    assert.ok(ringBtn, 'Topbar ring unit should mount when displayLocation=topbar');
    assert.equal(ringBtn.querySelectorAll('.ag-unit-seg').length, 3);
    assert.match(ringBtn.textContent, /20\.4k\/1M/);
    assert.match(ringBtn.textContent, /30\.6k/);
    assert.match(ringBtn.textContent, /200\/s/);
    assert.doesNotMatch(ringBtn.textContent, /窗口|本对话/);
    assert.match(panelEl.textContent, /预警 50%/);

    ringBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(outerPopover.getAttribute('data-placement'), 'bottom');

    // 关闭速度显示 -> 顶栏胶囊隐藏速度段
    await harness.updatePluginSettings('agy-daddy.context', { showSpeed: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.doesNotMatch(ringBtn.textContent, /200\/s/);

    // 切回输入框下方 -> 顶栏单元卸载，底部胶囊恢复
    await harness.updatePluginSettings('agy-daddy.context', {
      displayLocation: 'composer',
      showSpeed: true,
      warnThreshold: '240K',
      cliffThreshold: '328K'
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(shadowRoot.querySelector('#agy-topbar-slots').children.find((c) => c.id === 'agy-unit-agy-daddy.context-ring'), undefined);
    const restoredWrap = harness.mockDoc.getElementById('agy-pulse-context-wrap');
    assert.ok(restoredWrap, 'Restored #agy-pulse-context-wrap should exist');
    assert.equal(restoredWrap.parentElement, composerRootInitial.parentElement);
    const restoredParentChildren = Array.from(composerRootInitial.parentElement.children);
    assert.equal(
      restoredParentChildren.indexOf(restoredWrap),
      restoredParentChildren.indexOf(composerRootInitial) + 1
    );
    const restoredPulse = harness.mockDoc.querySelector('[data-agy-context-capsule="1"]');
    assert.ok(restoredPulse);
    assert.match(restoredPulse.textContent, /200\/s/);

    // 验证压缩触发策略 (remind / idle_prompt / cliff_auto) 与 丢缓存独立强开 + 草稿保护
    const compactEvents = [];
    const editorEl = harness.mockDoc.querySelector('[contenteditable="true"]');
    const sendBtnEl = harness.mockDoc.querySelector('[data-testid="input-send-button"]');
    const sentTexts = [];
    sendBtnEl.addEventListener('click', () => sentTexts.push(editorEl.textContent));

    let contextUi = null;
    await harness.rendererHost.mountPlugin('test.consumer', {
      mount(ctx) {
        contextUi = ctx.services.get('context-ui');
        ctx.events.on('context:auto-compact-triggered@1', (p) => compactEvents.push(p));
      }
    });
    assert.ok(contextUi);

    // 1) 默认 remind 策略：超预警不出现外置快捷压缩按钮，超断崖也不自动发
    await contextUi.evaluateCompactState({ hasSession: true, used: 350000, budget: 1000000, cacheDropDetected: false });
    const quickCompactBtn = harness.mockDoc.querySelector('[data-agy-compact-quick="1"]');
    assert.ok(quickCompactBtn);
    assert.equal(quickCompactBtn.hidden, true);
    assert.equal(sentTexts.length, 0);

    // 2) idle_prompt（仅开 A）：达预警且空闲无草稿时出现快捷按钮；有草稿或忙碌时隐藏；超断崖也不自动发；点击发送 /compact
    await harness.updatePluginSettings('agy-daddy.context', { compactPolicy: 'idle_prompt' });
    editorEl.textContent = '';
    const onlyARes = await contextUi.evaluateCompactState({ hasSession: true, used: 340000, budget: 1000000, cacheDropDetected: false });
    assert.equal(quickCompactBtn.hidden, false);
    assert.equal(onlyARes.triggered, false);
    assert.equal(sentTexts.length, 0);

    editorEl.textContent = '正在输入的草稿';
    harness.mockDoc.dispatchEvent({ type: 'input', target: editorEl });
    assert.equal(quickCompactBtn.hidden, true);

    editorEl.textContent = '';
    composerRoot.appendChild(cancelBtn);
    cancelBtn.disabled = false;
    await contextUi.evaluateCompactState({ hasSession: true, used: 250000, budget: 1000000, cacheDropDetected: false });
    assert.equal(quickCompactBtn.hidden, true);

    cancelBtn.disabled = true;
    cancelBtn.remove();
    await contextUi.evaluateCompactState({ hasSession: true, used: 250000, budget: 1000000, cacheDropDetected: false });
    assert.equal(quickCompactBtn.hidden, false);
    quickCompactBtn.click();
    assert.deepEqual(sentTexts, ['/compact']);

    // 3) cliff_auto（仅开 B）：预警区不显示外置快捷按钮；达断崖时 AI 忙碌不强杀，回复结束转为闲时自动发 /compact 并保护恢复草稿
    sentTexts.length = 0;
    editorEl.textContent = '';
    await harness.updatePluginSettings('agy-daddy.context', { compactPolicy: 'cliff_auto' });
    await contextUi.evaluateCompactState({ hasSession: true, used: 250000, budget: 1000000, cacheDropDetected: false });
    assert.equal(quickCompactBtn.hidden, true);

    editorEl.textContent = '别丢掉这段草稿';
    composerRoot.appendChild(cancelBtn);
    cancelBtn.disabled = false;
    const busyRes = await contextUi.evaluateCompactState({ hasSession: true, used: 340000, budget: 1000000, cacheDropDetected: false });
    assert.equal(busyRes.triggered, false);
    assert.equal(busyRes.pending, true);
    assert.equal(sentTexts.length, 0);

    cancelBtn.disabled = true;
    cancelBtn.remove();
    const idleRes = await contextUi.evaluateCompactState({ hasSession: true, used: 340000, budget: 1000000, cacheDropDetected: false });
    assert.equal(idleRes.triggered, true);
    assert.deepEqual(sentTexts, ['/compact']);
    assert.equal(idleRes.preservedDraft, true);
    await new Promise((r) => setTimeout(r, 110));
    assert.equal(editorEl.textContent, '别丢掉这段草稿');

    // 4) idle_and_cliff（开 A+B）：预警区显示快捷按钮，且达断崖空闲后也能自动发送
    await harness.updatePluginSettings('agy-daddy.context', { compactPolicy: 'idle_and_cliff' });
    editorEl.textContent = '';
    await contextUi.evaluateCompactState({ hasSession: true, used: 250000, budget: 1000000, cacheDropDetected: false });
    assert.equal(quickCompactBtn.hidden, false);

    sentTexts.length = 0;
    const abCliffRes = await contextUi.evaluateCompactState(
      { hasSession: true, used: 340000, budget: 1000000, cacheDropDetected: false },
      { bypassCooldown: true }
    );
    assert.equal(abCliffRes.triggered, true);
    assert.equal(abCliffRes.reason, 'cliff');
    assert.deepEqual(sentTexts, ['/compact']);

    // 5) 丢缓存独立强行触发：即使 compactPolicy='remind' 且 used < warnThreshold，只要 cacheDropDetected=true 即触发
    await harness.updatePluginSettings('agy-daddy.context', {
      compactPolicy: 'remind',
      autoCompactOnCacheDrop: true
    });
    await new Promise((r) => setTimeout(r, 10));
    sentTexts.length = 0;
    editorEl.textContent = '';
    const dropRes = await contextUi.evaluateCompactState(
      { hasSession: true, used: 160000, budget: 1000000, cacheDropDetected: true },
      { bypassCooldown: true }
    );
    assert.equal(dropRes.triggered, true);
    assert.equal(dropRes.reason, 'cache_drop');
    assert.deepEqual(sentTexts, ['/compact']);
    assert.equal(compactEvents.some((e) => e?.reason === 'cliff'), true);
    assert.equal(compactEvents.some((e) => e?.reason === 'cache_drop'), true);
    await harness.rendererHost.disposePlugin('test.consumer');

    // 验证命令 context.rescan
    const cmdSnap = await harness.executeCommand('context.rescan', [{ cascadeId: '11111111-2222-3333-4444-555555555555' }]);
    assert.equal(cmdSnap.used, 20400);
    assert.equal(cmdSnap.sessionUsage.totalTokens, 30600);
    assert.equal(cmdSnap.sessionUsage.callsCount, 2);

    // 验证事件广播与 callId 幂等去重
    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].calls.length, 2);

    const ctxSvc = harness.bus.getServiceProxy('context');
    const bufferedCalls = await ctxSvc.getRecentCalls(0);
    assert.equal(bufferedCalls.length, 2);

    const snapWithoutUsage = await ctxSvc.rescan({ cascadeId: '11111111-2222-3333-4444-555555555555' });
    assert.equal(telemetryEvents.length, 1);
    assert.equal(snapWithoutUsage.referenceCost, null);

    harness.bus.provideService('agy-daddy.usage', 'usage', {
      estimateCallsCost(calls) {
        return { callsCount: calls.length, totalUsd: 0.1234 };
      }
    }, { realm: 'node' });

    const snapWithUsage = await ctxSvc.rescan({ cascadeId: '11111111-2222-3333-4444-555555555555' });
    assert.deepEqual(snapWithUsage.referenceCost, { callsCount: 2, totalUsd: 0.1234 });

    const mobileSnap = await ctxSvc.getMobileSnapshot({ cascadeId: '11111111-2222-3333-4444-555555555555' });
    assert.equal(mobileSnap.used, 20400);
    assert.equal(mobileSnap.budget, 1000000);
    assert.equal(mobileSnap.sessionUsage.totalTokens, 30600);
    assert.equal(mobileSnap.speed.tps, 200);
    assert.equal(mobileSnap.cacheCliffRisk, 'none');
    assert.ok(mobileSnap.groups && typeof mobileSnap.groups.user === 'number');
    assert.deepEqual(mobileSnap.referenceCost, { callsCount: 2, totalUsd: 0.1234 });

    // 卸载并严格断言零泄漏
    await harness.unloadPlugin('agy-daddy.context');
    assert.equal(harness.mockDoc.querySelector('[data-agy-context-capsule="1"]'), null);
    assert.equal(harness.mockDoc.querySelector('style[data-agy-style="agy-daddy.context"]'), null);
    assert.equal(shadowRoot.querySelector('style[data-agy-style="agy-daddy.context"]'), null);
    harness.assertCleanDispose('agy-daddy.context');
  } finally {
    await harness.cleanup();
  }
});

test('回归：Lexical beforeinput 返回 false 且同步触发 document input 事件时，autoCompact 仅发送一次 /compact 并安全恢复草稿', async () => {
  const harness = createMockHostHarness();
  class MockInputEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
      this.inputType = init.inputType || '';
      this.data = init.data ?? null;
      this.defaultPrevented = false;
    }
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
  }
  const prevInputEvent = globalThis.InputEvent;
  globalThis.InputEvent = MockInputEvent;
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    const doc = harness.mockDoc;
    const editorEl = doc.querySelector('[contenteditable="true"]');
    const sendBtnEl = doc.querySelector('[data-testid="input-send-button"]');
    const sentTexts = [];
    const insertedTexts = [];
    let beforeInputCount = 0;
    let listboxEl = null;

    function clearSlashMenu() {
      if (listboxEl) {
        listboxEl.remove();
        listboxEl = null;
      }
    }

    function showCompactOption() {
      clearSlashMenu();
      listboxEl = doc.createElement('div');
      listboxEl.setAttribute('role', 'listbox');
      const opt = doc.createElement('div');
      opt.setAttribute('role', 'option');
      const inner = doc.createElement('div');
      inner.className = 'cursor-pointer';
      const label = doc.createElement('span');
      label.textContent = 'compact 压缩上下文';
      inner.appendChild(label);
      opt.appendChild(inner);
      inner.addEventListener('click', () => {
        editorEl.textContent = '[pill:compact]';
        clearSlashMenu();
      });
      listboxEl.appendChild(opt);
      doc.body.appendChild(listboxEl);
    }

    editorEl.addEventListener('beforeinput', (ev) => {
      beforeInputCount += 1;
      if (ev.inputType === 'insertText' && typeof ev.data === 'string') {
        ev.preventDefault();
        insertedTexts.push(ev.data);
        editorEl.textContent = `${editorEl.textContent || ''}${ev.data}`;
        doc.dispatchEvent({ type: 'input', target: editorEl });
      }
    });

    sendBtnEl.addEventListener('click', () => {
      sentTexts.push(editorEl.textContent);
      editorEl.textContent = '';
    });

    doc.execCommand = (cmd, _ui, val) => {
      if (cmd === 'selectAll') return true;
      if (cmd === 'delete') {
        editorEl.textContent = '';
        clearSlashMenu();
        doc.dispatchEvent({ type: 'input', target: editorEl });
        return true;
      }
      if (cmd === 'insertText') {
        const ev = new MockInputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: String(val ?? '')
        });
        doc.dispatchEvent(ev);
        editorEl.dispatchEvent(ev);
        if (editorEl.textContent === '/compact') {
          showCompactOption();
        } else {
          clearSlashMenu();
        }
        return !ev.defaultPrevented;
      }
      return false;
    };

    const compactEvents = [];
    let contextUi = null;
    await harness.rendererHost.mountPlugin('test.lexical.compact', {
      mount(ctx) {
        contextUi = ctx.services.get('context-ui');
        ctx.events.on('context:auto-compact-triggered@1', (p) => compactEvents.push(p));
      }
    });

    await harness.updatePluginSettings('agy-daddy.context', {
      compactPolicy: 'cliff_auto',
      autoCompactOnCacheDrop: true
    });

    // 1. 无草稿丢缓存触发：只写入一次 '/compact' 并仅发送一次
    editorEl.textContent = '';
    const res1 = await contextUi.evaluateCompactState(
      { hasSession: true, used: 160000, budget: 1000000, cacheDropDetected: true },
      { bypassCooldown: true }
    );
    assert.equal(res1.triggered, true);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(beforeInputCount, 1);
    assert.deepEqual(insertedTexts, ['/compact']);
    assert.deepEqual(sentTexts, ['[pill:compact]']);
    assert.equal(compactEvents.length, 1);

    // 2. 有草稿断崖自动压缩：先发送 '[pill:compact]'，320ms 后安全恢复草稿且不重复触发
    sentTexts.length = 0;
    insertedTexts.length = 0;
    beforeInputCount = 0;
    editorEl.textContent = '保留这段草稿';
    const res2 = await contextUi.evaluateCompactState(
      { hasSession: true, used: 340000, budget: 1000000, cacheDropDetected: false },
      { bypassCooldown: true }
    );
    assert.equal(res2.triggered, true);
    assert.equal(res2.preservedDraft, true);
    await new Promise((r) => setTimeout(r, 380));
    assert.deepEqual(sentTexts, ['[pill:compact]']);
    assert.deepEqual(insertedTexts, ['/compact', '保留这段草稿']);
    assert.equal(beforeInputCount, 2);
    assert.equal(editorEl.textContent, '保留这段草稿');
    assert.equal(compactEvents.length, 2);

    await harness.rendererHost.disposePlugin('test.lexical.compact');
    await harness.unloadPlugin('agy-daddy.context');
    harness.assertCleanDispose('agy-daddy.context');
  } finally {
    if (prevInputEvent === undefined) delete globalThis.InputEvent;
    else globalThis.InputEvent = prevInputEvent;
    await harness.cleanup();
  }
});
