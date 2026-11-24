'use strict';

const os = require('os');
const path = require('path');
const { readFileSafe, writeFileSafe, writeBinaryFileSafe, expandHomePath } = require('./file-service');
const {
  normalizeExportFormat,
  normalizeExportFormats,
  getDefaultBrainDir,
  listBrainSessions,
  pickLatestCascadeId,
  buildExportFilename,
  normalizeDomMessagesToSteps,
  exportConversationMarkdown,
  exportConversationHtml,
  renderHtmlToPdfBuffer,
  openSaveFileDialog,
  openDirectoryDialog
} = require('./conversation-export');

const DEFAULT_SETTINGS = Object.freeze({
  showFloatDock: true,
  keepThinkingExpanded: false,
  enableInlineFileEditor: true,
  enableCmdClickLinks: true,
  searchRegexMode: false,
  searchCaseSensitive: false,
  exportSaveBehavior: 'dialog',
  exportSaveDir: '',
  exportFormats: ['md']
});

let disposers = [];

function matchMessages(messages = [], query = '', options = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, matches: [], total: 0 };
  let matcher = null;
  if (options.regexMode) {
    try {
      matcher = new RegExp(q, options.caseSensitive ? '' : 'i');
    } catch (err) {
      return { ok: false, error: `INVALID_REGEX: ${err.message}`, matches: [], total: 0 };
    }
  }
  const needle = options.caseSensitive ? q : q.toLowerCase();
  const matches = [];
  for (let i = 0; i < (Array.isArray(messages) ? messages.length : 0); i++) {
    const text = String(messages[i] ?? '');
    const hit = matcher ? matcher.test(text) : (options.caseSensitive ? text.includes(needle) : text.toLowerCase().includes(needle));
    if (hit) matches.push({ index: i, preview: text.slice(0, 120) });
  }
  return { ok: true, matches, total: matches.length };
}

async function activate(host) {
  function readSettings() {
    const merged = {
      ...DEFAULT_SETTINGS,
      ...(host.settings?.get?.() || {})
    };
    merged.exportSaveBehavior = merged.exportSaveBehavior === 'direct' ? 'direct' : 'dialog';
    merged.exportSaveDir = typeof merged.exportSaveDir === 'string' ? merged.exportSaveDir.trim() : '';
    merged.exportFormats = normalizeExportFormats(merged.exportFormats);
    return merged;
  }

  function resolveDefaultExportDir(overrideDir, currentSettings) {
    const raw = String(overrideDir || currentSettings?.exportSaveDir || process.env.AGY_DADDY_EXPORT_DIR || '').trim();
    const expanded = raw ? expandHomePath(raw) : '';
    return expanded ? path.resolve(expanded) : path.join(os.homedir(), 'Downloads');
  }

  let settings = readSettings();

  const stopSettings = host.settings?.onChange?.((nextValues) => {
    settings = {
      ...DEFAULT_SETTINGS,
      ...(nextValues || {}),
      exportSaveBehavior: nextValues?.exportSaveBehavior === 'direct' ? 'direct' : 'dialog',
      exportSaveDir: typeof nextValues?.exportSaveDir === 'string' ? nextValues.exportSaveDir.trim() : '',
      exportFormats: normalizeExportFormats(nextValues?.exportFormats)
    };
  });

  const stopReadRoute = await host.bridge.registerRoute('/file/read', async (body) => {
    return readFileSafe(body?.path || body?.uri);
  });
  const stopWriteRoute = await host.bridge.registerRoute('/file/write', async (body) => {
    return writeFileSafe(body?.path || body?.uri, body?.content);
  });

  async function resolveConversationData(opts = {}) {
    let cascadeId = typeof opts.cascadeId === 'string' ? opts.cascadeId.trim() : '';
    let steps = Array.isArray(opts.steps) ? opts.steps : null;
    if (!cascadeId && !steps) {
      const resolved = await serviceMethods.getActiveSessionId(opts);
      if (resolved?.ok && resolved.cascadeId) {
        cascadeId = resolved.cascadeId;
      }
    }
    if (!steps && cascadeId) {
      try {
        const resp = await host.rpc.call('GetCascadeTrajectory', { cascadeId });
        steps = resp?.steps || resp?.trajectory?.steps || [];
      } catch {
        steps = [];
      }
    }
    if ((!Array.isArray(steps) || steps.length === 0) && Array.isArray(opts.domMessages) && opts.domMessages.length > 0) {
      steps = normalizeDomMessagesToSteps(opts.domMessages);
    }
    return { cascadeId, steps: steps || [] };
  }

  function resolveSaveBehavior(opts = {}) {
    if (opts.saveBehavior === 'dialog' || opts.saveBehavior === 'direct' || opts.saveBehavior === 'none') {
      return opts.saveBehavior;
    }
    if (opts.saveToDisk === true || Boolean(opts.outputDir)) {
      return 'direct';
    }
    return 'none';
  }

  async function writeFormattedExport({ format, targetPath, markdown, html, meta, opts = {} }) {
    if (format === 'pdf') {
      const pdfBuf = await renderHtmlToPdfBuffer(html, {
        plainText: markdown,
        meta,
        pdfRenderer: opts.pdfRenderer,
        chromeBin: opts.chromeBin
      });
      return writeBinaryFileSafe(targetPath, pdfBuf, { maxBytes: 16 * 1024 * 1024 });
    }
    const payload = format === 'html' ? html : markdown;
    return writeFileSafe(targetPath, payload, { maxBytes: 16 * 1024 * 1024 });
  }

  const serviceMethods = {
    async getActiveSessionId(opts = {}) {
      const explicit = typeof opts.cascadeId === 'string' ? opts.cascadeId.trim() : '';
      if (explicit) {
        return { ok: true, cascadeId: explicit, source: 'explicit' };
      }
      let summary = null;
      try {
        const allResp = await host.rpc.call('GetAllCascadeTrajectories', {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
        });
        const summaries = allResp?.trajectorySummaries || {};
        const picked = pickLatestCascadeId(summaries);
        if (picked) {
          summary = summaries[picked] || null;
          return { ok: true, cascadeId: picked, source: 'rpc', summary };
        }
      } catch {}

      try {
        const sessions = listBrainSessions(opts);
        if (sessions.length > 0 && sessions[0].id) {
          return { ok: true, cascadeId: sessions[0].id, source: 'brain' };
        }
      } catch {}

      return { ok: false, cascadeId: null, error: 'NO_SESSION_ID' };
    },
    listBrainSessions(opts = {}) {
      return listBrainSessions(opts);
    },
    async exportConversation(opts = {}) {
      const current = readSettings();
      const format = normalizeExportFormat(opts.format || 'md');
      const { cascadeId, steps } = await resolveConversationData(opts);
      const saveBehavior = resolveSaveBehavior(opts);

      const defaultDir = resolveDefaultExportDir(opts.outputDir, current);
      const defaultName = buildExportFilename({ title: opts.title, cascadeId, format });
      let targetPath = '';

      if (saveBehavior === 'dialog') {
        const dlg = await openSaveFileDialog({
          defaultDir,
          defaultName,
          format,
          title: opts.dialogTitle,
          saveDialogFn: opts.saveDialogFn
        });
        if (dlg && dlg.ok === false) {
          return {
            ok: false,
            cancelled: false,
            format,
            saveBehavior,
            cascadeId: cascadeId || null,
            filePath: null,
            error: dlg.error || '无法打开保存对话框'
          };
        }
        if (!dlg || dlg.cancelled || !dlg.path) {
          return {
            ok: true,
            cancelled: true,
            format,
            saveBehavior,
            cascadeId: cascadeId || null,
            filePath: null
          };
        }
        targetPath = dlg.path;
      } else if (saveBehavior === 'direct') {
        targetPath = path.join(defaultDir, defaultName);
      }

      const meta = { ...opts, cascadeId };
      const markdown = exportConversationMarkdown(steps, meta);
      const result = {
        ok: true,
        cancelled: false,
        format,
        saveBehavior,
        cascadeId: cascadeId || null,
        markdown
      };

      if (format === 'html' || format === 'pdf') {
        result.html = exportConversationHtml(steps, format === 'pdf' ? { ...meta, expandThinking: true } : meta);
      }

      if (targetPath) {
        const writeRes = await writeFormattedExport({
          format,
          targetPath,
          markdown,
          html: result.html,
          meta,
          opts
        });
        result.filePath = writeRes.ok ? writeRes.path : null;
        result.bytesWritten = writeRes.ok ? writeRes.bytesWritten : 0;
        if (!writeRes.ok) {
          result.saveError = writeRes.error;
          if (format === 'pdf') {
            result.ok = false;
            result.error = writeRes.error;
          }
        }
      }

      return result;
    },
    async exportConversationBatch(opts = {}) {
      const current = readSettings();
      const formats = normalizeExportFormats(opts.formats || current.exportFormats);
      const { cascadeId, steps } = await resolveConversationData(opts);
      const saveBehavior = resolveSaveBehavior(opts);
      const defaultDir = resolveDefaultExportDir(opts.outputDir, current);
      const exportDate = opts.date instanceof Date ? opts.date : new Date();

      let targetDir = '';
      if (saveBehavior === 'dialog') {
        const dlg = await openDirectoryDialog({
          defaultDir,
          title: opts.dialogTitle || '选择全部导出的保存文件夹',
          dirPickerFn: opts.dirPickerFn
        });
        if (dlg && dlg.ok === false) {
          return {
            ok: false,
            cancelled: false,
            formats,
            saveBehavior,
            cascadeId: cascadeId || null,
            targetDir: null,
            results: [],
            succeeded: [],
            failed: [],
            error: dlg.error || '无法打开文件夹选择对话框'
          };
        }
        if (!dlg || dlg.cancelled || !dlg.path) {
          return {
            ok: true,
            cancelled: true,
            formats,
            saveBehavior,
            cascadeId: cascadeId || null,
            targetDir: null,
            results: [],
            succeeded: [],
            failed: []
          };
        }
        targetDir = dlg.path;
      } else if (saveBehavior === 'direct') {
        targetDir = defaultDir;
      }

      const meta = { ...opts, cascadeId, date: exportDate };
      const markdown = exportConversationMarkdown(steps, meta);
      const html = formats.includes('html') ? exportConversationHtml(steps, meta) : undefined;
      const pdfHtml = formats.includes('pdf') ? exportConversationHtml(steps, { ...meta, expandThinking: true }) : undefined;

      const results = [];
      const succeeded = [];
      const failed = [];

      if (targetDir) {
        for (const fmt of formats) {
          const fileName = buildExportFilename({ title: opts.title, cascadeId, format: fmt, date: exportDate });
          const targetPath = path.join(targetDir, fileName);
          try {
            const writeRes = await writeFormattedExport({
              format: fmt,
              targetPath,
              markdown,
              html: fmt === 'pdf' ? pdfHtml : html,
              meta,
              opts
            });
            if (writeRes.ok) {
              const item = { format: fmt, ok: true, filePath: writeRes.path, bytesWritten: writeRes.bytesWritten };
              results.push(item);
              succeeded.push(item);
            } else {
              const item = { format: fmt, ok: false, filePath: null, bytesWritten: 0, error: writeRes.error || '写入失败' };
              results.push(item);
              failed.push(item);
            }
          } catch (err) {
            const item = { format: fmt, ok: false, filePath: null, bytesWritten: 0, error: err?.message || '导出失败' };
            results.push(item);
            failed.push(item);
          }
        }
      }

      const partial = succeeded.length > 0 && failed.length > 0;
      const ok = saveBehavior === 'none' ? true : succeeded.length > 0;
      const error = failed.length > 0
        ? failed.map((f) => `${f.format.toUpperCase()}: ${f.error}`).join('；')
        : undefined;

      return {
        ok,
        partial,
        cancelled: false,
        formats,
        saveBehavior,
        cascadeId: cascadeId || null,
        targetDir: targetDir || null,
        results,
        succeeded,
        failed,
        markdown,
        ...(html !== undefined ? { html } : {}),
        ...(error ? { error } : {})
      };
    },
    async exportMarkdown(opts = {}) {
      return serviceMethods.exportConversation({ ...opts, format: opts.format || 'md' });
    },
    async browseExportDir(opts = {}) {
      const current = readSettings();
      const valDir = typeof opts?.values?.exportSaveDir === 'string' ? opts.values.exportSaveDir.trim() : '';
      const defaultDir = resolveDefaultExportDir(opts.defaultDir || valDir, current);
      return openDirectoryDialog({
        defaultDir,
        title: opts.title || '选择默认导出保存文件夹',
        dirPickerFn: opts.dirPickerFn
      });
    }
  };

  const stopSvc = await host.services.provide('chat-nav-node', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopSessionRoute = await host.bridge.registerRoute('/session-id', async (body) => serviceMethods.getActiveSessionId(body || {}));
  const stopBrainRoute = await host.bridge.registerRoute('/brain-sessions', async (body) => serviceMethods.listBrainSessions(body || {}));
  const stopExportMdRoute = await host.bridge.registerRoute('/export-md', async (body) => serviceMethods.exportConversation(body || {}), { timeoutMs: 120000 });
  const stopExportRoute = await host.bridge.registerRoute('/export', async (body) => serviceMethods.exportConversation(body || {}), { timeoutMs: 120000 });
  const stopExportAllRoute = await host.bridge.registerRoute('/export-all', async (body) => serviceMethods.exportConversationBatch(body || {}), { timeoutMs: 120000 });

  const stopCmdTop = await host.commands.register('chat-nav.scroll-top', () => {
    host.events.emit('chat-nav:command@1', { command: 'scroll-top' });
    return { ok: true, command: 'chat-nav.scroll-top', action: 'scrollTop', settings: { ...settings } };
  });
  const stopCmdBottom = await host.commands.register('chat-nav.scroll-bottom', () => {
    host.events.emit('chat-nav:command@1', { command: 'scroll-bottom' });
    return { ok: true, command: 'chat-nav.scroll-bottom', action: 'scrollBottom', settings: { ...settings } };
  });
  const stopCmdExpand = await host.commands.register('chat-nav.expand-thinking', () => {
    host.events.emit('chat-nav:command@1', { command: 'expand-thinking' });
    return { ok: true, command: 'chat-nav.expand-thinking', action: 'expandThinking', settings: { ...settings } };
  });
  const stopCmdSearch = await host.commands.register('chat-nav.search', (query = '', messages = [], opts = {}) => {
    const current = readSettings();
    const merged = {
      regexMode: current.searchRegexMode,
      caseSensitive: current.searchCaseSensitive,
      ...opts
    };
    const res = matchMessages(messages, query, merged);
    host.state?.set?.('state:chat-nav.search@1', {
      query: String(query || ''),
      total: res.total,
      regexMode: Boolean(merged.regexMode)
    });
    return res;
  });
  const stopCmdCopyId = await host.commands.register('chat-nav.copy-id', async (opts = {}) => {
    const res = await serviceMethods.getActiveSessionId(opts || {});
    const cascadeId = res?.cascadeId || null;
    host.events.emit('chat-nav:command@1', { command: 'copy-id', cascadeId });
    return { ok: Boolean(cascadeId), command: 'chat-nav.copy-id', cascadeId };
  });
  const stopCmdExportMd = await host.commands.register('chat-nav.export-md', async (opts = {}) => {
    return serviceMethods.exportMarkdown(opts || {});
  });
  const stopCmdExport = await host.commands.register('chat-nav.export', async (opts = {}) => {
    return serviceMethods.exportConversation(opts || {});
  });
  const stopCmdExportAll = await host.commands.register('chat-nav.export-all', async (opts = {}) => {
    return serviceMethods.exportConversationBatch(opts || {});
  });
  const stopCmdBrowseDir = await host.commands.register('chat-nav.browseExportDir', async (opts = {}) => {
    return serviceMethods.browseExportDir(opts || {});
  });

  disposers.push(
    stopSettings,
    stopReadRoute,
    stopWriteRoute,
    stopSvc,
    stopSessionRoute,
    stopBrainRoute,
    stopExportMdRoute,
    stopExportRoute,
    stopExportAllRoute,
    stopCmdTop,
    stopCmdBottom,
    stopCmdExpand,
    stopCmdSearch,
    stopCmdCopyId,
    stopCmdExportMd,
    stopCmdExport,
    stopCmdExportAll,
    stopCmdBrowseDir
  );
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  matchMessages,
  getDefaultBrainDir,
  listBrainSessions,
  exportConversationMarkdown,
  exportConversationHtml,
  activate,
  deactivate
};
