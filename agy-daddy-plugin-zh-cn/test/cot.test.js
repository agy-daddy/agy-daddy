'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness, createMockElement } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const { SUPPORTED_LANGUAGES, normalizeLang } = require('../src/dictionary');
const {
  THINKING_TRANSLATION_MODES,
  THINKING_DISPLAY_MODES,
  THINKING_TARGET_LANG_FOLLOW,
  COT_OVERLAY_I18N,
  getCotOverlayLabels,
  normalizeThinkingTranslationMode,
  normalizeThinkingDisplayMode,
  normalizeThinkingTargetLang,
  resolveEffectiveCotTargetLang,
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

test('CoT 纯工具：全 10 语言元数据、URL 规范化、file:// + #L 源码定位解析、占位符保护与段落切分', async () => {
  assert.equal(normalizeThinkingTranslationMode('off'), THINKING_TRANSLATION_MODES.OFF);
  assert.equal(normalizeThinkingTranslationMode('free'), THINKING_TRANSLATION_MODES.FREE);
  assert.equal(normalizeThinkingTranslationMode('antigravity'), THINKING_TRANSLATION_MODES.ANTIGRAVITY);
  assert.equal(normalizeThinkingTranslationMode('custom_api'), THINKING_TRANSLATION_MODES.CUSTOM_API);
  assert.equal(normalizeThinkingDisplayMode('bilingual'), THINKING_DISPLAY_MODES.BILINGUAL);
  assert.equal(normalizeThinkingDisplayMode('translated'), THINKING_DISPLAY_MODES.TRANSLATED);

  // 全部 10 种语言均具备完整的 CoT 面板文案与目标语言解析
  assert.equal(SUPPORTED_LANGUAGES.length, 10);
  for (const langInfo of SUPPORTED_LANGUAGES) {
    assert.ok(COT_OVERLAY_I18N[langInfo.code], `Missing CoT i18n bundle for ${langInfo.code}`);
    const labels = getCotOverlayLabels(langInfo.code);
    assert.ok(labels.modeAntigravity && labels.switchToTranslated && labels.jumpTitlePrefix);
    assert.equal(
      resolveEffectiveCotTargetLang({ lang: langInfo.code, thinkingTargetLang: THINKING_TARGET_LANG_FOLLOW }, normalizeLang),
      langInfo.code
    );
    assert.equal(
      resolveEffectiveCotTargetLang({ lang: 'zh', thinkingTargetLang: langInfo.code }, normalizeLang),
      langInfo.code
    );
  }
  assert.equal(normalizeThinkingTargetLang('follow', normalizeLang), 'follow');
  assert.equal(normalizeThinkingTargetLang('ja-JP', normalizeLang), 'ja');

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

test('CoT 多模转译（关闭 / 机翻 / Antigravity RPC / OpenAI 流式）、全 10 语言目标与源码跳转', async () => {
  const nativeFetch = globalThis.fetch;
  const apiRequests = [];
  const openFileResponses = [];
  const rpcCalls = [];

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
      const tlMatch = urlStr.match(/[?&]tl=([^&]+)/);
      const qMatch = urlStr.match(/[?&]q=([^&]+)/);
      const tl = tlMatch ? decodeURIComponent(tlMatch[1]) : 'zh-CN';
      const q = qMatch ? decodeURIComponent(qMatch[1]) : '';
      apiRequests.push({ kind: 'google', tl, q });
      return {
        ok: true,
        status: 200,
        json: async () => [[[`[机翻:${tl}] ${q}`, q]]]
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
    fetch: mockFetch,
    onRpc: async (method, body) => {
      rpcCalls.push({ method, body });
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { modelOrAlias: { model: 'gemini-4-hydrogen' }, label: 'Gemini 4 Hydrogen', quotaInfo: { remainingFraction: 0.9 } },
                { modelOrAlias: { model: 'gemini-3.5-flash-lite' }, label: 'Gemini 3.5 Flash Lite', quotaInfo: { remainingFraction: 0.95 } }
              ]
            }
          }
        };
      }
      if (method === 'GetModelResponse') {
        if (body.prompt === 'Reply with OK.') {
          return { response: 'OK' };
        }
        return {
          response: `[AGY:${body.model}] Check file:///workspace/src/auth.ts#L42 translated.`
        };
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port, hostToken: harness.bridge.hostToken });

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

    // 1. 默认 off：不附加 CoT 面板，不发外部或 RPC 请求
    const zhSvc = harness.bus.getServiceProxy('zh-cn');
    const initCfg = await zhSvc.getConfig();
    assert.equal(initCfg.thinkingTranslationMode, 'off');
    assert.equal(initCfg.thinkingTargetLang, 'follow');
    assert.equal(initCfg.thinkingDisplayMode, 'bilingual');
    assert.equal(harness.mockDoc.querySelector('[data-agy-cot-panel="1"]'), null);
    assert.equal(apiRequests.length, 0);
    assert.equal(rpcCalls.length, 0);

    // 2. 切换为 Antigravity 内置模型转译（antigravity）+ 动态模型列表 + 连通性测试
    const modelOptsRes = await harness.executeCommand('zh-cn.list-antigravity-models');
    assert.equal(modelOptsRes.ok, true);
    assert.ok(modelOptsRes.options.some((o) => o.value === ''));
    assert.ok(modelOptsRes.options.some((o) => o.value === 'gemini-3.5-flash-lite'));
    assert.ok(modelOptsRes.options.some((o) => o.value === 'gemini-4-hydrogen'));

    await harness.updatePluginSettings('agy-daddy.zh-cn', {
      thinkingTranslationMode: 'antigravity',
      thinkingAntigravityModel: ''
    });

    assert.ok(await waitUntil(() => {
      const p = harness.mockDoc.querySelector('[data-agy-cot-panel="1"]');
      return Boolean(p && p.textContent.includes('[AGY:gemini-3.5-flash-lite]') && p.textContent.includes('auth.ts#L42'));
    }));

    const agyPanel = harness.mockDoc.querySelector('[data-agy-cot-panel="1"]');
    assert.equal(agyPanel.getAttribute('data-cot-mode'), 'antigravity');

    const agyProbe = await harness.executeCommand('zh-cn.test-thinking-api');
    assert.equal(agyProbe.ok, true);
    assert.equal(agyProbe.mode, 'antigravity');
    assert.equal(agyProbe.model, 'gemini-3.5-flash-lite');

    // 指定使用 gemini-4-hydrogen 模型
    await harness.updatePluginSettings('agy-daddy.zh-cn', {
      thinkingAntigravityModel: 'gemini-4-hydrogen'
    });
    assert.ok(await waitUntil(() => {
      const p = harness.mockDoc.querySelector('[data-agy-cot-panel="1"]');
      return Boolean(p && p.textContent.includes('[AGY:gemini-4-hydrogen]'));
    }));

    // 3. 切换为免配置机翻 (free)，验证全 10 种目标语言（含 en / ja / zh-TW / ru 等）与 CoT 面板本地化
    await harness.updatePluginSettings('agy-daddy.zh-cn', {
      thinkingTranslationMode: 'free',
      thinkingDisplayMode: 'bilingual'
    });

    assert.ok(await waitUntil(() => {
      const p = harness.mockDoc.querySelector('[data-agy-cot-panel="1"]');
      return Boolean(p && p.textContent.includes('[机翻:zh-CN]') && p.textContent.includes('auth.ts#L42'));
    }));

    // 切换界面为 en + 思考目标为 ja，验证英文界面下思考转译仍正常工作且面板文案本地化为 English
    await harness.updatePluginSettings('agy-daddy.zh-cn', {
      lang: 'en',
      thinkingTargetLang: 'ja'
    });
    assert.ok(await waitUntil(() => {
      const p = harness.mockDoc.querySelector('[data-agy-cot-panel="1"]');
      return Boolean(p && p.textContent.includes('[机翻:ja]') && p.getAttribute('data-cot-target-lang') === 'ja');
    }));
    const enUiPanel = harness.mockDoc.querySelector('[data-agy-cot-panel="1"]');
    assert.match(enUiPanel.querySelector('[data-cot-badge="1"]').textContent, /Machine Translation · Bilingual/);

    // 遍历其余全部 10 种语言作为 thinkingTargetLang（包括 follow+en -> en）
    for (const langInfo of SUPPORTED_LANGUAGES) {
      await harness.updatePluginSettings('agy-daddy.zh-cn', {
        lang: langInfo.code,
        thinkingTargetLang: langInfo.code
      });
      assert.ok(await waitUntil(() => {
        const p = harness.mockDoc.querySelector('[data-agy-cot-panel="1"]');
        return Boolean(
          p &&
          p.getAttribute('data-cot-target-lang') === langInfo.code &&
          p.textContent.includes(`[机翻:${langInfo.googleTl}]`)
        );
      }), `Expected CoT translation for target language ${langInfo.code}`);
    }

    // 切回 zh 验证源码 file://#L 链接点击触发 /cot/open-file
    await harness.updatePluginSettings('agy-daddy.zh-cn', {
      lang: 'zh',
      thinkingTargetLang: 'follow'
    });
    assert.ok(await waitUntil(() => {
      const p = harness.mockDoc.querySelector('[data-agy-cot-panel="1"]');
      return Boolean(p && p.textContent.includes('[机翻:zh-CN]'));
    }));

    const panelFree = harness.mockDoc.querySelector('[data-agy-cot-panel="1"]');
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

    // 4. 双语对照 <-> 沉浸式纯译文切换
    const toggleRes = await harness.executeCommand('zh-cn.toggle-thinking-display');
    assert.equal(toggleRes.ok, true);
    assert.equal(toggleRes.thinkingDisplayMode, 'translated');
    assert.ok(await waitUntil(() => body.style.getPropertyValue('display') === 'none'));
    assert.equal(panelFree.getAttribute('data-cot-display'), 'translated');

    const inlineToggleBtn = panelFree.querySelector('[data-cot-display-toggle="1"]');
    assert.ok(inlineToggleBtn);
    inlineToggleBtn.click();
    assert.ok(await waitUntil(() => body.style.getPropertyValue('display') === ''));
    assert.equal(panelFree.getAttribute('data-cot-display'), 'bilingual');

    // 5. 自定义 OpenAI 兼容流式模式（本地免密 Ollama + writeOnly API Key）
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

    assert.ok(await waitUntil(() => apiRequests.some((r) => r.kind === 'custom_api' && r.stream === true && r.model === 'gpt-4o-mini')));

    // 6. 增量段落流式：追加第二段思考时仅转译新段落
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

    // 7. 切回 off 与卸载零残留
    await harness.updatePluginSettings('agy-daddy.zh-cn', { thinkingTranslationMode: 'off' });
    assert.ok(await waitUntil(() => harness.mockDoc.querySelector('[data-agy-cot-panel="1"]') === null));
    assert.equal(body.style.getPropertyValue('display'), '');

    await harness.unloadPlugin('agy-daddy.zh-cn');
    harness.assertCleanDispose('agy-daddy.zh-cn');
  } finally {
    await harness.cleanup();
  }
});
