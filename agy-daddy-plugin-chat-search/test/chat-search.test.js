'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness, createMockElement } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const { matchMessages } = require('../src/node');

test('matchMessages 关键字与正则全文检索逻辑及非法正则兜底', () => {
  const msgs = ['Check auth middleware', 'Fix database pool leak', 'AUTH retry token'];
  const plain = matchMessages(msgs, 'auth');
  assert.equal(plain.ok, true);
  assert.equal(plain.total, 2);

  const rx = matchMessages(msgs, 'auth.*(middleware|retry)', { regexMode: true });
  assert.equal(rx.ok, true);
  assert.equal(rx.total, 2);

  const badRx = matchMessages(msgs, '[unclosed', { regexMode: true });
  assert.equal(badRx.ok, false);
});

test('插件契约：社区插件 T2 隔离世界检索、上/下跳转、紫色门禁与零残留 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i, /#fb923c/i, /#c2410c/i];
  for (const f of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', f), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${f} violated theme gate: ${re}`);
  }

  const harness = createMockHostHarness({
    seedAnchors: [
      { tag: 'div', attr: 'data-testid', val: 'autoscroll-viewport' },
      { tag: 'div', attr: 'data-testid', val: 'turn-cards-container' }
    ]
  });

  const msgList = harness.mockDoc.querySelector('[data-testid="turn-cards-container"]');
  for (const text of ['First turn: setup database', 'Second turn: verify proxy gateway', 'Third turn: finalize database index']) {
    const card = createMockElement('div', harness.mockDoc);
    card.textContent = text;
    msgList.appendChild(card);
  }

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T2' });
    assert.equal(loaded.trust.world, 'isolated');
    assert.ok(harness.isolatedWorlds.has('community.chat-search'));

    // 验证 Node 侧 chat-search 服务
    const svc = harness.bus.getServiceProxy('chat-search');
    const nodeRes = await svc.search('proxy', ['alpha', 'proxy gateway']);
    assert.equal(nodeRes.total, 1);

    // 验证隔离世界检索框、匹配计数 1/2 -> 下一个 2/2 -> 清空
    const input = harness.mockDoc.getElementById('agy-community-search-input');
    const count = harness.mockDoc.getElementById('agy-community-search-count');
    assert.ok(input);
    input.value = 'database';
    input.dispatchEvent({ type: 'change', target: input });
    assert.equal(count.textContent, '1/2');
    assert.equal(msgList.children[0].getAttribute('data-agy-search-hit'), 'active');

    harness.mockDoc.getElementById('agy-community-search-next').click();
    assert.equal(count.textContent, '2/2');
    assert.equal(msgList.children[2].getAttribute('data-agy-search-hit'), 'active');

    harness.mockDoc.getElementById('agy-community-search-clear').click();
    assert.equal(count.textContent, '0/0');
    assert.equal(msgList.children[0].getAttribute('data-agy-search-hit'), null);

    await harness.unloadPlugin('community.chat-search');
    assert.equal(harness.mockDoc.getElementById('agy-community-chat-search'), null);
    harness.assertCleanDispose('community.chat-search');
  } finally {
    await harness.cleanup();
  }
});
