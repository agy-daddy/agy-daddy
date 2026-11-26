'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness, createMockElement } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const {
  THINKING_TRANSLATION_MODES,
  THINKING_DISPLAY_MODES,
  normalizeThinkingTranslationMode,
  normalizeThinkingDisplayMode,
  normalizeApiBaseUrl,
  parseFileUriTarget,
  protectFileUrisForTranslation,
  restoreProtectedFileUris,
  tokenizeTextWithFileLinks,
  parseThinkingSegments
} = require('../src/cot-utils');
const { openFileInHost } = require('../src/cot-service');

async function waitUntil(pred, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

function makeSseStream(chunks, delayMs = 8) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const ch of chunks) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(encoder.encode(ch));
      }
      controller.close();
    }
  });
}

test('CoT 纯工具：URL 规范化、file:// + #L 源码定位解析、占位符保护与段落切分', async () => {
  assert.equal(normalizeThinkingTranslationMode('off'), THINKING_TRANSLATION_MODES.OFF);
  assert.equal(normalizeThinkingTranslationMode('free'), THINKING_TRANSLATION_MODES.FREE);
  assert.equal(normalizeThinkingTranslationMode('custom_api'), THINKING_TRANSLATION_MODES.CUSTOM_API);
  assert.equal(normalizeThinkingDisplayMode('bilingual'), THINKING_DISPLAY_MODES.BILINGUAL);
  assert.equal(normalizeThinkingDisplayMode('translated'), THINKING_DISPLAY_MODES.TRANSLATED);

  const ollama = normalizeApiBaseUrl('http://127.0.0.1:11434/v1/');
  assert.equal(ollama.ok, true);
  assert.equal(ollama.chatCompletionsUrl, 'http://127.0.0.1:11434/v1/chat/completions');

  const rootUrl = normalizeApiBaseUrl('http://localhost:1234');
  assert.equal(rootUrl.ok, true);
  assert.equal(rootUrl.chatCompletionsUrl, 'http://localhost:1234/v1/chat/completions');

  const fullUrl = normalizeApiBaseUrl('https://api.openai.com/v1/chat/completions');
  assert.equal(fullUrl.ok, true);
  assert.equal(fullUrl.chatCompletionsUrl, 'https://api.openai.com/v1/chat/completions');

  assert.equal(normalizeApiBaseUrl('file:///etc/passwd').ok, false);
  assert.equal(normalizeApiBaseUrl('not-a-url').ok, false);

  const posixTarget = parseFileUriTarget('file:///workspace/src/auth.ts#L42-L58');
  assert.equal(posixTarget.ok, true);
  assert.equal(posixTarget.path, '/workspace/src/auth.ts');
  assert.equal(posixTarget.line, 42);
  assert.equal(posixTarget.endLine, 58);
  assert.equal(posixTarget.displayLabel, 'auth.ts#L42-L58');
  assert.equal(posixTarget.editorUri, 'antigravity://file/workspace/src/auth.ts:42');

  const winTarget = parseFileUriTarget('file:///C:/Users/dev/app.ts#L19');
  assert.equal(winTarget.ok, true);
  assert.equal(winTarget.path, 'C:\\Users\\dev\\app.ts');
  assert.equal(winTarget.line, 19);

  assert.equal(parseFileUriTarget('file:///workspace/../etc/passwd').ok, false);
  assert.equal(parseFileUriTarget('https://example.com/a.ts#L10').ok, false);

  const raw = 'Inspect [auth.ts](file:///workspace/src/auth.ts#L42) and file:///workspace/src/router.ts#L10.';
  const { maskedText, tokens } = protectFileUrisForTranslation(raw);
  assert.equal(tokens.length, 2);
  assert.equal(maskedText.includes('file://'), false);
  // 模拟机翻在占位符中插入多余空格的场景
  const mtGarbled = maskedText.replace('[[AGY_FILE_REF_0]]', '[ [ AGY_FILE_REF_0 ] ]');
  const restored = restoreProtectedFileUris(mtGarbled, tokens);
  assert.equal(restored, raw);

  const toks = tokenizeTextWithFileLinks('查看 file:///workspace/src/auth.ts#L42 修复逻辑。');
  assert.equal(toks.length, 3);
  assert.equal(toks[1].type, 'file-link');
  assert.equal(toks[1].path, '/workspace/src/auth.ts');
  assert.equal(toks[1].line, 42);

  const segs = parseThinkingSegments('First paragraph.\n\nSecond paragraph.');
  assert.deepEqual(segs, ['First paragraph.', 'Second paragraph.']);

  let jumped = null;
  const openRes = await openFileInHost(
    { uri: 'file:///workspace/src/auth.ts#L42' },
    { openFileImpl: async (info) => { jumped = info; return { ok: true, method: 'mock-host' }; } }
  );
  assert.equal(openRes.ok, true);
  assert.equal(openRes.method, 'mock-host');
  assert.equal(jumped.path, '/workspace/src/auth.ts');
  assert.equal(jumped.line, 42);
});

test('CoT 双模转译（关闭 / 免配置机翻 / 自定义 OpenAI 流式）、双语切换与源码定位跳转', async () => {
  const nativeFetch = globalThis.fetch;
  const apiRequests = [];
  const openFileResponses = [];

  const mockFetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (urlStr.startsWith('http://127.0.0.1:') && urlStr.includes('/plugins/')) {
      const resp = await nativeFetch(url, init);
      if (urlStr.endsWith('/cot/open-file')) {
        try {
          const cloned = resp.clone();
          openFileResponses.push(await cloned.json());
        } catch {}
      }
      return resp;
    }

    if (urlStr.startsWith('https://translate.googleapis.com/')) {
      const qMatch = urlStr.match(/[?&]q=([^&]+)/);
      const q = qMatch ? decodeURIComponent(qMatch[1]) : '';
      apiRequests.push({ kind: 'google', q });
      return {
        ok: true,
        status: 200,
        json: async () => [[[`[机翻] ${q}`, q]]]
      };
    }

    if (urlStr.endsWith('/v1/chat/completions')) {
      const body = init.body ? JSON.parse(init.body) : {};
      const userText = body?.messages?.[1]?.content || '';
      apiRequests.push({
        kind: 'custom_api',
        url: urlStr,
        model: body.model,
        stream: body.stream,
        auth: init.headers?.Authorization || null,
        userText
      });

      if (body.stream === false) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ choices: [{ message: { content: 'OK' } }] })
        };
      }

      const chunks = [
        'data: {"choices":[{"delta":{"content":"[AI流式] "}}]}\n\n',
        `data: {"choices":[{"delta":{"content":"检查 ${userText.includes('file:///workspace/src/auth.ts#L42') ? 'file:///workspace/src/auth.ts#L42' : '段落'}"}}]}\n\n`,
        'data: [DONE]\n\n'
      ];
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: makeSseStream(chunks, 10)
      };
    }

    throw new Error(`Unexpected fetch URL in CoT test: ${urlStr}`);
  };

  const harness = createMockHostHarness({
    seedAnchors: [{ tag: 'div', attr: 'data-testid', val: 'conversation-row-sidebar' }],
    fetch: mockFetch
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port, hostToken: harness.bridge.hostToken });

    // 构建原生思维链 DOM（trigger + body）
    const thinkingWrap = createMockElement('div', harness.mockDoc);
    const trigger = createMockElement('button', harness.mockDoc);
    trigger.setAttribute('data-testid', 'thinking-collapsible-trigger');
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'cot-body-1');
    trigger.textContent = 'Thought for 4s';

    const body = createMockElement('div', harness.mockDoc);
    body.setAttribute('id', 'cot-body-1');
    body.setAttribute('data-testid', 'thinking-content');
    body.textContent = 'Check auth middleware in file:///workspace/src/auth.ts#L42 before editing.';

    thinkingWrap.appendChild(trigger);
    thinkingWrap.appendChild(body);
    harness.mockDoc.body.appendChild(thinkingWrap);

    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    // 1. 默认 off：不附加 CoT 面板，不发外部请求，不干扰原生思维链
    const zhSvc = harness.bus.getServiceProxy('zh-cn');
    const initCfg = await zhSvc.getConfig();
    assert.equal(initCfg.thinkingTranslationMode, 'off');
    assert.equal(initCfg.thinkingDisplayMode, 'bilingual');
    assert.equal(harness.mockDoc.querySelector('[data-agy-cot-panel="1"]'), null);
    assert.equal(apiRequests.length, 0);

    // 2. 切换为免配置机翻 (free) + 默认双语对照 (bilingual)
    await harness.updatePluginSettings('agy-daddy.zh-cn', {
      thinkingTranslationMode: 'free',
      thinkingDisplayMode: 'bilingual'
    });

    assert.ok(await waitUntil(() => {
      const p = harness.mockDoc.querySelector('[data-agy-cot-panel="1"]');
      return Boolean(p && p.textContent.includes('[机翻]') && p.textContent.includes('auth.ts#L42'));
    }));

    const panelFree = harness.mockDoc.querySelector('[data-agy-cot-panel="1"]');
    assert.equal(panelFree.getAttribute('data-cot-mode'), 'free');
    assert.equal(panelFree.getAttribute('data-cot-display'), 'bilingual');
    assert.equal(body.style.getPropertyValue('display'), '');
    assert.ok(apiRequests.some((r) => r.kind === 'google' && !r.q.includes('file://')));

    // 验证源码 file://#L 链接渲染与点击触发 /cot/open-file
    const fileLink = panelFree.querySelector('.agy-cot-file-link');
    assert.ok(fileLink, 'Expected clickable .agy-cot-file-link inside CoT panel');
    assert.equal(fileLink.getAttribute('data-file-path'), '/workspace/src/auth.ts');
    assert.equal(fileLink.getAttribute('data-file-line'), '42');
    fileLink.click();
    assert.equal(fileLink.getAttribute('data-jumped'), 'true');
    assert.ok(await waitUntil(() => openFileResponses.length >= 1));
    assert.equal(openFileResponses[0].ok, true);
    assert.equal(openFileResponses[0].path, '/workspace/src/auth.ts');
    assert.equal(openFileResponses[0].line, 42);
    assert.equal(openFileResponses[0].editorUri, 'antigravity://file/workspace/src/auth.ts:42');

    // 3. 切换为沉浸式纯译文 (translated)：原生思考块被干净隐藏；切回双语对照则恢复
    const toggleRes = await harness.executeCommand('zh-cn.toggle-thinking-display');
    assert.equal(toggleRes.ok, true);
    assert.equal(toggleRes.thinkingDisplayMode, 'translated');
    assert.ok(await waitUntil(() => body.style.getPropertyValue('display') === 'none'));
    assert.equal(panelFree.getAttribute('data-cot-display'), 'translated');

    // 点击面板内置切换按钮切回双语对照
    const inlineToggleBtn = panelFree.querySelector('[data-cot-display-toggle="1"]');
    assert.ok(inlineToggleBtn);
    inlineToggleBtn.click();
    assert.ok(await waitUntil(() => body.style.getPropertyValue('display') === ''));
    assert.equal(panelFree.getAttribute('data-cot-display'), 'bilingual');

    // 4. 切换为自定义 OpenAI 兼容流式模式（先测试本地免密 Ollama，不带 Authorization）
    await harness.updatePluginSettings('agy-daddy.zh-cn', {
      thinkingTranslationMode: 'custom_api',
      thinkingApiBaseUrl: 'http://127.0.0.1:11434/v1',
      thinkingApiModel: 'qwen2.5:7b',
      thinkingApiKey: ''
    });

    assert.ok(await waitUntil(() => {
      const p = harness.mockDoc.querySelector('[data-agy-cot-panel="1"]');
      return Boolean(p && p.textContent.includes('[AI流式]') && p.textContent.includes('auth.ts#L42'));
    }));

    const localReq = apiRequests.find((r) => r.kind === 'custom_api' && r.stream === true);
    assert.ok(localReq);
    assert.equal(localReq.url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(localReq.model, 'qwen2.5:7b');
    assert.equal(localReq.auth, null, 'Local passwordless Ollama must not send Authorization header');

    // 5. 测试 writeOnly thinkingApiKey 保密与 Bearer 鉴权 + 连通性测试命令
    await harness.updatePluginSettings('agy-daddy.zh-cn', {
      thinkingApiKey: 'sk-secret-do-not-leak',
      thinkingApiModel: 'gpt-4o-mini'
    });
    const safeCfg = await zhSvc.getConfig();
    assert.equal(safeCfg.hasThinkingApiKey, true);
    assert.equal('thinkingApiKey' in safeCfg, false, 'getConfig() must never leak writeOnly thinkingApiKey');

    const probeCmd = await harness.executeCommand('zh-cn.test-thinking-api');
    assert.equal(probeCmd.ok, true);
    assert.equal(probeCmd.model, 'gpt-4o-mini');
    const authProbeReq = apiRequests.find((r) => r.kind === 'custom_api' && r.stream === false);
    assert.equal(authProbeReq.auth, 'Bearer sk-secret-do-not-leak');

    // 等待模型切换触发的首段重译完成
    assert.ok(await waitUntil(() => apiRequests.some((r) => r.kind === 'custom_api' && r.stream === true && r.model === 'gpt-4o-mini')));

    // 6. 增量段落流式：追加第二段思考时，第一段命中状态不重复请求，仅转译新段落
    const apiCountBeforeAppend = apiRequests.filter((r) => r.kind === 'custom_api' && r.stream === true).length;
    body.textContent = 'Check auth middleware in file:///workspace/src/auth.ts#L42 before editing.\n\nSecond reasoning paragraph for unit verification.';
    await harness.updatePluginSettings('agy-daddy.zh-cn', { thinkingDisplayMode: 'translated' });
    assert.ok(await waitUntil(() => {
      const segs = harness.mockDoc.querySelectorAll('[data-agy-cot-panel="1"] .agy-cot-segment');
      return segs.length === 2 && segs[1].textContent.includes('[AI流式]');
    }));
    const apiCallsAfterAppend = apiRequests.filter((r) => r.kind === 'custom_api' && r.stream === true).slice(apiCountBeforeAppend);
    assert.equal(apiCallsAfterAppend.length, 1);
    assert.match(apiCallsAfterAppend[0].userText, /Second reasoning paragraph/);

    // 7. 切回 off 或卸载时：原生思考体恢复可见，CoT 面板彻底移除，零残留
    await harness.updatePluginSettings('agy-daddy.zh-cn', { thinkingTranslationMode: 'off' });
    assert.ok(await waitUntil(() => harness.mockDoc.querySelector('[data-agy-cot-panel="1"]') === null));
    assert.equal(body.style.getPropertyValue('display'), '');

    await harness.unloadPlugin('agy-daddy.zh-cn');
    harness.assertCleanDispose('agy-daddy.zh-cn');
  } finally {
    await harness.cleanup();
  }
});
