(function (root) {
  'use strict';

  const HOST_VERSION = typeof __AGY_HOST_VERSION__ === 'string' && __AGY_HOST_VERSION__
    ? __AGY_HOST_VERSION__
    : '1.0.0';
  const HOST_ELEMENT_ID = 'agy-daddy-host';
  const SAFE_MODE_PILL_HOST_ID = 'agy-safe-mode-pill-host';
  const NATIVE_SETTINGS_MOUNT_ID = 'agy-native-settings-mount';
  const DEFAULT_ACCENT = '#18181b';
  const DEFAULT_RUNTIME_HEALTH_REPORT_INTERVAL_MS = 8000;

  const DEFAULT_HOST_SETTINGS = {
    themeMode: 'auto',
    heatPreset: 'system',
    customColors: {},
    topbarPins: {},
    topbarOrder: [],
    maxVisibleUnits: 6,
    showTopbarEntry: true,
    injectNativeSettings: true,
    autoSyncNativeOnInstall: true,
    hideTrayIcon: false
  };

  const SETTINGS_SEGMENTS = [
    { id: 'plugins', label: '通用' },
    { id: 'appearance', label: '外观' }
  ];

  const SETTINGS_TAB_META = {
    plugins: {
      subtitle: '安装与发现插件、管理已安装扩展及查看运行诊断。',
      searchPlaceholder: '搜索插件或配置项...'
    },
    appearance: {
      subtitle: '配置入口显示、原生设置集成、顶栏胶囊上限与排列顺序。',
      searchPlaceholder: '筛选顶栏胶囊...'
    }
  };

  const UI_SVG_ICONS = {
    search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    refresh: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
    chevronRight: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    chevronLeft: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    pin: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
    pinFilled: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5" fill="none"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
    arrowUp: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
    arrowDown: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    grip: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    folder: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>',
    pencil: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    plus: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    star: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    download: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    alertTriangle: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    play: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
    menu: '<svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    settings: '<svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>'
  };

  function getThemeEngine() {
    if (root && root.__AGYThemeEngine) return root.__AGYThemeEngine;
    if (typeof require === 'function') {
      try { return require('./theme'); } catch {}
    }
    return null;
  }

  function isPlainObject(val) {
    return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
  }

  function sanitizeSvgMarkup(raw) {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!/^<svg\b[\s\S]*<\/svg>$/i.test(trimmed)) return '';
    if (/<(?:script|iframe|object|embed|foreignObject|link|style)\b/i.test(trimmed)) return '';
    if (/\bon[a-z]+\s*=/i.test(trimmed)) return '';
    if (/javascript\s*:/i.test(trimmed)) return '';
    return trimmed;
  }

  function normalizeHexColor(raw) {
    if (typeof raw !== 'string') return '';
    const s = raw.trim().toLowerCase();
    const m3 = s.match(/^#([0-9a-f]{3})$/);
    if (m3) {
      const c = m3[1];
      return `#${c[0]}${c[0]}${c[1]}${c[1]}${c[2]}${c[2]}`;
    }
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    return '';
  }

  function hexToRgbaSafe(hex, alpha) {
    const te = getThemeEngine();
    if (te && typeof te.hexToRgba === 'function') {
      return te.hexToRgba(hex, alpha);
    }
    const clean = normalizeHexColor(hex).slice(1);
    if (clean.length === 6) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return `rgba(113, 113, 122, ${alpha})`;
  }

  function setHidden(el, isHidden) {
    if (!el) return;
    el.hidden = Boolean(isHidden);
    if (el.hidden) {
      el.setAttribute?.('hidden', '');
    } else {
      el.removeAttribute?.('hidden');
    }
  }

  function getInlineDisplay(el) {
    if (!el?.style) return '';
    if (typeof el.style.getPropertyValue === 'function') {
      const pv = el.style.getPropertyValue('display');
      if (pv) return pv;
    }
    return typeof el.style.display === 'string' ? el.style.display : '';
  }

  function setInlineDisplay(el, val) {
    if (!el?.style) return;
    if (val) {
      if (typeof el.style.setProperty === 'function') el.style.setProperty('display', val);
      try { el.style.display = val; } catch {}
    } else {
      if (typeof el.style.removeProperty === 'function') el.style.removeProperty('display');
      try { el.style.display = ''; } catch {}
    }
  }

  function insertAfter(parent, node, refEl) {
    if (!parent || !node) return;
    if (refEl && refEl.parentElement === parent && typeof parent.insertBefore === 'function') {
      if (refEl.nextSibling) {
        parent.insertBefore(node, refEl.nextSibling);
        return;
      }
      if (Array.isArray(parent.children)) {
        const idx = parent.children.indexOf(refEl);
        if (idx >= 0 && idx + 1 < parent.children.length) {
          parent.insertBefore(node, parent.children[idx + 1]);
          return;
        }
      }
    }
    parent.appendChild?.(node);
  }

  function clearElement(el) {
    if (!el) return;
    el.innerHTML = '';
    if (Array.isArray(el.children)) el.children.length = 0;
  }

  function normalizeTabId(tab) {
    if (!tab) return 'plugins';
    const raw = String(tab).toLowerCase();
    if (raw === 'plugins' || raw === 'manage' || raw === 'general' || raw === 'diagnostics' || raw === 'health' || raw === 'marketplace') return 'plugins';
    if (raw === 'appearance' || raw === 'theme') return 'appearance';
    return 'plugins';
  }

  function escapeHtmlText(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMarkdownInline(rawLine) {
    const src = String(rawLine ?? '');
    const parts = [];
    let lastIdx = 0;
    const codeRe = /`([^`]+)`/g;
    let m;
    while ((m = codeRe.exec(src)) !== null) {
      if (m.index > lastIdx) {
        parts.push({ type: 'text', value: src.slice(lastIdx, m.index) });
      }
      parts.push({ type: 'code', value: m[1] });
      lastIdx = codeRe.lastIndex;
    }
    if (lastIdx < src.length) {
      parts.push({ type: 'text', value: src.slice(lastIdx) });
    }
    return parts.map((seg) => {
      if (seg.type === 'code') {
        return `<code class="ag-md-code">${escapeHtmlText(seg.value)}</code>`;
      }
      let out = escapeHtmlText(seg.value);
      out = out.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, '<span class="ag-md-var">{{$1}}</span>');
      out = out.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a class="ag-md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
      );
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      return out;
    }).join('');
  }

  function isSafeExternalUrl(rawUrl) {
    return /^https?:\/\//i.test(String(rawUrl || '').trim());
  }

  function renderSimpleMarkdownToHtml(rawText) {
    const normalized = String(rawText ?? '').replace(/\r\n?/g, '\n');
    if (!normalized.trim()) return '';
    const lines = normalized.split('\n');
    const html = [];
    let inFence = false;
    let fenceLang = '';
    let fenceLines = [];
    let listType = null; // 'ul' | 'ol'
    let nestedUlOpen = false;
    let openLi = false;
    let inQuote = false;
    let quoteLines = [];
    let paraLines = [];

    const flushPara = () => {
      if (!paraLines.length) return;
      html.push(`<p class="ag-md-p">${paraLines.map((l) => formatMarkdownInline(l)).join('<br />')}</p>`);
      paraLines = [];
    };

    const closeList = () => {
      if (nestedUlOpen) {
        html.push('</ul>');
        nestedUlOpen = false;
      }
      if (openLi) {
        html.push('</li>');
        openLi = false;
      }
      if (listType) {
        html.push(`</${listType}>`);
        listType = null;
      }
    };

    const flushQuote = () => {
      if (!inQuote) return;
      const inner = quoteLines.map((l) => formatMarkdownInline(l)).join('<br />');
      html.push(`<blockquote class="ag-md-quote">${inner}</blockquote>`);
      inQuote = false;
      quoteLines = [];
    };

    for (const line of lines) {
      if (inFence) {
        if (/^```\s*$/.test(line.trim())) {
          const langAttr = fenceLang ? ` data-lang="${escapeHtmlText(fenceLang)}"` : '';
          html.push(`<pre class="ag-md-pre"><code${langAttr}>${escapeHtmlText(fenceLines.join('\n'))}</code></pre>`);
          inFence = false;
          fenceLang = '';
          fenceLines = [];
        } else {
          fenceLines.push(line);
        }
        continue;
      }

      const fenceMatch = line.match(/^```([a-zA-Z0-9_-]*)\s*$/);
      if (fenceMatch) {
        flushPara();
        closeList();
        flushQuote();
        inFence = true;
        fenceLang = fenceMatch[1] || '';
        fenceLines = [];
        continue;
      }

      const trimmed = line.trim();
      if (!trimmed) {
        flushPara();
        closeList();
        flushQuote();
        continue;
      }

      if (/^([-*_])\1{2,}\s*$/.test(trimmed)) {
        flushPara();
        closeList();
        flushQuote();
        html.push('<hr class="ag-md-hr" />');
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushPara();
        closeList();
        flushQuote();
        const level = headingMatch[1].length;
        html.push(`<h${level} class="ag-md-h${level}">${formatMarkdownInline(headingMatch[2])}</h${level}>`);
        continue;
      }

      const quoteMatch = line.match(/^>\s?(.*)$/);
      if (quoteMatch) {
        flushPara();
        closeList();
        inQuote = true;
        quoteLines.push(quoteMatch[1]);
        continue;
      }
      flushQuote();

      const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
      if (olMatch) {
        flushPara();
        if (listType !== 'ol') {
          closeList();
          html.push('<ol class="ag-md-ol">');
          listType = 'ol';
        } else {
          if (nestedUlOpen) {
            html.push('</ul>');
            nestedUlOpen = false;
          }
          if (openLi) {
            html.push('</li>');
            openLi = false;
          }
        }
        html.push(`<li>${formatMarkdownInline(olMatch[1])}`);
        openLi = true;
        continue;
      }

      const nestedUlMatch = listType === 'ol' && openLi ? line.match(/^\s{2,}[-*+]\s+(.+)$/) : null;
      if (nestedUlMatch) {
        if (!nestedUlOpen) {
          html.push('<ul class="ag-md-ul ag-md-ul-nested">');
          nestedUlOpen = true;
        }
        html.push(`<li>${formatMarkdownInline(nestedUlMatch[1])}</li>`);
        continue;
      }

      const ulMatch = line.match(/^\s*[-*+]\s+(.+)$/);
      if (ulMatch) {
        flushPara();
        if (listType !== 'ul') {
          closeList();
          html.push('<ul class="ag-md-ul">');
          listType = 'ul';
        } else if (openLi) {
          html.push('</li>');
          openLi = false;
        }
        html.push(`<li>${formatMarkdownInline(ulMatch[1])}`);
        openLi = true;
        continue;
      }

      closeList();
      paraLines.push(line);
    }

    if (inFence) {
      const langAttr = fenceLang ? ` data-lang="${escapeHtmlText(fenceLang)}"` : '';
      html.push(`<pre class="ag-md-pre"><code${langAttr}>${escapeHtmlText(fenceLines.join('\n'))}</code></pre>`);
    }
    flushPara();
    closeList();
    flushQuote();
    return html.join('');
  }

  const SHORTCUT_CODE_MAP = Object.freeze({
    Space: 'Space',
    Enter: 'Enter',
    NumpadEnter: 'Enter',
    Tab: 'Tab',
    Slash: '/',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight'
  });

  function extractShortcutBaseKey(e) {
    const rawKey = String(e?.key || '');
    if (
      rawKey === 'Meta'
      || rawKey === 'Control'
      || rawKey === 'Alt'
      || rawKey === 'Shift'
      || rawKey === 'Dead'
      || rawKey === 'Process'
      || rawKey === 'AltGraph'
      || rawKey === 'CapsLock'
    ) {
      return { modifierOnly: true, key: '' };
    }
    const code = String(e?.code || '');
    if (/^Key([A-Z])$/.test(code)) return { modifierOnly: false, key: code.slice(3) };
    if (/^Digit([0-9])$/.test(code)) return { modifierOnly: false, key: code.slice(5) };
    if (/^F([1-9]|1[0-2])$/.test(code)) return { modifierOnly: false, key: code };
    if (Object.prototype.hasOwnProperty.call(SHORTCUT_CODE_MAP, code)) {
      return { modifierOnly: false, key: SHORTCUT_CODE_MAP[code] };
    }
    if (/^F([1-9]|1[0-2])$/i.test(rawKey)) return { modifierOnly: false, key: rawKey.toUpperCase() };
    if (rawKey === ' ') return { modifierOnly: false, key: 'Space' };
    if (rawKey.length === 1) return { modifierOnly: false, key: rawKey.toUpperCase() };
    if (rawKey === 'Enter' || rawKey === 'Tab' || /^Arrow(?:Up|Down|Left|Right)$/.test(rawKey)) {
      return { modifierOnly: false, key: rawKey };
    }
    return { modifierOnly: false, key: '' };
  }

  function normalizeShortcutEvent(e) {
    const base = extractShortcutBaseKey(e);
    if (base.modifierOnly) return { ok: false, ignored: true };
    if (!base.key) {
      return { ok: false, error: '无法识别该按键，请使用字母、数字或 F1-F12 组合键' };
    }
    const mods = [];
    if (e?.ctrlKey) mods.push('Ctrl');
    if (e?.metaKey) mods.push('Cmd');
    if (e?.altKey) mods.push('Alt');
    if (e?.shiftKey) mods.push('Shift');
    const isFunctionKey = /^F([1-9]|1[0-2])$/.test(base.key);
    if (!isFunctionKey && !e?.ctrlKey && !e?.metaKey && !e?.altKey) {
      return { ok: false, error: '快捷键需包含 Ctrl / Cmd / Alt 修饰键或功能键 (F1-F12)' };
    }
    return { ok: true, value: [...mods, base.key].join('+') };
  }

  function formatShortcutDisplay(canonical) {
    return String(canonical || '').trim();
  }

  function computeReorderTargetIndex(length, fromIdx, targetIdx, position) {
    if (!Number.isInteger(length) || length <= 1) return -1;
    if (!Number.isInteger(fromIdx) || fromIdx < 0 || fromIdx >= length) return -1;
    if (!Number.isInteger(targetIdx) || targetIdx < 0 || targetIdx >= length) return -1;
    if (fromIdx === targetIdx) return -1;
    let insertIdx = position === 'before'
      ? (fromIdx < targetIdx ? targetIdx - 1 : targetIdx)
      : (fromIdx < targetIdx ? targetIdx : targetIdx + 1);
    insertIdx = Math.max(0, Math.min(length - 1, insertIdx));
    return insertIdx === fromIdx ? -1 : insertIdx;
  }

  function reorderArray(items, fromIdx, toIdx) {
    if (!Array.isArray(items) || items.length <= 1) return null;
    if (!Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) return null;
    if (fromIdx < 0 || fromIdx >= items.length || toIdx < 0 || toIdx >= items.length) return null;
    if (fromIdx === toIdx) return null;
    const next = [...items];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    return next;
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
    const XWORLD_LIFECYCLE_EVENT = '__agy_xworld_lifecycle__';
    function dispatchLifecycleEvent(detail) {
      if (!doc || typeof doc.dispatchEvent !== 'function') return;
      const EventCtor = (win && typeof win.CustomEvent === 'function')
        ? win.CustomEvent
        : (typeof CustomEvent === 'function' ? CustomEvent : null);
      const ev = EventCtor
        ? new EventCtor(XWORLD_LIFECYCLE_EVENT, { detail })
        : { type: XWORLD_LIFECYCLE_EVENT, detail };
      try { doc.dispatchEvent(ev); } catch {}
    }

    // 防重复挂载：清理已有宿主实例
    if (win.__AGYDaddyHost && typeof win.__AGYDaddyHost.dispose === 'function') {
      try { win.__AGYDaddyHost.dispose(); } catch {}
    }

    const incomingHostSettings = isPlainObject(mergedOpts.hostSettings) ? mergedOpts.hostSettings : {};
    const resolvedThemeMode = mergedOpts.themeMode || incomingHostSettings.themeMode || DEFAULT_HOST_SETTINGS.themeMode;
    const resolvedHeatPreset = mergedOpts.heatPreset || incomingHostSettings.heatPreset || DEFAULT_HOST_SETTINGS.heatPreset;
    const resolvedCustomColors = isPlainObject(mergedOpts.customColors)
      ? { ...mergedOpts.customColors }
      : (isPlainObject(incomingHostSettings.customColors) ? { ...incomingHostSettings.customColors } : {});
    const resolvedMaxVisible = Number.isFinite(Number(incomingHostSettings.maxVisibleUnits)) && Number(incomingHostSettings.maxVisibleUnits) >= 1
      ? Math.floor(Number(incomingHostSettings.maxVisibleUnits))
      : DEFAULT_HOST_SETTINGS.maxVisibleUnits;
    const resolvedShowTopbarEntry = typeof incomingHostSettings.showTopbarEntry === 'boolean'
      ? incomingHostSettings.showTopbarEntry
      : DEFAULT_HOST_SETTINGS.showTopbarEntry;
    const resolvedInjectNativeSettings = typeof incomingHostSettings.injectNativeSettings === 'boolean'
      ? incomingHostSettings.injectNativeSettings
      : DEFAULT_HOST_SETTINGS.injectNativeSettings;
    const resolvedAutoSyncNativeOnInstall = typeof incomingHostSettings.autoSyncNativeOnInstall === 'boolean'
      ? incomingHostSettings.autoSyncNativeOnInstall
      : DEFAULT_HOST_SETTINGS.autoSyncNativeOnInstall;
    const resolvedHideTrayIcon = typeof incomingHostSettings.hideTrayIcon === 'boolean'
      ? incomingHostSettings.hideTrayIcon
      : DEFAULT_HOST_SETTINGS.hideTrayIcon;

    const state = {
      disposed: false,
      themeMode: resolvedThemeMode,
      heatPreset: resolvedHeatPreset,
      customColors: resolvedCustomColors,
      hostSettings: {
        themeMode: resolvedThemeMode,
        heatPreset: resolvedHeatPreset,
        customColors: resolvedCustomColors,
        topbarPins: isPlainObject(incomingHostSettings.topbarPins) ? { ...incomingHostSettings.topbarPins } : {},
        topbarOrder: Array.isArray(incomingHostSettings.topbarOrder) ? [...incomingHostSettings.topbarOrder] : [],
        maxVisibleUnits: resolvedMaxVisible,
        showTopbarEntry: resolvedShowTopbarEntry,
        injectNativeSettings: resolvedInjectNativeSettings,
        autoSyncNativeOnInstall: resolvedAutoSyncNativeOnInstall,
        hideTrayIcon: resolvedHideTrayIcon
      },
      locale: mergedOpts.locale || 'zh-CN',
      antigravityVersion: mergedOpts.antigravityVersion || '2.33.0',
      anchorsRegistry: mergedOpts.anchorsRegistry || { anchors: {} },
      healthTargetId: typeof mergedOpts.healthTargetId === 'string' ? mergedOpts.healthTargetId : '',
      healthReportId: typeof mergedOpts.healthReportId === 'string' ? mergedOpts.healthReportId : '',
      healthAnchors: isPlainObject(mergedOpts.healthAnchors) ? mergedOpts.healthAnchors : null,
      healthReportIntervalMs: Math.max(50, Number(mergedOpts.healthReportIntervalMs) || DEFAULT_RUNTIME_HEALTH_REPORT_INTERVAL_MS),
      bridgePort: Number(mergedOpts.bridgePort || 0),
      activeSettingsTab: 'plugins',
      selectedPluginId: null,
      focusPluginDiagnostics: null,
      marketplaceOpen: false,
      diagnosticsExpanded: false,
      settingsSearchQuery: '',
      installDrawerOpen: false,
      settingsMode: 'closed', // 'closed' | 'native' | 'modal'
      updateInfo: { hasUpdate: false, currentVersion: HOST_VERSION, latestVersion: HOST_VERSION },
      manageLoading: false,
      manageBusyId: null,
      actionBusyId: null,
      manageError: '',
      manageToast: null,
      managePlugins: [],
      manageCatalog: [],
      marketStats: new Map(),          // pluginId -> { eligible, githubRepo, npmPackage, githubStars, downloads, githubDownloads, npmDownloads, fetchedAt }
      marketStatsLoading: false,
      manageInstallSpec: '',
      manageCopyMode: false,
      managePendingPerm: null,
      manageConfirmUninstallId: null,
      managePendingNativeUninstall: null,
      repairPathDrafts: new Map(),     // pluginId -> custom local path input
      diagnosticsExportInfo: null,
      pluginMeta: new Map(),           // pluginId -> normalized meta
      fieldErrors: new Map(),          // `${pluginId}:${fieldKey}` -> string
      listDrafts: new Map(),           // `${pluginId}:${fieldKey}` -> string
      ruleDrafts: new Map(),           // `${pluginId}:${fieldKey}` -> { target, metric, threshold, color }
      commandDrafts: new Map(),        // `${pluginId}:${fieldKey}` -> { name, command, pinToTopbar }
      commandEdits: new Map(),         // `${pluginId}:${fieldKey}` -> { idx, name, command }
      presetDrafts: new Map(),         // `${pluginId}:${fieldKey}` -> { label, text, autoSend }
      dragReorder: { listKey: null, fromIdx: -1, containerEl: null, autoScrollRaf: 0, autoScrollEl: null, autoScrollSpeed: 0 },
      pendingFlipReorder: null,        // { listKey, rectsByOldIdx: Map, fromIdx, toIdx, focusNewIdx, ts }
      fieldModal: null,                // null | { pluginId, field, mode: 'preview'|'edit', draft, savedValue, onCommit }
      recordingShortcutKey: null,      // `${pluginId}:${fieldKey}` | null
      comboboxOptions: new Map(),      // `${pluginId}:${fieldKey}` -> { loaded, loading, options }
      dynamicPresets: new Map(),       // `${pluginId}:${fieldKey}` -> { loaded, loading, presets, meta }
      catalogItems: new Map(),         // `${pluginId}:${fieldKey}` -> { loaded, loading, items, error }
      catalogUiState: new Map(),       // `${pluginId}:${fieldKey}` -> { query, dimension, sortMode }
      openComboboxKey: null,           // `${pluginId}:${fieldKey}` | null
      fieldProbeState: new Map(),      // `${pluginId}:${fieldKey}` -> { status, message, sig, seq }
      fieldComposerTouched: new Set(), // `${pluginId}:${fieldKey}` -> user manually edited in current view
      units: new Map(),                // `${pluginId}:${unitId}` -> unit record
      popovers: new Map(),             // `${pluginId}:${popId}` -> popover record
      pluginStyles: new Map(),         // `${pluginId}:${styleId}` -> { pluginId, styleId, scope, node }
      surfaces: new Map(),             // surfaceName -> { pluginId, surfaceName, el, selector }
      surfaceSubs: new Map(),          // surfaceName -> Set<{ pluginId, isIsolated, fn }>
      services: new Map(),             // svcName -> { pluginId, methods, isIsolated }
      pendingServiceInvokes: new Map(),// invokeId -> { pluginId, resolve, reject, timer }
      events: new Map(),               // topic -> Set<{ pluginId, isIsolated, fn }>
      stickyState: new Map(),          // key -> { value, version }
      stateSubs: new Map(),            // key -> Set<{ pluginId, isIsolated, fn }>
      settingsSubs: new Map(),         // pluginId -> Set<fn>
      localCommands: new Map(),        // commandId -> { pluginId, handler }
      timers: new Map(),               // pluginId -> Set<{ kind, id }>
      anchorSubs: new Map(),           // subId -> { pluginId, anchorName, fn, lastHit }
      pluginInstances: new Map(),      // pluginId -> { pluginObj, ctx }
      topbarSuppressedPlugins: new Set(), // 显式声明当前无可用顶栏单元的插件（如已切至底部输入框）
      auxSidebarExpanded: false,       // 右侧辅助边栏是否处于展开态
      crashCounts: new Map(),          // pluginId -> number[]
      rendererErrors: new Map(),       // pluginId -> { message, at }
      metrics: new Map(),              // pluginId -> { mountMs, observerMs, timersCount, crashes }
      isolatedPlugins: new Set(),      // isolated-world pluginIds observed via xworld
      safeModeViewOpen: false,
      settingsInjectionAttemptFailed: false,
      safeModePillPos: null,           // null | { left, top }
      safeMode: {
        active: false,
        reasons: [],
        missingAnchors: [],
        topbarMissing: false,
        settingsInjectionFailed: false,
        pluginIssues: []
      },
      hostHealth: null,
      hostHealthLoading: false,
      hostHealthError: '',
      lastRuntimeHealthSig: '',
      lastRuntimeHealthSentAt: 0,
      xworldNonce: mergedOpts.xworldNonce || (String(Math.random()).slice(2) + Date.now().toString(36))
    };

    dispatchLifecycleEvent({ type: 'host.reset', nextNonce: state.xworldNonce });

    function pickLocaleText(val, fallback = '') {
      if (typeof val === 'string') return val;
      if (isPlainObject(val)) {
        return String(val[state.locale] || val['zh-CN'] || val.en || Object.values(val)[0] || fallback);
      }
      return fallback;
    }

    function mergeSchemaDefaults(schema, rawValues = {}) {
      const out = isPlainObject(rawValues) ? { ...rawValues } : {};
      if (schema && Array.isArray(schema.fields)) {
        for (const field of schema.fields) {
          if (field && field.key && out[field.key] === undefined && field.default !== undefined) {
            out[field.key] = Array.isArray(field.default) ? [...field.default] : field.default;
          }
        }
      }
      return out;
    }

    function sanitizeWriteOnlyForRenderer(schema, values = {}, prevSecretState = {}, incomingSecretState = null, clearedKeys = null) {
      const out = isPlainObject(values) ? { ...values } : {};
      const secretState = isPlainObject(prevSecretState) ? { ...prevSecretState } : {};
      if (schema && Array.isArray(schema.fields)) {
        for (const field of schema.fields) {
          if (!field || !field.key || field.writeOnly !== true) continue;
          const key = field.key;
          if (incomingSecretState && typeof incomingSecretState[key] === 'boolean') {
            secretState[key] = incomingSecretState[key];
          } else if (clearedKeys && clearedKeys.has(key)) {
            secretState[key] = false;
          } else if (typeof out[key] === 'string' && out[key].trim().length > 0) {
            secretState[key] = true;
          } else if (typeof secretState[key] !== 'boolean') {
            secretState[key] = false;
          }
          out[key] = '';
        }
      }
      return { values: out, secretState };
    }

    function upsertPluginMeta(rawMeta) {
      if (!rawMeta || !rawMeta.id) return null;
      const id = String(rawMeta.id);
      const prev = state.pluginMeta.get(id) || {};
      const nextSchema = rawMeta.settingsSchema !== undefined ? rawMeta.settingsSchema : (prev.settingsSchema || null);
      const rawValues = rawMeta.settingsValues !== undefined ? rawMeta.settingsValues : (prev.settingsValues || {});
      const sanitized = sanitizeWriteOnlyForRenderer(
        nextSchema,
        mergeSchemaDefaults(nextSchema, rawValues),
        prev.settingsSecretState,
        rawMeta.settingsSecretState || null,
        rawMeta._clearedSecretKeys || null
      );
      const merged = {
        id,
        displayName: rawMeta.displayName !== undefined ? pickLocaleText(rawMeta.displayName, id) : (prev.displayName || id),
        description: rawMeta.description !== undefined ? pickLocaleText(rawMeta.description, '') : (prev.description || ''),
        version: rawMeta.version || prev.version || '1.0.0',
        trustLevel: rawMeta.trustLevel || prev.trustLevel || (id.startsWith('agy-daddy.') ? 'T0' : (id.startsWith('community.') ? 'T1' : 'T2')),
        badge: rawMeta.badge || prev.badge || '',
        world: rawMeta.world || prev.world || 'isolated',
        enabled: rawMeta.enabled !== undefined ? rawMeta.enabled !== false : (prev.enabled !== false),
        active: rawMeta.active !== undefined ? Boolean(rawMeta.active) : (prev.active !== false),
        hasNative: rawMeta.hasNative !== undefined ? Boolean(rawMeta.hasNative) : Boolean(prev.hasNative),
        nativeInfo: isPlainObject(rawMeta.nativeInfo) ? { ...rawMeta.nativeInfo } : (prev.nativeInfo || null),
        hasRollback: rawMeta.hasRollback !== undefined ? Boolean(rawMeta.hasRollback) : Boolean(prev.hasRollback),
        permissions: Array.isArray(rawMeta.permissions) ? [...rawMeta.permissions] : (prev.permissions || []),
        settingsSchema: nextSchema,
        settingsValues: sanitized.values,
        settingsSecretState: sanitized.secretState,
        commands: Array.isArray(rawMeta.commands) ? [...rawMeta.commands] : (prev.commands || []),
        topbarUnits: Array.isArray(rawMeta.topbarUnits) ? [...rawMeta.topbarUnits] : (prev.topbarUnits || []),
        sourceKind: rawMeta.sourceKind || prev.sourceKind || 'installed',
        sourceSpec: rawMeta.sourceSpec !== undefined ? String(rawMeta.sourceSpec || '') : (prev.sourceSpec || ''),
        repo: rawMeta.repo !== undefined ? String(rawMeta.repo || '') : (prev.repo || ''),
        npmPackage: rawMeta.npmPackage !== undefined ? String(rawMeta.npmPackage || '') : (prev.npmPackage || ''),
        marketStats: isPlainObject(rawMeta.marketStats) ? { ...rawMeta.marketStats } : (prev.marketStats || null),
        health: rawMeta.health !== undefined ? rawMeta.health : (prev.health || null),
        installHealth: rawMeta.installHealth !== undefined
          ? (isPlainObject(rawMeta.installHealth) ? { ...rawMeta.installHealth } : null)
          : (prev.installHealth || null)
      };
      if (isPlainObject(rawMeta.marketStats)) {
        state.marketStats.set(id, { ...rawMeta.marketStats });
      }
      state.pluginMeta.set(id, merged);
      return merged;
    }

    function ingestPluginMetaMap(metaInput) {
      if (!metaInput) return;
      if (metaInput instanceof Map) {
        for (const [id, meta] of metaInput.entries()) {
          if (isPlainObject(meta)) upsertPluginMeta({ id, ...meta });
        }
      } else if (Array.isArray(metaInput)) {
        for (const meta of metaInput) {
          if (isPlainObject(meta) && meta.id) upsertPluginMeta(meta);
        }
      } else if (isPlainObject(metaInput)) {
        for (const [id, meta] of Object.entries(metaInput)) {
          if (isPlainObject(meta)) upsertPluginMeta({ id, ...meta });
        }
      }
    }

    ingestPluginMetaMap(mergedOpts.pluginMeta);

    function getMetric(pluginId) {
      if (!state.metrics.has(pluginId)) {
        state.metrics.set(pluginId, { mountMs: 0, observerMs: 0, timersCount: 0, crashes: 0 });
      }
      return state.metrics.get(pluginId);
    }

    // Shadow DOM 宿主壳、溢出菜单、独立模态窗与原生设置弹窗挂载状态
    let hostEl = null;
    let shadow = null;
    let barEl = null;
    let overflowBtnEl = null;
    let overflowMenuEl = null;
    let overflowTitleEl = null;
    let overflowListEl = null;
    let settingsBtnEl = null;
    let pluginAlertBtnEl = null;
    let pluginAlertPopoverEl = null;
    let pluginAlertListEl = null;
    let modalBackdropEl = null;
    let modalDialogEl = null;
    let modalSettingsRootEl = null;
    let lightDomStyleEl = null;
    let browserOccluderEl = null;
    let portalOverlayClaimed = false;
    let occluderResizeObserver = null;
    let occluderObservedEl = null;
    let occluderWindowResizeHandler = null;
    let occluderRafPending = false;
    let auxSidebarObserver = null;
    let rightOverlayResizeObserver = null;
    let rightOverlayObservedEl = null;
    let themeObserver = null;
    let removeMediaListener = null;
    let activePopoverId = null;
    let styleSeq = 0;
    let serviceInvokeSeq = 0;
    const boundOverflowUnitNodes = new WeakSet();
    let safeModePillHostEl = null;
    let safeModePillShadow = null;
    let safeModePillBtnEl = null;
    let safeModePillDragState = null;
    let suppressNextSafeModePillClick = false;
    let suppressSafeModeClickTimer = null;
    let runtimeHealthTimer = null;
    let runtimeHealthDebounceTimer = null;
    let runtimeHealthInFlight = null;
    let hostHealthInFlight = null;

    const nativeState = {
      dialogEl: null,
      navEl: null,
      contentEl: null,
      navWrapEl: null,
      navBtnEl: null,
      mountHostEl: null,
      mountShadow: null,
      viewRootEl: null,
      savedContentDisplay: null,
      active: false,
      boundNavClick: null,
      boundSiblingBtns: new WeakSet()
    };

    function hasBridgeAvailable() {
      return Boolean(state.bridgePort && hostToken && typeof fetchFn === 'function');
    }

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

      overflowBtnEl = doc.createElement('button');
      overflowBtnEl.id = 'agy-topbar-overflow-btn';
      overflowBtnEl.type = 'button';
      overflowBtnEl.className = 'ag-unit';
      overflowBtnEl.textContent = '⋯';
      overflowBtnEl.setAttribute('title', '更多顶栏插件');
      overflowBtnEl.setAttribute('aria-label', '更多顶栏插件');
      overflowBtnEl.setAttribute('aria-haspopup', 'menu');
      overflowBtnEl.setAttribute('aria-expanded', 'false');
      setHidden(overflowBtnEl, true);
      overflowBtnEl.addEventListener('click', () => toggleOverflowMenu());
      barEl.appendChild(overflowBtnEl);

      settingsBtnEl = doc.createElement('button');
      settingsBtnEl.id = 'agy-btn-settings';
      settingsBtnEl.type = 'button';
      settingsBtnEl.className = 'ag-unit';
      settingsBtnEl.textContent = 'Agy';
      const dot = doc.createElement('span');
      dot.id = 'agy-update-dot';
      dot.className = 'ag-update-dot';
      setHidden(dot, !state.updateInfo?.hasUpdate);
      settingsBtnEl.appendChild(dot);
      settingsBtnEl.addEventListener('click', () => {
        if (overflowMenuEl && !overflowMenuEl.hidden) {
          toggleOverflowMenu(false);
        }
        toggleSettingsPanel();
      });
      syncTopbarEntryVisibility();
      barEl.appendChild(settingsBtnEl);

      pluginAlertBtnEl = doc.createElement('button');
      pluginAlertBtnEl.id = 'agy-plugin-alert-btn';
      pluginAlertBtnEl.type = 'button';
      pluginAlertBtnEl.className = 'ag-unit ag-plugin-alert-btn';
      pluginAlertBtnEl.setAttribute('aria-haspopup', 'dialog');
      pluginAlertBtnEl.setAttribute('aria-expanded', 'false');
      setHidden(pluginAlertBtnEl, true);
      pluginAlertBtnEl.addEventListener('click', () => {
        if (overflowMenuEl && !overflowMenuEl.hidden) {
          toggleOverflowMenu(false);
        }
        const issues = getUnusablePlugins();
        if (issues.length === 0) {
          renderPluginAlertCapsule();
          return;
        }
        if (issues.length === 1) {
          closeAllPopovers('__settings__');
          void openSettings({ tab: 'plugins', pluginId: issues[0].id, focusDiagnostics: true });
          return;
        }
        togglePluginAlertPopover();
      });
      barEl.appendChild(pluginAlertBtnEl);

      pluginAlertPopoverEl = doc.createElement('section');
      pluginAlertPopoverEl.id = 'agy-plugin-alert-popover';
      pluginAlertPopoverEl.className = 'ag-panel ag-plugin-alert-popover';
      setHidden(pluginAlertPopoverEl, true);
      const alHead = doc.createElement('div');
      alHead.className = 'ag-panel-head';
      const alTitleWrap = doc.createElement('div');
      alTitleWrap.className = 'ag-panel-title-wrap';
      const alTitle = doc.createElement('span');
      alTitle.className = 'ag-panel-title';
      alTitle.textContent = '插件异常通知';
      alTitleWrap.appendChild(alTitle);
      const alActions = doc.createElement('div');
      alActions.className = 'ag-panel-actions';
      const alClose = doc.createElement('button');
      alClose.type = 'button';
      alClose.id = 'agy-plugin-alert-close';
      alClose.className = 'ag-icon-btn ag-popover-close-btn';
      alClose.setAttribute('aria-label', '关闭');
      alClose.setAttribute('title', '关闭');
      alClose.appendChild(createIconEl('close'));
      alClose.addEventListener('click', () => togglePluginAlertPopover(false));
      alActions.appendChild(alClose);
      alHead.appendChild(alTitleWrap);
      alHead.appendChild(alActions);
      pluginAlertPopoverEl.appendChild(alHead);

      pluginAlertListEl = doc.createElement('div');
      pluginAlertListEl.id = 'agy-plugin-alert-list';
      pluginAlertListEl.className = 'ag-plugin-alert-list';
      pluginAlertPopoverEl.appendChild(pluginAlertListEl);

      const alFoot = doc.createElement('div');
      alFoot.className = 'ag-plugin-alert-footer';
      const alActivateAllBtn = doc.createElement('button');
      alActivateAllBtn.type = 'button';
      alActivateAllBtn.id = 'agy-alert-activate-all-btn';
      alActivateAllBtn.className = 'ag-btn ag-btn-primary';
      alActivateAllBtn.textContent = '全部重试激活';
      alActivateAllBtn.addEventListener('click', () => {
        togglePluginAlertPopover(false);
        void activateAllInactiveFromUi();
      });
      const alOpenDiagBtn = doc.createElement('button');
      alOpenDiagBtn.type = 'button';
      alOpenDiagBtn.id = 'agy-alert-open-diag-btn';
      alOpenDiagBtn.className = 'ag-btn';
      alOpenDiagBtn.textContent = '运行诊断';
      alOpenDiagBtn.addEventListener('click', () => {
        togglePluginAlertPopover(false);
        void openSettings({ tab: 'diagnostics' });
      });
      alFoot.appendChild(alActivateAllBtn);
      alFoot.appendChild(alOpenDiagBtn);
      pluginAlertPopoverEl.appendChild(alFoot);
      shadow.appendChild(pluginAlertPopoverEl);

      overflowMenuEl = doc.createElement('section');
      overflowMenuEl.id = 'agy-topbar-overflow-menu';
      overflowMenuEl.className = 'ag-panel ag-overflow-menu';
      setHidden(overflowMenuEl, true);
      const ovHead = doc.createElement('div');
      ovHead.className = 'ag-panel-head';
      const ovTitleWrap = doc.createElement('div');
      ovTitleWrap.className = 'ag-panel-title-wrap';
      const ovTitle = doc.createElement('span');
      ovTitle.className = 'ag-panel-title';
      ovTitle.textContent = '更多顶栏插件';
      overflowTitleEl = ovTitle;
      ovTitleWrap.appendChild(ovTitle);
      const ovActions = doc.createElement('div');
      ovActions.className = 'ag-panel-actions';
      const ovSettings = doc.createElement('button');
      ovSettings.type = 'button';
      ovSettings.className = 'ag-icon-btn ag-popover-settings-btn';
      ovSettings.setAttribute('data-popover-settings', 'host');
      ovSettings.setAttribute('title', '设置');
      ovSettings.setAttribute('aria-label', '设置');
      ovSettings.appendChild(createIconEl('settings'));
      ovSettings.addEventListener('click', () => {
        toggleOverflowMenu(false);
        void openSettings({ tab: 'appearance' });
      });
      const ovClose = doc.createElement('button');
      ovClose.type = 'button';
      ovClose.className = 'ag-icon-btn ag-popover-close-btn';
      ovClose.setAttribute('data-popover-close', '__overflow__');
      ovClose.setAttribute('aria-label', '关闭');
      ovClose.setAttribute('title', '关闭');
      ovClose.appendChild(createIconEl('close'));
      ovClose.addEventListener('click', () => toggleOverflowMenu(false));
      ovActions.appendChild(ovSettings);
      ovActions.appendChild(ovClose);
      ovHead.appendChild(ovTitleWrap);
      ovHead.appendChild(ovActions);
      overflowMenuEl.appendChild(ovHead);
      overflowListEl = doc.createElement('div');
      overflowListEl.id = 'agy-topbar-overflow-list';
      overflowListEl.className = 'ag-overflow-list';
      overflowMenuEl.appendChild(overflowListEl);
      shadow.appendChild(overflowMenuEl);

      // 独立居中模态窗降级壳 (760x560)
      modalBackdropEl = doc.createElement('div');
      modalBackdropEl.id = 'agy-settings-modal-backdrop';
      modalBackdropEl.className = 'ag-modal-backdrop';
      setHidden(modalBackdropEl, true);
      modalBackdropEl.addEventListener('click', (ev) => {
        if (!ev || ev.target === modalBackdropEl) {
          closeSettings();
        }
      });

      modalDialogEl = doc.createElement('div');
      modalDialogEl.id = 'agy-settings-modal';
      modalDialogEl.className = 'ag-modal-dialog';
      modalDialogEl.setAttribute('role', 'dialog');
      modalDialogEl.setAttribute('aria-label', 'Agy-Daddy Settings');

      modalSettingsRootEl = doc.createElement('div');
      modalSettingsRootEl.id = 'agy-modal-settings-root';
      modalSettingsRootEl.className = 'agy-settings-view';
      modalDialogEl.appendChild(modalSettingsRootEl);
      modalBackdropEl.appendChild(modalDialogEl);
      shadow.appendChild(modalBackdropEl);

      const dockFlow = hostEl.getAttribute?.('data-dock') === 'flow';
      const anchorEl = dockFlow ? queryAnchor('topbar.rightCluster') : null;
      const isInteractive = anchorEl && /^(BUTTON|INPUT|A|SELECT|TEXTAREA)$/i.test(String(anchorEl.tagName || anchorEl.nodeName || ''));
      const mountTarget = (anchorEl && !isInteractive) ? anchorEl : (doc.body || doc.documentElement);
      if (mountTarget && typeof mountTarget.appendChild === 'function') {
        mountTarget.appendChild(hostEl);
      }
      applyThemeVars();
      startThemeWatchers();
      ensureSharedObserver();
      startAuxSidebarWatcher();
      syncAuxSidebarState({ forceRender: false });
      syncNativeSettingsIntegration();
      syncExternalDialogLayering();
      return shadow;
    }

    function applyThemeVars(accent = null) {
      const themeEngine = getThemeEngine();
      const prefersLight = themeEngine?.detectHostPrefersLight ? themeEngine.detectHostPrefersLight(doc, win) : false;
      const effectiveModeFallback = state.themeMode === 'light' ? 'light' : (state.themeMode === 'dark' ? 'dark' : (prefersLight ? 'light' : 'dark'));
      const defaultAccent = effectiveModeFallback === 'light' ? '#18181b' : '#e4e4e7';
      let resolved = { accent: accent || defaultAccent, effectiveMode: effectiveModeFallback, heatPreset: 'system' };
      const applyOpts = {
        window: win,
        themeMode: state.themeMode || 'auto',
        heatPreset: 'system',
        customColors: {
          ...(state.customColors || {}),
          ...(accent && accent !== DEFAULT_ACCENT ? { tokenAccent: accent } : {})
        }
      };
      if (themeEngine && typeof themeEngine.applyThemeVariables === 'function') {
        resolved = themeEngine.applyThemeVariables(doc, hostEl, applyOpts);
        if (nativeState.mountHostEl) {
          themeEngine.applyThemeVariables(doc, nativeState.mountHostEl, applyOpts);
        }
        if (safeModePillHostEl) {
          themeEngine.applyThemeVariables(doc, safeModePillHostEl, applyOpts);
        }
      } else {
        if (doc?.documentElement?.style?.setProperty) {
          doc.documentElement.style.setProperty('--ag-effective-accent', resolved.accent);
        }
        for (const target of [hostEl, nativeState.mountHostEl, safeModePillHostEl]) {
          if (target?.style?.setProperty) {
            target.style.setProperty('--ag-custom-token-accent', resolved.accent);
            target.setAttribute?.('data-theme', effectiveModeFallback);
          }
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
      notifyStateSubscribers('state:host.theme@1', nextSticky.value, nextSticky.version, false);
      return resolved;
    }

    function syncTopbarEntryVisibility() {
      if (settingsBtnEl) {
        setHidden(settingsBtnEl, state.hostSettings.showTopbarEntry === false);
      }
    }

    // 宿主设置持久化（外观、5套色板、顶栏 Pin/顺序、maxVisibleUnits、入口显示与原生设置注入）
    async function persistHostSettings(patch = {}) {
      if (!isPlainObject(patch)) return { ok: false };
      if (patch.themeMode !== undefined) {
        state.themeMode = patch.themeMode;
        state.hostSettings.themeMode = patch.themeMode;
      }
      if (patch.heatPreset !== undefined) {
        state.heatPreset = patch.heatPreset;
        state.hostSettings.heatPreset = patch.heatPreset;
      }
      if (isPlainObject(patch.customColors)) {
        state.customColors = { ...patch.customColors };
        state.hostSettings.customColors = { ...patch.customColors };
      }
      if (isPlainObject(patch.topbarPins)) {
        const mergedPins = { ...(state.hostSettings.topbarPins || {}) };
        for (const [k, v] of Object.entries(patch.topbarPins)) {
          if (v === null || v === undefined) delete mergedPins[k];
          else mergedPins[k] = Boolean(v);
        }
        state.hostSettings.topbarPins = mergedPins;
      }
      if (Array.isArray(patch.topbarOrder)) {
        state.hostSettings.topbarOrder = [...patch.topbarOrder];
      }
      if (patch.maxVisibleUnits !== undefined) {
        const n = Math.max(1, Math.floor(Number(patch.maxVisibleUnits) || 6));
        state.hostSettings.maxVisibleUnits = n;
      }
      if (patch.showTopbarEntry !== undefined) {
        state.hostSettings.showTopbarEntry = Boolean(patch.showTopbarEntry);
      }
      if (patch.injectNativeSettings !== undefined) {
        state.hostSettings.injectNativeSettings = Boolean(patch.injectNativeSettings);
      }
      if (patch.autoSyncNativeOnInstall !== undefined) {
        state.hostSettings.autoSyncNativeOnInstall = Boolean(patch.autoSyncNativeOnInstall);
      }
      if (patch.hideTrayIcon !== undefined) {
        state.hostSettings.hideTrayIcon = Boolean(patch.hideTrayIcon);
      }

      if (!hasBridgeAvailable()) {
        return { ok: true, localOnly: true, values: getHostSettingsSnapshot() };
      }
      try {
        const res = await hostBridgePost('/host/host-settings', {
          action: 'save',
          values: patch
        });
        return res;
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }

    function getHostSettingsSnapshot() {
      return {
        themeMode: state.hostSettings.themeMode,
        heatPreset: state.hostSettings.heatPreset,
        customColors: { ...(state.hostSettings.customColors || {}) },
        topbarPins: { ...(state.hostSettings.topbarPins || {}) },
        topbarOrder: [...(state.hostSettings.topbarOrder || [])],
        maxVisibleUnits: state.hostSettings.maxVisibleUnits,
        showTopbarEntry: state.hostSettings.showTopbarEntry !== false,
        injectNativeSettings: state.hostSettings.injectNativeSettings !== false,
        autoSyncNativeOnInstall: state.hostSettings.autoSyncNativeOnInstall !== false,
        hideTrayIcon: state.hostSettings.hideTrayIcon === true
      };
    }

    // 顶栏 Pin / 顺序 / 溢出治理
    function isUnitPinned(pluginId, unitId) {
      const pins = state.hostSettings.topbarPins || {};
      const key = `${pluginId}:${unitId}`;
      if (typeof pins[key] === 'boolean') return pins[key];
      if (typeof pins[pluginId] === 'boolean') return pins[pluginId];
      return true;
    }

    function isPluginPinned(pluginId) {
      const pins = state.hostSettings.topbarPins || {};
      if (typeof pins[pluginId] === 'boolean') return pins[pluginId];
      const unitEntries = Array.from(state.units.values()).filter((u) => u.pluginId === pluginId);
      if (unitEntries.length > 0) {
        return unitEntries.some((u) => isUnitPinned(u.pluginId, u.id));
      }
      return true;
    }

    function setPluginPinned(pluginId, pinned) {
      const prevPins = state.hostSettings.topbarPins || {};
      const nextPins = { ...prevPins };
      const pinPatch = { [pluginId]: Boolean(pinned) };
      nextPins[pluginId] = Boolean(pinned);
      for (const k of Object.keys(prevPins)) {
        if (k.startsWith(`${pluginId}:`)) {
          delete nextPins[k];
          pinPatch[k] = null;
        }
      }
      for (const u of state.units.values()) {
        if (u.pluginId === pluginId) {
          delete nextPins[u.key];
          pinPatch[u.key] = null;
        }
      }
      state.hostSettings.topbarPins = nextPins;
      renderUnits();
      void persistHostSettings({ topbarPins: pinPatch });
      renderSettingsBody();
    }

    function setUnitPinned(unitKey, pinned) {
      const nextPins = { ...(state.hostSettings.topbarPins || {}) };
      nextPins[unitKey] = Boolean(pinned);
      state.hostSettings.topbarPins = nextPins;
      renderUnits();
      void persistHostSettings({ topbarPins: { [unitKey]: Boolean(pinned) } });
      renderSettingsBody();
    }

    function getUnitSortRank(unit) {
      const orderList = state.hostSettings.topbarOrder || [];
      const exactIdx = orderList.indexOf(unit.key);
      if (exactIdx >= 0) return exactIdx;
      const pluginIdx = orderList.indexOf(unit.pluginId);
      if (pluginIdx >= 0) return pluginIdx + 0.5;
      return orderList.length + 1000 + (Number.isFinite(Number(unit.order)) ? Number(unit.order) : 50);
    }

    function getUnitPluginDisplayName(unit) {
      if (!unit) return '';
      const meta = state.pluginMeta.get(unit.pluginId);
      const fromMeta = meta?.displayName ? pickLocaleText(meta.displayName, '') : '';
      if (fromMeta && fromMeta !== unit.pluginId) return fromMeta;
      const fromManage = state.managePlugins.find((p) => p && p.id === unit.pluginId);
      const fromManageName = fromManage?.displayName ? pickLocaleText(fromManage.displayName, '') : '';
      if (fromManageName) return fromManageName;
      return fromMeta || unit.pluginId || String(unit.id || '');
    }

    function getOrderedUnits() {
      return Array.from(state.units.values()).sort((a, b) => {
        const ra = getUnitSortRank(a);
        const rb = getUnitSortRank(b);
        if (ra !== rb) return ra - rb;
        return a.key.localeCompare(b.key);
      });
    }

    function reorderTopbarUnits(fromIdx, toIdx) {
      const ordered = getOrderedUnits().map((u) => u.key);
      const nextOrder = reorderArray(ordered, fromIdx, toIdx);
      if (!nextOrder) return;
      state.hostSettings.topbarOrder = nextOrder;
      renderUnits();
      void persistHostSettings({ topbarOrder: nextOrder });
      renderSettingsBody();
    }

    function stopDragAutoScroll() {
      const drag = state.dragReorder;
      if (drag?.autoScrollRaf && typeof win?.cancelAnimationFrame === 'function') {
        try { win.cancelAnimationFrame(drag.autoScrollRaf); } catch {}
      }
      if (drag) {
        drag.autoScrollRaf = 0;
        drag.autoScrollEl = null;
        drag.autoScrollSpeed = 0;
      }
    }

    function clearContainerDropIndicators(containerEl, exceptEl = null) {
      if (!containerEl?.querySelectorAll) return;
      const items = containerEl.querySelectorAll('[data-drag-item="true"]');
      for (const el of items) {
        if (el !== exceptEl) {
          el.removeAttribute('data-drop-position');
        }
      }
    }

    function resetDragReorderState() {
      stopDragAutoScroll();
      const prevContainer = state.dragReorder?.containerEl;
      if (prevContainer) {
        prevContainer.removeAttribute?.('data-drag-active');
        if (typeof prevContainer.querySelectorAll === 'function') {
          for (const el of prevContainer.querySelectorAll('[data-drag-item="true"]')) {
            el.removeAttribute('data-dragging');
            el.removeAttribute('data-drop-position');
          }
        }
      }
      state.dragReorder = {
        listKey: null,
        fromIdx: -1,
        containerEl: null,
        autoScrollRaf: 0,
        autoScrollEl: null,
        autoScrollSpeed: 0
      };
    }

    function findScrollableAncestor(el) {
      let cur = el;
      while (cur) {
        if (typeof cur.className === 'string' && cur.className.split(/\s+/).includes('agy-settings-view')) {
          return cur;
        }
        const sh = Number(cur.scrollHeight);
        const ch = Number(cur.clientHeight);
        if (Number.isFinite(sh) && Number.isFinite(ch) && sh > ch + 2) {
          return cur;
        }
        cur = cur.parentElement || null;
      }
      return null;
    }

    function updateDragAutoScroll(itemEl, clientY) {
      if (typeof clientY !== 'number' || !Number.isFinite(clientY)) {
        stopDragAutoScroll();
        return;
      }
      const scrollEl = findScrollableAncestor(itemEl);
      if (!scrollEl || typeof scrollEl.getBoundingClientRect !== 'function') {
        stopDragAutoScroll();
        return;
      }
      const rect = scrollEl.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || rect.bottom <= rect.top) {
        stopDragAutoScroll();
        return;
      }
      const edgePx = 48;
      let speed = 0;
      if (clientY < rect.top + edgePx) {
        const ratio = Math.min(1, Math.max(0, (rect.top + edgePx - clientY) / edgePx));
        speed = -Math.round(4 + ratio * 10);
      } else if (clientY > rect.bottom - edgePx) {
        const ratio = Math.min(1, Math.max(0, (clientY - (rect.bottom - edgePx)) / edgePx));
        speed = Math.round(4 + ratio * 10);
      }
      if (!speed) {
        stopDragAutoScroll();
        return;
      }
      const drag = state.dragReorder;
      drag.autoScrollEl = scrollEl;
      drag.autoScrollSpeed = speed;
      if (!drag.autoScrollRaf && typeof win?.requestAnimationFrame === 'function') {
        const step = () => {
          const cur = state.dragReorder;
          if (!cur || cur.fromIdx < 0 || !cur.autoScrollEl || !cur.autoScrollSpeed) {
            stopDragAutoScroll();
            return;
          }
          cur.autoScrollEl.scrollTop = (Number(cur.autoScrollEl.scrollTop) || 0) + cur.autoScrollSpeed;
          cur.autoScrollRaf = win.requestAnimationFrame(step);
        };
        drag.autoScrollRaf = win.requestAnimationFrame(step);
      }
    }

    function resolveDropPosition(itemEl, e, fromIdx, targetIdx) {
      if (typeof e?.clientY === 'number' && typeof itemEl?.getBoundingClientRect === 'function') {
        const rect = itemEl.getBoundingClientRect();
        if (rect && Number.isFinite(rect.top) && Number.isFinite(rect.height) && rect.height > 0) {
          return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        }
      }
      return fromIdx > targetIdx ? 'before' : 'after';
    }

    function captureFlipSnapshot(containerEl, listKey, fromIdx, toIdx, focusNewIdx = null) {
      const rectsByOldIdx = new Map();
      if (containerEl?.querySelectorAll) {
        for (const el of containerEl.querySelectorAll('[data-drag-item="true"]')) {
          const idx = Number(el.getAttribute('data-drag-index'));
          if (Number.isInteger(idx) && typeof el.getBoundingClientRect === 'function') {
            const rect = el.getBoundingClientRect();
            if (rect && Number.isFinite(rect.top)) {
              rectsByOldIdx.set(idx, rect.top);
            }
          }
        }
      }
      state.pendingFlipReorder = {
        listKey,
        rectsByOldIdx,
        fromIdx,
        toIdx,
        focusNewIdx,
        ts: Date.now()
      };
    }

    function applyPendingFlipAndFocus(containerEl, listKey) {
      const pending = state.pendingFlipReorder;
      if (!pending || pending.listKey !== listKey) return;
      state.pendingFlipReorder = null;
      if (Date.now() - pending.ts > 800) return;

      const items = containerEl?.querySelectorAll ? containerEl.querySelectorAll('[data-drag-item="true"]') : [];
      if (pending.focusNewIdx !== null && Number.isInteger(pending.focusNewIdx)) {
        const focusTarget = Array.from(items).find((el) => Number(el.getAttribute('data-drag-index')) === pending.focusNewIdx);
        const handleEl = focusTarget?.querySelector?.('.ag-drag-handle');
        handleEl?.focus?.();
      }

      let reducedMotion = false;
      try {
        reducedMotion = Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
      } catch {}
      if (reducedMotion || typeof win?.requestAnimationFrame !== 'function' || pending.rectsByOldIdx.size === 0) {
        return;
      }

      const { fromIdx, toIdx, rectsByOldIdx } = pending;
      const movedEls = [];
      for (const el of items) {
        const newIdx = Number(el.getAttribute('data-drag-index'));
        if (!Number.isInteger(newIdx) || typeof el.getBoundingClientRect !== 'function') continue;
        let oldIdx = newIdx;
        if (newIdx === toIdx) {
          oldIdx = fromIdx;
        } else if (fromIdx < toIdx && newIdx >= fromIdx && newIdx < toIdx) {
          oldIdx = newIdx + 1;
        } else if (fromIdx > toIdx && newIdx > toIdx && newIdx <= fromIdx) {
          oldIdx = newIdx - 1;
        }
        const oldTop = rectsByOldIdx.get(oldIdx);
        const newRect = el.getBoundingClientRect();
        if (!Number.isFinite(oldTop) || !newRect || !Number.isFinite(newRect.top)) continue;
        const deltaY = oldTop - newRect.top;
        if (Math.abs(deltaY) < 1) continue;
        el.style?.setProperty?.('transition', 'none');
        el.style?.setProperty?.('transform', `translateY(${deltaY}px)`);
        movedEls.push(el);
      }

      if (movedEls.length === 0) return;
      win.requestAnimationFrame(() => {
        for (const el of movedEls) {
          try { void el.offsetHeight; } catch {}
          el.style?.setProperty?.('transition', 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)');
          el.style?.setProperty?.('transform', '');
        }
        const cleanup = () => {
          for (const el of movedEls) {
            el.style?.removeProperty?.('transition');
            el.style?.removeProperty?.('transform');
          }
        };
        if (typeof setTimeout === 'function') {
          const tid = setTimeout(() => {
            hostRetryTimers.delete(tid);
            cleanup();
          }, 230);
          hostRetryTimers.add(tid);
        } else {
          cleanup();
        }
      });
    }

    function attachSortableContainer(containerEl, opts = {}) {
      if (!containerEl) return;
      const { listKey, itemCount = 0, disabled = false, onReorder } = opts;
      const isDisabled = Boolean(disabled || itemCount <= 1);
      containerEl.setAttribute('data-drag-container', listKey);
      if (isDisabled) {
        containerEl.setAttribute('data-drag-disabled', 'true');
        return;
      }
      containerEl.removeAttribute('data-drag-disabled');

      const findClosestItemByClientY = (clientY) => {
        if (typeof clientY !== 'number' || !containerEl.querySelectorAll) return null;
        const items = Array.from(containerEl.querySelectorAll('[data-drag-item="true"]'));
        let best = null;
        let bestDist = Infinity;
        for (const el of items) {
          if (typeof el.getBoundingClientRect !== 'function') continue;
          const rect = el.getBoundingClientRect();
          if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.height)) continue;
          const mid = rect.top + rect.height / 2;
          const dist = Math.abs(clientY - mid);
          if (dist < bestDist) {
            bestDist = dist;
            best = el;
          }
        }
        return best;
      };

      containerEl.addEventListener('dragover', (e) => {
        const cur = state.dragReorder;
        if (!cur || cur.listKey !== listKey || cur.fromIdx < 0) return;
        e?.preventDefault?.();
        try {
          if (e?.dataTransfer) e.dataTransfer.dropEffect = 'move';
        } catch {}
        updateDragAutoScroll(containerEl, e?.clientY);
        if (e?.target === containerEl) {
          const nearest = findClosestItemByClientY(e?.clientY);
          if (nearest) {
            const targetIdx = Number(nearest.getAttribute('data-drag-index'));
            if (Number.isInteger(targetIdx) && targetIdx !== cur.fromIdx) {
              const pos = resolveDropPosition(nearest, e, cur.fromIdx, targetIdx);
              clearContainerDropIndicators(containerEl, nearest);
              nearest.setAttribute('data-drop-position', pos);
            } else {
              clearContainerDropIndicators(containerEl);
            }
          }
        }
      });

      containerEl.addEventListener('drop', (e) => {
        const cur = state.dragReorder;
        if (!cur || cur.listKey !== listKey || cur.fromIdx < 0) return;
        if (e?.target !== containerEl) return;
        e?.preventDefault?.();
        const nearest = findClosestItemByClientY(e?.clientY);
        const fromIdx = cur.fromIdx;
        if (!nearest) {
          resetDragReorderState();
          return;
        }
        const targetIdx = Number(nearest.getAttribute('data-drag-index'));
        const pos = nearest.getAttribute('data-drop-position') || resolveDropPosition(nearest, e, fromIdx, targetIdx);
        resetDragReorderState();
        const nextIdx = computeReorderTargetIndex(itemCount, fromIdx, targetIdx, pos);
        if (nextIdx >= 0 && typeof onReorder === 'function') {
          captureFlipSnapshot(containerEl, listKey, fromIdx, nextIdx, null);
          onReorder(fromIdx, nextIdx);
        }
      });
    }

    function attachSortableItem(opts = {}) {
      const {
        containerEl,
        itemEl,
        listKey,
        index,
        itemCount = 0,
        disabled = false,
        disabledReason = '',
        itemLabel = '',
        onReorder
      } = opts;
      if (!itemEl || !doc?.createElement) return;

      const isDisabled = Boolean(disabled || itemCount <= 1);
      const handle = doc.createElement('span');
      handle.className = 'ag-drag-handle';
      handle.setAttribute('data-drag-handle', `${listKey}:${index}`);
      handle.appendChild(createIconEl('grip'));

      if (itemEl.firstChild && typeof itemEl.insertBefore === 'function') {
        itemEl.insertBefore(handle, itemEl.firstChild);
      } else {
        itemEl.appendChild(handle);
      }

      if (isDisabled) {
        itemEl.draggable = false;
        itemEl.setAttribute('draggable', 'false');
        itemEl.setAttribute('data-drag-disabled', 'true');
        handle.setAttribute('aria-disabled', 'true');
        handle.setAttribute('tabindex', '-1');
        handle.setAttribute('title', disabledReason || '仅 1 项无需调整顺序');
        return;
      }

      const displayLbl = itemLabel ? String(itemLabel) : `第 ${index + 1} 项`;
      handle.setAttribute('role', 'button');
      handle.setAttribute('tabindex', '0');
      handle.setAttribute('aria-roledescription', '可拖动排序项');
      handle.setAttribute('aria-label', `拖动调整 ${displayLbl} 顺序（第 ${index + 1}/${itemCount} 项），可使用上下方向键移动`);
      handle.setAttribute('title', '拖动调整顺序（聚焦后可用 ↑ / ↓ 键）');

      handle.addEventListener('keydown', (e) => {
        const key = e?.key;
        if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
        e?.preventDefault?.();
        e?.stopPropagation?.();
        const delta = key === 'ArrowUp' ? -1 : 1;
        const nextIdx = index + delta;
        if (nextIdx < 0 || nextIdx >= itemCount) return;
        captureFlipSnapshot(containerEl, listKey, index, nextIdx, nextIdx);
        if (typeof onReorder === 'function') {
          onReorder(index, nextIdx);
        }
      });

      itemEl.draggable = true;
      itemEl.setAttribute('draggable', 'true');
      itemEl.setAttribute('data-drag-item', 'true');
      itemEl.setAttribute('data-drag-list', listKey);
      itemEl.setAttribute('data-drag-index', String(index));

      let blockNextDragFromInteractive = false;
      const markInteractivePointerDown = (e) => {
        const tgt = e?.target;
        if (!tgt || tgt === handle || (typeof handle.contains === 'function' && handle.contains(tgt))) {
          blockNextDragFromInteractive = false;
          return;
        }
        const hitInteractive = typeof tgt.closest === 'function'
          ? Boolean(tgt.closest('input, select, textarea, button, a, label'))
          : false;
        blockNextDragFromInteractive = hitInteractive;
      };
      const clearInteractivePointer = () => {
        blockNextDragFromInteractive = false;
      };
      itemEl.addEventListener('pointerdown', markInteractivePointerDown);
      itemEl.addEventListener('mousedown', markInteractivePointerDown);
      itemEl.addEventListener('pointerup', clearInteractivePointer);
      itemEl.addEventListener('mouseup', clearInteractivePointer);

      itemEl.addEventListener('dragstart', (e) => {
        if (blockNextDragFromInteractive) {
          blockNextDragFromInteractive = false;
          e?.preventDefault?.();
          return;
        }
        state.dragReorder = {
          listKey,
          fromIdx: index,
          containerEl,
          autoScrollRaf: 0,
          autoScrollEl: null,
          autoScrollSpeed: 0
        };
        containerEl?.setAttribute?.('data-drag-active', 'true');
        itemEl.setAttribute('data-dragging', 'true');
        try {
          if (e?.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData?.('text/plain', String(index));
          }
        } catch {}
      });

      itemEl.addEventListener('dragover', (e) => {
        const cur = state.dragReorder;
        if (!cur || cur.listKey !== listKey || cur.fromIdx < 0) return;
        updateDragAutoScroll(itemEl, e?.clientY);
        if (cur.fromIdx === index) {
          clearContainerDropIndicators(containerEl);
          return;
        }
        e?.preventDefault?.();
        try {
          if (e?.dataTransfer) e.dataTransfer.dropEffect = 'move';
        } catch {}
        const pos = resolveDropPosition(itemEl, e, cur.fromIdx, index);
        clearContainerDropIndicators(containerEl, itemEl);
        itemEl.setAttribute('data-drop-position', pos);
      });

      itemEl.addEventListener('dragleave', (e) => {
        const rel = e?.relatedTarget;
        if (rel && typeof itemEl.contains === 'function' && itemEl.contains(rel)) return;
        itemEl.removeAttribute('data-drop-position');
      });

      itemEl.addEventListener('drop', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        const cur = state.dragReorder;
        if (!cur || cur.listKey !== listKey) {
          return;
        }
        let fromIdx = cur.fromIdx;
        if (fromIdx < 0 && e?.dataTransfer?.getData) {
          const parsed = Number(e.dataTransfer.getData('text/plain'));
          if (Number.isInteger(parsed)) fromIdx = parsed;
        }
        const pos = itemEl.getAttribute('data-drop-position') || resolveDropPosition(itemEl, e, fromIdx, index);
        resetDragReorderState();

        const nextIdx = computeReorderTargetIndex(itemCount, fromIdx, index, pos);
        if (nextIdx >= 0 && typeof onReorder === 'function') {
          captureFlipSnapshot(containerEl, listKey, fromIdx, nextIdx, null);
          onReorder(fromIdx, nextIdx);
        }
      });

      itemEl.addEventListener('dragend', () => {
        blockNextDragFromInteractive = false;
        resetDragReorderState();
      });
    }

    function ensureBrowserOccluderEl() {
      if (!doc?.createElement) return null;
      if (browserOccluderEl && browserOccluderEl.parentElement) return browserOccluderEl;
      const existing = doc.getElementById ? doc.getElementById('agy-popover-browser-occluder') : null;
      if (existing && existing.remove) existing.remove();
      const el = doc.createElement('div');
      el.id = 'agy-popover-browser-occluder';
      el.setAttribute('data-browser-occluder', 'true');
      el.setAttribute('aria-hidden', 'true');
      setHidden(el, true);
      const mountTarget = doc.body || doc.documentElement;
      if (mountTarget?.appendChild) {
        mountTarget.appendChild(el);
      }
      browserOccluderEl = el;
      return el;
    }

    function getActiveElevatedPanelEl() {
      if (state.settingsMode === 'modal' && modalBackdropEl && !modalBackdropEl.hidden) {
        return { el: modalBackdropEl, fullViewport: true };
      }
      if (overflowMenuEl && !overflowMenuEl.hidden) {
        return { el: overflowMenuEl, fullViewport: false };
      }
      if (pluginAlertPopoverEl && !pluginAlertPopoverEl.hidden) {
        return { el: pluginAlertPopoverEl, fullViewport: false };
      }
      for (const p of state.popovers.values()) {
        if (p?.node && !p.node.hidden) {
          return { el: p.node, fullViewport: false };
        }
      }
      return null;
    }

    function hasExternalDialogOpen() {
      if (!doc?.querySelectorAll) return false;
      let dialogs = [];
      try {
        dialogs = Array.from(doc.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
      } catch {
        return false;
      }
      for (const d of dialogs) {
        if (!d || isHostOwnedElement(d)) continue;
        if (d.hidden || d.getAttribute?.('aria-hidden') === 'true') continue;
        if (d.closest?.('[hidden], [aria-hidden="true"]')) continue;
        if (typeof win?.getComputedStyle === 'function') {
          try {
            const cs = win.getComputedStyle(d);
            if (cs?.display === 'none' || cs?.visibility === 'hidden' || cs?.opacity === '0') continue;
          } catch {}
        }
        return true;
      }
      return false;
    }

    function applyBrowserOccluderRect(occluder, active) {
      if (!occluder?.style?.setProperty || !active) return;
      if (active.fullViewport) {
        occluder.style.setProperty('top', '0px');
        occluder.style.setProperty('left', '0px');
        occluder.style.setProperty('width', '100vw');
        occluder.style.setProperty('height', '100vh');
        return;
      }
      const panelEl = active.el;
      const rect = panelEl?.getBoundingClientRect ? panelEl.getBoundingClientRect() : null;
      if (rect && rect.width >= 2 && rect.height >= 2) {
        occluder.style.setProperty('top', `${Math.round(rect.top)}px`);
        occluder.style.setProperty('left', `${Math.round(rect.left)}px`);
        occluder.style.setProperty('width', `${Math.round(rect.width)}px`);
        occluder.style.setProperty('height', `${Math.round(rect.height)}px`);
        return;
      }
      const vw = Number(win?.innerWidth || doc?.documentElement?.clientWidth || 1280);
      const rawTop = parseFloat(panelEl?.style?.getPropertyValue?.('top') || '');
      const rawRight = parseFloat(panelEl?.style?.getPropertyValue?.('right') || '');
      const width = Number(panelEl?.offsetWidth) > 0 ? Number(panelEl.offsetWidth) : Math.min(408, Math.max(240, vw - 24));
      const height = Number(panelEl?.offsetHeight) > 0 ? Number(panelEl.offsetHeight) : 420;
      const top = Number.isFinite(rawTop) ? rawTop : 40;
      const right = Number.isFinite(rawRight) ? rawRight : 16;
      const left = Math.max(8, Math.round(vw - right - width));
      occluder.style.setProperty('top', `${Math.round(top)}px`);
      occluder.style.setProperty('left', `${left}px`);
      occluder.style.setProperty('width', `${Math.round(width)}px`);
      occluder.style.setProperty('height', `${Math.round(height)}px`);
    }

    function syncBrowserOccluder(scheduleRaf = true) {
      const active = state.disposed ? null : getActiveElevatedPanelEl();
      const wcv = win?.electronNative?.wcvBrowser;
      if (!active) {
        if (browserOccluderEl) {
          setHidden(browserOccluderEl, true);
        }
        if (occluderResizeObserver) {
          try { occluderResizeObserver.disconnect(); } catch {}
          occluderObservedEl = null;
        }
        if (portalOverlayClaimed) {
          portalOverlayClaimed = false;
          if (!hasExternalDialogOpen() && typeof wcv?.setPortalOverlayOpen === 'function') {
            try {
              Promise.resolve(wcv.setPortalOverlayOpen(false)).catch(() => {});
            } catch {}
          }
        }
        return;
      }

      const occluder = ensureBrowserOccluderEl();
      if (occluder) {
        applyBrowserOccluderRect(occluder, active);
        setHidden(occluder, false);
      }

      if (!active.fullViewport && typeof ResizeObserver === 'function' && active.el) {
        if (!occluderResizeObserver) {
          occluderResizeObserver = new ResizeObserver(() => {
            if (!state.disposed) syncBrowserOccluder(false);
          });
        }
        if (occluderObservedEl !== active.el) {
          try { occluderResizeObserver.disconnect(); } catch {}
          occluderObservedEl = active.el;
          try { occluderResizeObserver.observe(active.el); } catch {}
        }
      }

      if (scheduleRaf && !occluderRafPending && typeof requestAnimationFrame === 'function') {
        occluderRafPending = true;
        requestAnimationFrame(() => {
          occluderRafPending = false;
          if (!state.disposed) syncBrowserOccluder(false);
        });
      }

      if (!portalOverlayClaimed && typeof wcv?.setPortalOverlayOpen === 'function') {
        portalOverlayClaimed = true;
        try {
          Promise.resolve(wcv.setPortalOverlayOpen(true)).catch(() => {});
        } catch {}
      }
    }

    function syncExternalDialogLayering() {
      const open = hasExternalDialogOpen();
      hostEl?.setAttribute?.('data-under-dialog', open ? 'true' : 'false');
      if (open && state.settingsMode !== 'modal') {
        const hasPopoverOpen = (overflowMenuEl && !overflowMenuEl.hidden)
          || (pluginAlertPopoverEl && !pluginAlertPopoverEl.hidden)
          || Array.from(state.popovers.values()).some((p) => p?.node && !p.node.hidden);
        if (hasPopoverOpen) {
          closeAllPopovers('__settings__');
        }
      }
    }

    function updateElevationAttr() {
      const anyOpen = state.settingsMode === 'modal'
        || (overflowMenuEl && !overflowMenuEl.hidden)
        || (pluginAlertPopoverEl && !pluginAlertPopoverEl.hidden)
        || Array.from(state.popovers.values()).some((p) => p.node && !p.node.hidden);
      hostEl?.setAttribute?.('data-elevated', anyOpen ? 'true' : 'false');
      syncBrowserOccluder(true);
    }

    function syncOverflowPopoverOpenAttr() {
      if (!overflowBtnEl?.setAttribute) return;
      const hasOverflowPopoverOpen = Array.from(state.popovers.values()).some((p) => {
        if (!p?.node || p.node.hidden || !p.anchorId) return false;
        const exactKey = `${p.pluginId}:${p.anchorId}`;
        const anchorUnit = state.units.get(exactKey)
          || Array.from(state.units.values()).find((u) => u.id === p.anchorId);
        return Boolean(anchorUnit?.inOverflow);
      });
      overflowBtnEl.setAttribute('data-popover-open', hasOverflowPopoverOpen ? 'true' : 'false');
    }

    function detectAuxSidebarExpanded() {
      if (!doc?.querySelectorAll) return false;
      try {
        const panelHosts = Array.from(doc.querySelectorAll('[data-side-panel-open], [data-aux-pane-open]'))
          .filter((el) => el && !isHostOwnedElement(el));
        if (panelHosts.length > 0) {
          return panelHosts.some((el) => (
            el.getAttribute?.('data-side-panel-open') === 'true'
            || el.getAttribute?.('data-aux-pane-open') === 'true'
          ));
        }

        const vw = Number(win?.innerWidth || doc?.documentElement?.clientWidth || 0);
        const stripCandidates = Array.from(
          doc.querySelectorAll('[data-side-panel-strip="true"], .agy-aux-tab, [data-testid="side-panel-new-tab-button"]')
        ).filter((el) => el && !isHostOwnedElement(el));
        for (const el of stripCandidates) {
          if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') continue;
          if (el.closest?.('[hidden], [aria-hidden="true"]')) continue;
          if (typeof win?.getComputedStyle === 'function') {
            try {
              const cs = win.getComputedStyle(el);
              if (cs?.display === 'none' || cs?.visibility === 'hidden' || cs?.opacity === '0') continue;
            } catch {}
          }
          if (typeof el.getBoundingClientRect === 'function') {
            const rect = el.getBoundingClientRect();
            if (!rect || (rect.width <= 0 && rect.height <= 0)) continue;
            if (rect.top < -4 || rect.top > 64 || rect.right <= 0) continue;
            if (vw > 0 && rect.left >= vw - 10) continue;
          }
          return true;
        }
      } catch {}
      return false;
    }

    function findTopRightOverlayEl() {
      if (!doc?.querySelector) return null;
      try {
        const toggleBtn = doc.querySelector('[data-testid="toggle-aux-sidebar"]');
        if (toggleBtn && !isHostOwnedElement(toggleBtn)) {
          let cur = toggleBtn;
          for (let d = 0; cur && d < 4; d++) {
            const cls = String(cur.className || '');
            if (/\bright-0\b/.test(cls) && /\b(?:absolute|fixed)\b/.test(cls)) {
              return cur;
            }
            cur = cur.parentElement || null;
          }
        }
        const direct = doc.querySelector('div.absolute.right-0.z-50, div.absolute.right-0.top-0.z-50');
        if (direct && !isHostOwnedElement(direct)) return direct;
        if (toggleBtn?.parentElement && !isHostOwnedElement(toggleBtn.parentElement)) {
          return toggleBtn.parentElement;
        }
      } catch {}
      return null;
    }

    function measureRightChromeWidth(rightOverlayEl = null) {
      const target = rightOverlayEl || findTopRightOverlayEl();
      const vw = Number(win?.innerWidth || doc?.documentElement?.clientWidth || 0);
      if (target && typeof target.getBoundingClientRect === 'function') {
        try {
          const rect = target.getBoundingClientRect();
          if (rect && Number.isFinite(rect.width) && rect.width > 0) {
            const occupied = (vw > 0 && Number.isFinite(rect.left))
              ? Math.max(rect.width, vw - rect.left)
              : rect.width;
            return Math.max(36, Math.min(180, Math.round(occupied)));
          }
        } catch {}
      }
      return 36;
    }

    function syncAuxSidebarLayoutMetrics() {
      const rootEl = doc?.documentElement;
      const compactActive = Boolean(state.auxSidebarExpanded && state.units.size > 0 && hostEl);
      if (!compactActive) {
        hostEl?.style?.removeProperty?.('--ag-host-right');
        rootEl?.removeAttribute?.('data-agy-aux-compact');
        rootEl?.style?.removeProperty?.('--agy-aux-strip-pr');
        if (rightOverlayResizeObserver) {
          try { rightOverlayResizeObserver.disconnect(); } catch {}
          rightOverlayObservedEl = null;
        }
        return;
      }

      const rightOverlayEl = findTopRightOverlayEl();
      const rightChromeW = measureRightChromeWidth(rightOverlayEl);
      const compactRight = rightChromeW + 8;
      hostEl?.style?.setProperty?.('--ag-host-right', `${compactRight}px`);

      let hostW = 56;
      if (typeof hostEl?.getBoundingClientRect === 'function') {
        try {
          const rect = hostEl.getBoundingClientRect();
          if (rect && Number.isFinite(rect.width) && rect.width > 0) {
            hostW = Math.max(32, Math.min(160, Math.round(rect.width)));
          }
        } catch {}
      }
      const stripPr = Math.max(80, compactRight + hostW + 12);
      rootEl?.setAttribute?.('data-agy-aux-compact', 'true');
      rootEl?.style?.setProperty?.('--agy-aux-strip-pr', `${stripPr}px`);

      if (rightOverlayEl && typeof ResizeObserver === 'function') {
        if (!rightOverlayResizeObserver) {
          rightOverlayResizeObserver = new ResizeObserver(() => {
            if (!state.disposed && state.auxSidebarExpanded) {
              syncAuxSidebarLayoutMetrics();
            }
          });
        }
        if (rightOverlayObservedEl !== rightOverlayEl) {
          try { rightOverlayResizeObserver.disconnect(); } catch {}
          rightOverlayObservedEl = rightOverlayEl;
          try { rightOverlayResizeObserver.observe(rightOverlayEl); } catch {}
        }
      }
    }

    function computeHighestUnitRisk(units = []) {
      let hasWarn = false;
      for (const u of units) {
        if (!u) continue;
        if (u.tone === 'danger') return 'danger';
        if (u.tone === 'warn') hasWarn = true;
        if (Array.isArray(u.segments)) {
          for (const seg of u.segments) {
            if (seg?.tone === 'danger') return 'danger';
            if (seg?.tone === 'warn') hasWarn = true;
          }
        }
      }
      return hasWarn ? 'warn' : '';
    }

    function syncAuxSidebarState(opts = {}) {
      const prev = Boolean(state.auxSidebarExpanded);
      const next = detectAuxSidebarExpanded();
      state.auxSidebarExpanded = next;

      if (prev !== next || opts.forceRender) {
        if (overflowMenuEl && !overflowMenuEl.hidden) {
          toggleOverflowMenu(false);
        }
        renderUnits();
        if (activePopoverId) {
          const activePop = state.popovers.get(activePopoverId);
          if (activePop?.node && !activePop.node.hidden) {
            positionPopoverNearAnchor(activePop.node, activePop.pluginId, activePop.anchorId);
          }
        }
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (!state.disposed) syncAuxSidebarLayoutMetrics();
          });
        }
      } else if (next) {
        syncAuxSidebarLayoutMetrics();
      }
      return next;
    }

    function startAuxSidebarWatcher() {
      if (auxSidebarObserver || typeof MutationObserver !== 'function' || !doc?.documentElement) return;
      auxSidebarObserver = new MutationObserver(() => {
        if (!state.disposed) syncAuxSidebarState();
      });
      try {
        auxSidebarObserver.observe(doc.documentElement, {
          attributes: true,
          subtree: true,
          attributeFilter: ['data-side-panel-open', 'data-aux-pane-open']
        });
      } catch {}
    }

    function toggleOverflowMenu(force) {
      if (!overflowMenuEl) return false;
      const open = typeof force === 'boolean' ? force : Boolean(overflowMenuEl.hidden);
      if (open) {
        closeAllPopovers('__overflow__');
        positionPopoverNearAnchor(overflowMenuEl, null, null, overflowBtnEl);
        setHidden(overflowMenuEl, false);
        overflowBtnEl?.setAttribute?.('data-active', 'true');
        overflowBtnEl?.setAttribute?.('aria-expanded', 'true');
      } else {
        setHidden(overflowMenuEl, true);
        overflowBtnEl?.setAttribute?.('data-active', 'false');
        overflowBtnEl?.setAttribute?.('aria-expanded', 'false');
      }
      updateElevationAttr();
      return open;
    }

    function togglePluginAlertPopover(force) {
      if (!pluginAlertPopoverEl) return false;
      const open = typeof force === 'boolean' ? force : Boolean(pluginAlertPopoverEl.hidden);
      if (open) {
        renderPluginAlertCapsule();
        closeAllPopovers('__plugin_alert__');
        positionPopoverNearAnchor(pluginAlertPopoverEl, null, null, pluginAlertBtnEl);
        setHidden(pluginAlertPopoverEl, false);
        pluginAlertBtnEl?.setAttribute?.('data-active', 'true');
        pluginAlertBtnEl?.setAttribute?.('aria-expanded', 'true');
      } else {
        setHidden(pluginAlertPopoverEl, true);
        pluginAlertBtnEl?.setAttribute?.('data-active', 'false');
        pluginAlertBtnEl?.setAttribute?.('aria-expanded', 'false');
      }
      updateElevationAttr();
      return open;
    }

    function renderUnits() {
      if (!barEl) return;
      const unusableIssues = renderPluginAlertCapsule();
      const ordered = getOrderedUnits();
      const auxCompact = Boolean(state.auxSidebarExpanded && ordered.length > 0);
      hostEl?.setAttribute?.('data-aux-collapsed', auxCompact ? 'true' : 'false');
      barEl?.setAttribute?.('data-compact', auxCompact ? 'true' : 'false');

      let visibleUnits = [];
      let overflowUnits = [];
      if (auxCompact) {
        overflowUnits = ordered;
      } else {
        const pinned = [];
        const unpinned = [];
        for (const u of ordered) {
          if (isUnitPinned(u.pluginId, u.id)) pinned.push(u);
          else unpinned.push(u);
        }
        const maxVis = Math.max(1, Number(state.hostSettings.maxVisibleUnits) || DEFAULT_HOST_SETTINGS.maxVisibleUnits);
        visibleUnits = pinned.slice(0, maxVis);
        overflowUnits = [...pinned.slice(maxVis), ...unpinned];
      }

      const anchorRef = overflowBtnEl || settingsBtnEl || pluginAlertBtnEl;
      for (const u of visibleUnits) {
        u.inOverflow = false;
        if (!u.node) continue;
        if (anchorRef && typeof barEl.insertBefore === 'function') {
          barEl.insertBefore(u.node, anchorRef);
        } else {
          barEl.appendChild?.(u.node);
        }
      }

      if (overflowListEl) {
        if (auxCompact && pluginAlertBtnEl && unusableIssues.length > 0) {
          overflowListEl.appendChild?.(pluginAlertBtnEl);
        }
        for (const u of overflowUnits) {
          u.inOverflow = true;
          if (!u.node) continue;
          overflowListEl.appendChild?.(u.node);
        }
      }

      if (settingsBtnEl) {
        if (auxCompact && state.hostSettings.showTopbarEntry !== false && overflowListEl) {
          overflowListEl.appendChild?.(settingsBtnEl);
          setHidden(settingsBtnEl, false);
        } else {
          if (settingsBtnEl.parentElement !== barEl) {
            if (pluginAlertBtnEl && pluginAlertBtnEl.parentElement === barEl && typeof barEl.insertBefore === 'function') {
              barEl.insertBefore(settingsBtnEl, pluginAlertBtnEl);
            } else {
              barEl.appendChild?.(settingsBtnEl);
            }
          }
          syncTopbarEntryVisibility();
        }
      }

      if (pluginAlertBtnEl && (!auxCompact || unusableIssues.length === 0)) {
        if (pluginAlertBtnEl.parentElement !== barEl) {
          barEl.appendChild?.(pluginAlertBtnEl);
        }
      }

      if (overflowBtnEl) {
        if (auxCompact) {
          setHidden(overflowBtnEl, false);
          overflowBtnEl.setAttribute('data-compact-trigger', 'true');
          overflowBtnEl.setAttribute('data-overflow-count', String(overflowUnits.length));
          const compactTitle = '插件菜单（侧边栏展开时已自动收起）';
          overflowBtnEl.setAttribute('title', compactTitle);
          overflowBtnEl.setAttribute('aria-label', compactTitle);
          overflowBtnEl.setAttribute('aria-expanded', overflowMenuEl && !overflowMenuEl.hidden ? 'true' : 'false');
          clearElement(overflowBtnEl);
          let riskLevel = computeHighestUnitRisk(overflowUnits);
          if (unusableIssues.some((i) => i.tone === 'danger')) {
            riskLevel = 'danger';
          } else if (unusableIssues.length > 0 && !riskLevel) {
            riskLevel = 'warn';
          }
          if (riskLevel && doc?.createElement) {
            const riskDot = doc.createElement('span');
            riskDot.className = 'ag-unit-dot';
            riskDot.setAttribute('data-level', riskLevel);
            overflowBtnEl.appendChild(riskDot);
          }
          if (doc?.createElement) {
            const iconWrap = doc.createElement('span');
            iconWrap.className = 'ag-unit-icon';
            iconWrap.appendChild(createIconEl('menu'));
            overflowBtnEl.appendChild(iconWrap);
            const countSpan = doc.createElement('span');
            countSpan.className = 'ag-compact-count';
            countSpan.textContent = String(overflowUnits.length);
            overflowBtnEl.appendChild(countSpan);
            if (state.updateInfo?.hasUpdate && state.hostSettings.showTopbarEntry !== false) {
              const updDot = doc.createElement('span');
              updDot.className = 'ag-update-dot';
              overflowBtnEl.appendChild(updDot);
            }
          }
          if (overflowTitleEl) {
            overflowTitleEl.textContent = '顶栏插件';
          }
        } else {
          overflowBtnEl.removeAttribute?.('data-compact-trigger');
          overflowBtnEl.setAttribute('title', '更多顶栏插件');
          overflowBtnEl.setAttribute('aria-label', '更多顶栏插件');
          if (overflowTitleEl) {
            overflowTitleEl.textContent = '更多顶栏插件';
          }
          if (overflowUnits.length > 0) {
            setHidden(overflowBtnEl, false);
            overflowBtnEl.setAttribute('data-overflow-count', String(overflowUnits.length));
            overflowBtnEl.setAttribute('aria-expanded', overflowMenuEl && !overflowMenuEl.hidden ? 'true' : 'false');
            overflowBtnEl.textContent = `⋯ ${overflowUnits.length}`;
          } else {
            setHidden(overflowBtnEl, true);
            overflowBtnEl.removeAttribute?.('data-overflow-count');
            overflowBtnEl.setAttribute('aria-expanded', 'false');
            overflowBtnEl.textContent = '⋯';
            if (overflowMenuEl && !overflowMenuEl.hidden) {
              setHidden(overflowMenuEl, true);
              overflowBtnEl.setAttribute?.('data-active', 'false');
            }
          }
        }
      }

      const hasVisibleBarItem = visibleUnits.length > 0
        || Boolean(overflowBtnEl && !overflowBtnEl.hidden)
        || Boolean(!auxCompact && settingsBtnEl && !settingsBtnEl.hidden)
        || Boolean(!auxCompact && pluginAlertBtnEl && !pluginAlertBtnEl.hidden);
      setHidden(barEl, !hasVisibleBarItem);

      syncOverflowPopoverOpenAttr();
      syncAuxSidebarLayoutMetrics();
      updateElevationAttr();
    }

    function sanitizeUnitSegments(raw) {
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const out = [];
      for (const seg of raw.slice(0, 6)) {
        if (!seg || typeof seg !== 'object') continue;
        const iconSvg = sanitizeSvgMarkup(seg.iconSvg);
        const text = seg.text !== undefined && seg.text !== null ? String(seg.text) : '';
        if (!iconSvg && !text) continue;
        out.push({
          iconSvg,
          text,
          tone: typeof seg.tone === 'string' ? seg.tone : '',
          muted: Boolean(seg.muted),
          title: typeof seg.title === 'string' ? seg.title : ''
        });
      }
      return out.length > 0 ? out : null;
    }

    function renderUnitNodeContent(node, def) {
      if (!node || !doc?.createElement) return;
      const cleanSvg = sanitizeSvgMarkup(def.iconSvg);
      const labelText = def.label !== undefined ? String(def.label) : String(def.id || '');
      const hasBadge = def.badge !== undefined && def.badge !== null && String(def.badge) !== '';
      const segments = sanitizeUnitSegments(def.segments);

      if (segments) {
        clearElement(node);
        for (const seg of segments) {
          const segSpan = doc.createElement('span');
          segSpan.className = 'ag-unit-seg';
          if (seg.tone) segSpan.setAttribute('data-tone', seg.tone);
          if (seg.muted) segSpan.setAttribute('data-muted', 'true');
          if (seg.title) segSpan.setAttribute('title', seg.title);
          if (seg.iconSvg) {
            const iconSpan = doc.createElement('span');
            iconSpan.className = 'ag-unit-icon';
            iconSpan.innerHTML = seg.iconSvg;
            segSpan.appendChild(iconSpan);
          }
          if (seg.text) {
            const lblSpan = doc.createElement('span');
            lblSpan.className = 'ag-unit-label';
            lblSpan.textContent = seg.text;
            segSpan.appendChild(lblSpan);
          }
          node.appendChild(segSpan);
        }
        if (hasBadge) {
          const badgeSpan = doc.createElement('span');
          badgeSpan.className = 'ag-unit-badge';
          badgeSpan.textContent = String(def.badge);
          node.appendChild(badgeSpan);
        }
      } else if (!cleanSvg && !hasBadge) {
        node.textContent = labelText;
      } else {
        clearElement(node);
        if (cleanSvg) {
          const iconSpan = doc.createElement('span');
          iconSpan.className = 'ag-unit-icon';
          iconSpan.innerHTML = cleanSvg;
          node.appendChild(iconSpan);
        }
        if (labelText) {
          const lblSpan = doc.createElement('span');
          lblSpan.className = 'ag-unit-label';
          lblSpan.textContent = labelText;
          node.appendChild(lblSpan);
        }
        if (hasBadge) {
          const badgeSpan = doc.createElement('span');
          badgeSpan.className = 'ag-unit-badge';
          badgeSpan.textContent = String(def.badge);
          node.appendChild(badgeSpan);
        }
      }

      if (typeof def.title === 'string' && def.title) {
        node.setAttribute('title', def.title);
      } else if (def.title === '') {
        node.removeAttribute?.('title');
      }

      if (def.tone) {
        node.setAttribute('data-tone', String(def.tone));
        if (def.tone === 'warn' || def.tone === 'danger') {
          node.setAttribute('data-risk', String(def.tone));
        } else {
          node.removeAttribute?.('data-risk');
        }
      } else {
        node.removeAttribute?.('data-tone');
        node.removeAttribute?.('data-risk');
      }

      const customColor = normalizeHexColor(def.accentColor);
      if (customColor) {
        node.setAttribute('data-custom-color', customColor);
        node.style?.setProperty?.('--ag-unit-custom-color', customColor);
        node.style?.setProperty?.('--ag-unit-custom-border', hexToRgbaSafe(customColor, 0.5));
        node.style?.setProperty?.('--ag-unit-custom-bg', hexToRgbaSafe(customColor, 0.14));
      } else {
        node.removeAttribute?.('data-custom-color');
        node.style?.removeProperty?.('--ag-unit-custom-color');
        node.style?.removeProperty?.('--ag-unit-custom-border');
        node.style?.removeProperty?.('--ag-unit-custom-bg');
      }
    }

    function setAnchorButtonActive(pluginId, anchorId, active) {
      if (!anchorId) return;
      const exactKey = `${pluginId}:${anchorId}`;
      const unit = state.units.get(exactKey)
        || Array.from(state.units.values()).find((u) => u.id === anchorId);
      if (unit?.node?.setAttribute) {
        unit.node.setAttribute('data-active', active ? 'true' : 'false');
      }
      syncOverflowPopoverOpenAttr();
    }

    function normalizeAnchorRect(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const top = Number(raw.top);
      const left = Number(raw.left);
      const right = Number(raw.right);
      const bottom = Number(raw.bottom);
      const width = Number(raw.width);
      const height = Number(raw.height);
      if (![top, left, right, bottom, width, height].every(Number.isFinite)) return null;
      if (width <= 0 && height <= 0) return null;
      return { top, left, right, bottom, width, height };
    }

    function positionPopoverNearAnchor(panelNode, pluginId, anchorId, explicitAnchorEl = null, opts = {}) {
      if (!panelNode?.style?.setProperty) return;
      const anchorRect = normalizeAnchorRect(opts?.anchorRect);
      const placement = opts?.placement || (anchorRect ? 'auto' : 'bottom');

      let anchorEl = explicitAnchorEl;
      if (!anchorEl && !anchorRect && anchorId) {
        const exactKey = `${pluginId}:${anchorId}`;
        const unit = state.units.get(exactKey)
          || Array.from(state.units.values()).find((u) => u.id === anchorId);
        anchorEl = unit?.inOverflow ? overflowBtnEl : unit?.node;
      }
      const rect = anchorRect || (anchorEl?.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null);
      const vw = Number(win?.innerWidth || doc?.documentElement?.clientWidth || 0);
      const vh = Number(win?.innerHeight || doc?.documentElement?.clientHeight || 0);
      const panelW = panelNode.offsetWidth > 0 ? panelNode.offsetWidth : Math.min(400, Math.max(240, vw - 24));
      const openUpward = placement === 'top' || (placement === 'auto' && rect && vh > 0 && rect.top > vh / 2);

      if (openUpward) {
        panelNode.setAttribute?.('data-placement', 'top');
        panelNode.style.setProperty('top', 'auto');
        if (rect && vw > 0) {
          const rightPx = Math.max(12, Math.min(Math.max(12, vw - panelW - 12), Math.round(vw - rect.right)));
          panelNode.style.setProperty('right', `${rightPx}px`);
          panelNode.style.setProperty('left', 'auto');
          const bottomPx = vh > 0 ? Math.max(12, Math.min(Math.max(12, vh - 120), Math.round(vh - rect.top + 8))) : 64;
          panelNode.style.setProperty('bottom', `${bottomPx}px`);
          if (vh > 0 && rect.top > 120) {
            panelNode.style.setProperty('max-height', `${Math.max(220, Math.min(Math.round(rect.top - 24), Math.round(vh - 64)))}px`);
          } else {
            panelNode.style.removeProperty?.('max-height');
          }
        } else {
          panelNode.style.setProperty('bottom', '64px');
          panelNode.style.setProperty('right', '16px');
          panelNode.style.setProperty('left', 'auto');
          panelNode.style.removeProperty?.('max-height');
        }
        return;
      }

      panelNode.setAttribute?.('data-placement', 'bottom');
      panelNode.style.removeProperty?.('bottom');
      panelNode.style.removeProperty?.('max-height');
      if (rect && rect.width > 0 && vw > 0) {
        const rightPx = Math.max(12, Math.min(Math.max(12, vw - panelW - 12), Math.round(vw - rect.right)));
        const topPx = Math.max(36, Math.round(rect.bottom + 8));
        panelNode.style.setProperty('right', `${rightPx}px`);
        panelNode.style.setProperty('left', 'auto');
        panelNode.style.setProperty('top', `${topPx}px`);
      } else {
        panelNode.style.removeProperty?.('top');
        panelNode.style.removeProperty?.('right');
        panelNode.style.removeProperty?.('left');
      }
      if (!panelNode.hidden) {
        syncBrowserOccluder(true);
      }
    }

    function closeAllPopovers(exceptKey = null) {
      if (exceptKey !== '__overflow__' && overflowMenuEl && !overflowMenuEl.hidden) {
        setHidden(overflowMenuEl, true);
        overflowBtnEl?.setAttribute?.('data-active', 'false');
        overflowBtnEl?.setAttribute?.('aria-expanded', 'false');
      }
      if (exceptKey !== '__plugin_alert__' && pluginAlertPopoverEl && !pluginAlertPopoverEl.hidden) {
        setHidden(pluginAlertPopoverEl, true);
        pluginAlertBtnEl?.setAttribute?.('data-active', 'false');
        pluginAlertBtnEl?.setAttribute?.('aria-expanded', 'false');
      }
      if (exceptKey !== '__settings__' && state.settingsMode === 'modal') {
        setHidden(modalBackdropEl, true);
        state.settingsMode = 'closed';
        settingsBtnEl?.setAttribute?.('data-active', 'false');
      }
      for (const [k, p] of state.popovers.entries()) {
        if (k === exceptKey) continue;
        if (p.node && !p.node.hidden) {
          setHidden(p.node, true);
          setAnchorButtonActive(p.pluginId, p.anchorId, false);
          if (typeof p.onToggle === 'function') {
            try { p.onToggle(false); } catch {}
          }
          if (p.isIsolated) {
            dispatchToIsolated({ event: 'popover.toggle', pluginId: p.pluginId, popoverId: p.id, open: false });
          }
        }
      }
      if (!exceptKey || exceptKey === '__settings__' || exceptKey === '__overflow__') {
        activePopoverId = null;
      }
      updateElevationAttr();
    }

    function togglePopoverImpl(pluginId, popoverId, force, opts = {}) {
      const key = `${pluginId}:${popoverId}`;
      const p = state.popovers.get(key);
      if (!p || !p.node) return false;
      let resolvedForce = force;
      let resolvedOpts = opts && typeof opts === 'object' ? opts : {};
      if (force && typeof force === 'object') {
        resolvedOpts = force;
        resolvedForce = force.force;
      }
      const open = typeof resolvedForce === 'boolean' ? resolvedForce : Boolean(p.node.hidden);
      if (open) {
        closeAllPopovers(key);
        positionPopoverNearAnchor(p.node, pluginId, p.anchorId, null, resolvedOpts);
        if (p.bodyNode) p.bodyNode.scrollTop = 0;
        if (p.node) p.node.scrollTop = 0;
      }
      setHidden(p.node, !open);
      activePopoverId = open ? key : (activePopoverId === key ? null : activePopoverId);
      setAnchorButtonActive(pluginId, p.anchorId, open);
      updateElevationAttr();
      if (typeof p.onToggle === 'function') {
        try { p.onToggle(open); } catch {}
      }
      if (p.isIsolated) {
        dispatchToIsolated({ event: 'popover.toggle', pluginId, popoverId, open });
      }
      return open;
    }

    // 统一 Popover 包壳（左标题，右 ⚙ 直跳插件设置详情页 + ✕ 关闭，下为业务槽位）
    function registerPopoverImpl(pluginId, def = {}) {
      ensureDomShell();
      if (!def.id) throw new Error('registerPopover requires id');
      const key = `${pluginId}:${def.id}`;
      const prev = state.popovers.get(key);
      if (prev?.node?.remove) {
        prev.node.remove();
      }

      const panelNode = doc.createElement('section');
      panelNode.className = 'ag-panel';
      panelNode.setAttribute('data-agy-popover', key);
      panelNode.setAttribute('data-plugin-id', pluginId);
      panelNode.setAttribute('data-popover-id', def.id);
      setHidden(panelNode, true);

      const meta = state.pluginMeta.get(pluginId);
      const titleText = pickLocaleText(def.title, meta?.displayName || def.id || pluginId);

      const head = doc.createElement('div');
      head.className = 'ag-panel-head';

      const titleWrap = doc.createElement('div');
      titleWrap.className = 'ag-panel-title-wrap';
      const titleEl = doc.createElement('span');
      titleEl.className = 'ag-panel-title';
      titleEl.textContent = titleText;
      titleWrap.appendChild(titleEl);

      const actions = doc.createElement('div');
      actions.className = 'ag-panel-actions';

      const gearBtn = doc.createElement('button');
      gearBtn.type = 'button';
      gearBtn.className = 'ag-icon-btn ag-popover-settings-btn';
      gearBtn.setAttribute('data-popover-settings', pluginId);
      gearBtn.setAttribute('title', '插件设置');
      gearBtn.setAttribute('aria-label', '插件设置');
      gearBtn.appendChild(createIconEl('settings'));
      gearBtn.addEventListener('click', () => {
        closeAllPopovers(null);
        void openSettings({ tab: 'plugins', pluginId });
      });

      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ag-icon-btn ag-popover-close-btn';
      closeBtn.setAttribute('data-popover-close', key);
      closeBtn.setAttribute('title', '关闭');
      closeBtn.setAttribute('aria-label', '关闭');
      closeBtn.appendChild(createIconEl('close'));
      closeBtn.addEventListener('click', () => {
        togglePopoverImpl(pluginId, def.id, false);
      });

      actions.appendChild(gearBtn);
      actions.appendChild(closeBtn);
      head.appendChild(titleWrap);
      head.appendChild(actions);
      panelNode.appendChild(head);

      const bodyNode = doc.createElement('div');
      bodyNode.className = 'ag-panel-body';
      bodyNode.setAttribute('data-agy-slot', `popover:${key}`);
      panelNode.appendChild(bodyNode);

      shadow?.appendChild?.(panelNode);

      if (typeof def.render === 'function') {
        def.render(bodyNode);
      }

      state.popovers.set(key, {
        key,
        pluginId,
        id: def.id,
        anchorId: def.anchorId || null,
        title: titleText,
        node: panelNode,
        bodyNode,
        onToggle: def.onToggle,
        isIsolated: Boolean(def.isIsolated)
      });

      return {
        key,
        slotSelector: `[data-agy-slot="popover:${key}"]`,
        panelSelector: `[data-agy-popover="${key}"]`,
        toggle(force, opts) {
          return togglePopoverImpl(pluginId, def.id, force, opts);
        },
        dispose() {
          disposePopoverImpl(pluginId, def.id);
        }
      };
    }

    function disposePopoverImpl(pluginId, popoverId) {
      const key = `${pluginId}:${popoverId}`;
      const existing = state.popovers.get(key);
      state.popovers.delete(key);
      if (existing) {
        setAnchorButtonActive(pluginId, existing.anchorId, false);
        if (activePopoverId === key) activePopoverId = null;
        if (existing.node?.remove) existing.node.remove();
      }
      updateElevationAttr();
    }

    function registerUnitImpl(pluginId, def = {}) {
      ensureDomShell();
      if (!def.id) throw new Error('registerUnit requires id');
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
        node.setAttribute('data-agy-slot', `unit:${key}`);
        node.setAttribute('data-plugin-id', pluginId);
        node.setAttribute('data-unit-id', def.id);
        renderUnitNodeContent(node, def);
        if (typeof def.onClick === 'function') node.addEventListener('click', def.onClick);
        if (typeof def.render === 'function') def.render(node);
      } else if (node?.setAttribute) {
        node.setAttribute('data-agy-slot', `unit:${key}`);
      }

      if (node && typeof node.addEventListener === 'function' && !boundOverflowUnitNodes.has(node)) {
        boundOverflowUnitNodes.add(node);
        node.addEventListener('click', () => {
          const unitKey = node.getAttribute?.('data-plugin-id') && node.getAttribute?.('data-unit-id')
            ? `${node.getAttribute('data-plugin-id')}:${node.getAttribute('data-unit-id')}`
            : key;
          const rec = state.units.get(unitKey) || state.units.get(key);
          if (rec?.inOverflow && overflowMenuEl && !overflowMenuEl.hidden) {
            toggleOverflowMenu(false);
          }
        });
      }

      state.units.set(key, {
        key,
        pluginId,
        id: def.id,
        order: def.order ?? 50,
        label: def.label !== undefined ? def.label : def.id,
        iconSvg: def.iconSvg || '',
        segments: Array.isArray(def.segments) ? def.segments : null,
        title: typeof def.title === 'string' ? def.title : undefined,
        badge: def.badge,
        tone: def.tone || '',
        accentColor: def.accentColor || '',
        node,
        inOverflow: false,
        onClick: def.onClick
      });
      state.topbarSuppressedPlugins.delete(pluginId);
      renderUnits();
      if (state.settingsMode !== 'closed') renderSettingsBody();
      return {
        key,
        slotSelector: `[data-agy-slot="unit:${key}"]`,
        dispose() {
          disposeUnitImpl(pluginId, def.id);
        }
      };
    }

    function setTopbarAvailableImpl(pluginId, available) {
      if (!pluginId) return;
      if (available) state.topbarSuppressedPlugins.delete(pluginId);
      else state.topbarSuppressedPlugins.add(pluginId);
      if (state.settingsMode !== 'closed') renderSettingsBody();
    }

    function updateUnitImpl(pluginId, unitId, patch = {}) {
      const key = `${pluginId}:${unitId}`;
      const existing = state.units.get(key);
      if (!existing) return { ok: false, error: `UNIT_NOT_FOUND: ${key}` };
      const shouldRerenderContent = (
        patch.label !== undefined ||
        patch.iconSvg !== undefined ||
        patch.segments !== undefined ||
        patch.title !== undefined ||
        patch.badge !== undefined ||
        patch.tone !== undefined ||
        patch.accentColor !== undefined
      );
      if (patch.label !== undefined) existing.label = patch.label;
      if (patch.iconSvg !== undefined) existing.iconSvg = patch.iconSvg;
      if (patch.segments !== undefined) existing.segments = Array.isArray(patch.segments) ? patch.segments : null;
      if (patch.title !== undefined) existing.title = patch.title;
      if (patch.badge !== undefined) existing.badge = patch.badge;
      if (patch.tone !== undefined) existing.tone = patch.tone;
      if (patch.accentColor !== undefined) existing.accentColor = patch.accentColor || '';
      if (patch.order !== undefined) existing.order = patch.order;
      if (shouldRerenderContent && existing.node) {
        renderUnitNodeContent(existing.node, existing);
      }
      renderUnits();
      return { ok: true, slotSelector: `[data-agy-slot="unit:${key}"]` };
    }

    function disposeUnitImpl(pluginId, unitId) {
      const key = `${pluginId}:${unitId}`;
      const existing = state.units.get(key);
      state.units.delete(key);
      if (existing?.node?.remove) existing.node.remove();
      if (!Array.from(state.units.values()).some((u) => u.pluginId === pluginId)) {
        state.topbarSuppressedPlugins.add(pluginId);
      }
      renderUnits();
      if (state.settingsMode !== 'closed') renderSettingsBody();
    }

    // 托管插件样式注入与回收
    function injectPluginStyle(pluginId, cssText, opts = {}) {
      const scope = opts.scope === 'shadow' ? 'shadow' : 'document';
      const styleId = String(opts.id || opts.styleId || `style-${++styleSeq}`);
      const key = `${pluginId}:${styleId}`;
      let rec = state.pluginStyles.get(key);

      if (scope === 'shadow') ensureDomShell();
      const targetRoot = scope === 'shadow'
        ? shadow
        : (doc?.head || doc?.documentElement || doc?.body);

      if (!targetRoot || !doc?.createElement) {
        return { ok: false, styleId, scope, dispose() {} };
      }

      if (rec && rec.node) {
        rec.node.textContent = String(cssText || '');
        if (rec.scope !== scope) {
          rec.node.remove?.();
          rec.node.setAttribute('data-agy-style-scope', scope);
          targetRoot.appendChild?.(rec.node);
          rec.scope = scope;
        }
      } else {
        const styleEl = doc.createElement('style');
        styleEl.setAttribute('data-agy-style', pluginId);
        styleEl.setAttribute('data-agy-style-id', styleId);
        styleEl.setAttribute('data-agy-style-scope', scope);
        styleEl.textContent = String(cssText || '');
        targetRoot.appendChild?.(styleEl);
        rec = { pluginId, styleId, scope, node: styleEl };
        state.pluginStyles.set(key, rec);
      }

      return {
        ok: true,
        styleId,
        scope,
        dispose() {
          disposePluginStyle(pluginId, styleId);
        }
      };
    }

    function disposePluginStyle(pluginId, styleId = null) {
      if (styleId) {
        const key = `${pluginId}:${styleId}`;
        const rec = state.pluginStyles.get(key);
        if (rec) {
          state.pluginStyles.delete(key);
          rec.node?.remove?.();
        }
        return;
      }
      for (const [k, rec] of Array.from(state.pluginStyles.entries())) {
        if (rec.pluginId === pluginId) {
          state.pluginStyles.delete(k);
          rec.node?.remove?.();
        }
      }
    }

    // Surfaces 插槽注册表（解耦跨插件 DOM 挂载）
    function findSurfaceElement(surfaceName, selector = null) {
      const targetSel = selector || `[data-agy-surface="${surfaceName}"]`;
      if (doc?.querySelector) {
        try {
          const found = doc.querySelector(targetSel);
          if (found) return found;
        } catch {}
      }
      if (shadow?.querySelector) {
        try {
          const found = shadow.querySelector(targetSel);
          if (found) return found;
        } catch {}
      }
      return null;
    }

    function provideSurfaceImpl(pluginId, surfaceName, el = null, selector = null) {
      if (!surfaceName) throw new Error('surfaceName is required');
      const sel = selector || `[data-agy-surface="${surfaceName}"]`;
      let targetEl = el;
      if (targetEl && typeof targetEl.setAttribute === 'function') {
        targetEl.setAttribute('data-agy-surface', surfaceName);
        targetEl.setAttribute('data-agy-surface-owner', pluginId);
      } else if (!targetEl) {
        targetEl = findSurfaceElement(surfaceName, sel);
      }

      const rec = { pluginId, surfaceName, el: targetEl || null, selector: sel };
      state.surfaces.set(surfaceName, rec);

      const subs = state.surfaceSubs.get(surfaceName);
      if (subs) {
        for (const sub of Array.from(subs)) {
          if (sub.isIsolated) {
            dispatchToIsolated({
              event: 'surface.changed',
              pluginId: sub.pluginId,
              surfaceName,
              available: true,
              selector: sel
            });
          } else if (typeof sub.fn === 'function') {
            try { sub.fn(rec.el || findSurfaceElement(surfaceName, sel), { available: true, surfaceName, ownerPluginId: pluginId }); } catch {}
          }
        }
      }
      return { ok: true, surfaceName, available: true, selector: sel };
    }

    function revokeSurfaceImpl(pluginId, surfaceName) {
      const rec = state.surfaces.get(surfaceName);
      if (!rec) return { ok: true, surfaceName, available: false };
      if (pluginId && rec.pluginId !== pluginId) return { ok: false, error: 'NOT_SURFACE_OWNER' };
      state.surfaces.delete(surfaceName);
      if (rec.el && rec.el.getAttribute?.('data-agy-surface') === surfaceName) {
        rec.el.removeAttribute?.('data-agy-surface');
        rec.el.removeAttribute?.('data-agy-surface-owner');
      }
      const subs = state.surfaceSubs.get(surfaceName);
      if (subs) {
        for (const sub of Array.from(subs)) {
          if (sub.isIsolated) {
            dispatchToIsolated({
              event: 'surface.changed',
              pluginId: sub.pluginId,
              surfaceName,
              available: false
            });
          } else if (typeof sub.fn === 'function') {
            try { sub.fn(null, { available: false, surfaceName }); } catch {}
          }
        }
      }
      return { ok: true, surfaceName, available: false };
    }

    // Host Bridge 请求工具
    async function hostBridgePost(routePath, payload = {}) {
      if (!hasBridgeAvailable()) {
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

    // 统一插件设置读写与双端广播
    function getPluginSettings(pluginId) {
      const meta = state.pluginMeta.get(pluginId);
      if (!meta) return {};
      return mergeSchemaDefaults(meta.settingsSchema, meta.settingsValues || {});
    }

    function validateFieldLocally(field, value) {
      if (!field) return { ok: true, value };
      if (field.type === 'boolean') {
        if (typeof value !== 'boolean') return { ok: false, error: `${field.key} 须为布尔值` };
        return { ok: true, value };
      }
      if (field.type === 'number') {
        const num = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(num)) return { ok: false, error: '请输入有效数字' };
        if (typeof field.min === 'number' && num < field.min) {
          return { ok: false, error: `数值不能小于 ${field.min}` };
        }
        if (typeof field.max === 'number' && num > field.max) {
          return { ok: false, error: `数值不能大于 ${field.max}` };
        }
        return { ok: true, value: num };
      }
      if (field.type === 'enum') {
        const allowed = (field.options || []).map((o) => (isPlainObject(o) ? o.value : o));
        if (field.optionsCommand) {
          if (allowed.includes(value) || typeof value === 'string') {
            return { ok: true, value };
          }
          return { ok: false, error: `无效选项：${String(value)}` };
        }
        if (allowed.length > 0 && !allowed.includes(value)) {
          return { ok: false, error: `无效选项：${String(value)}` };
        }
        return { ok: true, value };
      }
      if (field.type === 'string') {
        if (typeof value !== 'string') return { ok: false, error: `${field.key} 须为字符串` };
        return { ok: true, value };
      }
      if (field.type === 'list') {
        if (!Array.isArray(value)) return { ok: false, error: `${field.key} 须为列表` };
        if (typeof field.maxItems === 'number' && value.length > field.maxItems) {
          return { ok: false, error: `最多允许 ${field.maxItems} 项` };
        }
        return { ok: true, value: value.map((v) => String(v)) };
      }
      return { ok: true, value };
    }

    function notifyPluginSettingsChanged(pluginId, values = {}, changedKeys = null, secretState = null) {
      if (!pluginId) return { ok: false };
      const prevMeta = state.pluginMeta.get(pluginId);
      const schema = prevMeta?.settingsSchema || null;
      const keys = Array.isArray(changedKeys) ? [...changedKeys] : Object.keys(values || {});
      const clearedSecretKeys = new Set();
      if (!secretState && schema && Array.isArray(schema.fields)) {
        for (const f of schema.fields) {
          if (f?.writeOnly === true && keys.includes(f.key) && values[f.key] === '') {
            clearedSecretKeys.add(f.key);
          }
        }
      }

      const updatedMeta = upsertPluginMeta({
        ...(prevMeta || { id: pluginId }),
        id: pluginId,
        settingsValues: mergeSchemaDefaults(schema, values),
        ...(isPlainObject(secretState) ? { settingsSecretState: secretState } : {}),
        _clearedSecretKeys: clearedSecretKeys
      });
      const safeValues = updatedMeta?.settingsValues || mergeSchemaDefaults(schema, values);

      const localSubs = state.settingsSubs.get(pluginId);
      if (localSubs) {
        for (const fn of Array.from(localSubs)) {
          try { fn({ ...safeValues }, [...keys]); } catch {}
        }
      }

      dispatchToIsolated({
        event: 'settings.changed',
        pluginId,
        values: { ...safeValues },
        changedKeys: [...keys]
      });

      if (state.settingsMode !== 'closed' && state.activeSettingsTab === 'plugins' && state.selectedPluginId === pluginId) {
        renderSettingsBody();
      }
      return { ok: true, pluginId, values: { ...safeValues }, changedKeys: keys };
    }

    async function updatePluginSettings(pluginId, patch = {}) {
      if (!pluginId || !isPlainObject(patch)) {
        return { ok: false, errors: ['INVALID_SETTINGS_PATCH'] };
      }
      const meta = state.pluginMeta.get(pluginId);
      const schema = meta?.settingsSchema || null;
      const sanitizedPatch = {};
      const localErrors = [];

      if (schema && Array.isArray(schema.fields)) {
        const fieldMap = new Map(schema.fields.map((f) => [f.key, f]));
        for (const [k, v] of Object.entries(patch)) {
          const field = fieldMap.get(k);
          if (field) {
            const check = validateFieldLocally(field, v);
            if (!check.ok) {
              localErrors.push(check.error);
              continue;
            }
            sanitizedPatch[k] = check.value;
          } else {
            sanitizedPatch[k] = v;
          }
        }
      } else {
        Object.assign(sanitizedPatch, patch);
      }

      if (localErrors.length > 0) {
        return { ok: false, errors: localErrors };
      }

      const prevValues = getPluginSettings(pluginId);
      const candidateValues = { ...prevValues, ...sanitizedPatch };
      const changedKeys = Object.keys(sanitizedPatch);

      if (hasBridgeAvailable()) {
        try {
          const res = await hostBridgePost('/host/settings', {
            pluginId,
            action: 'update',
            values: sanitizedPatch
          });
          if (res?.ok === false) {
            return { ok: false, errors: res.errors || [res.error || 'SETTINGS_UPDATE_FAILED'] };
          }
          const finalValues = isPlainObject(res?.values) ? res.values : candidateValues;
          const finalKeys = Array.isArray(res?.changedKeys) ? res.changedKeys : changedKeys;
          const resSecretState = isPlainObject(res?.secretState) ? res.secretState : null;
          if (!(Number(res?.rendererNotified) > 0)) {
            notifyPluginSettingsChanged(pluginId, finalValues, finalKeys, resSecretState);
          } else {
            const prevMeta = state.pluginMeta.get(pluginId);
            upsertPluginMeta({
              ...(prevMeta || { id: pluginId }),
              id: pluginId,
              settingsValues: mergeSchemaDefaults(prevMeta?.settingsSchema || null, finalValues),
              ...(resSecretState ? { settingsSecretState: resSecretState } : {})
            });
          }
          return { ok: true, values: finalValues, secretState: resSecretState || undefined, changedKeys: finalKeys };
        } catch (err) {
          return { ok: false, errors: [err?.message || String(err)] };
        }
      }

      const nextSecretState = isPlainObject(meta?.settingsSecretState) ? { ...meta.settingsSecretState } : {};
      if (schema && Array.isArray(schema.fields)) {
        for (const f of schema.fields) {
          if (f?.writeOnly === true && Object.prototype.hasOwnProperty.call(sanitizedPatch, f.key)) {
            nextSecretState[f.key] = Boolean(String(sanitizedPatch[f.key] || '').trim());
          }
        }
      }
      const notified = notifyPluginSettingsChanged(pluginId, candidateValues, changedKeys, nextSecretState);
      return { ok: true, values: notified.values || candidateValues, secretState: nextSecretState, changedKeys };
    }

    async function executeCommand(pluginId, commandId, args = []) {
      const cmdId = String(commandId || '').trim();
      if (!cmdId) throw new Error('commandId is required');
      const cmdArgs = Array.isArray(args) ? args : [];
      if (hasBridgeAvailable()) {
        return await hostBridgePost('/host/commands/run', {
          pluginId: pluginId || undefined,
          commandId: cmdId,
          args: cmdArgs
        });
      }
      const local = state.localCommands.get(cmdId);
      if (local && typeof local.handler === 'function') {
        const result = await local.handler(...cmdArgs);
        return { ok: true, result };
      }
      throw new Error(`COMMAND_UNAVAILABLE: ${cmdId}`);
    }

    // 锚点解析与共享 MutationObserver 中心
    function resolveAnchorSelectors(anchorName, registryOverride = null) {
      const reg = registryOverride || state.anchorsRegistry;
      const def = reg?.anchors?.[anchorName];
      if (!def || !Array.isArray(def.versions) || !def.versions.length) return [];
      return def.versions[0].selectors || [];
    }

    function isHostOwnedElement(el) {
      if (!el) return false;
      let cur = el;
      while (cur) {
        if (
          cur === hostEl
          || cur === safeModePillHostEl
          || cur === browserOccluderEl
          || cur === modalDialogEl
          || cur === modalBackdropEl
          || cur === nativeState.mountHostEl
        ) return true;
        if (
          cur.id === HOST_ELEMENT_ID
          || cur.id === SAFE_MODE_PILL_HOST_ID
          || cur.id === 'agy-popover-browser-occluder'
          || cur.id === NATIVE_SETTINGS_MOUNT_ID
          || cur.id === 'agy-settings-modal'
        ) return true;
        cur = cur.parentElement || null;
      }
      return false;
    }

    function getActiveHealthAnchorsRegistry() {
      if (state.healthAnchors?.anchors && Object.keys(state.healthAnchors.anchors).length > 0) {
        return state.healthAnchors;
      }
      return state.anchorsRegistry || { anchors: {} };
    }

    function probeHealthAnchors(registryOverride = null) {
      const reg = registryOverride || getActiveHealthAnchorsRegistry();
      const names = Object.keys(reg.anchors || {});
      const items = names.map((name) => {
        const selectors = resolveAnchorSelectors(name, reg);
        let matchedSelector = null;
        if (doc && typeof doc.querySelectorAll === 'function') {
          for (const sel of selectors) {
            try {
              const list = Array.from(doc.querySelectorAll(sel));
              if (list.some((el) => el && !isHostOwnedElement(el))) {
                matchedSelector = sel;
                break;
              }
            } catch {}
          }
        } else if (doc && typeof doc.querySelector === 'function') {
          for (const sel of selectors) {
            try {
              const el = doc.querySelector(sel);
              if (el && !isHostOwnedElement(el)) {
                matchedSelector = sel;
                break;
              }
            } catch {}
          }
        }
        return {
          name,
          status: matchedSelector ? 'ok' : 'missing',
          matchedSelector
        };
      });
      const healthyCount = items.filter((item) => item.status === 'ok').length;
      return {
        total: items.length,
        healthyCount,
        missingCount: items.length - healthyCount,
        items
      };
    }

    function hasNativeSettingsMarkerInDom() {
      if (!doc) return false;
      if (typeof doc.querySelectorAll === 'function') {
        try {
          const list = Array.from(doc.querySelectorAll(
            '[data-testid="settings-dialog"],[data-testid="settings-sidebar"],[data-testid="settings-content"],[role="dialog"][aria-label*="Settings"],[role="dialog"][aria-label*="设置"]'
          ));
          if (list.some((el) => el && !isHostOwnedElement(el))) return true;
        } catch {}
      } else if (typeof doc.querySelector === 'function') {
        try {
          const marker = doc.querySelector(
            '[data-testid="settings-dialog"],[data-testid="settings-sidebar"],[data-testid="settings-content"],[role="dialog"][aria-label*="Settings"],[role="dialog"][aria-label*="设置"]'
          );
          if (marker && !isHostOwnedElement(marker)) return true;
        } catch {}
      }
      return Boolean(queryAnchor('settings.nav') || queryAnchor('settings.content'));
    }

    function isSettingsExpectedInDom() {
      if (state.settingsMode === 'native') return true;
      if (state.settingsInjectionAttemptFailed && state.hostSettings.injectNativeSettings !== false) return true;
      return hasNativeSettingsMarkerInDom();
    }

    function collectRuntimePluginStates() {
      const ids = Array.from(new Set([
        ...state.pluginInstances.keys(),
        ...state.isolatedPlugins.keys(),
        ...state.rendererErrors.keys(),
        ...state.pluginMeta.keys()
      ])).sort();
      const list = [];
      for (const id of ids) {
        const meta = state.pluginMeta.get(id);
        const err = state.rendererErrors.get(id);
        if (state.pluginInstances.has(id)) {
          list.push({
            id,
            rendererMounted: true,
            lastError: err ? err.message : null,
            lastErrorStack: err ? (err.stack || null) : null
          });
        } else if (err) {
          list.push({
            id,
            rendererMounted: false,
            lastError: err.message,
            lastErrorStack: err.stack || null
          });
        } else if (state.isolatedPlugins.has(id)) {
          list.push({
            id,
            rendererMounted: true,
            lastError: null,
            lastErrorStack: null
          });
        } else if (meta && meta.enabled === false) {
          list.push({
            id,
            rendererMounted: false,
            lastError: null,
            lastErrorStack: null
          });
        } else if (meta && (meta.health?.lastErrorStage === 'renderer' || meta.health?.lastError)) {
          list.push({
            id,
            rendererMounted: false,
            lastError: meta.health.lastError || null,
            lastErrorStack: meta.health.lastErrorStack || null
          });
        } else if (meta && meta.world === 'main' && meta.enabled !== false) {
          list.push({
            id,
            rendererMounted: false,
            lastError: null,
            lastErrorStack: null
          });
        }
      }
      return list;
    }

    function buildRuntimeHealthReport() {
      const probe = probeHealthAnchors(getActiveHealthAnchorsRegistry());
      return {
        targetId: state.healthTargetId,
        reportId: state.healthReportId,
        settingsExpected: isSettingsExpectedInDom(),
        anchors: { items: probe.items },
        plugins: collectRuntimePluginStates()
      };
    }

    function canReportRuntimeHealth() {
      const reg = getActiveHealthAnchorsRegistry();
      return Boolean(
        !state.disposed
        && hasBridgeAvailable()
        && state.healthTargetId
        && state.healthReportId
        && reg?.anchors
        && Object.keys(reg.anchors).length > 0
      );
    }

    async function reportRuntimeHealth({ force = false } = {}) {
      if (!canReportRuntimeHealth()) {
        return { ok: false, skipped: true };
      }
      const payload = buildRuntimeHealthReport();
      const sig = JSON.stringify({
        settingsExpected: payload.settingsExpected,
        items: payload.anchors.items,
        plugins: payload.plugins
      });
      const now = Date.now();
      const refreshThreshold = Math.max(40, Math.floor(state.healthReportIntervalMs * 0.75));
      if (!force && sig === state.lastRuntimeHealthSig && (now - state.lastRuntimeHealthSentAt < refreshThreshold)) {
        return { ok: true, deduped: true };
      }
      if (runtimeHealthInFlight) {
        try { await runtimeHealthInFlight; } catch {}
      }
      const run = (async () => {
        try {
          const res = await hostBridgePost('/host/health/runtime-report', payload);
          state.lastRuntimeHealthSig = sig;
          state.lastRuntimeHealthSentAt = Date.now();
          return res;
        } catch (err) {
          return { ok: false, error: err?.message || String(err) };
        } finally {
          if (runtimeHealthInFlight === run) {
            runtimeHealthInFlight = null;
          }
        }
      })();
      runtimeHealthInFlight = run;
      return await run;
    }

    function scheduleRuntimeHealthReport({ immediate = false } = {}) {
      if (!canReportRuntimeHealth()) return;
      if (immediate) {
        if (runtimeHealthDebounceTimer) {
          clearTimeout(runtimeHealthDebounceTimer);
          runtimeHealthDebounceTimer = null;
        }
        void reportRuntimeHealth();
        return;
      }
      if (runtimeHealthDebounceTimer) return;
      runtimeHealthDebounceTimer = setTimeout(() => {
        runtimeHealthDebounceTimer = null;
        if (!state.disposed) {
          void reportRuntimeHealth();
        }
      }, 25);
      runtimeHealthDebounceTimer.unref?.();
    }

    function startRuntimeHealthReporting() {
      if (runtimeHealthTimer || !canReportRuntimeHealth()) return;
      const initialTid = setTimeout(() => {
        hostRetryTimers.delete(initialTid);
        if (!state.disposed) {
          void reportRuntimeHealth({ force: true });
        }
      }, 0);
      initialTid.unref?.();
      hostRetryTimers.add(initialTid);
      runtimeHealthTimer = setInterval(() => {
        if (!state.disposed) {
          void reportRuntimeHealth({ force: true });
        }
      }, state.healthReportIntervalMs);
      runtimeHealthTimer.unref?.();
    }

    async function fetchHostHealth({ reportFirst = true } = {}) {
      if (!hasBridgeAvailable()) {
        return state.hostHealth;
      }
      if (hostHealthInFlight) {
        return await hostHealthInFlight;
      }
      state.hostHealthLoading = true;
      state.hostHealthError = '';
      if (state.settingsMode !== 'closed' && (state.safeModeViewOpen || state.diagnosticsExpanded)) {
        renderSettingsBody();
      }
      const run = (async () => {
        try {
          if (reportFirst && canReportRuntimeHealth()) {
            await reportRuntimeHealth({ force: true });
          }
          const res = await hostBridgePost('/host/health', {});
          if (res && res.ok && res.daemon && res.antigravity && res.cdp && res.injection && res.fault) {
            state.hostHealth = res;
            state.hostHealthError = '';
          } else if (res?.hostHealth) {
            state.hostHealth = res.hostHealth;
            state.hostHealthError = '';
          } else {
            state.hostHealthError = res?.error || '无效的 hostHealth 响应';
          }
          return state.hostHealth;
        } catch (err) {
          state.hostHealthError = err?.message || String(err);
          return state.hostHealth;
        } finally {
          state.hostHealthLoading = false;
          if (hostHealthInFlight === run) hostHealthInFlight = null;
          if (!state.disposed) {
            evaluateSafeMode();
            if (state.settingsMode !== 'closed' && (state.safeModeViewOpen || state.diagnosticsExpanded)) {
              renderSettingsBody();
            }
          }
        }
      })();
      hostHealthInFlight = run;
      return await run;
    }

    function queryAnchor(anchorName, opts = {}) {
      if (!doc || typeof doc.querySelector !== 'function') return null;
      const selectors = resolveAnchorSelectors(anchorName);
      const container = opts.within || null;
      for (const sel of selectors) {
        try {
          if (container && typeof doc.querySelectorAll === 'function') {
            const list = Array.from(doc.querySelectorAll(sel));
            const inside = list.find((el) => el && el !== container && !isHostOwnedElement(el) && (typeof container.contains === 'function' ? container.contains(el) : true));
            if (inside) return inside;
          } else {
            const list = typeof doc.querySelectorAll === 'function' ? Array.from(doc.querySelectorAll(sel)) : [doc.querySelector(sel)].filter(Boolean);
            const hit = list.find((el) => el && !isHostOwnedElement(el));
            if (hit) return hit;
          }
        } catch {}
      }
      return null;
    }

    function queryAnchorAll(anchorName) {
      if (!doc || typeof doc.querySelectorAll !== 'function') return [];
      const selectors = resolveAnchorSelectors(anchorName);
      for (const sel of selectors) {
        try {
          const list = Array.from(doc.querySelectorAll(sel)).filter((el) => el && !isHostOwnedElement(el));
          if (list.length > 0) return list;
        } catch {}
      }
      return [];
    }

    // Antigravity 原生设置弹窗融合挂载器
    function teardownNativeSettingsMount() {
      closeFieldModal(false);
      state.recordingShortcutKey = null;
      state.openComboboxKey = null;
      if (nativeState.active && nativeState.contentEl) {
        setInlineDisplay(nativeState.contentEl, nativeState.savedContentDisplay || '');
      }
      if (nativeState.navEl) {
        nativeState.navEl.removeAttribute?.('data-agy-nav-active');
        if (nativeState.boundNavClick && typeof nativeState.navEl.removeEventListener === 'function') {
          try { nativeState.navEl.removeEventListener('click', nativeState.boundNavClick, true); } catch {}
        }
      }
      if (nativeState.navWrapEl?.remove) {
        try { nativeState.navWrapEl.remove(); } catch {}
      }
      if (nativeState.navBtnEl?.remove) {
        try { nativeState.navBtnEl.remove(); } catch {}
      }
      if (nativeState.mountHostEl?.remove) {
        try { nativeState.mountHostEl.remove(); } catch {}
      }
      const wasNative = state.settingsMode === 'native';
      nativeState.dialogEl = null;
      nativeState.navEl = null;
      nativeState.contentEl = null;
      nativeState.navWrapEl = null;
      nativeState.navBtnEl = null;
      nativeState.mountHostEl = null;
      nativeState.mountShadow = null;
      nativeState.viewRootEl = null;
      nativeState.savedContentDisplay = null;
      nativeState.active = false;
      nativeState.boundNavClick = null;
      if (wasNative) {
        state.settingsMode = 'closed';
        settingsBtnEl?.setAttribute?.('data-active', 'false');
        updateElevationAttr();
      }
    }

    function deactivateNativeSettingsView() {
      closeFieldModal(false);
      state.recordingShortcutKey = null;
      state.openComboboxKey = null;
      if (nativeState.active && nativeState.contentEl) {
        setInlineDisplay(nativeState.contentEl, nativeState.savedContentDisplay || '');
      }
      nativeState.savedContentDisplay = null;
      nativeState.active = false;
      if (nativeState.mountHostEl) {
        setHidden(nativeState.mountHostEl, true);
      }
      if (nativeState.navEl) {
        nativeState.navEl.removeAttribute?.('data-agy-nav-active');
      }
      if (nativeState.navBtnEl) {
        nativeState.navBtnEl.setAttribute('data-active', 'false');
      }
      if (state.settingsMode === 'native') {
        state.settingsMode = 'closed';
        settingsBtnEl?.setAttribute?.('data-active', 'false');
        updateElevationAttr();
      }
    }

    function activateNativeSettingsView() {
      if (!nativeState.dialogEl || !nativeState.navEl || !nativeState.contentEl || !nativeState.mountHostEl || !nativeState.viewRootEl) {
        return false;
      }
      closeAllPopovers('__settings__');
      if (modalBackdropEl && !modalBackdropEl.hidden) {
        setHidden(modalBackdropEl, true);
      }
      if (!nativeState.active) {
        nativeState.savedContentDisplay = getInlineDisplay(nativeState.contentEl);
        setInlineDisplay(nativeState.contentEl, 'none');
        setHidden(nativeState.mountHostEl, false);
        nativeState.navEl.setAttribute?.('data-agy-nav-active', 'true');
        nativeState.navBtnEl?.setAttribute?.('data-active', 'true');
        nativeState.active = true;
      }
      state.settingsMode = 'native';
      settingsBtnEl?.setAttribute?.('data-active', 'true');
      applyThemeVars();
      renderSettingsView();
      if (state.activeSettingsTab === 'plugins' && hasBridgeAvailable() && !state.manageLoading) {
        void fetchManagePlugins();
      }
      return true;
    }

    function bindNativeSiblingNavButtons(navEl, agyBtn) {
      if (!navEl || typeof navEl.querySelectorAll !== 'function') return;
      const candidates = Array.from(navEl.querySelectorAll('button, [role="tab"], [role="menuitem"], [role="option"], a'));
      for (const btn of candidates) {
        if (!btn || btn === agyBtn || btn.getAttribute?.('data-agy-native-nav') === 'true') continue;
        if (nativeState.boundSiblingBtns.has(btn)) continue;
        nativeState.boundSiblingBtns.add(btn);
        btn.addEventListener?.('click', () => {
          if (nativeState.active) {
            deactivateNativeSettingsView();
          }
        });
      }
    }

    function findSplitSiblingContent(navEl) {
      let cur = navEl;
      for (let depth = 0; cur && cur.parentElement && depth < 5; depth++) {
        const parent = cur.parentElement;
        const siblings = Array.from(parent.children || []).filter(
          (sib) => sib && sib !== cur && sib !== navEl && !isHostOwnedElement(sib)
        );
        for (const sib of siblings) {
          const scrollArea = sib.querySelector ? sib.querySelector('.overflow-auto') : null;
          if (scrollArea && scrollArea !== navEl && scrollArea.parentElement && !isHostOwnedElement(scrollArea)) {
            return { splitRoot: parent, contentEl: scrollArea };
          }
        }
        for (const sib of siblings) {
          const kids = Array.from(sib.children || []);
          const cls = String(sib.className || '');
          if (kids.length > 0 || /\boverflow-auto\b/.test(cls)) {
            return { splitRoot: parent, contentEl: sib };
          }
        }
        cur = parent;
      }
      return null;
    }

    function resolveNativeSettingsNodes() {
      let navEl = queryAnchor('settings.nav');
      let dialogEl = null;
      if (navEl) {
        dialogEl = (typeof navEl.closest === 'function' ? navEl.closest('[role="dialog"], [aria-modal="true"]') : null)
          || queryAnchor('settings.dialog');
      } else {
        dialogEl = queryAnchor('settings.dialog');
        if (dialogEl) {
          navEl = queryAnchor('settings.nav', { within: dialogEl });
        }
      }
      if (!navEl) return null;

      let contentEl = dialogEl ? queryAnchor('settings.content', { within: dialogEl }) : null;
      if (!contentEl) {
        const splitMatch = findSplitSiblingContent(navEl);
        if (splitMatch) {
          contentEl = splitMatch.contentEl;
          if (!dialogEl) dialogEl = splitMatch.splitRoot;
        }
      }
      if (!dialogEl || !contentEl || navEl === contentEl || !contentEl.parentElement) {
        return null;
      }
      return { dialogEl, navEl, contentEl };
    }

    function syncNativeSettingsIntegration() {
      if (state.disposed || !doc?.createElement) return false;
      if (state.hostSettings.injectNativeSettings === false) {
        state.settingsInjectionAttemptFailed = false;
        if (nativeState.dialogEl || nativeState.navBtnEl || nativeState.mountHostEl) {
          teardownNativeSettingsMount();
        }
        return false;
      }
      const resolved = resolveNativeSettingsNodes();
      if (!resolved) {
        if (nativeState.dialogEl) teardownNativeSettingsMount();
        return false;
      }
      const { dialogEl, navEl, contentEl } = resolved;

      if (nativeState.dialogEl && (nativeState.dialogEl !== dialogEl || nativeState.navEl !== navEl || nativeState.contentEl !== contentEl)) {
        teardownNativeSettingsMount();
      }

      nativeState.dialogEl = dialogEl;
      nativeState.navEl = navEl;
      nativeState.contentEl = contentEl;

      // 防重复注入左侧导航按钮
      let navBtn = navEl.querySelector ? navEl.querySelector('[data-agy-native-nav="true"]') : null;
      let navWrap = navBtn?.parentElement?.getAttribute?.('data-agy-native-nav-wrap') === 'true'
        ? navBtn.parentElement
        : null;
      if (!navBtn) {
        navBtn = doc.createElement('button');
        navBtn.type = 'button';
        navBtn.setAttribute('data-agy-native-nav', 'true');
        navBtn.setAttribute('data-active', 'false');
        const navLbl = doc.createElement('span');
        navLbl.textContent = 'Agy-Daddy';
        navBtn.appendChild(navLbl);
        navBtn.addEventListener('click', (ev) => {
          ev?.stopPropagation?.();
          activateNativeSettingsView();
        });

        const navKids = Array.from(navEl.children || []);
        const scrollListEl = navKids.find((ch) => /\boverflow-y-auto\b/.test(String(ch?.className || ''))) || null;
        const isSidebarTestId = navEl.getAttribute?.('data-testid') === 'settings-sidebar';
        const targetListEl = (isSidebarTestId || scrollListEl) ? (scrollListEl || navEl) : null;

        if (targetListEl) {
          navWrap = doc.createElement('div');
          navWrap.className = 'relative group/nav-item mx-2';
          navWrap.setAttribute('data-agy-native-nav-wrap', 'true');
          navWrap.appendChild(navBtn);

          const listKids = Array.from(targetListEl.children || []);
          const sectionRef = listKids.find((ch, idx) => {
            if (idx < 2) return false;
            const cls = String(ch?.className || '');
            const txt = String(ch?.textContent || '').trim();
            if (/\bmt-2\b/.test(cls)) return true;
            if (/^(Workspaces|Projects|Not in Project)$/i.test(txt)) return true;
            return false;
          });
          const spacerRef = listKids.find(
            (ch) => /\bflex-1\b/.test(String(ch?.className || '')) && (!ch.children || ch.children.length === 0)
          );
          const insertRef = sectionRef || spacerRef || null;
          if (insertRef && typeof targetListEl.insertBefore === 'function') {
            targetListEl.insertBefore(navWrap, insertRef);
          } else {
            targetListEl.appendChild(navWrap);
          }
        } else {
          navEl.appendChild(navBtn);
        }
      }
      nativeState.navWrapEl = navWrap;
      nativeState.navBtnEl = navBtn;

      if (!nativeState.boundNavClick && typeof navEl.addEventListener === 'function') {
        nativeState.boundNavClick = (ev) => {
          const target = ev?.target;
          if (!target) return;
          if (target === nativeState.navBtnEl) return;
          if (typeof nativeState.navBtnEl?.contains === 'function' && nativeState.navBtnEl.contains(target)) return;
          const clickedBtn = typeof target.closest === 'function'
            ? target.closest('button, [role="tab"], [role="menuitem"], [role="option"], a')
            : target;
          if (!clickedBtn || clickedBtn === nativeState.navBtnEl) return;
          if (nativeState.active) {
            deactivateNativeSettingsView();
          }
        };
        navEl.addEventListener('click', nativeState.boundNavClick, true);
      }
      bindNativeSiblingNavButtons(navEl, navBtn);

      // 同级挂载 Shadow DOM 容器（绝不修改原生 settings.content 内部 React 子树）
      const parentEl = contentEl.parentElement;
      let mountHost = parentEl.querySelector ? parentEl.querySelector(`#${NATIVE_SETTINGS_MOUNT_ID}`) : null;
      if (!mountHost) {
        mountHost = doc.createElement('div');
        mountHost.id = NATIVE_SETTINGS_MOUNT_ID;
        mountHost.setAttribute('data-host-role', 'native-settings');
        mountHost.setAttribute('data-theme', state.themeMode === 'light' ? 'light' : 'dark');
        setHidden(mountHost, true);

        const mountShadow = typeof mountHost.attachShadow === 'function'
          ? mountHost.attachShadow({ mode: 'open' })
          : mountHost;

        const styleEl = doc.createElement('style');
        styleEl.id = 'agy-native-settings-style';
        styleEl.textContent = typeof __AGY_HOST_CSS__ === 'string' ? __AGY_HOST_CSS__ : '';
        mountShadow.appendChild(styleEl);

        const viewRoot = doc.createElement('div');
        viewRoot.id = 'agy-native-settings-root';
        viewRoot.className = 'agy-settings-view';
        mountShadow.appendChild(viewRoot);

        insertAfter(parentEl, mountHost, contentEl);
        nativeState.mountHostEl = mountHost;
        nativeState.mountShadow = mountShadow;
        nativeState.viewRootEl = viewRoot;
        applyThemeVars();
      } else {
        nativeState.mountHostEl = mountHost;
        nativeState.mountShadow = mountHost.shadowRoot || mountHost;
        const cssText = typeof __AGY_HOST_CSS__ === 'string' ? __AGY_HOST_CSS__ : '';
        let styleEl = nativeState.mountShadow.querySelector?.('#agy-native-settings-style')
          || nativeState.mountShadow.querySelector?.('style');
        if (!styleEl && doc?.createElement) {
          styleEl = doc.createElement('style');
          styleEl.id = 'agy-native-settings-style';
          if (nativeState.mountShadow.firstChild && typeof nativeState.mountShadow.insertBefore === 'function') {
            nativeState.mountShadow.insertBefore(styleEl, nativeState.mountShadow.firstChild);
          } else {
            nativeState.mountShadow.appendChild?.(styleEl);
          }
        }
        if (styleEl && styleEl.textContent !== cssText) {
          styleEl.textContent = cssText;
        }
        nativeState.viewRootEl = nativeState.mountShadow.querySelector?.('#agy-native-settings-root') || nativeState.viewRootEl;
      }

      state.settingsInjectionAttemptFailed = false;
      return true;
    }

    // 共享 MutationObserver
    let sharedObserver = null;
    let observerRafPending = false;

    function flushSharedAnchorObservers() {
      observerRafPending = false;
      if (state.disposed) return;
      syncNativeSettingsIntegration();
      syncExternalDialogLayering();
      syncAuxSidebarState();
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
      evaluateSafeMode();
      scheduleRuntimeHealthReport();
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
      const errMsg = err?.message || String(err || '未知渲染错误');
      const errStack = typeof err?.stack === 'string' && err.stack ? err.stack : null;
      state.rendererErrors.set(pluginId, { message: errMsg, stack: errStack, at: now });
      const metric = getMetric(pluginId);
      metric.crashes = arr.length;
      if (arr.length >= 3) {
        void disposePlugin(pluginId);
      }
      renderPluginAlertCapsule();
      renderUnits();
      evaluateSafeMode();
      scheduleRuntimeHealthReport({ immediate: true });
      return { crashes: arr.length, circuitOpen: arr.length >= 3, error: errMsg };
    }

    function formatCompactCount(val) {
      const n = Number(val);
      if (!Number.isFinite(n) || n < 0) return '--';
      if (n >= 1000000) {
        const m = n / 1000000;
        return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`;
      }
      if (n >= 1000) {
        const k = n / 1000;
        return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
      }
      return String(Math.floor(n));
    }

    function isGitHubSpec(raw) {
      if (typeof raw !== 'string') return false;
      const s = raw.trim();
      return s.startsWith('github:') || s.startsWith('git@github.com:') || /^((?:git\+)?https?:\/\/)github\.com\//i.test(s);
    }

    function isNpmSpec(raw) {
      return typeof raw === 'string' && raw.trim().startsWith('npm:');
    }

    function ingestMarketStatsMap(statsMap) {
      if (!isPlainObject(statsMap)) return;
      for (const [id, st] of Object.entries(statsMap)) {
        if (id && isPlainObject(st)) {
          state.marketStats.set(id, { ...st });
        }
      }
    }

    // 插件管理与设置中心数据聚合
    function applyManagePayload(data) {
      if (isPlainObject(data?.marketStats)) {
        ingestMarketStatsMap(data.marketStats);
      }
      if (Array.isArray(data?.plugins)) {
        state.managePlugins = data.plugins;
        for (const p of data.plugins) {
          if (isPlainObject(p?.marketStats) && p.id) {
            state.marketStats.set(p.id, { ...p.marketStats });
          }
          if (p?.id && p.active && !p.health?.lastError && !p.health?.circuitOpen) {
            state.rendererErrors.delete(p.id);
          }
          upsertPluginMeta(p);
        }
      }
      if (Array.isArray(data?.catalog)) {
        state.manageCatalog = data.catalog;
        for (const c of data.catalog) {
          if (isPlainObject(c?.marketStats) && c.id) {
            state.marketStats.set(c.id, { ...c.marketStats });
          }
        }
      }
      renderPluginAlertCapsule();
      renderUnits();
    }

    function getCombinedPlugins() {
      const byId = new Map();
      const addOrMerge = (p) => {
        if (!p || !p.id) return;
        const prev = byId.get(p.id) || {};
        byId.set(p.id, { ...prev, ...p });
      };

      for (const p of state.managePlugins) {
        addOrMerge({
          ...p,
          displayName: pickLocaleText(p.displayName, p.id),
          description: pickLocaleText(p.description, '')
        });
      }
      for (const meta of state.pluginMeta.values()) {
        if (state.managePlugins.length > 0 && !byId.has(meta.id) && meta.sourceKind !== 'memory') {
          // 如果后端已返回权威安装列表，仅补充已运行或有本地 meta 的插件
          if (!state.pluginInstances.has(meta.id)) continue;
        }
        addOrMerge(meta);
      }
      for (const id of state.pluginInstances.keys()) {
        if (!byId.has(id)) {
          addOrMerge({
            id,
            displayName: id,
            description: '',
            version: '1.0.0',
            trustLevel: id.startsWith('agy-daddy.') ? 'T0' : (id.startsWith('community.') ? 'T1' : 'T2'),
            enabled: true,
            active: true,
            hasNative: false,
            hasRollback: false,
            permissions: [],
            settingsSchema: null,
            settingsValues: {},
            commands: [],
            topbarUnits: [],
            sourceKind: 'memory'
          });
        }
      }
      for (const u of state.units.values()) {
        if (!byId.has(u.pluginId)) {
          addOrMerge({
            id: u.pluginId,
            displayName: u.pluginId,
            description: '',
            version: '1.0.0',
            trustLevel: u.pluginId.startsWith('agy-daddy.') ? 'T0' : (u.pluginId.startsWith('community.') ? 'T1' : 'T2'),
            enabled: true,
            active: true,
            hasNative: false,
            hasRollback: false,
            permissions: [],
            settingsSchema: null,
            settingsValues: {},
            commands: [],
            topbarUnits: [{ id: u.id }],
            sourceKind: 'memory'
          });
        }
      }
      for (const id of state.rendererErrors.keys()) {
        if (!byId.has(id)) {
          addOrMerge({
            id,
            displayName: id,
            description: '',
            version: '1.0.0',
            trustLevel: id.startsWith('agy-daddy.') ? 'T0' : (id.startsWith('community.') ? 'T1' : 'T2'),
            enabled: true,
            active: false,
            hasNative: false,
            hasRollback: false,
            permissions: [],
            settingsSchema: null,
            settingsValues: {},
            commands: [],
            topbarUnits: [],
            sourceKind: 'memory'
          });
        }
      }

      const list = [];
      for (const item of byId.values()) {
        const meta = state.pluginMeta.get(item.id);
        const schema = item.settingsSchema || meta?.settingsSchema || null;
        const values = mergeSchemaDefaults(schema, meta?.settingsValues || item.settingsValues || {});
        const liveUnits = Array.from(state.units.values()).filter((u) => u.pluginId === item.id);
        const hasTopbarUnits = liveUnits.length > 0
          ? true
          : (!state.topbarSuppressedPlugins.has(item.id) && Array.isArray(item.topbarUnits) && item.topbarUnits.length > 0);
        list.push({
          ...item,
          displayName: pickLocaleText(item.displayName, item.id),
          description: pickLocaleText(item.description, ''),
          settingsSchema: schema,
          settingsValues: values,
          commands: Array.isArray(item.commands) ? item.commands : (meta?.commands || []),
          topbarUnits: Array.isArray(item.topbarUnits) ? item.topbarUnits : (meta?.topbarUnits || []),
          hasTopbarUnits
        });
      }
      return list.sort((a, b) => a.id.localeCompare(b.id));
    }

    function getPluginDiagnosticIssue(p) {
      if (!p || !p.id) return null;
      const installHealth = isPlainObject(p.installHealth) ? p.installHealth : null;
      const isMissingPath = Boolean(
        (installHealth && installHealth.status !== 'ok') ||
        p.health?.lastErrorCode === 'INSTALL_PATH_MISSING'
      );
      if (p.enabled === false && !isMissingPath) return null;

      const metric = getMetric(p.id);
      const crashes = Math.max(metric.crashes, Number(p.health?.crashesInWindow || 0));
      const circuitOpen = crashes >= 3 || Boolean(p.health?.circuitOpen);
      const localRenderErr = state.rendererErrors.get(p.id);
      const remoteStage = p.health?.lastErrorStage || null;
      const isRendererErr = Boolean(localRenderErr || (remoteStage === 'renderer' && p.health?.lastError));
      const isInactive = p.active === false;

      if (!isMissingPath && !isInactive && !circuitOpen && !isRendererErr) {
        return null;
      }

      const displayName = pickLocaleText(p.displayName, p.id);
      const repairCandidates = Array.isArray(installHealth?.repairCandidates) ? installHealth.repairCandidates : [];
      const bestRepair = repairCandidates[0] || null;

      if (isMissingPath) {
        const isBrokenLink = installHealth?.status === 'broken_symlink';
        const rawError = isBrokenLink && installHealth?.symlinkTarget
          ? `软链目标已丢失：${installHealth.symlinkTarget}`
          : (p.health?.lastError || '插件安装目录已不存在（可能已被删除或移动）');
        const suggestion = bestRepair
          ? `检测到可用恢复源（${bestRepair.label}：${bestRepair.target}），可点击「一键修复」恢复路径并激活，也可手动指定本地目录或移除该失效记录。`
          : '未找到原目录（常见于删除 Git worktree 或移动本地插件目录），请重新指定本地目录或移除该失效记录。';
        return {
          id: p.id,
          displayName,
          statusKind: 'path_missing',
          statusLabel: isBrokenLink ? '路径失效' : '文件丢失',
          tone: 'danger',
          error: rawError,
          errorCode: 'INSTALL_PATH_MISSING',
          errorStage: 'load',
          suggestion,
          crashes,
          circuitOpen: false,
          isMissingPath: true,
          installHealth,
          repairCandidates,
          bestRepair,
          plugin: p
        };
      }

      const rawError = localRenderErr?.message
        || p.health?.lastError
        || (circuitOpen
          ? `插件连续异常 ${crashes} 次，已触发熔断保护`
          : '插件已启用但当前未激活（可能未完成启动加载或依赖未就绪）');
      const errorCode = p.health?.lastErrorCode || (circuitOpen ? 'CIRCUIT_OPEN' : (isRendererErr ? 'RENDERER_MOUNT_FAILED' : 'NOT_ACTIVE'));
      const errorStage = localRenderErr ? 'renderer' : (remoteStage || 'activate');
      const suggestion = p.health?.lastErrorSuggestion || (
        circuitOpen
          ? '请排查下方错误信息后点击「解除熔断并激活」重试。'
          : (isRendererErr
              ? '页面渲染层挂载异常，请检查宿主页面状态后点击「立即激活」或「重新载入」重试。'
              : '可点击「立即激活」尝试重新加载该插件，并检查下方错误信息。')
      );

      let statusKind = 'inactive';
      let statusLabel = '未激活';
      let tone = 'warn';
      if (circuitOpen) {
        statusKind = 'circuit';
        statusLabel = '已熔断';
        tone = 'danger';
      } else if (isRendererErr) {
        statusKind = 'renderer_error';
        statusLabel = '注入失败';
        tone = isInactive ? 'danger' : 'warn';
      } else if (p.health?.lastError) {
        statusKind = 'activate_failed';
        statusLabel = '未激活';
        tone = 'danger';
      }

      return {
        id: p.id,
        displayName,
        statusKind,
        statusLabel,
        tone,
        error: rawError,
        errorCode,
        errorStage,
        suggestion,
        crashes,
        circuitOpen,
        isMissingPath: false,
        installHealth,
        repairCandidates: [],
        bestRepair: null,
        plugin: p
      };
    }

    function getUnusablePlugins() {
      const issues = [];
      for (const p of getCombinedPlugins()) {
        const issue = getPluginDiagnosticIssue(p);
        if (issue) issues.push(issue);
      }
      return issues;
    }

    function renderPluginAlertCapsule() {
      const issues = getUnusablePlugins();
      if (!pluginAlertBtnEl) {
        if (issues.length > 0 && doc && typeof doc.createElement === 'function' && !state.disposed) {
          ensureDomShell();
        } else {
          return issues;
        }
      }
      if (!pluginAlertBtnEl) return issues;

      if (issues.length === 0) {
        setHidden(pluginAlertBtnEl, true);
        pluginAlertBtnEl.removeAttribute?.('data-tone');
        pluginAlertBtnEl.removeAttribute?.('data-issue-count');
        pluginAlertBtnEl.removeAttribute?.('title');
        pluginAlertBtnEl.removeAttribute?.('aria-label');
        if (pluginAlertPopoverEl && !pluginAlertPopoverEl.hidden) {
          setHidden(pluginAlertPopoverEl, true);
          pluginAlertBtnEl.setAttribute?.('data-active', 'false');
          pluginAlertBtnEl.setAttribute?.('aria-expanded', 'false');
        }
        return issues;
      }

      const hasDanger = issues.some((i) => i.tone === 'danger');
      setHidden(pluginAlertBtnEl, false);
      pluginAlertBtnEl.setAttribute('data-tone', hasDanger ? 'danger' : 'warn');
      pluginAlertBtnEl.setAttribute('data-issue-count', String(issues.length));

      const namesSummary = issues.slice(0, 3).map((i) => `${i.displayName}(${i.statusLabel})`).join('、');
      const tipText = `${namesSummary}${issues.length > 3 ? ` 等 ${issues.length} 个插件` : ''}不能使用，点击进入插件诊断解决`;
      pluginAlertBtnEl.setAttribute('title', tipText);
      pluginAlertBtnEl.setAttribute('aria-label', tipText);

      clearElement(pluginAlertBtnEl);
      const iconWrap = doc.createElement('span');
      iconWrap.className = 'ag-unit-icon';
      iconWrap.appendChild(createIconEl('alertTriangle'));
      pluginAlertBtnEl.appendChild(iconWrap);
      const lbl = doc.createElement('span');
      lbl.className = 'ag-plugin-alert-text';
      lbl.textContent = issues.length === 1 ? '1 插件异常' : `${issues.length} 插件异常`;
      pluginAlertBtnEl.appendChild(lbl);

      if (pluginAlertListEl) {
        clearElement(pluginAlertListEl);
        for (const issue of issues) {
          const rowBtn = doc.createElement('button');
          rowBtn.type = 'button';
          rowBtn.className = 'ag-plugin-alert-item';
          rowBtn.setAttribute('data-alert-plugin-id', issue.id);

          const rowMain = doc.createElement('div');
          rowMain.className = 'ag-plugin-alert-item-main';
          const head = doc.createElement('div');
          head.className = 'ag-plugin-alert-item-head';
          const nameEl = doc.createElement('span');
          nameEl.className = 'ag-plugin-alert-item-name';
          nameEl.textContent = issue.displayName;
          const chip = doc.createElement('span');
          chip.className = 'ag-chip';
          chip.setAttribute('data-tone', issue.tone);
          chip.textContent = issue.statusLabel;
          head.appendChild(nameEl);
          head.appendChild(chip);
          const errEl = doc.createElement('div');
          errEl.className = 'ag-plugin-alert-item-err';
          errEl.textContent = issue.error;
          rowMain.appendChild(head);
          rowMain.appendChild(errEl);

          rowBtn.appendChild(rowMain);
          rowBtn.appendChild(createIconEl('chevronRight'));
          rowBtn.addEventListener('click', () => {
            togglePluginAlertPopover(false);
            void openSettings({ tab: 'plugins', pluginId: issue.id, focusDiagnostics: true });
          });
          pluginAlertListEl.appendChild(rowBtn);
        }
      }
      return issues;
    }

    function getViewportSize() {
      const vw = Number(win?.innerWidth || doc?.documentElement?.clientWidth || 1280);
      const vh = Number(win?.innerHeight || doc?.documentElement?.clientHeight || 800);
      return {
        vw: Number.isFinite(vw) && vw > 0 ? vw : 1280,
        vh: Number.isFinite(vh) && vh > 0 ? vh : 800
      };
    }

    function clampSafeModePillCoords(rawLeft, rawTop, width = 168, height = 32) {
      const { vw, vh } = getViewportSize();
      const margin = 8;
      const w = Number.isFinite(width) && width > 0 ? width : 168;
      const h = Number.isFinite(height) && height > 0 ? height : 32;
      const maxLeft = Math.max(margin, vw - w - margin);
      const maxTop = Math.max(margin, vh - h - margin);
      return {
        left: Math.min(maxLeft, Math.max(margin, Math.round(rawLeft))),
        top: Math.min(maxTop, Math.max(margin, Math.round(rawTop)))
      };
    }

    function applySafeModePillPosition(pos = null) {
      if (!safeModePillHostEl?.style) return;
      safeModePillHostEl.style.setProperty('position', 'fixed');
      safeModePillHostEl.style.setProperty('z-index', '2147483647');
      if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        safeModePillHostEl.style.setProperty('left', `${Math.round(pos.left)}px`);
        safeModePillHostEl.style.setProperty('top', `${Math.round(pos.top)}px`);
        safeModePillHostEl.style.setProperty('right', 'auto');
        safeModePillHostEl.style.setProperty('bottom', 'auto');
      } else {
        safeModePillHostEl.style.setProperty('right', '16px');
        safeModePillHostEl.style.setProperty('bottom', '16px');
        safeModePillHostEl.style.setProperty('left', 'auto');
        safeModePillHostEl.style.setProperty('top', 'auto');
      }
    }

    function clampSafeModePillPosition() {
      if (!safeModePillHostEl || !state.safeModePillPos) return;
      const rect = typeof safeModePillHostEl.getBoundingClientRect === 'function'
        ? safeModePillHostEl.getBoundingClientRect()
        : null;
      const w = (rect && Number.isFinite(rect.width) && rect.width > 0) ? rect.width : 168;
      const h = (rect && Number.isFinite(rect.height) && rect.height > 0) ? rect.height : 32;
      const clamped = clampSafeModePillCoords(state.safeModePillPos.left, state.safeModePillPos.top, w, h);
      state.safeModePillPos = clamped;
      applySafeModePillPosition(clamped);
    }

    function detachSafeModePillDragListeners() {
      if (!safeModePillDragState) return;
      const d = safeModePillDragState;
      safeModePillDragState = null;
      safeModePillBtnEl?.removeAttribute?.('data-dragging');
      if (doc?.removeEventListener) {
        if (d.onMove) {
          doc.removeEventListener('pointermove', d.onMove, true);
          doc.removeEventListener('mousemove', d.onMove, true);
        }
        if (d.onUp) {
          doc.removeEventListener('pointerup', d.onUp, true);
          doc.removeEventListener('pointercancel', d.onUp, true);
          doc.removeEventListener('mouseup', d.onUp, true);
        }
      }
      if (win?.removeEventListener) {
        if (d.onMove) {
          win.removeEventListener('pointermove', d.onMove, true);
          win.removeEventListener('mousemove', d.onMove, true);
        }
        if (d.onUp) {
          win.removeEventListener('pointerup', d.onUp, true);
          win.removeEventListener('pointercancel', d.onUp, true);
          win.removeEventListener('mouseup', d.onUp, true);
        }
      }
    }

    function startSafeModePillDrag(ev, source) {
      if (state.disposed || !safeModePillHostEl) return;
      if (ev && ev.button !== undefined && ev.button !== 0) return;
      if (safeModePillDragState) {
        if (safeModePillDragState.source === 'pointer' && source === 'mouse') return;
        detachSafeModePillDragListeners();
      }

      const { vw, vh } = getViewportSize();
      const rect = typeof safeModePillHostEl.getBoundingClientRect === 'function'
        ? safeModePillHostEl.getBoundingClientRect()
        : null;
      const width = (rect && Number.isFinite(rect.width) && rect.width > 0) ? rect.width : 168;
      const height = (rect && Number.isFinite(rect.height) && rect.height > 0) ? rect.height : 32;
      const hasRectOrigin = Boolean(rect && Number.isFinite(rect.left) && Number.isFinite(rect.top) && (rect.width > 0 || rect.height > 0));
      const startLeft = hasRectOrigin
        ? rect.left
        : (state.safeModePillPos ? state.safeModePillPos.left : Math.max(8, vw - width - 16));
      const startTop = hasRectOrigin
        ? rect.top
        : (state.safeModePillPos ? state.safeModePillPos.top : Math.max(8, vh - height - 16));
      const startClientX = Number(ev?.clientX ?? 0);
      const startClientY = Number(ev?.clientY ?? 0);

      let moved = false;
      const onMove = (moveEv) => {
        if (!safeModePillDragState || state.disposed) return;
        const cx = Number(moveEv?.clientX ?? startClientX);
        const cy = Number(moveEv?.clientY ?? startClientY);
        const dx = cx - startClientX;
        const dy = cy - startClientY;
        if (!moved && Math.hypot(dx, dy) < 5) return;
        if (!moved) {
          moved = true;
          suppressNextSafeModePillClick = true;
          safeModePillBtnEl?.setAttribute?.('data-dragging', 'true');
        }
        moveEv?.preventDefault?.();
        const clamped = clampSafeModePillCoords(startLeft + dx, startTop + dy, width, height);
        state.safeModePillPos = clamped;
        applySafeModePillPosition(clamped);
      };

      const onUp = () => {
        detachSafeModePillDragListeners();
        if (moved) {
          suppressNextSafeModePillClick = true;
          if (suppressSafeModeClickTimer) clearTimeout(suppressSafeModeClickTimer);
          suppressSafeModeClickTimer = setTimeout(() => {
            suppressSafeModeClickTimer = null;
            suppressNextSafeModePillClick = false;
          }, 120);
          suppressSafeModeClickTimer.unref?.();
        }
      };

      safeModePillDragState = { source, onMove, onUp };
      const target = doc?.addEventListener ? doc : (win?.addEventListener ? win : null);
      if (target) {
        if (source === 'pointer') {
          target.addEventListener('pointermove', onMove, true);
          target.addEventListener('pointerup', onUp, true);
          target.addEventListener('pointercancel', onUp, true);
        } else {
          target.addEventListener('mousemove', onMove, true);
          target.addEventListener('mouseup', onUp, true);
        }
      }
    }

    function ensureSafeModePillShell() {
      if (!doc || typeof doc.createElement !== 'function' || state.disposed) return null;
      if (safeModePillHostEl && safeModePillBtnEl) {
        const mountParent = doc.body || doc.documentElement;
        if (mountParent && safeModePillHostEl.parentElement !== mountParent && typeof mountParent.appendChild === 'function') {
          mountParent.appendChild(safeModePillHostEl);
        }
        return safeModePillShadow;
      }

      const stale = doc.getElementById ? doc.getElementById(SAFE_MODE_PILL_HOST_ID) : null;
      if (stale && stale.remove) stale.remove();
      ensureLightDomStyles();

      safeModePillHostEl = doc.createElement('div');
      safeModePillHostEl.id = SAFE_MODE_PILL_HOST_ID;
      safeModePillHostEl.setAttribute('data-agy-safe-mode', 'true');
      safeModePillHostEl.setAttribute('data-theme', state.themeMode === 'light' ? 'light' : 'dark');
      applySafeModePillPosition(state.safeModePillPos);
      setHidden(safeModePillHostEl, true);

      if (typeof safeModePillHostEl.attachShadow === 'function') {
        safeModePillShadow = safeModePillHostEl.attachShadow({ mode: 'open' });
      } else {
        safeModePillShadow = safeModePillHostEl;
      }

      const styleEl = doc.createElement('style');
      styleEl.textContent = typeof __AGY_HOST_CSS__ === 'string' ? __AGY_HOST_CSS__ : '';
      safeModePillShadow.appendChild(styleEl);

      safeModePillBtnEl = doc.createElement('button');
      safeModePillBtnEl.id = 'agy-safe-mode-pill';
      safeModePillBtnEl.type = 'button';
      safeModePillBtnEl.className = 'ag-safe-mode-pill';
      safeModePillBtnEl.setAttribute('aria-haspopup', 'dialog');
      safeModePillBtnEl.addEventListener('pointerdown', (ev) => startSafeModePillDrag(ev, 'pointer'));
      safeModePillBtnEl.addEventListener('mousedown', (ev) => startSafeModePillDrag(ev, 'mouse'));
      safeModePillBtnEl.addEventListener('click', (ev) => {
        if (suppressNextSafeModePillClick) {
          suppressNextSafeModePillClick = false;
          if (suppressSafeModeClickTimer) {
            clearTimeout(suppressSafeModeClickTimer);
            suppressSafeModeClickTimer = null;
          }
          ev?.preventDefault?.();
          ev?.stopPropagation?.();
          return;
        }
        void openSafeModeDiagnostics();
      });
      safeModePillShadow.appendChild(safeModePillBtnEl);

      const mountTarget = doc.body || doc.documentElement;
      if (mountTarget && typeof mountTarget.appendChild === 'function') {
        mountTarget.appendChild(safeModePillHostEl);
      }
      applyThemeVars();
      return safeModePillShadow;
    }

    function computeSafeModeStatus() {
      const reg = getActiveHealthAnchorsRegistry();
      const hasTopbarDef = Boolean(reg?.anchors?.['topbar.rightCluster']);
      const topbarMissing = hasTopbarDef && !queryAnchor('topbar.rightCluster');

      let liveSettingsBroken = false;
      const injectNativeEnabled = state.hostSettings.injectNativeSettings !== false;
      if (injectNativeEnabled && hasNativeSettingsMarkerInDom() && !nativeState.active && !resolveNativeSettingsNodes()) {
        liveSettingsBroken = true;
      }
      const settingsInjectionFailed = Boolean(
        injectNativeEnabled && (liveSettingsBroken || state.settingsInjectionAttemptFailed)
      );

      const pluginIssues = getUnusablePlugins();
      const probe = probeHealthAnchors(reg);
      const settingsExpected = settingsInjectionFailed || isSettingsExpectedInDom();
      const missingAnchors = probe.items
        .filter((item) => {
          if (item.status !== 'missing') return false;
          if (!settingsExpected && item.name.startsWith('settings.')) return false;
          return true;
        })
        .map((item) => item.name);
      if (topbarMissing && !missingAnchors.includes('topbar.rightCluster')) {
        missingAnchors.unshift('topbar.rightCluster');
      }
      if (settingsInjectionFailed) {
        if (!queryAnchor('settings.dialog') && !missingAnchors.includes('settings.dialog')) {
          missingAnchors.push('settings.dialog');
        }
        if (!queryAnchor('settings.nav') && !missingAnchors.includes('settings.nav')) {
          missingAnchors.push('settings.nav');
        }
      }

      const reasons = [];
      if (topbarMissing) reasons.push('顶栏挂载锚点 topbar.rightCluster 缺失');
      if (settingsInjectionFailed) reasons.push('原生设置注入失败（settings.dialog / settings.nav 不可用）');
      if (pluginIssues.length > 0) {
        const names = pluginIssues.slice(0, 2).map((p) => p.displayName || p.id).join('、');
        reasons.push(`${pluginIssues.length} 个插件异常（${names}${pluginIssues.length > 2 ? ' 等' : ''}）`);
      }

      const daemonFault = state.hostHealth?.fault?.active ? state.hostHealth.fault : null;
      const active = Boolean(topbarMissing || settingsInjectionFailed || pluginIssues.length > 0);
      return {
        active,
        reasons,
        missingAnchors,
        topbarMissing,
        settingsInjectionFailed,
        pluginIssues,
        daemonFault
      };
    }

    function evaluateSafeMode() {
      const next = computeSafeModeStatus();
      state.safeMode = next;
      if (state.disposed || !doc || typeof doc.createElement !== 'function') {
        return next;
      }

      if (!next.active) {
        if (safeModePillHostEl) {
          setHidden(safeModePillHostEl, true);
          safeModePillHostEl.removeAttribute?.('data-safe-mode-active');
        }
        syncTopbarEntryVisibility();
        return next;
      }

      ensureSafeModePillShell();
      if (!safeModePillHostEl || !safeModePillBtnEl) return next;

      setHidden(safeModePillHostEl, false);
      safeModePillHostEl.setAttribute('data-safe-mode-active', 'true');
      applySafeModePillPosition(state.safeModePillPos);

      const hasDanger = next.topbarMissing
        || next.settingsInjectionFailed
        || next.pluginIssues.some((i) => i.tone === 'danger')
        || Boolean(next.daemonFault);
      safeModePillBtnEl.setAttribute('data-tone', hasDanger ? 'danger' : 'warn');

      let labelText = 'Agy ⚠️ 异常诊断';
      if (next.missingAnchors.length > 0 && next.pluginIssues.length > 0) {
        labelText = `Agy ⚠️ ${next.missingAnchors.length} 锚点 · ${next.pluginIssues.length} 插件异常`;
      } else if (next.missingAnchors.length > 0) {
        labelText = `Agy ⚠️ ${next.missingAnchors.length} 锚点失效`;
      } else if (next.settingsInjectionFailed) {
        labelText = 'Agy ⚠️ 设置注入异常';
      } else if (next.pluginIssues.length > 0) {
        labelText = `Agy ⚠️ ${next.pluginIssues.length} 插件异常`;
      }

      const tipText = `Safe Mode：${next.reasons.join('；')}（点击打开独立诊断弹窗，可拖动调整位置）`;
      safeModePillBtnEl.setAttribute('title', tipText);
      safeModePillBtnEl.setAttribute('aria-label', tipText);

      clearElement(safeModePillBtnEl);
      const gripWrap = doc.createElement('span');
      gripWrap.className = 'ag-safe-mode-pill-grip';
      gripWrap.appendChild(createIconEl('grip'));
      const lbl = doc.createElement('span');
      lbl.className = 'ag-safe-mode-pill-text';
      lbl.textContent = labelText;
      safeModePillBtnEl.appendChild(gripWrap);
      safeModePillBtnEl.appendChild(lbl);

      return next;
    }

    function openSafeModeDiagnostics() {
      state.safeModeViewOpen = true;
      state.activeSettingsTab = 'plugins';
      state.selectedPluginId = null;
      state.marketplaceOpen = false;
      state.diagnosticsExpanded = true;
      ensureDomShell();
      const opened = openFallbackModal();
      if (hasBridgeAvailable()) {
        void fetchHostHealth({ reportFirst: true });
      }
      return { ok: opened, mode: 'modal', safeMode: true };
    }

    function activatePluginFromUi(pluginId, opts = {}) {
      if (!pluginId) return;
      state.manageConfirmUninstallId = null;
      state.managePendingNativeUninstall = null;
      void runManageAction(pluginId, `正在激活 ${pluginId}...`, async () => {
        const res = await hostBridgePost('/host/plugins/activate', {
          pluginId,
          resetCircuit: opts.resetCircuit !== false,
          enableIfDisabled: opts.enableIfDisabled !== false
        });
        if (state.disposed) return;
        api.reEnablePlugin(pluginId);
        state.rendererErrors.delete(pluginId);
        applyManagePayload(res);
        if (res?.ok && res?.active) {
          state.manageToast = { tone: 'info', spinning: false, text: `已激活 ${pluginId}` };
        } else {
          state.manageToast = {
            tone: 'error',
            spinning: false,
            text: `激活 ${pluginId} 失败：${res?.error || res?.health?.lastError || '未知错误'}`
          };
        }
      });
    }

    function activateAllInactiveFromUi() {
      void runManageAction('__activate_all__', '正在尝试激活异常/未激活插件...', async () => {
        const res = await hostBridgePost('/host/plugins/activate', {
          all: true,
          resetCircuit: true
        });
        if (state.disposed) return;
        if (Array.isArray(res?.activated)) {
          for (const id of res.activated) {
            api.reEnablePlugin(id);
            state.rendererErrors.delete(id);
          }
        }
        applyManagePayload(res);
        const okCount = Array.isArray(res?.activated) ? res.activated.length : 0;
        const failCount = Array.isArray(res?.failed) ? res.failed.length : 0;
        if (failCount === 0 && okCount > 0) {
          state.manageToast = { tone: 'info', spinning: false, text: `已激活 ${okCount} 个插件` };
        } else if (failCount > 0) {
          state.manageToast = {
            tone: 'warn',
            spinning: false,
            text: `已激活 ${okCount} 个插件，仍有 ${failCount} 个无法激活，请查看诊断`
          };
        } else {
          state.manageToast = { tone: 'info', spinning: false, text: '当前所有已启用插件均已激活' };
        }
      });
    }

    function repairPluginFromUi(pluginId, repairOpts = {}) {
      if (!pluginId) return;
      state.manageConfirmUninstallId = null;
      state.managePendingNativeUninstall = null;
      void runManageAction(pluginId, `正在修复 ${pluginId} 安装路径...`, async () => {
        const res = await hostBridgePost('/host/plugins/repair', {
          pluginId,
          mode: repairOpts.mode || 'auto',
          ...(repairOpts.spec ? { spec: repairOpts.spec } : {}),
          ...(repairOpts.localPath ? { localPath: repairOpts.localPath } : {}),
          copy: Boolean(repairOpts.copy)
        });
        if (state.disposed) return;
        if (res?.ok && res?.active) {
          api.reEnablePlugin(pluginId);
          state.rendererErrors.delete(pluginId);
          state.repairPathDrafts.delete(pluginId);
        }
        applyManagePayload(res);
        if (res?.ok && res?.active) {
          state.manageToast = { tone: 'info', spinning: false, text: `已修复路径并激活 ${pluginId}` };
        } else if (res?.repaired) {
          state.manageToast = {
            tone: 'warn',
            spinning: false,
            text: `已修复 ${pluginId} 路径，但激活失败：${res?.error || '请查看下方诊断'}`
          };
        } else {
          state.manageToast = {
            tone: 'error',
            spinning: false,
            text: `修复 ${pluginId} 失败：${res?.error || '未找到可用目录'}`
          };
        }
      });
    }

    function removeBrokenPluginFromUi(pluginId) {
      if (!pluginId) return;
      if (state.manageConfirmUninstallId !== pluginId) {
        state.manageConfirmUninstallId = pluginId;
        state.manageToast = { tone: 'warn', spinning: false, text: `再次点击「确认移除?」将清理失效插件记录 ${pluginId}` };
        renderSettingsBody();
        return;
      }
      state.manageConfirmUninstallId = null;
      state.managePendingNativeUninstall = null;
      void runManageAction(pluginId, `正在移除失效记录 ${pluginId}...`, async () => {
        const res = await hostBridgePost('/host/plugins/uninstall', {
          pluginId,
          confirmNativeDelete: true
        });
        if (state.disposed) return;
        state.rendererErrors.delete(pluginId);
        state.repairPathDrafts.delete(pluginId);
        applyManagePayload(res);
        if (state.selectedPluginId === pluginId) {
          state.selectedPluginId = null;
          state.focusPluginDiagnostics = null;
        }
        state.manageToast = { tone: 'info', spinning: false, text: `已移除失效插件记录 ${pluginId}` };
      });
    }

    async function fetchMarketplaceStats(forceRefresh = false) {
      if (!hasBridgeAvailable() || state.disposed || state.marketStatsLoading) return;
      state.marketStatsLoading = true;
      try {
        const res = await hostBridgePost('/host/marketplace/stats', { forceRefresh: Boolean(forceRefresh) });
        if (state.disposed) return;
        if (res && isPlainObject(res.stats) && Object.keys(res.stats).length > 0) {
          ingestMarketStatsMap(res.stats);
          if (
            state.settingsMode !== 'closed' &&
            state.activeSettingsTab === 'plugins' &&
            !state.selectedPluginId &&
            !state.fieldModal
          ) {
            renderSettingsBody();
          }
        }
      } catch {
        // 统计接口为增强信息，失败时静默降级不污染管理页主提示
      } finally {
        state.marketStatsLoading = false;
      }
    }

    async function fetchManagePlugins(opts = {}) {
      if (!hasBridgeAvailable()) return;
      state.manageLoading = true;
      state.manageError = '';
      if (state.settingsMode !== 'closed' && state.activeSettingsTab === 'plugins') {
        renderSettingsBody();
      }
      try {
        const res = await hostBridgePost('/host/plugins', {});
        applyManagePayload(res);
        void fetchMarketplaceStats(Boolean(opts?.forceRefreshStats));
      } catch (err) {
        state.manageError = err?.message || String(err);
      } finally {
        state.manageLoading = false;
        if (state.settingsMode !== 'closed' && state.activeSettingsTab === 'plugins') {
          renderSettingsBody();
        }
      }
    }

    async function runManageAction(busyId, pendingMsg, fn) {
      if (state.manageBusyId || state.disposed) return;
      state.manageBusyId = busyId;
      state.manageError = '';
      state.manageToast = { tone: 'info', spinning: true, text: pendingMsg };
      renderSettingsBody();
      try {
        await fn();
        if (state.disposed) return;
      } catch (err) {
        if (state.disposed) return;
        state.manageToast = { tone: 'error', spinning: false, text: `操作失败：${err?.message || String(err)}` };
      } finally {
        if (state.disposed) return;
        state.manageBusyId = null;
        if (state.settingsMode !== 'closed') {
          renderSettingsBody();
        }
      }
    }

    // <agy-settings-view> 渲染引擎
    function getActiveSettingsRootEl() {
      if (state.settingsMode === 'native') return nativeState.viewRootEl;
      if (state.settingsMode === 'modal') return modalSettingsRootEl;
      return null;
    }

    function getActiveModalContainerShadow() {
      if (state.settingsMode === 'native' && nativeState.mountShadow) {
        return nativeState.mountShadow;
      }
      return shadow || nativeState.mountShadow || null;
    }

    function closeFieldModal(rerenderSettings = false) {
      state.fieldModal = null;
      for (const rootContainer of [shadow, nativeState.mountShadow]) {
        if (!rootContainer) continue;
        const stale = rootContainer.querySelector?.('#agy-field-modal-backdrop');
        if (stale?.remove) stale.remove();
      }
      if (rerenderSettings && state.settingsMode !== 'closed') {
        renderSettingsBody();
      }
    }

    function renderFieldModal() {
      for (const rootContainer of [shadow, nativeState.mountShadow]) {
        if (!rootContainer) continue;
        const stale = rootContainer.querySelector?.('#agy-field-modal-backdrop');
        if (stale?.remove) stale.remove();
      }
      if (!state.fieldModal) return;
      const container = getActiveModalContainerShadow();
      if (!container || typeof doc?.createElement !== 'function') return;

      const modalState = state.fieldModal;
      const field = modalState.field || {};
      const modalTitle = pickLocaleText(field.modalTitle, pickLocaleText(field.label, field.key || '详情'));
      const modalDesc = pickLocaleText(field.description, '');
      const draftStr = String(modalState.draft ?? '');
      const savedStr = String(modalState.savedValue ?? '');
      const canReset = field.resetToDefault === true || typeof field.default === 'string';
      const defaultStr = typeof field.default === 'string' ? field.default : '';

      const backdrop = doc.createElement('div');
      backdrop.id = 'agy-field-modal-backdrop';
      backdrop.className = 'ag-field-modal-backdrop';
      backdrop.addEventListener('click', (ev) => {
        if (!ev || ev.target === backdrop) {
          closeFieldModal(false);
        }
      });

      const dialog = doc.createElement('div');
      dialog.id = 'agy-field-modal';
      dialog.className = 'ag-field-modal-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', modalTitle);

      const header = doc.createElement('div');
      header.className = 'ag-field-modal-header';

      const titleWrap = doc.createElement('div');
      titleWrap.className = 'ag-field-modal-title-wrap';
      const titleEl = doc.createElement('h3');
      titleEl.className = 'ag-field-modal-title';
      titleEl.textContent = modalTitle;
      titleWrap.appendChild(titleEl);
      if (modalDesc) {
        const descEl = doc.createElement('p');
        descEl.className = 'ag-field-modal-desc';
        descEl.textContent = modalDesc;
        titleWrap.appendChild(descEl);
      }
      header.appendChild(titleWrap);

      const headerActions = doc.createElement('div');
      headerActions.className = 'ag-field-modal-header-actions';

      const tabs = doc.createElement('div');
      tabs.className = 'ag-segmented';
      const previewTab = doc.createElement('button');
      previewTab.type = 'button';
      previewTab.className = 'ag-seg-btn';
      previewTab.setAttribute('data-field-modal-tab', 'preview');
      previewTab.setAttribute('data-active', modalState.mode === 'preview' ? 'true' : 'false');
      previewTab.textContent = 'Markdown 预览';
      previewTab.addEventListener('click', () => {
        if (!state.fieldModal || state.fieldModal.mode === 'preview') return;
        state.fieldModal.mode = 'preview';
        renderFieldModal();
      });

      const editTab = doc.createElement('button');
      editTab.type = 'button';
      editTab.className = 'ag-seg-btn';
      editTab.setAttribute('data-field-modal-tab', 'edit');
      editTab.setAttribute('data-active', modalState.mode === 'edit' ? 'true' : 'false');
      editTab.textContent = '编辑源码';
      editTab.addEventListener('click', () => {
        if (!state.fieldModal || state.fieldModal.mode === 'edit') return;
        state.fieldModal.mode = 'edit';
        renderFieldModal();
      });

      tabs.appendChild(previewTab);
      tabs.appendChild(editTab);
      headerActions.appendChild(tabs);

      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ag-icon-btn';
      closeBtn.setAttribute('data-field-modal-close', 'true');
      closeBtn.setAttribute('aria-label', '关闭弹窗');
      closeBtn.appendChild(createIconEl('close'));
      closeBtn.addEventListener('click', () => closeFieldModal(false));
      headerActions.appendChild(closeBtn);
      header.appendChild(headerActions);
      dialog.appendChild(header);

      const body = doc.createElement('div');
      body.className = 'ag-field-modal-body';

      const metaEl = doc.createElement('span');
      metaEl.className = 'ag-field-modal-meta';
      metaEl.setAttribute('data-field-modal-meta', field.key || '');
      const updateMetaText = (text) => {
        const s = String(text ?? '');
        const linesCount = s ? s.split(/\r\n?|\n/).length : 0;
        const dirtyLabel = s !== savedStr ? ' · 未保存' : '';
        metaEl.textContent = `${s.length} 字符 · ${linesCount} 行${dirtyLabel}`;
      };
      updateMetaText(draftStr);

      let textareaEl = null;
      if (modalState.mode === 'edit') {
        textareaEl = doc.createElement('textarea');
        textareaEl.className = 'settings-input ag-field-modal-textarea';
        textareaEl.value = draftStr;
        const ph = pickLocaleText(field.placeholder, '');
        if (ph) textareaEl.placeholder = ph;
        textareaEl.setAttribute('data-field-modal-textarea', field.key || '');
        textareaEl.setAttribute('aria-label', modalTitle);
        textareaEl.addEventListener('input', () => {
          if (!state.fieldModal) return;
          state.fieldModal.draft = String(textareaEl.value || '');
          updateMetaText(state.fieldModal.draft);
        });
        body.appendChild(textareaEl);
      } else {
        const previewEl = doc.createElement('div');
        previewEl.className = 'ag-md-preview';
        previewEl.setAttribute('data-field-modal-preview', 'true');
        if (draftStr.trim()) {
          previewEl.innerHTML = renderSimpleMarkdownToHtml(draftStr);
        } else {
          const emptyEl = doc.createElement('p');
          emptyEl.className = 'ag-md-empty';
          emptyEl.textContent = pickLocaleText(field.placeholder, '暂无内容，点击右上角「编辑源码」开始编写');
          previewEl.appendChild(emptyEl);
        }
        body.appendChild(previewEl);
      }
      dialog.appendChild(body);

      const footer = doc.createElement('div');
      footer.className = 'ag-field-modal-footer';

      const footerLeft = doc.createElement('div');
      footerLeft.className = 'ag-field-modal-footer-left';
      if (canReset) {
        const resetBtn = doc.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'ag-btn';
        resetBtn.setAttribute('data-field-modal-reset', field.key || '');
        resetBtn.textContent = '恢复默认';
        resetBtn.addEventListener('click', () => {
          if (!state.fieldModal) return;
          state.fieldModal.draft = defaultStr;
          renderFieldModal();
        });
        footerLeft.appendChild(resetBtn);
      }
      footerLeft.appendChild(metaEl);

      const footerRight = doc.createElement('div');
      footerRight.className = 'ag-field-modal-footer-right';
      const cancelBtn = doc.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'ag-btn';
      cancelBtn.setAttribute('data-field-modal-cancel', 'true');
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => closeFieldModal(false));

      const saveBtn = doc.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'ag-btn ag-btn-primary';
      saveBtn.setAttribute('data-field-modal-save', field.key || '');
      saveBtn.textContent = '保存';
      saveBtn.addEventListener('click', async () => {
        if (!state.fieldModal) return;
        const nextVal = String(state.fieldModal.draft ?? '');
        const commitFn = state.fieldModal.onCommit;
        closeFieldModal(false);
        if (typeof commitFn === 'function') {
          await commitFn(nextVal);
        }
      });

      footerRight.appendChild(cancelBtn);
      footerRight.appendChild(saveBtn);
      footer.appendChild(footerLeft);
      footer.appendChild(footerRight);
      dialog.appendChild(footer);

      backdrop.appendChild(dialog);
      container.appendChild(backdrop);
      if (textareaEl && typeof textareaEl.focus === 'function') {
        try { textareaEl.focus(); } catch {}
      }
    }

    function createIconEl(name, extraClass = '') {
      const span = doc.createElement('span');
      span.className = extraClass ? `ag-svg-icon ${extraClass}` : 'ag-svg-icon';
      span.setAttribute('aria-hidden', 'true');
      span.innerHTML = UI_SVG_ICONS[name] || '';
      return span;
    }

    function createSectionBlock(title, desc = '', rightActionsEl = null) {
      const section = doc.createElement('section');
      section.className = 'ag-sv-section';
      const head = doc.createElement('div');
      head.className = 'ag-sv-section-head';
      const heading = doc.createElement('div');
      heading.className = 'ag-sv-section-heading';
      const h2 = doc.createElement('h2');
      h2.className = 'ag-sv-section-title';
      h2.textContent = title;
      heading.appendChild(h2);
      if (desc) {
        const p = doc.createElement('p');
        p.className = 'ag-sv-section-desc';
        p.textContent = desc;
        heading.appendChild(p);
      }
      head.appendChild(heading);
      if (rightActionsEl) {
        const actionsWrap = doc.createElement('div');
        actionsWrap.className = 'ag-sv-section-actions';
        actionsWrap.appendChild(rightActionsEl);
        head.appendChild(actionsWrap);
      }
      section.appendChild(head);
      return section;
    }

    function ensureSettingsViewSkeleton(rootEl) {
      if (!rootEl) return null;
      let topbar = rootEl.querySelector ? rootEl.querySelector('.ag-sv-topbar') : null;
      let body = rootEl.querySelector ? rootEl.querySelector('.ag-sv-body') : null;
      if (topbar && body) return { topbar, body };

      clearElement(rootEl);

      const shell = doc.createElement('div');
      shell.className = 'ag-sv-shell';

      const hero = doc.createElement('div');
      hero.id = 'agy-settings-hero';
      hero.className = 'ag-sv-hero';
      const pageTitle = doc.createElement('h1');
      pageTitle.id = 'agy-settings-page-title';
      pageTitle.className = 'ag-sv-page-title';
      pageTitle.textContent = 'Agy-Daddy';
      const pageSubtitle = doc.createElement('p');
      pageSubtitle.id = 'agy-settings-page-subtitle';
      pageSubtitle.className = 'ag-sv-page-subtitle';
      pageSubtitle.textContent = SETTINGS_TAB_META[state.activeSettingsTab]?.subtitle || SETTINGS_TAB_META.plugins.subtitle;
      hero.appendChild(pageTitle);
      hero.appendChild(pageSubtitle);
      shell.appendChild(hero);

      topbar = doc.createElement('div');
      topbar.id = 'agy-settings-topbar';
      topbar.className = 'ag-sv-topbar';

      const segWrap = doc.createElement('div');
      segWrap.id = 'agy-settings-tab-bar';
      segWrap.className = 'ag-segmented';
      segWrap.setAttribute('role', 'tablist');
      segWrap.setAttribute('aria-label', 'Agy-Daddy 设置分区');
      for (const seg of SETTINGS_SEGMENTS) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.id = `agy-tab-${seg.id}`;
        btn.className = seg.id === state.activeSettingsTab ? 'switch-pill-btn active' : 'switch-pill-btn';
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', seg.id === state.activeSettingsTab ? 'true' : 'false');
        btn.setAttribute('data-segment', seg.id);
        btn.setAttribute('data-active', seg.id === state.activeSettingsTab ? 'true' : 'false');
        btn.textContent = seg.label;
        btn.addEventListener('click', () => {
          state.safeModeViewOpen = false;
          state.activeSettingsTab = seg.id;
          if (seg.id === 'plugins') {
            state.selectedPluginId = null;
            state.marketplaceOpen = false;
          }
          state.manageConfirmUninstallId = null;
          state.managePendingNativeUninstall = null;
          if (state.manageToast && !state.manageToast.spinning && state.manageToast.tone === 'info') {
            state.manageToast = null;
          }
          syncSettingsTopbarActiveState(rootEl);
          renderSettingsBody();
          if (seg.id === 'plugins' && hasBridgeAvailable()) {
            void fetchManagePlugins();
          }
        });
        segWrap.appendChild(btn);
      }

      const rightWrap = doc.createElement('div');
      rightWrap.className = 'ag-sv-topbar-right';

      const searchWrap = doc.createElement('div');
      searchWrap.id = 'agy-settings-search-wrap';
      searchWrap.className = 'ag-sv-search-wrap';
      searchWrap.appendChild(createIconEl('search', 'ag-sv-search-icon'));

      const searchInput = doc.createElement('input');
      searchInput.type = 'text';
      searchInput.id = 'agy-settings-search';
      searchInput.className = 'settings-input ag-sv-search';
      searchInput.placeholder = SETTINGS_TAB_META[state.activeSettingsTab]?.searchPlaceholder || '搜索插件或配置项...';
      searchInput.setAttribute('aria-label', '搜索插件或配置项');
      searchInput.value = state.settingsSearchQuery;
      searchInput.addEventListener('input', () => {
        state.settingsSearchQuery = String(searchInput.value || '');
        renderSettingsBody();
      });
      searchInput.addEventListener('change', () => {
        state.settingsSearchQuery = String(searchInput.value || '');
        renderSettingsBody();
      });
      searchWrap.appendChild(searchInput);

      const clearSearchBtn = doc.createElement('button');
      clearSearchBtn.type = 'button';
      clearSearchBtn.id = 'agy-settings-search-clear';
      clearSearchBtn.className = 'ag-sv-search-clear';
      clearSearchBtn.setAttribute('title', '清空搜索');
      clearSearchBtn.setAttribute('aria-label', '清空搜索');
      clearSearchBtn.appendChild(createIconEl('close'));
      setHidden(clearSearchBtn, !state.settingsSearchQuery);
      clearSearchBtn.addEventListener('click', () => {
        state.settingsSearchQuery = '';
        searchInput.value = '';
        renderSettingsBody();
        searchInput.focus?.();
      });
      searchWrap.appendChild(clearSearchBtn);
      rightWrap.appendChild(searchWrap);

      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.id = 'agy-settings-close-btn';
      closeBtn.className = 'ag-icon-btn';
      closeBtn.setAttribute('title', '关闭设置');
      closeBtn.setAttribute('aria-label', '关闭设置');
      closeBtn.appendChild(createIconEl('close'));
      const isNativeRoot = rootEl?.id === 'agy-native-settings-root' || state.settingsMode !== 'modal';
      setHidden(closeBtn, isNativeRoot);
      closeBtn.addEventListener('click', () => closeSettings());
      rightWrap.appendChild(closeBtn);

      topbar.appendChild(segWrap);
      topbar.appendChild(rightWrap);
      shell.appendChild(topbar);

      body = doc.createElement('div');
      body.className = 'ag-sv-body';
      body.id = 'agy-settings-body';
      shell.appendChild(body);
      rootEl.appendChild(shell);

      return { topbar, body };
    }

    function syncSettingsTopbarActiveState(rootEl) {
      if (!rootEl) return;
      for (const seg of SETTINGS_SEGMENTS) {
        const btn = rootEl.querySelector ? rootEl.querySelector(`#agy-tab-${seg.id}`) : null;
        if (!btn) continue;
        const active = seg.id === state.activeSettingsTab;
        btn.className = active ? 'switch-pill-btn active' : 'switch-pill-btn';
        btn.setAttribute('data-active', active ? 'true' : 'false');
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      const inPluginDetail = state.activeSettingsTab === 'plugins' && Boolean(state.selectedPluginId);
      const inDetail = inPluginDetail || (state.activeSettingsTab === 'plugins' && Boolean(state.marketplaceOpen));
      const isNativeRoot = rootEl?.id === 'agy-native-settings-root' || state.settingsMode !== 'modal';
      const topbarEl = rootEl.querySelector ? rootEl.querySelector('#agy-settings-topbar') : null;
      if (topbarEl) {
        setHidden(topbarEl, inPluginDetail && isNativeRoot);
      }
      const tabBarEl = rootEl.querySelector ? rootEl.querySelector('#agy-settings-tab-bar') : null;
      if (tabBarEl) {
        setHidden(tabBarEl, inPluginDetail);
      }
      const searchWrapEl = rootEl.querySelector ? rootEl.querySelector('#agy-settings-search-wrap') : null;
      if (searchWrapEl) {
        setHidden(searchWrapEl, inPluginDetail);
      }
      const heroEl = rootEl.querySelector ? rootEl.querySelector('#agy-settings-hero') : null;
      if (heroEl) {
        setHidden(heroEl, inDetail);
      }
      const subtitleEl = rootEl.querySelector ? rootEl.querySelector('#agy-settings-page-subtitle') : null;
      if (subtitleEl) {
        subtitleEl.textContent = state.safeModeViewOpen && state.activeSettingsTab === 'plugins'
          ? 'Safe Mode 诊断视图：统一展示故障摘要、14 锚点探活、插件健康与守护进程状态。'
          : (SETTINGS_TAB_META[state.activeSettingsTab]?.subtitle || SETTINGS_TAB_META.plugins.subtitle);
      }
      const searchEl = rootEl.querySelector ? rootEl.querySelector('#agy-settings-search') : null;
      if (searchEl) {
        if (searchEl.value !== state.settingsSearchQuery) {
          searchEl.value = state.settingsSearchQuery;
        }
        searchEl.placeholder = state.marketplaceOpen
          ? '搜索市场插件...'
          : (SETTINGS_TAB_META[state.activeSettingsTab]?.searchPlaceholder || '搜索插件或配置项...');
      }
      const clearSearchEl = rootEl.querySelector ? rootEl.querySelector('#agy-settings-search-clear') : null;
      if (clearSearchEl) {
        setHidden(clearSearchEl, !state.settingsSearchQuery);
      }
      const closeBtn = rootEl.querySelector ? rootEl.querySelector('#agy-settings-close-btn') : null;
      if (closeBtn) {
        setHidden(closeBtn, isNativeRoot);
      }
    }

    function renderToastBanner(body) {
      if (!state.manageToast && !state.manageError && !state.manageLoading) return;
      const toast = doc.createElement('div');
      toast.id = 'agy-manage-toast';
      toast.className = 'ag-manage-toast';
      toast.setAttribute('role', 'status');
      const tone = state.manageError ? 'error' : (state.manageToast?.tone || 'info');
      toast.setAttribute('data-tone', tone);

      const main = doc.createElement('div');
      main.className = 'ag-toast-main';
      const isSpinning = Boolean(state.manageLoading || state.manageToast?.spinning);
      if (isSpinning) {
        const sp = doc.createElement('span');
        sp.className = 'ag-spinner';
        main.appendChild(sp);
      } else {
        const dot = doc.createElement('span');
        dot.className = 'ag-status-dot';
        dot.setAttribute('data-tone', tone === 'error' ? 'danger' : (tone === 'warn' ? 'warn' : 'ok'));
        main.appendChild(dot);
      }
      const txt = doc.createElement('span');
      txt.textContent = state.manageError
        ? `加载失败：${state.manageError}`
        : (state.manageToast?.text || '正在加载插件列表...');
      main.appendChild(txt);
      toast.appendChild(main);

      if (!isSpinning) {
        const dismissBtn = doc.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.id = 'agy-manage-toast-dismiss';
        dismissBtn.className = 'ag-icon-btn';
        dismissBtn.setAttribute('title', '关闭提示');
        dismissBtn.setAttribute('aria-label', '关闭提示');
        dismissBtn.appendChild(createIconEl('close'));
        dismissBtn.addEventListener('click', () => {
          state.manageToast = null;
          state.manageError = '';
          renderSettingsBody();
        });
        toast.appendChild(dismissBtn);
      }
      body.appendChild(toast);
    }

    function filterPluginByQuery(plugin, queryLower) {
      if (!queryLower) return { matched: true, matchedFields: [] };
      const hay = `${plugin.id} ${plugin.displayName || ''} ${plugin.description || ''}`.toLowerCase();
      const matchedFields = [];
      for (const field of plugin.settingsSchema?.fields || []) {
        const fLabel = pickLocaleText(field.label, field.key);
        if (`${field.key} ${fLabel}`.toLowerCase().includes(queryLower)) {
          matchedFields.push(fLabel);
        }
      }
      for (const act of plugin.settingsSchema?.actions || []) {
        const aLabel = pickLocaleText(act.label, act.command || act.id || '');
        if (`${act.command || ''} ${aLabel}`.toLowerCase().includes(queryLower)) {
          matchedFields.push(aLabel);
        }
      }
      return {
        matched: hay.includes(queryLower) || matchedFields.length > 0,
        matchedFields
      };
    }

    function renderInstallBar(body, hasBridge, triggerInstall) {
      const section = createSectionBlock('安装插件');
      const installCard = doc.createElement('div');
      installCard.className = 'settings-card-box';
      installCard.id = 'agy-plugin-install-box';

      const wrap = doc.createElement('div');
      wrap.className = 'ag-install-bar-wrap';

      const installRow = doc.createElement('div');
      installRow.className = 'ag-install-row';

      const installInput = doc.createElement('input');
      installInput.type = 'text';
      installInput.id = 'agy-plugin-install-input';
      installInput.className = 'settings-input';
      installInput.placeholder = '输入本地目录路径、github:作者/仓库 或 npm:包名';
      installInput.setAttribute('aria-label', '插件来源地址');
      installInput.value = state.manageInstallSpec;
      installInput.addEventListener('input', () => { state.manageInstallSpec = installInput.value; });
      installInput.addEventListener('change', () => { state.manageInstallSpec = installInput.value; });
      installInput.addEventListener('keydown', (e) => {
        if (e?.key === 'Enter') triggerInstall(installInput.value);
      });

      const modeBtn = doc.createElement('button');
      modeBtn.type = 'button';
      modeBtn.id = 'agy-install-mode-btn';
      modeBtn.className = 'ag-btn ag-install-mode-btn';
      modeBtn.setAttribute('title', state.manageCopyMode
        ? '当前为复制安装，点击切换为本地软链'
        : '当前为本地软链，点击切换为复制安装');
      modeBtn.textContent = state.manageCopyMode ? '复制安装' : '本地软链';
      modeBtn.addEventListener('click', () => {
        state.manageCopyMode = !state.manageCopyMode;
        renderSettingsBody();
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
      installBtn.addEventListener('click', () => triggerInstall(installInput.value));

      installRow.appendChild(installInput);
      installRow.appendChild(modeBtn);
      installRow.appendChild(installBtn);
      wrap.appendChild(installRow);

      if (state.managePendingPerm) {
        const pInfo = state.managePendingPerm;
        const permBox = doc.createElement('div');
        permBox.id = 'agy-perm-confirm-box';
        permBox.className = 'ag-perm-confirm-box';
        const permTitle = doc.createElement('div');
        permTitle.className = 'ag-sv-row-title';
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
          renderSettingsBody();
        });
        permActions.appendChild(confirmBtn);
        permActions.appendChild(cancelPermBtn);
        permBox.appendChild(permActions);
        wrap.appendChild(permBox);
      }

      installCard.appendChild(wrap);
      section.appendChild(installCard);
      body.appendChild(section);
    }

    function getMarketplaceEntries(installedItems) {
      const seen = new Set();
      const entries = [];
      for (const cat of state.manageCatalog || []) {
        if (!cat?.id || seen.has(cat.id)) continue;
        seen.add(cat.id);
        entries.push({
          id: cat.id,
          displayName: pickLocaleText(cat.displayName, cat.id),
          description: pickLocaleText(cat.description, cat.recommendedSpec || cat.id),
          version: cat.version || '1.0.0',
          trustLevel: cat.trustLevel || (cat.id.startsWith('agy-daddy.') ? 'T0' : 'T1'),
          recommendedSpec: cat.recommendedSpec,
          repo: cat.repo || '',
          npmPackage: cat.npmPackage || '',
          sourceKind: cat.sourceKind || '',
          sourceSpec: cat.sourceSpec || '',
          marketStats: state.marketStats.get(cat.id) || (isPlainObject(cat.marketStats) ? cat.marketStats : null),
          installed: false
        });
      }
      for (const p of installedItems || []) {
        if (!p?.id || seen.has(p.id)) continue;
        seen.add(p.id);
        entries.push({
          id: p.id,
          displayName: p.displayName || p.id,
          description: p.description || p.id,
          version: p.version || '1.0.0',
          trustLevel: p.trustLevel || (p.id.startsWith('agy-daddy.') ? 'T0' : 'T1'),
          recommendedSpec: '',
          repo: p.repo || '',
          npmPackage: p.npmPackage || '',
          sourceKind: p.sourceKind || '',
          sourceSpec: p.sourceSpec || '',
          marketStats: state.marketStats.get(p.id) || (isPlainObject(p.marketStats) ? p.marketStats : null),
          installed: true
        });
      }
      return entries;
    }

    function renderMarketplaceCard(entry, hasBridge, triggerInstall) {
      const card = doc.createElement('div');
      card.className = 'ag-market-card';
      card.setAttribute(entry.installed ? 'data-market-installed-id' : 'data-catalog-id', entry.id);

      const head = doc.createElement('div');
      head.className = 'ag-market-card-head';

      const titleRow = doc.createElement('div');
      titleRow.className = 'ag-market-card-title-row';
      const title = doc.createElement('span');
      title.className = 'ag-market-card-title';
      title.textContent = entry.displayName || entry.id;
      const badge = doc.createElement('span');
      badge.className = 'agy-trust-badge';
      badge.setAttribute('data-trust', entry.trustLevel || 'T0');
      badge.textContent = entry.trustLevel === 'T1' ? 'T1 社区' : (entry.trustLevel === 'T0' ? 'T0 官方' : 'T2');
      titleRow.appendChild(title);
      titleRow.appendChild(badge);
      head.appendChild(titleRow);

      const desc = doc.createElement('div');
      desc.className = 'ag-market-card-desc';
      desc.textContent = entry.description || entry.id;
      head.appendChild(desc);
      card.appendChild(head);

      const stats = entry.marketStats || null;
      const hasGitHub = Boolean(
        stats?.githubRepo ||
        isGitHubSpec(entry.repo) ||
        isGitHubSpec(entry.sourceSpec) ||
        isGitHubSpec(entry.recommendedSpec)
      );
      const hasNpm = Boolean(
        stats?.npmPackage ||
        entry.npmPackage ||
        isNpmSpec(entry.sourceSpec) ||
        isNpmSpec(entry.recommendedSpec)
      );
      const hasAnyNumericStats = typeof stats?.githubStars === 'number' || typeof stats?.downloads === 'number';
      const isLocalOnly = stats?.eligible === false || (!hasGitHub && !hasNpm && !hasAnyNumericStats);

      const statsRow = doc.createElement('div');
      statsRow.className = 'ag-market-card-stats';
      statsRow.setAttribute('data-market-stats', entry.id);

      if (isLocalOnly) {
        const localSpan = doc.createElement('span');
        localSpan.className = 'ag-market-stat ag-market-stat-local';
        localSpan.setAttribute('data-market-stat', 'local');
        localSpan.setAttribute('title', '本地安装不计入 GitHub / npm 统计');
        localSpan.textContent = '仅本地安装';
        statsRow.appendChild(localSpan);
      } else {
        if (hasGitHub || typeof stats?.githubStars === 'number') {
          const starSpan = doc.createElement('span');
          starSpan.className = 'ag-market-stat';
          starSpan.setAttribute('data-market-stat', 'stars');
          const starTip = typeof stats?.githubStars === 'number'
            ? `GitHub 收藏数: ${stats.githubStars}${stats.githubRepo ? ` (${stats.githubRepo})` : ''}`
            : `GitHub 收藏数${stats?.githubRepo ? ` (${stats.githubRepo})` : ''}`;
          starSpan.setAttribute('title', starTip);
          starSpan.appendChild(createIconEl('star'));
          const starVal = doc.createElement('span');
          starVal.textContent = formatCompactCount(stats?.githubStars);
          starSpan.appendChild(starVal);
          statsRow.appendChild(starSpan);
        }

        const dlSpan = doc.createElement('span');
        dlSpan.className = 'ag-market-stat';
        dlSpan.setAttribute('data-market-stat', 'downloads');
        const dlParts = [];
        if (typeof stats?.githubDownloads === 'number') dlParts.push(`GitHub ${stats.githubDownloads}`);
        if (typeof stats?.npmDownloads === 'number') dlParts.push(`npm ${stats.npmDownloads}`);
        const dlTip = dlParts.length > 0
          ? `下载次数 (${dlParts.join(' + ')}, 不含本地安装)`
          : 'GitHub / npm 下载次数（不含本地安装）';
        dlSpan.setAttribute('title', dlTip);
        dlSpan.appendChild(createIconEl('download'));
        const dlVal = doc.createElement('span');
        dlVal.textContent = formatCompactCount(stats?.downloads);
        dlSpan.appendChild(dlVal);
        statsRow.appendChild(dlSpan);
      }
      card.appendChild(statsRow);

      const foot = doc.createElement('div');
      foot.className = 'ag-market-card-foot';
      const idSpan = doc.createElement('span');
      idSpan.className = 'ag-market-card-id';
      idSpan.textContent = `v${entry.version || '1.0.0'}`;
      foot.appendChild(idSpan);

      if (entry.installed) {
        const openBtn = doc.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'ag-btn';
        openBtn.setAttribute('data-market-open', entry.id);
        openBtn.textContent = '已安装';
        openBtn.addEventListener('click', () => {
          state.marketplaceOpen = false;
          state.selectedPluginId = entry.id;
          state.manageConfirmUninstallId = null;
          state.managePendingNativeUninstall = null;
          renderSettingsBody();
        });
        foot.appendChild(openBtn);
      } else {
        const addBtn = doc.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'ag-btn ag-btn-primary';
        addBtn.setAttribute('data-catalog-install', entry.id);
        addBtn.disabled = Boolean(state.manageBusyId) || !hasBridge;
        if (state.manageBusyId !== entry.id) {
          addBtn.appendChild(createIconEl('plus'));
        }
        const addLbl = doc.createElement('span');
        addLbl.textContent = state.manageBusyId === entry.id ? '安装中...' : '安装';
        addBtn.appendChild(addLbl);
        addBtn.addEventListener('click', () => {
          triggerInstall(entry.recommendedSpec, {
            busyId: entry.id,
            trustLevel: entry.trustLevel,
            copy: state.manageCopyMode
          });
        });
        foot.appendChild(addBtn);
      }
      card.appendChild(foot);
      return card;
    }

    function createInstallTrigger() {
      return (specVal, extraOpts = {}) => {
        const spec = String(specVal || '').trim();
        if (!spec) {
          state.manageToast = { tone: 'warn', spinning: false, text: '请输入插件目录路径、github: 或 npm: 地址' };
          renderSettingsBody();
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
    }

    function renderMarketplaceView(body) {
      const hasBridge = hasBridgeAvailable();
      const queryLower = state.settingsSearchQuery.trim().toLowerCase();
      const triggerInstall = createInstallTrigger();
      const allItems = getCombinedPlugins();
      const marketEntries = getMarketplaceEntries(allItems);
      const filtered = queryLower
        ? marketEntries.filter((e) => `${e.id} ${e.displayName} ${e.description}`.toLowerCase().includes(queryLower))
        : marketEntries;
      const uninstalledCount = marketEntries.filter((e) => !e.installed).length;

      const heroWrap = doc.createElement('div');
      heroWrap.className = 'ag-sv-detail-hero';
      heroWrap.id = 'agy-marketplace-header';

      const crumb = doc.createElement('div');
      crumb.className = 'ag-sv-breadcrumb';
      const backBtn = doc.createElement('button');
      backBtn.type = 'button';
      backBtn.id = 'agy-marketplace-back-btn';
      backBtn.className = 'ag-btn ag-btn-ghost';
      backBtn.appendChild(createIconEl('chevronLeft'));
      const backLbl = doc.createElement('span');
      backLbl.textContent = '返回通用设置';
      backBtn.appendChild(backLbl);
      backBtn.addEventListener('click', () => {
        state.marketplaceOpen = false;
        renderSettingsBody();
      });
      crumb.appendChild(backBtn);
      heroWrap.appendChild(crumb);

      const headRow = doc.createElement('div');
      headRow.className = 'ag-sv-detail-head-row';
      const identity = doc.createElement('div');
      identity.className = 'ag-sv-detail-identity';
      const titleEl = doc.createElement('h1');
      titleEl.className = 'ag-sv-detail-title';
      titleEl.textContent = '插件市场';
      const descEl = doc.createElement('div');
      descEl.className = 'ag-plugin-meta';
      descEl.textContent = `共 ${marketEntries.length} 个插件 · ${uninstalledCount} 个待安装`;
      identity.appendChild(titleEl);
      identity.appendChild(descEl);
      headRow.appendChild(identity);

      if (hasBridge) {
        const refreshBtn = doc.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.id = 'agy-marketplace-refresh-btn';
        refreshBtn.className = 'ag-btn';
        refreshBtn.disabled = Boolean(state.manageLoading || state.manageBusyId);
        refreshBtn.appendChild(createIconEl('refresh'));
        const rLbl = doc.createElement('span');
        rLbl.textContent = '刷新目录';
        refreshBtn.appendChild(rLbl);
        refreshBtn.addEventListener('click', () => { void fetchManagePlugins({ forceRefreshStats: true }); });
        headRow.appendChild(refreshBtn);
      }
      heroWrap.appendChild(headRow);
      body.appendChild(heroWrap);

      if (filtered.length === 0) {
        const emptyCard = doc.createElement('div');
        emptyCard.className = 'settings-card-box';
        const empty = doc.createElement('div');
        empty.className = 'ag-sv-empty';
        empty.textContent = queryLower ? `未找到匹配「${state.settingsSearchQuery}」的市场插件` : '暂无可展示的市场插件';
        emptyCard.appendChild(empty);
        body.appendChild(emptyCard);
        return;
      }

      const grid = doc.createElement('div');
      grid.id = 'agy-marketplace-full-grid';
      grid.className = 'ag-market-grid';
      for (const entry of filtered) {
        grid.appendChild(renderMarketplaceCard(entry, hasBridge, triggerInstall));
      }
      body.appendChild(grid);
    }

    function renderPluginsListView(body) {
      const hasBridge = hasBridgeAvailable();
      const queryLower = state.settingsSearchQuery.trim().toLowerCase();
      const triggerInstall = createInstallTrigger();

      // 1. 顶部常驻紧凑安装栏
      renderInstallBar(body, hasBridge, triggerInstall);

      // 2. 插件市场预览（默认展示 3 张卡片 + 更多按钮）
      const allItems = getCombinedPlugins();
      const marketEntries = getMarketplaceEntries(allItems);
      const filteredMarket = queryLower
        ? marketEntries.filter((e) => `${e.id} ${e.displayName} ${e.description}`.toLowerCase().includes(queryLower))
        : marketEntries;
      if (filteredMarket.length > 0) {
        const moreBtn = doc.createElement('button');
        moreBtn.type = 'button';
        moreBtn.id = 'agy-marketplace-more-btn';
        moreBtn.className = 'ag-btn';
        const moreLbl = doc.createElement('span');
        moreLbl.textContent = '更多';
        moreBtn.appendChild(moreLbl);
        moreBtn.appendChild(createIconEl('chevronRight'));
        moreBtn.addEventListener('click', () => {
          state.marketplaceOpen = true;
          renderSettingsBody();
        });

        const uninstalledCount = marketEntries.filter((e) => !e.installed).length;
        const marketSection = createSectionBlock(
          '插件市场',
          uninstalledCount > 0 ? `${uninstalledCount} 个可一键安装的新插件` : '官方与社区扩展目录',
          moreBtn
        );
        marketSection.id = 'agy-plugin-marketplace-preview';
        const grid = doc.createElement('div');
        grid.className = 'ag-market-grid';
        for (const entry of filteredMarket.slice(0, 3)) {
          grid.appendChild(renderMarketplaceCard(entry, hasBridge, triggerInstall));
        }
        marketSection.appendChild(grid);
        body.appendChild(marketSection);
      }

      // 3. 已安装插件列表
      const filtered = [];
      for (const p of allItems) {
        const res = filterPluginByQuery(p, queryLower);
        if (res.matched) filtered.push({ plugin: p, matchedFields: res.matchedFields });
      }

      const enabledCount = allItems.filter((p) => p.enabled !== false).length;
      const unusableList = allItems.filter((p) => Boolean(getPluginDiagnosticIssue(p)));
      const activatableList = unusableList.filter((p) => !getPluginDiagnosticIssue(p)?.isMissingPath);
      let listHeaderActions = null;
      if (hasBridge) {
        listHeaderActions = doc.createElement('div');
        listHeaderActions.className = 'ag-plugin-actions';
        if (activatableList.length > 0) {
          const actAllBtn = doc.createElement('button');
          actAllBtn.type = 'button';
          actAllBtn.id = 'agy-manage-activate-all-btn';
          actAllBtn.className = 'ag-btn ag-btn-primary';
          actAllBtn.disabled = Boolean(state.manageLoading || state.manageBusyId);
          actAllBtn.appendChild(createIconEl('play'));
          const actAllLbl = doc.createElement('span');
          actAllLbl.textContent = `一键激活 (${activatableList.length})`;
          actAllBtn.appendChild(actAllLbl);
          actAllBtn.addEventListener('click', () => { activateAllInactiveFromUi(); });
          listHeaderActions.appendChild(actAllBtn);
        }
        const refreshListBtn = doc.createElement('button');
        refreshListBtn.type = 'button';
        refreshListBtn.id = 'agy-manage-refresh-btn';
        refreshListBtn.className = 'ag-btn';
        refreshListBtn.disabled = Boolean(state.manageLoading || state.manageBusyId);
        refreshListBtn.appendChild(createIconEl('refresh'));
        const rLbl = doc.createElement('span');
        rLbl.textContent = '刷新';
        refreshListBtn.appendChild(rLbl);
        refreshListBtn.addEventListener('click', () => { void fetchManagePlugins(); });
        listHeaderActions.appendChild(refreshListBtn);
      }

      const installedSection = createSectionBlock(
        queryLower ? '匹配插件' : '已安装插件',
        queryLower
          ? `找到 ${filtered.length} / ${allItems.length} 个匹配项`
          : `共 ${allItems.length} 个插件，${enabledCount} 个已启用${unusableList.length > 0 ? `，${unusableList.length} 个异常/未激活` : ''}。点击条目查看详细配置。`,
        listHeaderActions
      );

      const card = doc.createElement('div');
      card.className = 'settings-card-box';
      card.id = 'agy-manage-settings-card';

      if (filtered.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'ag-sv-empty';
        empty.textContent = queryLower ? `未找到匹配「${state.settingsSearchQuery}」的插件或配置项` : '暂无已安装插件';
        card.appendChild(empty);
      }

      for (const { plugin: p, matchedFields } of filtered) {
        const item = doc.createElement('div');
        item.className = 'ag-plugin-item';
        item.setAttribute('data-plugin-id', p.id);
        item.setAttribute('data-enabled', p.enabled !== false ? 'true' : 'false');

        const top = doc.createElement('div');
        top.className = 'ag-plugin-top';

        const openDetail = () => {
          state.selectedPluginId = p.id;
          state.focusPluginDiagnostics = null;
          state.manageConfirmUninstallId = null;
          state.managePendingNativeUninstall = null;
          renderSettingsBody();
        };

        const mainArea = doc.createElement('div');
        mainArea.className = 'ag-plugin-main';
        mainArea.setAttribute('tabindex', '0');
        mainArea.setAttribute('role', 'button');
        mainArea.setAttribute('data-plugin-open-detail', p.id);
        mainArea.addEventListener('click', openDetail);
        mainArea.addEventListener('keydown', (ev) => {
          if (ev?.key === 'Enter' || ev?.key === ' ') {
            ev?.preventDefault?.();
            openDetail();
          }
        });

        const info = doc.createElement('div');
        info.className = 'ag-plugin-info';
        const nameSpan = doc.createElement('span');
        nameSpan.className = 'ag-plugin-name';
        nameSpan.textContent = p.displayName || p.id;
        const verSpan = doc.createElement('span');
        verSpan.className = 'ag-plugin-ver';
        verSpan.textContent = `v${p.version || '1.0.0'}`;
        const badge = doc.createElement('span');
        badge.className = 'agy-trust-badge';
        const tLevel = p.trustLevel || (p.id.startsWith('agy-daddy.') ? 'T0' : (p.id.startsWith('community.') ? 'T1' : 'T2'));
        badge.setAttribute('data-trust', tLevel);
        badge.textContent = tLevel === 'T0' ? 'T0 官方' : (tLevel === 'T1' ? 'T1 社区' : 'T2');
        info.appendChild(nameSpan);
        info.appendChild(verSpan);
        info.appendChild(badge);
        if (p.hasNative) {
          const nChip = doc.createElement('span');
          nChip.className = 'ag-chip';
          nChip.textContent = '原生扩展';
          info.appendChild(nChip);
        }
        const issue = getPluginDiagnosticIssue(p);
        if (issue?.isMissingPath) {
          const missChip = doc.createElement('span');
          missChip.className = 'ag-chip';
          missChip.setAttribute('data-tone', 'danger');
          missChip.textContent = issue.statusLabel;
          info.appendChild(missChip);
        } else if (p.enabled === false) {
          const offChip = doc.createElement('span');
          offChip.className = 'ag-chip';
          offChip.textContent = '已停用';
          info.appendChild(offChip);
        } else if (issue) {
          const warnChip = doc.createElement('span');
          warnChip.className = 'ag-chip';
          warnChip.setAttribute('data-tone', issue.tone);
          warnChip.textContent = issue.statusLabel;
          info.appendChild(warnChip);
        }
        mainArea.appendChild(info);

        const meta = doc.createElement('div');
        meta.className = issue?.isMissingPath ? 'ag-plugin-meta ag-plugin-meta-danger' : 'ag-plugin-meta';
        meta.textContent = issue?.isMissingPath
          ? issue.error
          : (p.description || p.id);
        mainArea.appendChild(meta);

        if (matchedFields.length > 0) {
          const matchRow = doc.createElement('div');
          matchRow.className = 'ag-channels-row';
          for (const fName of matchedFields.slice(0, 3)) {
            const chip = doc.createElement('span');
            chip.className = 'ag-chip';
            chip.textContent = `配置: ${fName}`;
            matchRow.appendChild(chip);
          }
          mainArea.appendChild(matchRow);
        }
        top.appendChild(mainArea);

        const actions = doc.createElement('div');
        actions.className = 'ag-plugin-actions';
        const isBusy = state.manageBusyId === p.id;
        if (isBusy) {
          const sp = doc.createElement('span');
          sp.className = 'ag-spinner';
          actions.appendChild(sp);
        }

        if (p.hasTopbarUnits) {
          const pinned = isPluginPinned(p.id);
          const pinBtn = doc.createElement('button');
          pinBtn.type = 'button';
          pinBtn.className = 'ag-pin-btn';
          pinBtn.setAttribute('data-plugin-pin', p.id);
          pinBtn.setAttribute('data-pinned', pinned ? 'true' : 'false');
          const pinTip = pinned ? '已固定到顶栏（点击收进溢出菜单）' : '已收进溢出菜单（点击固定到顶栏）';
          pinBtn.setAttribute('title', pinTip);
          pinBtn.setAttribute('aria-label', pinTip);
          pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
          pinBtn.appendChild(createIconEl(pinned ? 'pinFilled' : 'pin'));
          pinBtn.addEventListener('click', (ev) => {
            ev?.stopPropagation?.();
            setPluginPinned(p.id, !pinned);
          });
          actions.appendChild(pinBtn);
        }

        if (issue?.isMissingPath && hasBridge) {
          if (issue.bestRepair) {
            const repBtn = doc.createElement('button');
            repBtn.type = 'button';
            repBtn.className = 'ag-btn ag-btn-primary';
            repBtn.setAttribute('data-plugin-list-repair', p.id);
            repBtn.setAttribute('title', `${issue.bestRepair.label}：${issue.bestRepair.target}`);
            repBtn.disabled = Boolean(state.manageBusyId);
            repBtn.textContent = '一键修复';
            repBtn.addEventListener('click', (ev) => {
              ev?.stopPropagation?.();
              repairPluginFromUi(p.id, { mode: 'auto' });
            });
            actions.appendChild(repBtn);
          } else {
            const inspRepBtn = doc.createElement('button');
            inspRepBtn.type = 'button';
            inspRepBtn.className = 'ag-btn';
            inspRepBtn.setAttribute('data-plugin-list-inspect-repair', p.id);
            inspRepBtn.disabled = Boolean(state.manageBusyId);
            inspRepBtn.textContent = '修复路径';
            inspRepBtn.addEventListener('click', (ev) => {
              ev?.stopPropagation?.();
              state.selectedPluginId = p.id;
              state.focusPluginDiagnostics = p.id;
              state.manageConfirmUninstallId = null;
              state.managePendingNativeUninstall = null;
              renderSettingsBody();
            });
            actions.appendChild(inspRepBtn);
          }
          const rmConfirming = state.manageConfirmUninstallId === p.id;
          const rmBtn = doc.createElement('button');
          rmBtn.type = 'button';
          rmBtn.className = 'ag-btn ag-btn-danger';
          rmBtn.setAttribute('data-plugin-list-remove-broken', p.id);
          rmBtn.disabled = Boolean(state.manageBusyId);
          rmBtn.textContent = rmConfirming ? '确认移除?' : '移除';
          rmBtn.addEventListener('click', (ev) => {
            ev?.stopPropagation?.();
            removeBrokenPluginFromUi(p.id);
          });
          actions.appendChild(rmBtn);
        } else if (issue && hasBridge) {
          const actBtn = doc.createElement('button');
          actBtn.type = 'button';
          actBtn.className = 'ag-btn ag-btn-primary';
          actBtn.setAttribute('data-plugin-list-activate', p.id);
          actBtn.disabled = Boolean(state.manageBusyId);
          actBtn.textContent = issue.circuitOpen ? '解除并激活' : '激活';
          actBtn.addEventListener('click', (ev) => {
            ev?.stopPropagation?.();
            activatePluginFromUi(p.id, { resetCircuit: true });
          });
          actions.appendChild(actBtn);
        }

        const toggleWrap = doc.createElement('label');
        toggleWrap.className = 'ag-toggle-label';
        toggleWrap.setAttribute('title', p.enabled !== false ? '点击停用插件' : '点击启用插件');
        const toggleInput = doc.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.checked = p.enabled !== false;
        toggleInput.disabled = Boolean(state.manageBusyId) || !hasBridge;
        toggleInput.setAttribute('data-plugin-toggle', p.id);
        toggleInput.setAttribute('aria-label', `启停 ${p.displayName || p.id}`);
        toggleInput.addEventListener('change', () => {
          const want = Boolean(toggleInput.checked);
          state.manageConfirmUninstallId = null;
          state.managePendingNativeUninstall = null;
          void runManageAction(p.id, `正在${want ? '启用' : '停用'} ${p.id}...`, async () => {
            const res = await hostBridgePost('/host/plugins/toggle', { pluginId: p.id, enabled: want });
            applyManagePayload(res);
            if (want && (res?.activationError || res?.reload?.active === false)) {
              state.manageToast = {
                tone: 'warn',
                spinning: false,
                text: `已启用 ${p.id}，但尚未激活：${res?.activationError || res?.reload?.error || '请进入详情诊断'}`
              };
            } else {
              state.manageToast = { tone: 'info', spinning: false, text: `已${want ? '启用' : '停用'} ${p.id}` };
            }
          });
        });
        toggleWrap.appendChild(toggleInput);
        actions.appendChild(toggleWrap);

        const chevronBtn = doc.createElement('button');
        chevronBtn.type = 'button';
        chevronBtn.className = 'ag-chevron-btn';
        chevronBtn.setAttribute('data-plugin-detail', p.id);
        chevronBtn.setAttribute('title', '进入插件详情与设置');
        chevronBtn.setAttribute('aria-label', `进入 ${p.displayName || p.id} 详情`);
        chevronBtn.appendChild(createIconEl('chevronRight'));
        chevronBtn.addEventListener('click', (ev) => {
          ev?.stopPropagation?.();
          openDetail();
        });
        actions.appendChild(chevronBtn);

        top.appendChild(actions);
        item.appendChild(top);
        card.appendChild(item);
      }
      installedSection.appendChild(card);
      body.appendChild(installedSection);

      // 4. 运行与诊断（摘要 + 可折叠明细）
      renderDiagnosticsSection(body);
    }

    function renderPluginDetailView(body, pluginId) {
      const hasBridge = hasBridgeAvailable();
      const allItems = getCombinedPlugins();
      const p = allItems.find((x) => x.id === pluginId) || {
        id: pluginId,
        displayName: pluginId,
        description: '',
        version: '1.0.0',
        trustLevel: pluginId.startsWith('agy-daddy.') ? 'T0' : (pluginId.startsWith('community.') ? 'T1' : 'T2'),
        enabled: true,
        active: state.pluginInstances.has(pluginId),
        hasNative: false,
        hasRollback: false,
        permissions: [],
        settingsSchema: state.pluginMeta.get(pluginId)?.settingsSchema || null,
        settingsValues: getPluginSettings(pluginId),
        commands: state.pluginMeta.get(pluginId)?.commands || [],
        topbarUnits: state.pluginMeta.get(pluginId)?.topbarUnits || [],
        hasTopbarUnits: Array.from(state.units.values()).some((u) => u.pluginId === pluginId),
        sourceKind: 'memory'
      };

      const issue = getPluginDiagnosticIssue(p);

      // 1. 详情页头部：轻量返回 + Antigravity 风格页头 + 生命周期操作
      const heroWrap = doc.createElement('div');
      heroWrap.className = 'ag-sv-detail-hero';
      heroWrap.id = 'agy-plugin-detail-header';
      heroWrap.setAttribute('data-detail-plugin-id', p.id);

      const crumb = doc.createElement('div');
      crumb.className = 'ag-sv-breadcrumb';
      const backBtn = doc.createElement('button');
      backBtn.type = 'button';
      backBtn.id = 'agy-detail-back-btn';
      backBtn.className = 'ag-btn ag-btn-ghost';
      backBtn.appendChild(createIconEl('chevronLeft'));
      const backLbl = doc.createElement('span');
      backLbl.textContent = '返回插件列表';
      backBtn.appendChild(backLbl);
      backBtn.addEventListener('click', () => {
        state.selectedPluginId = null;
        state.focusPluginDiagnostics = null;
        state.manageConfirmUninstallId = null;
        state.managePendingNativeUninstall = null;
        state.openComboboxKey = null;
        state.commandEdits.clear();
        renderSettingsBody();
      });
      crumb.appendChild(backBtn);
      heroWrap.appendChild(crumb);

      const headRow = doc.createElement('div');
      headRow.className = 'ag-sv-detail-head-row';

      const identity = doc.createElement('div');
      identity.className = 'ag-sv-detail-identity';
      const titleRow = doc.createElement('div');
      titleRow.className = 'ag-sv-detail-title-row';
      const titleEl = doc.createElement('h1');
      titleEl.className = 'ag-sv-detail-title';
      titleEl.textContent = p.displayName || p.id;
      const verEl = doc.createElement('span');
      verEl.className = 'ag-plugin-ver';
      verEl.textContent = `v${p.version || '1.0.0'}`;
      const badge = doc.createElement('span');
      badge.className = 'agy-trust-badge';
      const tLevel = p.trustLevel || 'T2';
      badge.setAttribute('data-trust', tLevel);
      badge.textContent = tLevel === 'T0' ? 'T0 官方' : (tLevel === 'T1' ? 'T1 社区' : 'T2');
      titleRow.appendChild(titleEl);
      titleRow.appendChild(verEl);
      titleRow.appendChild(badge);
      if (p.hasNative) {
        const nChip = doc.createElement('span');
        nChip.className = 'ag-chip';
        nChip.textContent = '原生扩展';
        titleRow.appendChild(nChip);
      }
      identity.appendChild(titleRow);

      const descEl = doc.createElement('div');
      descEl.className = 'ag-plugin-meta';
      descEl.textContent = p.description ? `${p.description} · ${p.id}` : p.id;
      identity.appendChild(descEl);
      headRow.appendChild(identity);

      const rightCtrl = doc.createElement('div');
      rightCtrl.className = 'ag-sv-detail-toolbar';
      if (hasBridge) {
        if (issue?.isMissingPath) {
          if (issue.bestRepair) {
            const repBtn = doc.createElement('button');
            repBtn.type = 'button';
            repBtn.className = 'ag-btn ag-btn-primary';
            repBtn.setAttribute('data-plugin-repair', p.id);
            repBtn.disabled = Boolean(state.manageBusyId);
            repBtn.appendChild(createIconEl('play'));
            const repLbl = doc.createElement('span');
            repLbl.textContent = '一键修复';
            repBtn.appendChild(repLbl);
            repBtn.addEventListener('click', () => {
              repairPluginFromUi(p.id, { mode: 'auto' });
            });
            rightCtrl.appendChild(repBtn);
          }
        } else if (p.enabled !== false && (!p.active || issue)) {
          const actBtn = doc.createElement('button');
          actBtn.type = 'button';
          actBtn.className = 'ag-btn ag-btn-primary';
          actBtn.setAttribute('data-plugin-activate', p.id);
          actBtn.disabled = Boolean(state.manageBusyId);
          actBtn.appendChild(createIconEl('play'));
          const actLbl = doc.createElement('span');
          actLbl.textContent = issue?.circuitOpen ? '解除熔断并激活' : '立即激活';
          actBtn.appendChild(actLbl);
          actBtn.addEventListener('click', () => {
            activatePluginFromUi(p.id, { resetCircuit: true });
          });
          rightCtrl.appendChild(actBtn);
        }

        const reloadBtn = doc.createElement('button');
        reloadBtn.type = 'button';
        reloadBtn.className = 'ag-btn';
        reloadBtn.setAttribute('data-plugin-reload', p.id);
        reloadBtn.disabled = Boolean(state.manageBusyId) || p.enabled === false;
        reloadBtn.appendChild(createIconEl('refresh'));
        const rlLbl = doc.createElement('span');
        rlLbl.textContent = '重载';
        reloadBtn.appendChild(rlLbl);
        reloadBtn.addEventListener('click', () => {
          state.manageConfirmUninstallId = null;
          state.managePendingNativeUninstall = null;
          void runManageAction(p.id, `正在热重载 ${p.id}...`, async () => {
            const res = await hostBridgePost('/host/reload', { pluginId: p.id });
            applyManagePayload(res);
            state.manageToast = { tone: 'info', spinning: false, text: `已热重载 ${p.id}` };
          });
        });
        rightCtrl.appendChild(reloadBtn);

        if (p.hasRollback) {
          const rbBtn = doc.createElement('button');
          rbBtn.type = 'button';
          rbBtn.className = 'ag-btn';
          rbBtn.textContent = '回滚';
          rbBtn.setAttribute('data-plugin-rollback', p.id);
          rbBtn.disabled = Boolean(state.manageBusyId);
          rbBtn.addEventListener('click', () => {
            state.manageConfirmUninstallId = null;
          state.managePendingNativeUninstall = null;
            void runManageAction(p.id, `正在回滚 ${p.id}...`, async () => {
              const res = await hostBridgePost('/host/plugins/rollback', { pluginId: p.id });
              applyManagePayload(res);
              state.manageToast = { tone: 'info', spinning: false, text: `已回滚 ${p.id}` };
            });
          });
          rightCtrl.appendChild(rbBtn);
        }

        if (p.sourceKind !== 'memory') {
          const confirming = !p.hasNative && state.manageConfirmUninstallId === p.id;
          const unBtn = doc.createElement('button');
          unBtn.type = 'button';
          unBtn.className = 'ag-btn ag-btn-danger';
          unBtn.textContent = confirming ? '确认卸载?' : '卸载';
          unBtn.setAttribute('data-plugin-uninstall', p.id);
          unBtn.disabled = Boolean(state.manageBusyId);
          unBtn.addEventListener('click', () => {
            if (p.hasNative) {
              state.manageConfirmUninstallId = null;
              state.managePendingNativeUninstall = {
                pluginId: p.id,
                displayName: p.displayName || p.id,
                nativeInfo: p.nativeInfo || null
              };
              state.manageToast = {
                tone: 'warn',
                spinning: false,
                text: `插件 ${p.displayName || p.id} 包含原生扩展，请确认下方删除提示后再卸载`
              };
              renderSettingsBody();
              return;
            }
            if (!confirming) {
              state.manageConfirmUninstallId = p.id;
              state.manageToast = { tone: 'warn', spinning: false, text: `再次点击「确认卸载?」将移除 ${p.id}` };
              renderSettingsBody();
              return;
            }
            state.manageConfirmUninstallId = null;
            state.managePendingNativeUninstall = null;
            void runManageAction(p.id, `正在卸载 ${p.id}...`, async () => {
              const res = await hostBridgePost('/host/plugins/uninstall', { pluginId: p.id });
              if (res?.needsNativeUninstallConfirm) {
                state.managePendingNativeUninstall = {
                  pluginId: p.id,
                  displayName: p.displayName || p.id,
                  nativeInfo: res.nativeInfo || p.nativeInfo || null
                };
                state.manageToast = { tone: 'warn', spinning: false, text: res.error || '请确认删除原生扩展' };
                return;
              }
              applyManagePayload(res);
              state.selectedPluginId = null;
              state.manageToast = {
                tone: 'info',
                spinning: false,
                text: `已卸载 ${p.id}${res.nativeCleanup?.removed ? '（已同步清理原生扩展）' : ''}`
              };
            });
          });
          rightCtrl.appendChild(unBtn);
        }
      }
      if (rightCtrl.children.length > 0) {
        headRow.appendChild(rightCtrl);
      }
      heroWrap.appendChild(headRow);
      body.appendChild(heroWrap);

      if (state.managePendingNativeUninstall?.pluginId === p.id) {
        const pending = state.managePendingNativeUninstall;
        const nInfo = pending.nativeInfo || p.nativeInfo || {};
        const confirmBox = doc.createElement('div');
        confirmBox.id = 'agy-native-uninstall-confirm-box';
        confirmBox.className = 'ag-native-uninstall-box';

        const cTitle = doc.createElement('div');
        cTitle.className = 'ag-sv-row-title';
        cTitle.textContent = `确认卸载「${pending.displayName}」并删除原生扩展？`;
        confirmBox.appendChild(cTitle);

        const cDesc = doc.createElement('div');
        cDesc.className = 'ag-sv-row-desc';
        cDesc.textContent = nInfo.targetDir
          ? `此操作将卸载插件并同步删除已注入的原生扩展目录与备份：${nInfo.targetDir}`
          : '此操作将卸载插件并同步删除已注入的原生扩展产物。';
        confirmBox.appendChild(cDesc);

        const assetTags = doc.createElement('div');
        assetTags.className = 'ag-channels-row';
        const decl = nInfo.declared || {};
        const synced = nInfo.syncedAssets || {};
        const tagLabels = [];
        if ((decl.rules?.length || 0) > 0 || (synced.rules?.length || 0) > 0) {
          tagLabels.push(`Rules: ${(synced.rules?.length ? synced.rules : decl.rules).join(', ')}`);
        }
        if ((decl.skills?.length || 0) > 0 || (synced.skills?.length || 0) > 0) {
          tagLabels.push(`Skills: ${(synced.skills?.length ? synced.skills : decl.skills).join(', ')}`);
        }
        if ((decl.mcp?.length || 0) > 0 || synced.mcp) {
          tagLabels.push(`MCP Server: ${(decl.mcp?.length ? decl.mcp : ['mcp.json']).join(', ')}`);
        }
        if ((decl.hooks?.length || 0) > 0 || synced.hooks) {
          tagLabels.push(`Hooks: ${(decl.hooks?.length ? decl.hooks : ['hooks.json']).join(', ')}`);
        }
        for (const lbl of tagLabels) {
          const chip = doc.createElement('span');
          chip.className = 'ag-chip';
          chip.setAttribute('data-tone', 'danger');
          chip.textContent = lbl;
          assetTags.appendChild(chip);
        }
        if (tagLabels.length > 0) {
          confirmBox.appendChild(assetTags);
        }

        const cActions = doc.createElement('div');
        cActions.className = 'ag-panel-actions';
        const confirmDelBtn = doc.createElement('button');
        confirmDelBtn.type = 'button';
        confirmDelBtn.id = 'agy-native-uninstall-confirm-btn';
        confirmDelBtn.className = 'ag-btn ag-btn-danger';
        confirmDelBtn.textContent = '确认删除并卸载';
        confirmDelBtn.disabled = Boolean(state.manageBusyId);
        confirmDelBtn.addEventListener('click', () => {
          state.managePendingNativeUninstall = null;
          void runManageAction(p.id, `正在卸载 ${p.id} 并清理原生扩展...`, async () => {
            const res = await hostBridgePost('/host/plugins/uninstall', {
              pluginId: p.id,
              confirmNativeDelete: true
            });
            applyManagePayload(res);
            state.selectedPluginId = null;
            state.manageToast = {
              tone: 'info',
              spinning: false,
              text: `已卸载 ${p.id}${res.nativeCleanup?.removed ? '（已删除原生扩展）' : ''}`
            };
          });
        });

        const cancelDelBtn = doc.createElement('button');
        cancelDelBtn.type = 'button';
        cancelDelBtn.id = 'agy-native-uninstall-cancel-btn';
        cancelDelBtn.className = 'ag-btn';
        cancelDelBtn.textContent = '取消';
        cancelDelBtn.addEventListener('click', () => {
          state.managePendingNativeUninstall = null;
          state.manageToast = null;
          renderSettingsBody();
        });

        cActions.appendChild(confirmDelBtn);
        cActions.appendChild(cancelDelBtn);
        confirmBox.appendChild(cActions);
        body.appendChild(confirmBox);
      }

      // 2. 运行状态与权限分组卡片
      const statusSection = createSectionBlock('运行状态与权限');
      const statusCard = doc.createElement('div');
      statusCard.className = 'settings-card-box';

      const enableRow = doc.createElement('div');
      enableRow.className = 'settings-pref-row';
      const enableInfo = doc.createElement('div');
      enableInfo.className = 'ag-sv-row-info';
      const enableTitle = doc.createElement('span');
      enableTitle.className = 'ag-sv-row-title';
      enableTitle.textContent = '启用插件';
      const enableDesc = doc.createElement('span');
      enableDesc.className = 'ag-sv-row-desc';
      if (issue?.isMissingPath) {
        enableDesc.textContent = '插件目录或软链目标已丢失，修复路径后即可自动激活';
      } else if (p.enabled === false) {
        enableDesc.textContent = '当前已停用，开启后立即热加载';
      } else if (issue) {
        enableDesc.textContent = issue.circuitOpen
          ? '已触发熔断保护，请查看下方诊断并点击「解除熔断并激活」'
          : (issue.statusKind === 'renderer_error'
              ? '后端已启动但页面注入异常，可点击右侧「立即激活」重试'
              : '已启用但尚未激活，可点击右侧「立即激活」或查看下方插件诊断');
      } else {
        enableDesc.textContent = '当前运行中，停用后将卸载页面注入与服务';
      }
      enableInfo.appendChild(enableTitle);
      enableInfo.appendChild(enableDesc);

      const enableActions = doc.createElement('div');
      enableActions.className = 'ag-plugin-actions';
      if (hasBridge && issue?.isMissingPath && issue.bestRepair) {
        const inlineRepBtn = doc.createElement('button');
        inlineRepBtn.type = 'button';
        inlineRepBtn.id = 'agy-detail-repair-btn';
        inlineRepBtn.className = 'ag-btn ag-btn-primary';
        inlineRepBtn.setAttribute('data-plugin-repair', p.id);
        inlineRepBtn.disabled = Boolean(state.manageBusyId);
        inlineRepBtn.textContent = '一键修复';
        inlineRepBtn.addEventListener('click', () => {
          repairPluginFromUi(p.id, { mode: 'auto' });
        });
        enableActions.appendChild(inlineRepBtn);
      } else if (hasBridge && p.enabled !== false && (!p.active || issue)) {
        const inlineActBtn = doc.createElement('button');
        inlineActBtn.type = 'button';
        inlineActBtn.id = 'agy-detail-activate-btn';
        inlineActBtn.className = 'ag-btn ag-btn-primary';
        inlineActBtn.setAttribute('data-plugin-activate', p.id);
        inlineActBtn.disabled = Boolean(state.manageBusyId);
        inlineActBtn.textContent = issue?.circuitOpen ? '解除熔断并激活' : '立即激活';
        inlineActBtn.addEventListener('click', () => {
          activatePluginFromUi(p.id, { resetCircuit: true });
        });
        enableActions.appendChild(inlineActBtn);
      }

      const toggleWrap = doc.createElement('label');
      toggleWrap.className = 'ag-toggle-label';
      const toggleInput = doc.createElement('input');
      toggleInput.type = 'checkbox';
      toggleInput.checked = p.enabled !== false;
      toggleInput.disabled = Boolean(state.manageBusyId) || !hasBridge;
      toggleInput.setAttribute('data-plugin-toggle', p.id);
      toggleInput.setAttribute('aria-label', `启停 ${p.displayName || p.id}`);
      toggleInput.addEventListener('change', () => {
        const want = Boolean(toggleInput.checked);
        state.manageConfirmUninstallId = null;
        void runManageAction(p.id, `正在${want ? '启用' : '停用'} ${p.id}...`, async () => {
          const res = await hostBridgePost('/host/plugins/toggle', { pluginId: p.id, enabled: want });
          applyManagePayload(res);
          if (want && (res?.activationError || res?.reload?.active === false)) {
            state.manageToast = {
              tone: 'warn',
              spinning: false,
              text: `已启用 ${p.id}，但尚未激活：${res?.activationError || res?.reload?.error || '请查看下方诊断'}`
            };
          } else {
            state.manageToast = { tone: 'info', spinning: false, text: `已${want ? '启用' : '停用'} ${p.id}` };
          }
        });
      });
      toggleWrap.appendChild(toggleInput);
      enableActions.appendChild(toggleWrap);
      enableRow.appendChild(enableInfo);
      enableRow.appendChild(enableActions);
      statusCard.appendChild(enableRow);

      if (p.hasTopbarUnits) {
        const pinRow = doc.createElement('div');
        pinRow.className = 'settings-pref-row';
        const pinInfo = doc.createElement('div');
        pinInfo.className = 'ag-sv-row-info';
        const pinTitle = doc.createElement('span');
        pinTitle.className = 'ag-sv-row-title';
        pinTitle.textContent = '顶栏胶囊固定';
        const pinDesc = doc.createElement('span');
        pinDesc.className = 'ag-sv-row-desc';
        pinDesc.textContent = '固定后在 Antigravity 顶栏常驻显示，取消固定将收入溢出菜单';
        pinInfo.appendChild(pinTitle);
        pinInfo.appendChild(pinDesc);

        const pinned = isPluginPinned(p.id);
        const pinBtn = doc.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'ag-btn';
        pinBtn.setAttribute('data-plugin-pin', p.id);
        pinBtn.setAttribute('data-pinned', pinned ? 'true' : 'false');
        pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
        pinBtn.appendChild(createIconEl(pinned ? 'pinFilled' : 'pin'));
        const pinLbl = doc.createElement('span');
        pinLbl.textContent = pinned ? '顶栏固定' : '已收入菜单';
        pinBtn.appendChild(pinLbl);
        pinBtn.addEventListener('click', () => {
          setPluginPinned(p.id, !pinned);
        });
        pinRow.appendChild(pinInfo);
        pinRow.appendChild(pinBtn);
        statusCard.appendChild(pinRow);
      }

      if (Array.isArray(p.permissions) && p.permissions.length > 0) {
        const permRowWrap = doc.createElement('div');
        permRowWrap.className = 'settings-pref-row';
        const permInfo = doc.createElement('div');
        permInfo.className = 'ag-sv-row-info';
        const permTitle = doc.createElement('span');
        permTitle.className = 'ag-sv-row-title';
        permTitle.textContent = '已声明权限';
        const permTags = doc.createElement('div');
        permTags.className = 'ag-channels-row';
        for (const perm of p.permissions) {
          const chip = doc.createElement('span');
          chip.className = 'ag-chip';
          chip.setAttribute('data-tone', 'muted');
          chip.textContent = perm;
          permTags.appendChild(chip);
        }
        permInfo.appendChild(permTitle);
        permInfo.appendChild(permTags);
        permRowWrap.appendChild(permInfo);
        statusCard.appendChild(permRowWrap);
      }

      const metric = getMetric(p.id);
      const crashes = Math.max(metric.crashes, Number(p.health?.crashesInWindow || 0));
      const healthRow = doc.createElement('div');
      healthRow.className = 'settings-pref-row';
      const healthInfo = doc.createElement('div');
      healthInfo.className = 'ag-sv-row-info';
      const healthTitle = doc.createElement('span');
      healthTitle.className = 'ag-sv-row-title';
      healthTitle.textContent = '运行指标';
      const healthEl = doc.createElement('span');
      healthEl.id = 'agy-detail-health-summary';
      healthEl.className = 'ag-sv-row-desc';
      healthEl.textContent = `${p.enabled === false ? '已停用' : (p.active ? '运行中' : '未激活')} · mount=${metric.mountMs}ms · obs=${metric.observerMs}ms · timers=${metric.timersCount} · crashes=${crashes}`;
      healthInfo.appendChild(healthTitle);
      healthInfo.appendChild(healthEl);
      healthRow.appendChild(healthInfo);
      statusCard.appendChild(healthRow);

      statusSection.appendChild(statusCard);
      body.appendChild(statusSection);

      // 2.2 插件诊断（针对当前插件的激活异常、熔断、注入故障与修复入口）
      const diagFocused = state.focusPluginDiagnostics === p.id;
      const diagSection = createSectionBlock(
        '插件诊断',
        issue
          ? '检测到该插件当前异常，请查看具体原因并尝试激活或修复。'
          : '查看当前插件激活链路、运行世界与熔断健康度。'
      );
      diagSection.id = 'agy-plugin-diagnostics-section';
      const diagCard = doc.createElement('div');
      diagCard.id = 'agy-plugin-diagnostics-card';
      diagCard.className = 'settings-card-box';
      diagCard.setAttribute('data-diag-status', issue ? issue.tone : 'ok');
      diagCard.setAttribute('data-diag-focused', diagFocused ? 'true' : 'false');

      const diagStatusRow = doc.createElement('div');
      diagStatusRow.className = 'settings-pref-row';
      const diagStatusInfo = doc.createElement('div');
      diagStatusInfo.className = 'ag-sv-row-info';
      const diagStatusTitle = doc.createElement('span');
      diagStatusTitle.className = 'ag-sv-row-title';
      diagStatusTitle.textContent = issue ? '当前诊断结论' : '插件运行正常';
      const diagStatusDesc = doc.createElement('span');
      diagStatusDesc.className = 'ag-sv-row-desc';
      if (issue) {
        const stageLabel = issue.errorStage === 'renderer'
          ? '页面注入阶段'
          : (issue.errorStage === 'load' ? '清单加载阶段' : '插件激活阶段');
        diagStatusDesc.textContent = `${stageLabel} · 错误码 ${issue.errorCode} · 窗口崩溃次数 ${crashes}`;
      } else {
        diagStatusDesc.textContent = p.enabled === false
          ? '插件当前处于已停用状态；如需使用请打开上方「启用插件」开关。'
          : `世界=${p.world || 'isolated'} · 隔离=${p.nodeIsolation || 'in-process'} · mount=${metric.mountMs}ms · crashes=${crashes}`;
      }
      diagStatusInfo.appendChild(diagStatusTitle);
      diagStatusInfo.appendChild(diagStatusDesc);

      const diagStatusChip = doc.createElement('span');
      diagStatusChip.className = 'ag-chip';
      diagStatusChip.setAttribute('data-tone', issue ? issue.tone : (p.enabled === false ? 'muted' : 'accent'));
      diagStatusChip.textContent = issue ? issue.statusLabel : (p.enabled === false ? '已停用' : '健康');
      diagStatusRow.appendChild(diagStatusInfo);
      diagStatusRow.appendChild(diagStatusChip);
      diagCard.appendChild(diagStatusRow);

      if (issue) {
        const errBox = doc.createElement('div');
        errBox.id = 'agy-plugin-diag-error';
        errBox.className = 'ag-diag-error-box';
        errBox.textContent = issue.error;
        diagCard.appendChild(errBox);

        const sugEl = doc.createElement('div');
        sugEl.id = 'agy-plugin-diag-suggestion';
        sugEl.className = 'ag-diag-suggestion';
        sugEl.textContent = `修复建议：${issue.suggestion}`;
        diagCard.appendChild(sugEl);

        const diagActRow = doc.createElement('div');
        diagActRow.className = 'settings-pref-row';
        const diagActInfo = doc.createElement('div');
        diagActInfo.className = 'ag-sv-row-info';
        const diagActTitle = doc.createElement('span');
        diagActTitle.className = 'ag-sv-row-title';
        diagActTitle.textContent = '恢复与排查操作';
        const diagActDesc = doc.createElement('span');
        diagActDesc.className = 'ag-sv-row-desc';
        diagActDesc.textContent = '修正配置或环境后，可立即重新激活或导出脱敏诊断包定位问题。';
        diagActInfo.appendChild(diagActTitle);
        diagActInfo.appendChild(diagActDesc);

        const diagActBtns = doc.createElement('div');
        diagActBtns.className = 'ag-plugin-actions';
        if (hasBridge) {
          if (issue.isMissingPath) {
            if (issue.bestRepair) {
              const bestBtn = doc.createElement('button');
              bestBtn.type = 'button';
              bestBtn.className = 'ag-btn ag-btn-primary';
              bestBtn.setAttribute('data-diag-repair', p.id);
              bestBtn.setAttribute('title', issue.bestRepair.target || '');
              bestBtn.disabled = Boolean(state.manageBusyId);
              bestBtn.textContent = `一键修复（${issue.bestRepair.label}）`;
              bestBtn.addEventListener('click', () => {
                repairPluginFromUi(p.id, {
                  mode: issue.bestRepair.kind === 'rollback' ? 'rollback' : 'relink',
                  spec: issue.bestRepair.spec
                });
              });
              diagActBtns.appendChild(bestBtn);
            }
            for (const cand of issue.repairCandidates.slice(1, 3)) {
              const altBtn = doc.createElement('button');
              altBtn.type = 'button';
              altBtn.className = 'ag-btn';
              altBtn.setAttribute('data-diag-repair-spec', cand.spec);
              altBtn.setAttribute('title', cand.target || '');
              altBtn.disabled = Boolean(state.manageBusyId);
              altBtn.textContent = cand.label;
              altBtn.addEventListener('click', () => {
                repairPluginFromUi(p.id, {
                  mode: cand.kind === 'rollback' ? 'rollback' : 'relink',
                  spec: cand.spec
                });
              });
              diagActBtns.appendChild(altBtn);
            }
            const rmConfirming = state.manageConfirmUninstallId === p.id;
            const rmBrokenBtn = doc.createElement('button');
            rmBrokenBtn.type = 'button';
            rmBrokenBtn.className = 'ag-btn ag-btn-danger';
            rmBrokenBtn.setAttribute('data-diag-remove-broken', p.id);
            rmBrokenBtn.disabled = Boolean(state.manageBusyId);
            rmBrokenBtn.textContent = rmConfirming ? '确认移除?' : '移除失效记录';
            rmBrokenBtn.addEventListener('click', () => {
              removeBrokenPluginFromUi(p.id);
            });
            diagActBtns.appendChild(rmBrokenBtn);
          } else {
            const fixActBtn = doc.createElement('button');
            fixActBtn.type = 'button';
            fixActBtn.className = 'ag-btn ag-btn-primary';
            fixActBtn.setAttribute('data-diag-activate', p.id);
            fixActBtn.disabled = Boolean(state.manageBusyId);
            fixActBtn.textContent = issue.circuitOpen ? '解除熔断并激活' : '立即激活';
            fixActBtn.addEventListener('click', () => {
              activatePluginFromUi(p.id, { resetCircuit: true });
            });
            diagActBtns.appendChild(fixActBtn);
          }

          const diagExpBtn = doc.createElement('button');
          diagExpBtn.type = 'button';
          diagExpBtn.className = 'ag-btn';
          diagExpBtn.setAttribute('data-diag-export-plugin', p.id);
          diagExpBtn.disabled = Boolean(state.manageBusyId);
          diagExpBtn.textContent = '导出诊断包';
          diagExpBtn.addEventListener('click', () => {
            void runManageAction('__diag_export__', '正在生成脱敏诊断包...', async () => {
              const res = await hostBridgePost('/host/diagnostics/export', {});
              const outPath = res?.path || 'agy-daddy-diagnostic-bundle.json';
              state.diagnosticsExportInfo = { path: outPath, timestamp: Date.now() };
              state.manageToast = { tone: 'info', spinning: false, text: `已导出脱敏诊断包：${outPath}` };
            });
          });
          diagActBtns.appendChild(diagExpBtn);
        } else {
          const resetLocalBtn = doc.createElement('button');
          resetLocalBtn.type = 'button';
          resetLocalBtn.className = 'ag-btn';
          resetLocalBtn.setAttribute('data-diag-reset-local', p.id);
          resetLocalBtn.textContent = '重置本地故障计数';
          resetLocalBtn.addEventListener('click', () => {
            api.reEnablePlugin(p.id);
            state.manageToast = { tone: 'info', spinning: false, text: `已重置 ${p.id} 本地故障计数` };
            renderSettingsBody();
          });
          diagActBtns.appendChild(resetLocalBtn);
        }
        diagActRow.appendChild(diagActInfo);
        diagActRow.appendChild(diagActBtns);
        diagCard.appendChild(diagActRow);

        if (issue.isMissingPath && hasBridge) {
          const relinkRow = doc.createElement('div');
          relinkRow.className = 'ag-diag-repair-row';
          const pathInput = doc.createElement('input');
          pathInput.type = 'text';
          pathInput.id = 'agy-plugin-repair-path-input';
          pathInput.className = 'settings-input';
          pathInput.placeholder = issue.bestRepair?.target
            ? `输入新目录路径（如 ${issue.bestRepair.target}）`
            : '输入插件新目录绝对路径（或 github:/npm: 来源）';
          pathInput.setAttribute('aria-label', '修复插件目录路径');
          pathInput.value = state.repairPathDrafts.get(p.id) || '';
          pathInput.addEventListener('input', () => {
            state.repairPathDrafts.set(p.id, pathInput.value);
          });
          pathInput.addEventListener('change', () => {
            state.repairPathDrafts.set(p.id, pathInput.value);
          });
          const relinkBtn = doc.createElement('button');
          relinkBtn.type = 'button';
          relinkBtn.className = 'ag-btn';
          relinkBtn.setAttribute('data-diag-relink', p.id);
          relinkBtn.disabled = Boolean(state.manageBusyId);
          relinkBtn.textContent = '重新链接';
          relinkBtn.addEventListener('click', () => {
            const rawPath = String(pathInput.value || state.repairPathDrafts.get(p.id) || '').trim();
            if (!rawPath) {
              state.manageToast = { tone: 'warn', spinning: false, text: '请先输入有效的本地插件目录路径' };
              renderSettingsBody();
              return;
            }
            repairPluginFromUi(p.id, { mode: 'relink', localPath: rawPath });
          });
          relinkRow.appendChild(pathInput);
          relinkRow.appendChild(relinkBtn);
          diagCard.appendChild(relinkRow);
        }
      }

      diagSection.appendChild(diagCard);
      body.appendChild(diagSection);
      if (diagFocused && typeof diagSection.scrollIntoView === 'function') {
        try { diagSection.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
      }

      // 2.5 原生扩展注入控制区（按需开关 Rules / Skills / MCP Server / Hooks + Rules 备份撤回）
      if (p.hasNative || p.nativeInfo?.hasNative) {
        const nativeInfo = p.nativeInfo || {};
        const declared = nativeInfo.declared || {};
        const nativeCfg = nativeInfo.config || {};
        const rulesBackups = Array.isArray(nativeInfo.rulesBackups) ? nativeInfo.rulesBackups : [];
        const nativeSection = createSectionBlock(
          '原生扩展注入',
          nativeInfo.targetDir
            ? `目标目录：${nativeInfo.targetDir}（关闭开关将移除对应已注入文件）`
            : '按类别控制向 Antigravity 注入的原生 Agent 能力'
        );
        const nativeCard = doc.createElement('div');
        nativeCard.className = 'settings-card-box';
        nativeCard.id = 'agy-native-injection-card';

        const statusRow = doc.createElement('div');
        statusRow.className = 'settings-pref-row';
        const statusInfo = doc.createElement('div');
        statusInfo.className = 'ag-sv-row-info';
        const statusTitle = doc.createElement('span');
        statusTitle.className = 'ag-sv-row-title';
        statusTitle.textContent = '当前注入状态';
        const statusDesc = doc.createElement('span');
        statusDesc.className = 'ag-sv-row-desc';
        const enabledKinds = ['rules', 'skills', 'mcp', 'hooks'].filter((k) => Boolean(nativeCfg[k]));
        const declaredKinds = ['rules', 'skills', 'mcp', 'hooks'].filter((k) => Array.isArray(declared[k]) && declared[k].length > 0);
        statusDesc.textContent = nativeInfo.synced
          ? `已启用 ${enabledKinds.length}/${declaredKinds.length || enabledKinds.length} 项原生能力`
          : '未向 Antigravity 注入任何原生扩展文件';
        statusInfo.appendChild(statusTitle);
        statusInfo.appendChild(statusDesc);

        const statusChip = doc.createElement('span');
        statusChip.className = 'ag-chip';
        statusChip.setAttribute('data-tone', nativeInfo.synced ? (enabledKinds.length < declaredKinds.length ? 'warn' : 'accent') : 'muted');
        statusChip.textContent = nativeInfo.synced
          ? (enabledKinds.length < declaredKinds.length ? '部分注入' : '已注入')
          : '未注入';
        statusRow.appendChild(statusInfo);
        statusRow.appendChild(statusChip);
        nativeCard.appendChild(statusRow);

        const kindDefs = [
          {
            key: 'rules',
            title: 'Rules 行为规则',
            desc: (items) => `规则文件：${items.join(', ')}（注入前自动备份，支持一键撤回）`
          },
          {
            key: 'skills',
            title: 'Skills 技能',
            desc: (items) => `技能目录：${items.join(', ')}`
          },
          {
            key: 'mcp',
            title: 'MCP Server 工具',
            desc: (items) => `服务：${items.join(', ')}`
          },
          {
            key: 'hooks',
            title: 'Hooks 钩子',
            desc: (items) => `钩子配置：${items.join(', ')}`
          }
        ];

        for (const def of kindDefs) {
          const items = Array.isArray(declared[def.key]) ? declared[def.key] : [];
          if (items.length === 0) continue;

          const kRow = doc.createElement('div');
          kRow.className = 'settings-pref-row';
          const kInfo = doc.createElement('div');
          kInfo.className = 'ag-sv-row-info';
          const kTitle = doc.createElement('span');
          kTitle.className = 'ag-sv-row-title';
          kTitle.textContent = def.title;
          const kDesc = doc.createElement('span');
          kDesc.className = 'ag-sv-row-desc';
          kDesc.textContent = def.desc(items);
          kInfo.appendChild(kTitle);
          kInfo.appendChild(kDesc);

          const kToggleWrap = doc.createElement('label');
          kToggleWrap.className = 'ag-toggle-label';
          const kToggle = doc.createElement('input');
          kToggle.type = 'checkbox';
          kToggle.checked = Boolean(nativeCfg[def.key]);
          kToggle.disabled = Boolean(state.manageBusyId) || !hasBridge;
          kToggle.setAttribute('data-native-toggle', `${p.id}:${def.key}`);
          kToggle.setAttribute('aria-label', `${def.title} (${p.displayName || p.id})`);
          kToggle.addEventListener('change', () => {
            const want = Boolean(kToggle.checked);
            void runManageAction(p.id, `正在${want ? '注入' : '关闭'} ${def.title}...`, async () => {
              const res = await hostBridgePost('/host/plugins/native/config', {
                pluginId: p.id,
                config: { [def.key]: want }
              });
              applyManagePayload(res);
              const backupTip = (def.key === 'rules' && want && res?.nativeSync?.rulesBackup?.created)
                ? '（已备份原 Rules）'
                : '';
              state.manageToast = {
                tone: 'info',
                spinning: false,
                text: `已${want ? '注入' : '关闭'} ${def.title}${backupTip}`
              };
            });
          });
          kToggleWrap.appendChild(kToggle);
          kRow.appendChild(kInfo);
          kRow.appendChild(kToggleWrap);
          nativeCard.appendChild(kRow);

          if (def.key === 'rules') {
            const rbRow = doc.createElement('div');
            rbRow.className = 'settings-pref-row';
            const rbInfo = doc.createElement('div');
            rbInfo.className = 'ag-sv-row-info';
            const rbTitle = doc.createElement('span');
            rbTitle.className = 'ag-sv-row-title';
            rbTitle.textContent = 'Rules 备份与撤回';
            const rbDesc = doc.createElement('span');
            rbDesc.className = 'ag-sv-row-desc';
            rbDesc.id = 'agy-native-rules-backup-summary';
            if (rulesBackups.length > 0) {
              const latest = rulesBackups[0];
              const preText = latest.existedBefore
                ? `注入前有 ${latest.fileCount} 个文件`
                : '首次注入前为空';
              rbDesc.textContent = `已有 ${rulesBackups.length} 份备份 · 最近：${latest.createdAt || latest.backupId}（${preText}）`;
            } else {
              rbDesc.textContent = '暂无 Rules 备份记录（每次注入或覆盖前会自动创建）';
            }
            rbInfo.appendChild(rbTitle);
            rbInfo.appendChild(rbDesc);

            const rbActions = doc.createElement('div');
            rbActions.className = 'ag-native-row-actions';
            const rbBtn = doc.createElement('button');
            rbBtn.type = 'button';
            rbBtn.className = 'ag-btn';
            rbBtn.textContent = '撤回 Rules';
            rbBtn.setAttribute('data-native-rules-rollback', p.id);
            rbBtn.disabled = rulesBackups.length === 0 || Boolean(state.manageBusyId) || !hasBridge;
            rbBtn.addEventListener('click', () => {
              void runManageAction(p.id, '正在撤回 Rules 注入...', async () => {
                const res = await hostBridgePost('/host/plugins/native/rules/rollback', { pluginId: p.id });
                applyManagePayload(res);
                state.manageToast = {
                  tone: res?.ok ? 'info' : 'warn',
                  spinning: false,
                  text: res?.ok
                    ? (res.existedBefore
                        ? '已将 Rules 恢复到注入前备份内容'
                        : '已撤回 Rules 注入并移除本次新增规则文件')
                    : (res?.error || '没有可撤回的 Rules 备份')
                };
              });
            });
            rbActions.appendChild(rbBtn);
            rbRow.appendChild(rbInfo);
            rbRow.appendChild(rbActions);
            nativeCard.appendChild(rbRow);
          }
        }

        nativeSection.appendChild(nativeCard);
        body.appendChild(nativeSection);
      }

      // 3. 声明式配置表单区（严格按 settingsSchema.fields 渲染，支持 group / placeholder / unit）
      const schema = p.settingsSchema;
      const formSection = createSectionBlock(
        schema?.title ? pickLocaleText(schema.title, '插件配置') : '插件配置'
      );

      const fields = Array.isArray(schema?.fields) ? schema.fields : [];
      const currentValues = getPluginSettings(p.id);
      const isFieldVisible = (field, values = {}) => {
        const vw = field?.visibleWhen;
        if (!vw || !isPlainObject(vw) || typeof vw.key !== 'string') return true;
        const actual = values[vw.key];
        if (Array.isArray(vw.in)) return vw.in.includes(actual);
        if (Object.prototype.hasOwnProperty.call(vw, 'equals')) return actual === vw.equals;
        if (Object.prototype.hasOwnProperty.call(vw, 'notEquals')) return actual !== vw.notEquals;
        return true;
      };
      const visibleFields = fields.filter((f) => isFieldVisible(f, currentValues));
      const invalidatePluginDynamicPresets = (targetPluginId) => {
        const prefix = `${targetPluginId}:`;
        for (const k of Array.from(state.dynamicPresets.keys())) {
          if (k.startsWith(prefix)) state.dynamicPresets.delete(k);
        }
        for (const k of Array.from(state.catalogItems.keys())) {
          if (k.startsWith(prefix)) state.catalogItems.delete(k);
        }
        for (const k of Array.from(state.comboboxOptions.keys())) {
          if (k.startsWith(prefix)) state.comboboxOptions.delete(k);
        }
      };

      if (fields.length === 0) {
        const formCard = doc.createElement('div');
        formCard.className = 'settings-card-box';
        formCard.id = 'agy-plugin-detail-form';
        const emptyMsg = doc.createElement('div');
        emptyMsg.className = 'ag-sv-empty';
        emptyMsg.textContent = '该插件未声明可配置字段';
        formCard.appendChild(emptyMsg);
        formSection.appendChild(formCard);
      } else if (visibleFields.length === 0) {
        const formCard = doc.createElement('div');
        formCard.className = 'settings-card-box';
        formCard.id = 'agy-plugin-detail-form';
        const emptyMsg = doc.createElement('div');
        emptyMsg.className = 'ag-sv-empty';
        emptyMsg.textContent = state.settingsSearchQuery
          ? `没有匹配「${state.settingsSearchQuery}」的配置项`
          : '当前模式下无可配置项';
        formCard.appendChild(emptyMsg);
        formSection.appendChild(formCard);
      } else {

        const secretState = state.pluginMeta.get(p.id)?.settingsSecretState || p.settingsSecretState || {};

        const normalizeStringOption = (opt) => {
          if (isPlainObject(opt)) {
            const val = opt.value !== undefined ? String(opt.value) : '';
            const lbl = opt.label !== undefined ? pickLocaleText(opt.label, val) : val;
            const desc = opt.description !== undefined ? pickLocaleText(opt.description, '') : '';
            return { value: val, label: lbl, description: desc };
          }
          const strVal = String(opt ?? '');
          return { value: strVal, label: strVal, description: '' };
        };

        const mergeComboboxOptions = (staticOpts = [], dynamicOpts = []) => {
          const out = [];
          const seen = new Set();
          for (const rawOpt of [...(Array.isArray(staticOpts) ? staticOpts : []), ...(Array.isArray(dynamicOpts) ? dynamicOpts : [])]) {
            const item = normalizeStringOption(rawOpt);
            if (seen.has(item.value)) continue;
            seen.add(item.value);
            out.push(item);
          }
          return out;
        };

        const loadDynamicOptions = async (field, valuesSnapshot) => {
          if (!field?.optionsCommand) return;
          const comboKey = `${p.id}:${field.key}`;
          const prevEntry = state.comboboxOptions.get(comboKey);
          if (prevEntry?.loading) return;
          state.comboboxOptions.set(comboKey, {
            loaded: Boolean(prevEntry?.loaded),
            loading: true,
            failed: false,
            fallback: false,
            emptyReason: '',
            options: prevEntry?.options || []
          });
          try {
            const res = await executeCommand(p.id, field.optionsCommand, [{ values: valuesSnapshot, fieldKey: field.key }]);
            const payload = (res && isPlainObject(res.result)) ? res.result : (isPlainObject(res) ? res : {});
            if (res?.ok === false || payload?.ok === false) {
              throw new Error(payload?.error || res?.error || 'OPTIONS_COMMAND_FAILED');
            }
            const rawList = payload.options ?? res?.options ?? (Array.isArray(res?.result) ? res.result : null);
            if (!Array.isArray(rawList)) {
              state.comboboxOptions.set(comboKey, {
                loaded: true,
                loading: false,
                failed: true,
                fallback: true,
                emptyReason: '',
                options: prevEntry?.options || []
              });
            } else {
              const normalized = rawList.map(normalizeStringOption);
              const emptyReasonText = payload.emptyReason !== undefined
                ? pickLocaleText(payload.emptyReason, '')
                : '';
              state.comboboxOptions.set(comboKey, {
                loaded: true,
                loading: false,
                failed: false,
                fallback: payload.fallback === true,
                emptyReason: emptyReasonText,
                options: normalized
              });
            }
          } catch {
            state.comboboxOptions.set(comboKey, {
              loaded: true,
              loading: false,
              failed: true,
              fallback: true,
              emptyReason: '',
              options: prevEntry?.options || []
            });
          }
          if (state.settingsMode !== 'closed' && state.selectedPluginId === p.id) {
            renderSettingsBody();
          }
        };

        const loadDynamicPresets = async (field, valuesSnapshot, { force = false } = {}) => {
          const cmd = field?.itemEditor?.dynamicPresetsCommand;
          if (!cmd) return;
          const dynKey = `${p.id}:${field.key}`;
          const prevEntry = state.dynamicPresets.get(dynKey);
          if (prevEntry?.loading) return;
          if (!force && prevEntry?.loaded) return;
          state.dynamicPresets.set(dynKey, {
            loaded: Boolean(prevEntry?.loaded),
            loading: true,
            presets: prevEntry?.presets || [],
            meta: prevEntry?.meta || null
          });
          try {
            const res = await executeCommand(p.id, cmd, [{ values: valuesSnapshot, fieldKey: field.key }]);
            const payload = (res && isPlainObject(res.result)) ? res.result : (isPlainObject(res) ? res : {});
            const rawList = Array.isArray(payload.presets)
              ? payload.presets
              : (Array.isArray(payload.items) ? payload.items : (Array.isArray(res?.result) ? res.result : []));
            const normalized = rawList
              .filter((it) => isPlainObject(it) && typeof it.id === 'string' && it.id.trim() && String(it.text || '').trim())
              .map((it) => ({
                id: String(it.id).trim(),
                label: it.label || it.id,
                text: String(it.text || '').trim(),
                tag: it.tag || '',
                description: it.description || '',
                source: it.source ? String(it.source) : 'dynamic',
                count: Number.isFinite(Number(it.count)) ? Number(it.count) : 0,
                autoSend: Boolean(it.autoSend)
              }));
            state.dynamicPresets.set(dynKey, {
              loaded: true,
              loading: false,
              presets: normalized,
              meta: isPlainObject(payload.meta) ? payload.meta : null
            });
          } catch {
            state.dynamicPresets.set(dynKey, {
              loaded: true,
              loading: false,
              presets: prevEntry?.presets || [],
              meta: prevEntry?.meta || null
            });
          }
          if (state.settingsMode !== 'closed' && state.selectedPluginId === p.id) {
            renderSettingsBody();
          }
        };

        const loadCatalogItems = async (field, valuesSnapshot, { force = false } = {}) => {
          const cmd = field?.itemEditor?.itemsCommand;
          if (!cmd) return;
          const catKey = `${p.id}:${field.key}`;
          const prevEntry = state.catalogItems.get(catKey);
          if (prevEntry?.loading) return;
          if (!force && prevEntry?.loaded) return;
          state.catalogItems.set(catKey, {
            loaded: Boolean(prevEntry?.loaded),
            loading: true,
            items: prevEntry?.items || [],
            error: ''
          });
          try {
            const res = await executeCommand(p.id, cmd, [{ values: valuesSnapshot, fieldKey: field.key }]);
            const payload = (res && isPlainObject(res.result)) ? res.result : (isPlainObject(res) ? res : {});
            const rawList = Array.isArray(payload.items)
              ? payload.items
              : (Array.isArray(payload.models) ? payload.models : (Array.isArray(res?.result) ? res.result : []));
            const normalized = rawList
              .filter((it) => isPlainObject(it) && typeof it.id === 'string' && it.id.trim())
              .map((it) => ({
                id: String(it.id).trim(),
                label: String(it.label || it.name || it.id).trim(),
                category: String(it.category || it.provider || 'other').trim().toLowerCase(),
                description: it.description ? String(it.description).trim() : '',
                frequency: Number.isFinite(Number(it.frequency)) ? Number(it.frequency) : 0
              }));
            state.catalogItems.set(catKey, {
              loaded: true,
              loading: false,
              items: normalized,
              error: ''
            });
          } catch (err) {
            state.catalogItems.set(catKey, {
              loaded: true,
              loading: false,
              items: prevEntry?.items || [],
              error: err?.message || String(err)
            });
          }
          if (state.settingsMode !== 'closed' && state.selectedPluginId === p.id) {
            renderSettingsBody();
          }
        };

        const buildProbeSignature = (field, valuesObj) => {
          const watchKeys = Array.isArray(field?.probe?.watchKeys) ? field.probe.watchKeys : [];
          return JSON.stringify([
            ...watchKeys.map((k) => valuesObj?.[k]),
            valuesObj?.[field.key] ?? ''
          ]);
        };

        const runFieldProbe = async (field, trigger, valuesSnapshot, changedKey = null) => {
          if (!field?.probe?.command) return;
          const probeKey = `${p.id}:${field.key}`;
          const prevProbe = state.fieldProbeState.get(probeKey);
          const nextSeq = (prevProbe?.seq || 0) + 1;
          const reqSig = buildProbeSignature(field, valuesSnapshot);
          state.fieldProbeState.set(probeKey, {
            status: 'loading',
            message: '正在检测程序路径...',
            sig: reqSig,
            seq: nextSeq
          });
          if (state.settingsMode !== 'closed' && state.selectedPluginId === p.id && trigger !== 'open') {
            renderSettingsBody();
          }
          try {
            const res = await executeCommand(p.id, field.probe.command, [{
              trigger,
              changedKey,
              fieldKey: field.key,
              values: valuesSnapshot
            }]);
            const curState = state.fieldProbeState.get(probeKey);
            if (curState && curState.seq !== nextSeq) return;

            const payload = (res && isPlainObject(res.result)) ? res.result : (isPlainObject(res) ? res : {});
            const detectedVal = typeof payload.path === 'string'
              ? payload.path
              : (typeof payload.value === 'string' ? payload.value : '');
            let finalValues = { ...valuesSnapshot };

            if (payload.found === true) {
              const curVal = String(finalValues[field.key] ?? '');
              if (field.probe.autoFill && detectedVal && detectedVal !== curVal && (trigger === 'watch' || trigger === 'manual' || !curVal.trim())) {
                const upd = await updatePluginSettings(p.id, { [field.key]: detectedVal });
                if (upd?.ok && isPlainObject(upd.values)) {
                  finalValues = { ...finalValues, ...upd.values };
                } else {
                  finalValues[field.key] = detectedVal;
                }
              }
              state.fieldProbeState.set(probeKey, {
                status: 'ok',
                title: payload.title ? pickLocaleText(payload.title, '') : '',
                message: payload.message || (detectedVal ? `已检测到：${detectedVal}` : '检测通过'),
                commands: Array.isArray(payload.commands) ? payload.commands : [],
                links: Array.isArray(payload.links) ? payload.links : [],
                sig: buildProbeSignature(field, finalValues),
                seq: nextSeq
              });
            } else {
              const curVal = String(finalValues[field.key] ?? '');
              if (field.probe.autoFill && trigger === 'watch' && curVal.trim() !== '') {
                const upd = await updatePluginSettings(p.id, { [field.key]: '' });
                if (upd?.ok && isPlainObject(upd.values)) {
                  finalValues = { ...finalValues, ...upd.values };
                } else {
                  finalValues[field.key] = '';
                }
              }
              state.fieldProbeState.set(probeKey, {
                status: 'error',
                title: payload.title ? pickLocaleText(payload.title, '') : '',
                message: payload.message || payload.error || '未检测到程序路径，请手动输入路径或点击「浏览选择」',
                commands: Array.isArray(payload.commands) ? payload.commands : [],
                links: Array.isArray(payload.links) ? payload.links : [],
                sig: buildProbeSignature(field, finalValues),
                seq: nextSeq
              });
            }
          } catch (err) {
            const curState = state.fieldProbeState.get(probeKey);
            if (curState && curState.seq !== nextSeq) return;
            state.fieldProbeState.set(probeKey, {
              status: 'error',
              message: err?.message || '程序路径检测失败，请手动输入路径或点击「浏览选择」',
              sig: reqSig,
              seq: nextSeq
            });
          }
          if (state.settingsMode !== 'closed' && state.selectedPluginId === p.id) {
            renderSettingsBody();
          }
        };

        const runFieldComposer = async (field, trigger, valuesSnapshot, changedKey = null) => {
          if (!field?.composer?.command) return;
          const composerKey = `${p.id}:${field.key}`;
          const errKey = `${p.id}:${field.key}`;
          try {
            const res = await executeCommand(p.id, field.composer.command, [{
              trigger,
              changedKey,
              fieldKey: field.key,
              values: valuesSnapshot
            }]);
            const payload = (res && isPlainObject(res.result)) ? res.result : (isPlainObject(res) ? res : {});
            if (res?.ok === false || payload?.ok === false) {
              throw new Error(payload?.error || res?.error || '生成命令失败');
            }
            const rawComposed = typeof payload.value === 'string'
              ? payload.value
              : (typeof payload.command === 'string'
                ? payload.command
                : (typeof res?.value === 'string'
                  ? res.value
                  : (typeof res?.command === 'string' ? res.command : null)));
            if (typeof rawComposed !== 'string') {
              throw new Error('命令生成器返回了非字符串结果');
            }
            if (trigger === 'reset') {
              state.fieldComposerTouched.delete(composerKey);
            }
            state.fieldErrors.delete(errKey);
            const upd = await updatePluginSettings(p.id, { [field.key]: rawComposed });
            if (!upd?.ok) {
              throw new Error((upd?.errors && upd.errors[0]) || '保存命令失败');
            }
            const lbl = pickLocaleText(field.label, field.key);
            if (trigger === 'reset') {
              state.manageToast = { tone: 'info', spinning: false, text: `已恢复默认 ${lbl}` };
            } else if (trigger === 'watch') {
              state.manageToast = { tone: 'info', spinning: false, text: `已按当前选项更新 ${lbl}` };
            }
          } catch (err) {
            const msg = err?.message || String(err);
            state.fieldErrors.set(errKey, msg);
            if (trigger === 'reset' || trigger === 'watch') {
              state.manageToast = { tone: 'error', spinning: false, text: msg };
            }
          }
          if (state.settingsMode !== 'closed' && state.selectedPluginId === p.id) {
            renderSettingsBody();
          }
        };

        const parseCommandPresetItem = (rawItem) => {
          if (isPlainObject(rawItem)) {
            const command = String(rawItem.command || '').trim();
            const name = String(rawItem.name || '').trim() || (command.split(/\s+/)[0] || '命令');
            return { name, command, pinToTopbar: rawItem.pinToTopbar !== false };
          }
          const rawStr = String(rawItem ?? '').trim();
          if (rawStr.startsWith('{')) {
            try {
              const parsed = JSON.parse(rawStr);
              if (isPlainObject(parsed)) {
                const command = String(parsed.command || '').trim();
                const name = String(parsed.name || '').trim() || (command.split(/\s+/)[0] || '命令');
                return { name, command, pinToTopbar: parsed.pinToTopbar !== false };
              }
            } catch {}
          }
          const fallbackName = rawStr.split(/\s+/)[0] || '命令';
          return { name: fallbackName, command: rawStr, pinToTopbar: true };
        };

        const commitFieldValue = async (field, nextValue, extraPatch = null) => {
          const errKey = `${p.id}:${field.key}`;
          const check = validateFieldLocally(field, nextValue);
          if (!check.ok) {
            state.fieldErrors.set(errKey, check.error);
            renderSettingsBody();
            return;
          }
          state.fieldErrors.delete(errKey);
          const payloadPatch = isPlainObject(extraPatch)
            ? { ...extraPatch, [field.key]: check.value }
            : { [field.key]: check.value };
          const res = await updatePluginSettings(p.id, payloadPatch);
          if (!res.ok) {
            state.fieldErrors.set(errKey, (res.errors && res.errors[0]) || '保存失败');
            state.manageToast = { tone: 'error', spinning: false, text: `配置保存失败：${(res.errors || []).join('; ')}` };
            renderSettingsBody();
            return;
          }
          const lbl = pickLocaleText(field.label, field.key);
          const okMsg = field.writeOnly === true
            ? (check.value === '' ? `已清除 ${lbl}` : `已仅写保存 ${lbl}`)
            : `已保存 ${lbl}`;
          state.manageToast = { tone: 'info', spinning: false, text: okMsg };
          const updatedValues = isPlainObject(res.values)
            ? { ...currentValues, ...res.values }
            : { ...currentValues, ...payloadPatch };
          renderSettingsBody();

          for (const targetField of fields) {
            if (targetField.key === field.key) continue;
            const watchKeys = Array.isArray(targetField.probe?.watchKeys) ? targetField.probe.watchKeys : [];
            if (targetField.probe?.command && watchKeys.includes(field.key)) {
              void runFieldProbe(targetField, 'watch', updatedValues, field.key);
            }
            const composerWatchKeys = Array.isArray(targetField.composer?.watchKeys) ? targetField.composer.watchKeys : [];
            if (targetField.composer?.command && composerWatchKeys.includes(field.key)) {
              void runFieldComposer(targetField, 'watch', updatedValues, field.key);
            }
          }
          if (field.probe?.command) {
            if (field.probe.onlyWhenTruthy === true && !check.value) {
              state.fieldProbeState.delete(`${p.id}:${field.key}`);
              renderSettingsBody();
            } else {
              void runFieldProbe(field, 'edit', updatedValues, field.key);
            }
          }
        };

        for (const vf of visibleFields) {
          if ((vf.type === 'string' || vf.type === 'enum') && vf.optionsCommand) {
            const comboKey = `${p.id}:${vf.key}`;
            const cached = state.comboboxOptions.get(comboKey);
            if (!cached) {
              void loadDynamicOptions(vf, currentValues);
            }
          }
          if (vf.probe?.command && vf.probe.runOnOpen === true) {
            const probeKey = `${p.id}:${vf.key}`;
            if (vf.probe.onlyWhenTruthy === true && !currentValues[vf.key]) {
              state.fieldProbeState.delete(probeKey);
            } else {
              const sig = buildProbeSignature(vf, currentValues);
              const curProbe = state.fieldProbeState.get(probeKey);
              if ((!curProbe || curProbe.sig !== sig) && curProbe?.status !== 'loading') {
                void runFieldProbe(vf, 'open', currentValues);
              }
            }
          }
          if (vf.type === 'string' && vf.composer?.command && vf.composer.runOnOpen !== false) {
            const composerKey = `${p.id}:${vf.key}`;
            if (String(currentValues[vf.key] ?? '').trim() === '' && !state.fieldComposerTouched.has(composerKey)) {
              state.fieldComposerTouched.add(composerKey);
              void runFieldComposer(vf, 'open', currentValues, vf.key);
            }
          }
        }

        const copyTextToClipboard = (text) => {
          const str = String(text ?? '');
          if (!str) return;
          try {
            if (globalThis.navigator?.clipboard?.writeText) {
              void globalThis.navigator.clipboard.writeText(str);
              return;
            }
          } catch {}
          try {
            if (doc?.createElement && doc?.body?.appendChild) {
              const ta = doc.createElement('textarea');
              ta.value = str;
              ta.setAttribute('readonly', 'true');
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              doc.body.appendChild(ta);
              ta.select?.();
              doc.execCommand?.('copy');
              ta.remove?.();
            }
          } catch {}
        };

        const renderCalloutBox = (opts = {}) => {
          const box = doc.createElement('div');
          box.className = 'ag-callout-box';
          box.setAttribute('data-tone', opts.tone || 'info');
          box.setAttribute('data-callout-kind', opts.kind || 'guide');
          box.setAttribute('data-callout-key', opts.fieldKey || '');

          const titleText = String(opts.title || '').trim();
          if (titleText || typeof opts.onReprobe === 'function') {
            const head = doc.createElement('div');
            head.className = 'ag-callout-head';
            const titleEl = doc.createElement('span');
            titleEl.className = 'ag-callout-title';
            titleEl.textContent = titleText || '提示';
            head.appendChild(titleEl);
            if (typeof opts.onReprobe === 'function') {
              const actions = doc.createElement('div');
              actions.className = 'ag-callout-head-actions';
              const reprobeBtn = doc.createElement('button');
              reprobeBtn.type = 'button';
              reprobeBtn.className = 'ag-btn';
              reprobeBtn.setAttribute('data-field-probe', opts.fieldKey || '');
              reprobeBtn.textContent = opts.reprobeLabel || '重新检测';
              reprobeBtn.addEventListener('click', () => {
                opts.onReprobe();
              });
              actions.appendChild(reprobeBtn);
              head.appendChild(actions);
            }
            box.appendChild(head);
          }

          if (opts.message) {
            const desc = doc.createElement('div');
            desc.className = 'ag-callout-desc';
            desc.textContent = String(opts.message);
            box.appendChild(desc);
          }

          if (Array.isArray(opts.steps) && opts.steps.length > 0) {
            const ol = doc.createElement('ol');
            ol.className = 'ag-callout-steps';
            for (const stepItem of opts.steps) {
              const txt = pickLocaleText(stepItem, '');
              if (!txt) continue;
              const li = doc.createElement('li');
              li.textContent = txt;
              ol.appendChild(li);
            }
            if (ol.children.length > 0) box.appendChild(ol);
          }

          if (Array.isArray(opts.commands) && opts.commands.length > 0) {
            const cmdList = doc.createElement('div');
            cmdList.className = 'ag-callout-cmd-list';
            opts.commands.forEach((cmdObj, idx) => {
              const cmdStr = isPlainObject(cmdObj) ? String(cmdObj.command || '').trim() : String(cmdObj || '').trim();
              if (!cmdStr) return;
              const cmdLabel = isPlainObject(cmdObj) && cmdObj.label ? pickLocaleText(cmdObj.label, '') : '';
              const row = doc.createElement('div');
              row.className = 'ag-callout-cmd-row';
              if (cmdLabel) {
                const lblEl = doc.createElement('span');
                lblEl.className = 'ag-callout-cmd-label';
                lblEl.textContent = cmdLabel;
                row.appendChild(lblEl);
              }
              const codeRow = doc.createElement('div');
              codeRow.className = 'ag-callout-code-row';
              const codeEl = doc.createElement('code');
              codeEl.className = 'ag-callout-code';
              codeEl.setAttribute('data-selectable-code', 'true');
              codeEl.textContent = cmdStr;
              codeRow.appendChild(codeEl);

              const copyBtn = doc.createElement('button');
              copyBtn.type = 'button';
              copyBtn.className = 'ag-btn ag-callout-copy-btn';
              copyBtn.setAttribute('data-callout-copy', `${opts.fieldKey || ''}:${idx}`);
              copyBtn.textContent = '复制';
              let copyTimer = null;
              copyBtn.addEventListener('click', () => {
                copyTextToClipboard(cmdStr);
                copyBtn.textContent = '已复制';
                clearTimeout(copyTimer);
                copyTimer = setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
              });
              codeRow.appendChild(copyBtn);
              row.appendChild(codeRow);
              cmdList.appendChild(row);
            });
            if (cmdList.children.length > 0) box.appendChild(cmdList);
          }

          if (Array.isArray(opts.links) && opts.links.length > 0) {
            const linksRow = doc.createElement('div');
            linksRow.className = 'ag-callout-links';
            opts.links.forEach((lnk, idx) => {
              const url = isPlainObject(lnk) ? String(lnk.url || '').trim() : '';
              if (!isSafeExternalUrl(url)) return;
              const lbl = pickLocaleText(lnk.label, url);
              const a = doc.createElement('a');
              a.className = 'ag-btn ag-callout-link';
              a.setAttribute('href', url);
              a.setAttribute('target', '_blank');
              a.setAttribute('rel', 'noopener noreferrer');
              a.setAttribute('data-callout-link', `${opts.fieldKey || ''}:${idx}`);
              a.textContent = `${lbl} ↗`;
              linksRow.appendChild(a);
            });
            if (linksRow.children.length > 0) box.appendChild(linksRow);
          }

          return box;
        };

        const renderFieldRow = (field) => {
          const fRow = doc.createElement('div');
          fRow.className = 'ag-field-row';
          fRow.setAttribute('data-field-key', field.key);

          const fTop = doc.createElement('div');
          fTop.className = 'ag-field-top';

          const fInfo = doc.createElement('div');
          fInfo.className = 'ag-field-info';
          const labelText = pickLocaleText(field.label, field.key);
          const descText = field.description ? pickLocaleText(field.description, '') : '';
          const placeholderText = field.placeholder ? pickLocaleText(field.placeholder, '') : '';
          const unitText = field.unit ? pickLocaleText(field.unit, '') : '';
          const isWriteOnly = field.writeOnly === true;
          const isConfigured = isWriteOnly && Boolean(secretState?.[field.key]);
          const fLabel = doc.createElement('span');
          fLabel.className = 'ag-field-label';
          fLabel.textContent = labelText;
          if (isConfigured) {
            const labelRow = doc.createElement('div');
            labelRow.className = 'ag-field-label-row';
            labelRow.appendChild(fLabel);
            const badgeChip = doc.createElement('span');
            badgeChip.className = 'ag-chip';
            badgeChip.setAttribute('data-secret-configured', field.key);
            badgeChip.textContent = '已保存';
            labelRow.appendChild(badgeChip);
            fInfo.appendChild(labelRow);
          } else {
            fInfo.appendChild(fLabel);
          }
          if (descText) {
            const fDesc = doc.createElement('span');
            fDesc.className = 'ag-sv-row-desc';
            fDesc.textContent = descText;
            fInfo.appendChild(fDesc);
          } else if (labelText !== field.key) {
            const fKey = doc.createElement('span');
            fKey.className = 'ag-field-key';
            fKey.textContent = field.key;
            fInfo.appendChild(fKey);
          }
          fTop.appendChild(fInfo);

          const val = currentValues[field.key] !== undefined ? currentValues[field.key] : field.default;

          if (field.type === 'boolean') {
            const tLabel = doc.createElement('label');
            tLabel.className = 'ag-toggle-label';
            const input = doc.createElement('input');
            input.type = 'checkbox';
            input.checked = Boolean(val);
            input.setAttribute('data-setting-key', field.key);
            input.setAttribute('aria-label', labelText);
            input.addEventListener('change', () => {
              void commitFieldValue(field, Boolean(input.checked));
            });
            tLabel.appendChild(input);
            fTop.appendChild(tLabel);
            fRow.appendChild(fTop);
            if (field.probe?.command) {
              const probeState = state.fieldProbeState.get(`${p.id}:${field.key}`);
              if (probeState?.status === 'error') {
                fRow.appendChild(renderCalloutBox({
                  fieldKey: field.key,
                  kind: 'probe',
                  tone: 'danger',
                  title: probeState.title || '未检测到所需程序',
                  message: probeState.message,
                  commands: probeState.commands,
                  links: probeState.links,
                  reprobeLabel: field.probe.buttonLabel ? pickLocaleText(field.probe.buttonLabel, '重新检测') : '重新检测',
                  onReprobe: () => { void runFieldProbe(field, 'manual', currentValues, field.key); }
                }));
              } else if (probeState?.status === 'loading') {
                const loadingHint = doc.createElement('div');
                loadingHint.className = 'ag-field-hint';
                loadingHint.setAttribute('data-field-probe-status', 'loading');
                loadingHint.setAttribute('data-field-probe-key', field.key);
                loadingHint.textContent = '正在检测程序状态...';
                fRow.appendChild(loadingHint);
              } else if (probeState?.status === 'ok' && probeState.message) {
                const okHint = doc.createElement('div');
                okHint.className = 'ag-field-hint';
                okHint.setAttribute('data-field-probe-status', 'ok');
                okHint.setAttribute('data-field-probe-key', field.key);
                okHint.textContent = probeState.message;
                fRow.appendChild(okHint);
              }
            }
          } else if (field.type === 'enum') {
            const sel = doc.createElement('select');
            sel.className = 'settings-input';
            sel.setAttribute('data-setting-key', field.key);
            sel.setAttribute('aria-label', labelText);

            const staticOptions = (field.options || []).map(normalizeStringOption);
            const comboKey = `${p.id}:${field.key}`;
            const cached = field.optionsCommand ? state.comboboxOptions.get(comboKey) : null;
            const currentValStr = val !== undefined && val !== null ? String(val) : '';

            let sourceKind = 'static';
            let resolvedOptions = staticOptions;
            let enumHintText = '';

            if (field.optionsCommand) {
              if (cached?.loaded && !cached.failed && !cached.fallback) {
                sourceKind = 'dynamic';
                resolvedOptions = Array.isArray(cached.options) ? [...cached.options] : [];
                if (resolvedOptions.length === 0) {
                  enumHintText = cached.emptyReason || '当前模型不支持调节思考等级';
                }
              } else {
                sourceKind = cached?.loading ? 'loading' : 'fallback';
                resolvedOptions = (cached?.loaded && !cached.failed && cached.fallback && Array.isArray(cached.options) && cached.options.length > 0)
                  ? [...cached.options]
                  : staticOptions;
                if (cached?.loaded && (cached.failed || cached.fallback)) {
                  enumHintText = '宿主模型目录尚未就绪，已回退至默认候选项';
                }
              }
            }

            let hasPreservedValue = false;
            if (currentValStr !== '' && !resolvedOptions.some((o) => o.value === currentValStr)) {
              const staticMatch = staticOptions.find((o) => o.value === currentValStr);
              const baseLbl = staticMatch?.label || currentValStr;
              resolvedOptions = [
                {
                  value: currentValStr,
                  label: sourceKind === 'dynamic'
                    ? `${baseLbl}（当前已选 · 目录未返回）`
                    : `${baseLbl}（当前已选）`,
                  description: ''
                },
                ...resolvedOptions
              ];
              hasPreservedValue = true;
            }

            if (resolvedOptions.length === 0) {
              resolvedOptions = [
                {
                  value: '',
                  label: enumHintText || '无可用选项',
                  description: ''
                }
              ];
              sel.disabled = true;
            }

            sel.setAttribute('data-options-source', sourceKind);
            if (hasPreservedValue) {
              sel.setAttribute('data-preserved-value', currentValStr);
            }

            for (const opt of resolvedOptions) {
              const o = doc.createElement('option');
              o.value = opt.value;
              o.textContent = opt.label;
              if (opt.value === currentValStr) o.selected = true;
              sel.appendChild(o);
            }
            sel.value = currentValStr !== '' || resolvedOptions.some((o) => o.value === '')
              ? currentValStr
              : (resolvedOptions[0]?.value ?? '');
            sel.addEventListener('change', () => {
              void commitFieldValue(field, sel.value);
            });
            fTop.appendChild(sel);
            fRow.appendChild(fTop);
            if (enumHintText) {
              const hintEl = doc.createElement('div');
              hintEl.className = 'ag-field-hint';
              hintEl.setAttribute('data-enum-options-hint', field.key);
              hintEl.textContent = enumHintText;
              fRow.appendChild(hintEl);
            }
          } else if (field.type === 'number') {
            const input = doc.createElement('input');
            input.type = 'number';
            input.className = 'settings-input';
            input.value = val !== undefined && val !== null ? String(val) : '';
            if (placeholderText) input.placeholder = placeholderText;
            if (typeof field.min === 'number') input.setAttribute('min', String(field.min));
            if (typeof field.max === 'number') input.setAttribute('max', String(field.max));
            input.setAttribute('data-setting-key', field.key);
            input.setAttribute('aria-label', labelText);
            input.addEventListener('change', () => {
              const raw = String(input.value).trim();
              const parsed = raw === '' ? NaN : Number(raw);
              void commitFieldValue(field, parsed);
            });
            if (unitText) {
              const unitWrap = doc.createElement('div');
              unitWrap.className = 'ag-input-unit-wrap';
              unitWrap.appendChild(input);
              const unitSpan = doc.createElement('span');
              unitSpan.className = 'ag-input-unit';
              unitSpan.textContent = unitText;
              unitWrap.appendChild(unitSpan);
              fTop.appendChild(unitWrap);
            } else {
              fTop.appendChild(input);
            }
            fRow.appendChild(fTop);
          } else if (field.type === 'list') {
            const editor = isPlainObject(field.itemEditor) ? field.itemEditor : null;
            const editorKind = editor?.kind || '';
            const arr = Array.isArray(val) ? val : [];
            const draftKey = `${p.id}:${field.key}`;

            const commitListReorder = (fromIdx, toIdx, beforeCommit) => {
              const nextArr = reorderArray(arr, fromIdx, toIdx);
              if (!nextArr) return;
              if (typeof beforeCommit === 'function') beforeCommit();
              void commitFieldValue(field, nextArr);
            };

            if (editorKind === 'threshold-color-rule') {
              if (Array.isArray(field.default)) {
                const resetBtn = doc.createElement('button');
                resetBtn.type = 'button';
                resetBtn.className = 'ag-btn';
                resetBtn.setAttribute('data-rule-reset', field.key);
                resetBtn.textContent = '恢复默认';
                resetBtn.addEventListener('click', () => {
                  void commitFieldValue(field, [...field.default]);
                });
                fTop.appendChild(resetBtn);
              }
              fRow.appendChild(fTop);

              const targets = Array.isArray(editor.targets) ? editor.targets : [];
              const metrics = Array.isArray(editor.metrics) ? editor.metrics : [];
              const colors = Array.isArray(editor.colors) ? editor.colors : [];
              const unitSuffix = typeof editor.unit === 'string' ? editor.unit : '%';

              const findTargetLabel = (tVal) => {
                const hit = targets.find((t) => (isPlainObject(t) ? t.value : t) === tVal);
                return hit ? (isPlainObject(hit) ? pickLocaleText(hit.label, String(tVal)) : String(hit)) : String(tVal);
              };
              const findMetricLabel = (mVal) => {
                const hit = metrics.find((m) => (isPlainObject(m) ? m.value : m) === mVal);
                return hit ? (isPlainObject(hit) ? pickLocaleText(hit.label, String(mVal)) : String(hit)) : String(mVal);
              };
              const parseRuleDisplay = (rawStr) => {
                const m = String(rawStr || '').trim().match(/^([^:]+):((?:remaining|used)(?:<=|>=|<|>))(\d+(?:\.\d+)?):(.+)$/i);
                if (!m) {
                  return {
                    valid: false,
                    target: '',
                    metric: '',
                    threshold: '',
                    color: '',
                    label: String(rawStr || '')
                  };
                }
                const tVal = m[1].trim();
                const mVal = m[2].toLowerCase();
                const thr = m[3];
                const colorHex = normalizeHexColor(m[4]);
                return {
                  valid: Boolean(colorHex),
                  target: tVal,
                  metric: mVal,
                  threshold: thr,
                  color: colorHex,
                  label: `${findTargetLabel(tVal)} ${findMetricLabel(mVal)} ${thr}${unitSuffix}`
                };
              };
              const commitRulePatch = (idx, parsed, patch) => {
                const nextTarget = patch.target !== undefined ? String(patch.target || '').trim() : parsed.target;
                const nextMetric = patch.metric !== undefined ? String(patch.metric || '').trim() : parsed.metric;
                const rawThreshold = patch.threshold !== undefined ? patch.threshold : parsed.threshold;
                const numThreshold = Number(rawThreshold);
                if (!Number.isFinite(numThreshold) || String(rawThreshold).trim() === '') return false;
                const clampedThreshold = Math.max(0, Math.min(100, numThreshold));
                const thresholdText = String(Math.round(clampedThreshold * 100) / 100);
                const nextColor = patch.color !== undefined ? normalizeHexColor(patch.color) : parsed.color;
                if (!nextTarget || !nextMetric || !nextColor) return false;
                const nextArr = arr.slice();
                nextArr[idx] = `${nextTarget}:${nextMetric}${thresholdText}:${nextColor}`;
                commitFieldValue(field, nextArr);
                return true;
              };

              const listWrap = doc.createElement('div');
              listWrap.className = 'ag-list-editor ag-rule-editor';
              listWrap.setAttribute('data-setting-list', field.key);
              listWrap.setAttribute('data-rule-editor', field.key);

              const rulesList = doc.createElement('div');
              rulesList.className = 'ag-rule-list';
              if (arr.length === 0) {
                const emptyNote = doc.createElement('div');
                emptyNote.className = 'ag-sv-row-desc';
                emptyNote.textContent = '当前未配置规则（保持默认中性色）';
                rulesList.appendChild(emptyNote);
              } else {
                arr.forEach((itemStr, idx) => {
                  const parsed = parseRuleDisplay(itemStr);
                  const li = doc.createElement('div');
                  li.className = 'ag-list-item ag-rule-item';
                  li.setAttribute('data-rule-item', `${field.key}:${idx}`);

                  const info = doc.createElement('div');
                  info.className = 'ag-rule-info';
                  if (parsed.valid) {
                    const colorPicker = doc.createElement('input');
                    colorPicker.type = 'color';
                    colorPicker.className = 'ag-rule-dot-picker';
                    colorPicker.value = parsed.color;
                    colorPicker.setAttribute('data-rule-item-color', `${field.key}:${idx}`);
                    colorPicker.setAttribute('title', '修改颜色');
                    colorPicker.setAttribute('aria-label', '修改颜色');
                    colorPicker.style?.setProperty?.('background', parsed.color);
                    colorPicker.addEventListener('change', () => {
                      const ok = commitRulePatch(idx, parsed, { color: colorPicker.value });
                      if (!ok) colorPicker.value = parsed.color;
                    });
                    info.appendChild(colorPicker);

                    const targetSelect = doc.createElement('select');
                    targetSelect.className = 'ag-rule-inline-select';
                    targetSelect.setAttribute('data-rule-item-target', `${field.key}:${idx}`);
                    targetSelect.setAttribute('aria-label', '选择目标');
                    let hasTargetOpt = false;
                    targets.forEach((t) => {
                      const val = isPlainObject(t) ? String(t.value) : String(t);
                      const lbl = isPlainObject(t) ? pickLocaleText(t.label, val) : val;
                      const opt = doc.createElement('option');
                      opt.value = val;
                      opt.textContent = lbl;
                      if (val === parsed.target) {
                        opt.selected = true;
                        hasTargetOpt = true;
                      }
                      targetSelect.appendChild(opt);
                    });
                    if (!hasTargetOpt) {
                      const extraOpt = doc.createElement('option');
                      extraOpt.value = parsed.target;
                      extraOpt.textContent = findTargetLabel(parsed.target);
                      extraOpt.selected = true;
                      targetSelect.appendChild(extraOpt);
                    }
                    targetSelect.value = parsed.target;
                    targetSelect.addEventListener('change', () => {
                      commitRulePatch(idx, parsed, { target: targetSelect.value });
                    });
                    info.appendChild(targetSelect);

                    const metricSelect = doc.createElement('select');
                    metricSelect.className = 'ag-rule-inline-select';
                    metricSelect.setAttribute('data-rule-item-metric', `${field.key}:${idx}`);
                    metricSelect.setAttribute('aria-label', '选择条件');
                    let hasMetricOpt = false;
                    metrics.forEach((mItem) => {
                      const val = isPlainObject(mItem) ? String(mItem.value) : String(mItem);
                      const lbl = isPlainObject(mItem) ? pickLocaleText(mItem.label, val) : val;
                      const opt = doc.createElement('option');
                      opt.value = val;
                      opt.textContent = lbl;
                      if (val === parsed.metric) {
                        opt.selected = true;
                        hasMetricOpt = true;
                      }
                      metricSelect.appendChild(opt);
                    });
                    if (!hasMetricOpt) {
                      const extraOpt = doc.createElement('option');
                      extraOpt.value = parsed.metric;
                      extraOpt.textContent = findMetricLabel(parsed.metric);
                      extraOpt.selected = true;
                      metricSelect.appendChild(extraOpt);
                    }
                    metricSelect.value = parsed.metric;
                    metricSelect.addEventListener('change', () => {
                      commitRulePatch(idx, parsed, { metric: metricSelect.value });
                    });
                    info.appendChild(metricSelect);

                    const numInput = doc.createElement('input');
                    numInput.type = 'number';
                    numInput.min = '0';
                    numInput.max = '100';
                    numInput.step = '1';
                    numInput.className = 'ag-rule-inline-num';
                    numInput.value = parsed.threshold;
                    numInput.setAttribute('data-rule-item-threshold', `${field.key}:${idx}`);
                    numInput.setAttribute('aria-label', '修改阈值');
                    numInput.addEventListener('change', () => {
                      const ok = commitRulePatch(idx, parsed, { threshold: numInput.value });
                      if (!ok) numInput.value = parsed.threshold;
                    });
                    info.appendChild(numInput);

                    if (unitSuffix) {
                      const unitSpan = doc.createElement('span');
                      unitSpan.className = 'ag-rule-text';
                      unitSpan.textContent = unitSuffix;
                      info.appendChild(unitSpan);
                    }
                  } else {
                    const dot = doc.createElement('span');
                    dot.className = 'ag-rule-dot';
                    if (parsed.color) dot.style?.setProperty?.('background', parsed.color);
                    info.appendChild(dot);

                    const span = doc.createElement('span');
                    span.className = 'ag-rule-text';
                    span.textContent = parsed.label;
                    info.appendChild(span);
                  }
                  li.appendChild(info);

                  const ops = doc.createElement('div');
                  ops.className = 'ag-rule-ops';
                  const rmBtn = doc.createElement('button');
                  rmBtn.type = 'button';
                  rmBtn.className = 'ag-icon-btn';
                  rmBtn.setAttribute('data-list-remove', `${field.key}:${idx}`);
                  rmBtn.setAttribute('aria-label', `删除 ${parsed.label}`);
                  rmBtn.appendChild(createIconEl('close'));
                  rmBtn.addEventListener('click', () => {
                    const nextArr = arr.filter((_, i) => i !== idx);
                    void commitFieldValue(field, nextArr);
                  });
                  ops.appendChild(rmBtn);
                  li.appendChild(ops);
                  attachSortableItem({
                    containerEl: rulesList,
                    itemEl: li,
                    listKey: draftKey,
                    index: idx,
                    itemCount: arr.length,
                    itemLabel: parsed.label,
                    onReorder: (fromIdx, toIdx) => commitListReorder(fromIdx, toIdx)
                  });
                  rulesList.appendChild(li);
                });
                attachSortableContainer(rulesList, {
                  listKey: draftKey,
                  itemCount: arr.length,
                  onReorder: (fromIdx, toIdx) => commitListReorder(fromIdx, toIdx)
                });
                applyPendingFlipAndFocus(rulesList, draftKey);
              }
              listWrap.appendChild(rulesList);

              const defRule = isPlainObject(editor.defaultRule) ? editor.defaultRule : {};
              const firstTarget = targets[0] ? (isPlainObject(targets[0]) ? targets[0].value : targets[0]) : 'any';
              const firstMetric = metrics[0] ? (isPlainObject(metrics[0]) ? metrics[0].value : metrics[0]) : 'remaining<=';
              const firstColor = colors[0] ? normalizeHexColor(isPlainObject(colors[0]) ? colors[0].value : colors[0]) : '#ef4444';
              const draft = state.ruleDrafts.get(draftKey) || {
                target: String(defRule.target || firstTarget),
                metric: String(defRule.metric || firstMetric),
                threshold: String(defRule.threshold ?? 20),
                color: normalizeHexColor(defRule.color || firstColor) || '#ef4444'
              };
              state.ruleDrafts.set(draftKey, draft);

              const builder = doc.createElement('div');
              builder.className = 'ag-rule-builder';

              const condRow = doc.createElement('div');
              condRow.className = 'ag-rule-builder-row';

              const targetSel = doc.createElement('select');
              targetSel.className = 'settings-input';
              targetSel.setAttribute('data-rule-target', field.key);
              targetSel.setAttribute('aria-label', `${labelText} 目标`);
              for (const t of targets) {
                const opt = doc.createElement('option');
                const tVal = isPlainObject(t) ? String(t.value) : String(t);
                opt.value = tVal;
                opt.textContent = isPlainObject(t) ? pickLocaleText(t.label, tVal) : tVal;
                if (tVal === draft.target) opt.selected = true;
                targetSel.appendChild(opt);
              }
              targetSel.value = draft.target;
              targetSel.addEventListener('change', () => {
                draft.target = targetSel.value;
              });
              condRow.appendChild(targetSel);

              const metricSel = doc.createElement('select');
              metricSel.className = 'settings-input';
              metricSel.setAttribute('data-rule-metric', field.key);
              metricSel.setAttribute('aria-label', `${labelText} 条件`);
              for (const m of metrics) {
                const opt = doc.createElement('option');
                const mVal = isPlainObject(m) ? String(m.value) : String(m);
                opt.value = mVal;
                opt.textContent = isPlainObject(m) ? pickLocaleText(m.label, mVal) : mVal;
                if (mVal === draft.metric) opt.selected = true;
                metricSel.appendChild(opt);
              }
              metricSel.value = draft.metric;
              metricSel.addEventListener('change', () => {
                draft.metric = metricSel.value;
              });
              condRow.appendChild(metricSel);

              const thrInput = doc.createElement('input');
              thrInput.type = 'number';
              thrInput.min = '0';
              thrInput.max = '100';
              thrInput.className = 'settings-input ag-rule-threshold';
              thrInput.value = String(draft.threshold);
              thrInput.setAttribute('data-rule-threshold', field.key);
              thrInput.setAttribute('aria-label', `${labelText} 阈值`);
              thrInput.addEventListener('input', () => {
                draft.threshold = thrInput.value;
              });
              thrInput.addEventListener('change', () => {
                draft.threshold = thrInput.value;
              });
              condRow.appendChild(thrInput);

              const unitEl = doc.createElement('span');
              unitEl.className = 'ag-sv-row-desc';
              unitEl.textContent = unitSuffix;
              condRow.appendChild(unitEl);
              builder.appendChild(condRow);

              const colorRow = doc.createElement('div');
              colorRow.className = 'ag-rule-builder-row';
              const swatchesWrap = doc.createElement('div');
              swatchesWrap.className = 'ag-rule-swatches';
              const swatchBtns = [];

              const colorInput = doc.createElement('input');
              colorInput.type = 'color';
              colorInput.className = 'ag-rule-color-picker';
              colorInput.value = normalizeHexColor(draft.color) || '#ef4444';
              colorInput.setAttribute('data-rule-color', field.key);
              colorInput.setAttribute('aria-label', `${labelText} 自定义颜色`);

              const syncSwatchActive = (hex) => {
                const norm = normalizeHexColor(hex);
                for (const b of swatchBtns) {
                  const pHex = b.getAttribute('data-rule-color-hex');
                  b.setAttribute('data-active', pHex === norm ? 'true' : 'false');
                }
                if (norm) colorInput.value = norm;
              };

              for (const c of colors) {
                const rawHex = isPlainObject(c) ? c.value : c;
                const hex = normalizeHexColor(rawHex);
                if (!hex) continue;
                const cLabel = isPlainObject(c) ? pickLocaleText(c.label, hex) : hex;
                const sw = doc.createElement('button');
                sw.type = 'button';
                sw.className = 'ag-rule-swatch';
                sw.title = cLabel;
                sw.setAttribute('aria-label', cLabel);
                sw.setAttribute('data-rule-color-hex', hex);
                sw.setAttribute('data-rule-color-preset', `${field.key}:${hex}`);
                sw.setAttribute('data-active', normalizeHexColor(draft.color) === hex ? 'true' : 'false');
                sw.style?.setProperty?.('background', hex);
                sw.addEventListener('click', () => {
                  draft.color = hex;
                  syncSwatchActive(hex);
                });
                swatchBtns.push(sw);
                swatchesWrap.appendChild(sw);
              }
              colorRow.appendChild(swatchesWrap);

              colorInput.addEventListener('input', () => {
                const hex = normalizeHexColor(colorInput.value);
                if (hex) {
                  draft.color = hex;
                  syncSwatchActive(hex);
                }
              });
              colorInput.addEventListener('change', () => {
                const hex = normalizeHexColor(colorInput.value);
                if (hex) {
                  draft.color = hex;
                  syncSwatchActive(hex);
                }
              });
              colorRow.appendChild(colorInput);

              const addBtn = doc.createElement('button');
              addBtn.type = 'button';
              addBtn.className = 'ag-btn';
              addBtn.setAttribute('data-list-add', field.key);
              addBtn.appendChild(createIconEl('plus'));
              const addLbl = doc.createElement('span');
              addLbl.textContent = '添加规则';
              addBtn.appendChild(addLbl);
              addBtn.addEventListener('click', () => {
                const tVal = String(targetSel.value || draft.target || firstTarget).trim();
                const mVal = String(metricSel.value || draft.metric || firstMetric).trim();
                const rawNum = Number(thrInput.value ?? draft.threshold);
                const cHex = normalizeHexColor(colorInput.value || draft.color);
                if (!tVal || !mVal || !Number.isFinite(rawNum) || !cHex) return;
                const clamped = Math.max(0, Math.min(100, Number(rawNum.toFixed(1))));
                const serialized = `${tVal}:${mVal}${clamped}:${cHex}`;
                void commitFieldValue(field, [...arr, serialized]);
              });
              colorRow.appendChild(addBtn);
              builder.appendChild(colorRow);

              listWrap.appendChild(builder);
              fRow.appendChild(listWrap);
            } else if (editorKind === 'command-preset') {
              fRow.appendChild(fTop);
              const listWrap = doc.createElement('div');
              listWrap.className = 'ag-list-editor ag-cmd-editor';
              listWrap.setAttribute('data-setting-list', field.key);
              listWrap.setAttribute('data-cmd-editor', field.key);

              const activeEdit = state.commandEdits.get(draftKey) || null;
              const cmdList = doc.createElement('div');
              cmdList.className = 'ag-cmd-list';
              if (arr.length === 0) {
                const emptyNote = doc.createElement('div');
                emptyNote.className = 'ag-cmd-empty';
                emptyNote.textContent = '尚未配置快捷命令，可在下方添加任意终端命令';
                cmdList.appendChild(emptyNote);
              } else {
                arr.forEach((rawItem, idx) => {
                  const parsed = parseCommandPresetItem(rawItem);
                  const isEditingThis = Boolean(activeEdit && activeEdit.idx === idx);

                  if (isEditingThis) {
                    const editLi = doc.createElement('div');
                    editLi.className = 'ag-list-item ag-cmd-item ag-cmd-item-editing';
                    editLi.setAttribute('data-cmd-editing', `${field.key}:${idx}`);

                    const editGrid = doc.createElement('div');
                    editGrid.className = 'ag-cmd-builder-grid';

                    const editNameInput = doc.createElement('input');
                    editNameInput.type = 'text';
                    editNameInput.className = 'settings-input ag-cmd-name-input';
                    editNameInput.placeholder = editor?.namePlaceholder ? pickLocaleText(editor.namePlaceholder, '按钮名称') : '按钮名称';
                    editNameInput.value = activeEdit.name ?? parsed.name;
                    editNameInput.setAttribute('data-cmd-edit-name', `${field.key}:${idx}`);
                    editNameInput.setAttribute('aria-label', `编辑 ${parsed.name} 名称`);
                    editNameInput.addEventListener('input', () => { activeEdit.name = editNameInput.value; });

                    const editCmdInput = doc.createElement('input');
                    editCmdInput.type = 'text';
                    editCmdInput.className = 'settings-input ag-cmd-command-input';
                    editCmdInput.placeholder = editor?.commandPlaceholder ? pickLocaleText(editor.commandPlaceholder, '输入任意终端命令') : '输入任意终端命令';
                    editCmdInput.value = activeEdit.command ?? parsed.command;
                    editCmdInput.setAttribute('data-cmd-edit-command', `${field.key}:${idx}`);
                    editCmdInput.setAttribute('aria-label', `编辑 ${parsed.name} 命令`);
                    editCmdInput.addEventListener('input', () => { activeEdit.command = editCmdInput.value; });

                    editGrid.appendChild(editNameInput);
                    editGrid.appendChild(editCmdInput);
                    editLi.appendChild(editGrid);

                    const editActions = doc.createElement('div');
                    editActions.className = 'ag-cmd-edit-actions';

                    const cancelBtn = doc.createElement('button');
                    cancelBtn.type = 'button';
                    cancelBtn.className = 'ag-btn';
                    cancelBtn.setAttribute('data-cmd-edit-cancel', `${field.key}:${idx}`);
                    cancelBtn.textContent = '取消';
                    cancelBtn.addEventListener('click', () => {
                      state.commandEdits.delete(draftKey);
                      state.fieldErrors.delete(`${p.id}:${field.key}`);
                      renderSettingsBody();
                    });

                    const saveEditBtn = doc.createElement('button');
                    saveEditBtn.type = 'button';
                    saveEditBtn.className = 'ag-btn ag-btn-primary';
                    saveEditBtn.setAttribute('data-cmd-edit-save', `${field.key}:${idx}`);
                    saveEditBtn.textContent = '保存';

                    const commitInlineEdit = () => {
                      const nextCmd = String(editCmdInput.value || activeEdit.command || '').trim();
                      if (!nextCmd) {
                        state.fieldErrors.set(`${p.id}:${field.key}`, '请输入要启动的终端命令');
                        renderSettingsBody();
                        return;
                      }
                      const rawName = String(editNameInput.value || activeEdit.name || '').trim();
                      const nextName = rawName || (nextCmd.split(/\s+/)[0] || parsed.name || '命令');
                      const nextArr = arr.map((item, i) => {
                        if (i !== idx) return item;
                        const cur = parseCommandPresetItem(item);
                        return JSON.stringify({
                          name: nextName,
                          command: nextCmd,
                          pinToTopbar: cur.pinToTopbar
                        });
                      });
                      state.commandEdits.delete(draftKey);
                      state.fieldErrors.delete(`${p.id}:${field.key}`);
                      void commitFieldValue(field, nextArr);
                    };

                    saveEditBtn.addEventListener('click', commitInlineEdit);
                    editNameInput.addEventListener('keydown', (e) => {
                      if (e?.key === 'Enter') commitInlineEdit();
                      else if (e?.key === 'Escape') {
                        state.commandEdits.delete(draftKey);
                        state.fieldErrors.delete(`${p.id}:${field.key}`);
                        renderSettingsBody();
                      }
                    });
                    editCmdInput.addEventListener('keydown', (e) => {
                      if (e?.key === 'Enter') commitInlineEdit();
                      else if (e?.key === 'Escape') {
                        state.commandEdits.delete(draftKey);
                        state.fieldErrors.delete(`${p.id}:${field.key}`);
                        renderSettingsBody();
                      }
                    });

                    editActions.appendChild(cancelBtn);
                    editActions.appendChild(saveEditBtn);
                    editLi.appendChild(editActions);
                    cmdList.appendChild(editLi);
                    return;
                  }

                  const li = doc.createElement('div');
                  li.className = 'ag-list-item ag-cmd-item';
                  li.setAttribute('data-cmd-item', `${field.key}:${idx}`);

                  const info = doc.createElement('div');
                  info.className = 'ag-cmd-info';
                  const nameEl = doc.createElement('span');
                  nameEl.className = 'ag-cmd-name';
                  nameEl.textContent = parsed.name;
                  const codeEl = doc.createElement('code');
                  codeEl.className = 'ag-cmd-code';
                  codeEl.textContent = parsed.command;
                  info.appendChild(nameEl);
                  info.appendChild(codeEl);
                  info.addEventListener('dblclick', () => {
                    state.commandEdits.set(draftKey, { idx, name: parsed.name, command: parsed.command });
                    renderSettingsBody();
                  });
                  li.appendChild(info);

                  const ops = doc.createElement('div');
                  ops.className = 'ag-rule-ops';

                  const editBtn = doc.createElement('button');
                  editBtn.type = 'button';
                  editBtn.className = 'ag-icon-btn';
                  editBtn.setAttribute('data-cmd-edit', `${field.key}:${idx}`);
                  editBtn.setAttribute('aria-label', `编辑 ${parsed.name}`);
                  editBtn.setAttribute('title', '修改名称和命令');
                  editBtn.appendChild(createIconEl('pencil'));
                  editBtn.addEventListener('click', () => {
                    state.commandEdits.set(draftKey, { idx, name: parsed.name, command: parsed.command });
                    renderSettingsBody();
                  });
                  ops.appendChild(editBtn);

                  if (editor?.allowPinToTopbar !== false) {
                    const pinBtn = doc.createElement('button');
                    pinBtn.type = 'button';
                    pinBtn.className = 'ag-pin-btn';
                    pinBtn.setAttribute('data-cmd-pin-toggle', `${field.key}:${idx}`);
                    pinBtn.setAttribute('data-pinned', parsed.pinToTopbar ? 'true' : 'false');
                    pinBtn.setAttribute('title', parsed.pinToTopbar ? '已固定到顶栏独立按钮，点击收纳至菜单' : '仅在 CLI 菜单显示，点击固定到顶栏');
                    pinBtn.appendChild(createIconEl(parsed.pinToTopbar ? 'pinFilled' : 'pin'));
                    const pinLbl = doc.createElement('span');
                    pinLbl.textContent = parsed.pinToTopbar ? '顶栏' : '菜单';
                    pinBtn.appendChild(pinLbl);
                    pinBtn.addEventListener('click', () => {
                      const nextArr = arr.map((item, i) => {
                        if (i !== idx) return item;
                        const cur = parseCommandPresetItem(item);
                        return JSON.stringify({
                          name: cur.name,
                          command: cur.command,
                          pinToTopbar: !cur.pinToTopbar
                        });
                      });
                      void commitFieldValue(field, nextArr);
                    });
                    ops.appendChild(pinBtn);
                  }

                  const rmBtn = doc.createElement('button');
                  rmBtn.type = 'button';
                  rmBtn.className = 'ag-icon-btn';
                  rmBtn.setAttribute('data-list-remove', `${field.key}:${idx}`);
                  rmBtn.setAttribute('aria-label', `删除 ${parsed.name}`);
                  rmBtn.appendChild(createIconEl('close'));
                  rmBtn.addEventListener('click', () => {
                    state.commandEdits.delete(draftKey);
                    const nextArr = arr.filter((_, i) => i !== idx);
                    void commitFieldValue(field, nextArr);
                  });
                  ops.appendChild(rmBtn);
                  li.appendChild(ops);
                  attachSortableItem({
                    containerEl: cmdList,
                    itemEl: li,
                    listKey: draftKey,
                    index: idx,
                    itemCount: arr.length,
                    disabled: Boolean(activeEdit),
                    disabledReason: activeEdit ? '请先完成或取消当前编辑后再拖动排序' : '',
                    itemLabel: parsed.name,
                    onReorder: (fromIdx, toIdx) => commitListReorder(fromIdx, toIdx, () => {
                      state.commandEdits.delete(draftKey);
                    })
                  });
                  cmdList.appendChild(li);
                });
                attachSortableContainer(cmdList, {
                  listKey: draftKey,
                  itemCount: arr.length,
                  disabled: Boolean(activeEdit),
                  onReorder: (fromIdx, toIdx) => commitListReorder(fromIdx, toIdx, () => {
                    state.commandEdits.delete(draftKey);
                  })
                });
                applyPendingFlipAndFocus(cmdList, draftKey);
              }
              listWrap.appendChild(cmdList);

              const cmdDraft = state.commandDrafts.get(draftKey) || { name: '', command: '', pinToTopbar: true };
              state.commandDrafts.set(draftKey, cmdDraft);

              const builder = doc.createElement('div');
              builder.className = 'ag-rule-builder ag-cmd-builder';

              const row1 = doc.createElement('div');
              row1.className = 'ag-cmd-builder-grid';

              const nameInput = doc.createElement('input');
              nameInput.type = 'text';
              nameInput.className = 'settings-input ag-cmd-name-input';
              nameInput.placeholder = editor?.namePlaceholder ? pickLocaleText(editor.namePlaceholder, '按钮名称') : '按钮名称（如 Claude / Dev）';
              nameInput.value = cmdDraft.name || '';
              nameInput.setAttribute('data-cmd-name', field.key);
              nameInput.setAttribute('aria-label', `${labelText} 名称`);
              nameInput.addEventListener('input', () => { cmdDraft.name = nameInput.value; });
              nameInput.addEventListener('change', () => { cmdDraft.name = nameInput.value; });

              const cmdInput = doc.createElement('input');
              cmdInput.type = 'text';
              cmdInput.className = 'settings-input ag-cmd-command-input';
              cmdInput.placeholder = editor?.commandPlaceholder ? pickLocaleText(editor.commandPlaceholder, '输入任意终端命令...') : '输入任意终端命令（如 claude --continue）';
              cmdInput.value = cmdDraft.command || '';
              cmdInput.setAttribute('data-cmd-command', field.key);
              cmdInput.setAttribute('aria-label', `${labelText} 命令`);
              cmdInput.addEventListener('input', () => { cmdDraft.command = cmdInput.value; });
              cmdInput.addEventListener('change', () => { cmdDraft.command = cmdInput.value; });

              row1.appendChild(nameInput);
              row1.appendChild(cmdInput);
              builder.appendChild(row1);

              const row2 = doc.createElement('div');
              row2.className = 'ag-cmd-builder-row ag-cmd-builder-actions';

              const pinCheckWrap = doc.createElement('label');
              pinCheckWrap.className = 'ag-cmd-pin-label';
              const pinToggle = doc.createElement('span');
              pinToggle.className = 'ag-toggle-label';
              const pinCheck = doc.createElement('input');
              pinCheck.type = 'checkbox';
              pinCheck.checked = cmdDraft.pinToTopbar !== false;
              pinCheck.setAttribute('data-cmd-pin', field.key);
              pinCheck.addEventListener('change', () => {
                cmdDraft.pinToTopbar = Boolean(pinCheck.checked);
              });
              pinToggle.appendChild(pinCheck);
              const pinText = doc.createElement('span');
              pinText.textContent = '在顶栏显示独立快捷按钮';
              pinCheckWrap.appendChild(pinToggle);
              pinCheckWrap.appendChild(pinText);
              if (editor?.allowPinToTopbar !== false) {
                row2.appendChild(pinCheckWrap);
              }

              const addBtn = doc.createElement('button');
              addBtn.type = 'button';
              addBtn.className = 'ag-btn';
              addBtn.setAttribute('data-list-add', field.key);
              addBtn.appendChild(createIconEl('plus'));
              const addLbl = doc.createElement('span');
              addLbl.textContent = '添加命令';
              addBtn.appendChild(addLbl);

              const handleAddCmd = () => {
                const rawCmd = String(cmdInput.value || cmdDraft.command || '').trim();
                if (!rawCmd) {
                  state.fieldErrors.set(`${p.id}:${field.key}`, '请输入要启动的终端命令');
                  renderSettingsBody();
                  return;
                }
                const rawName = String(nameInput.value || cmdDraft.name || '').trim();
                const finalName = rawName || (rawCmd.split(/\s+/)[0] || '命令');
                const pin = editor?.allowPinToTopbar === false ? true : Boolean(pinCheck.checked);
                const serialized = JSON.stringify({ name: finalName, command: rawCmd, pinToTopbar: pin });
                state.commandDrafts.set(draftKey, { name: '', command: '', pinToTopbar: true });
                state.fieldErrors.delete(`${p.id}:${field.key}`);
                void commitFieldValue(field, [...arr, serialized]);
              };
              addBtn.addEventListener('click', handleAddCmd);
              nameInput.addEventListener('keydown', (e) => { if (e?.key === 'Enter') handleAddCmd(); });
              cmdInput.addEventListener('keydown', (e) => { if (e?.key === 'Enter') handleAddCmd(); });
              row2.appendChild(addBtn);
              builder.appendChild(row2);

              listWrap.appendChild(builder);
              fRow.appendChild(listWrap);
            } else if (editorKind === 'ordered-preset-list') {
              const presets = Array.isArray(editor.presets) ? editor.presets : [];
              const presetById = new Map();
              for (const pr of presets) {
                if (pr && typeof pr.id === 'string' && pr.id.trim()) {
                  presetById.set(pr.id.trim(), pr);
                }
              }

              const parsePresetEntry = (rawEntry) => {
                const rawStr = String(rawEntry || '').trim();
                if (!rawStr) return null;
                if (rawStr.startsWith('{')) {
                  try {
                    const obj = JSON.parse(rawStr);
                    if (obj && typeof obj === 'object') {
                      const id = String(obj.id || '').trim() || `custom_${Math.random().toString(36).slice(2, 8)}`;
                      return {
                        id,
                        label: String(obj.label || id),
                        text: String(obj.text || ''),
                        tag: obj.tag ? String(obj.tag) : '',
                        description: obj.description ? String(obj.description) : '',
                        source: obj.source ? String(obj.source) : '',
                        autoSend: Boolean(obj.autoSend),
                        isCustom: !presetById.has(id)
                      };
                    }
                  } catch {}
                }
                const preset = presetById.get(rawStr);
                if (preset) {
                  return {
                    id: preset.id,
                    label: pickLocaleText(preset.label, preset.id),
                    tag: preset.tag ? pickLocaleText(preset.tag, '') : '',
                    description: preset.description ? pickLocaleText(preset.description, '') : '',
                    text: String(preset.text || ''),
                    autoSend: Boolean(preset.autoSend),
                    isCustom: false
                  };
                }
                return {
                  id: rawStr,
                  label: rawStr,
                  text: rawStr,
                  autoSend: false,
                  isCustom: true
                };
              };

              if (Array.isArray(field.default)) {
                const resetBtn = doc.createElement('button');
                resetBtn.type = 'button';
                resetBtn.className = 'ag-btn';
                resetBtn.setAttribute('data-preset-reset', field.key);
                resetBtn.textContent = '恢复默认';
                resetBtn.addEventListener('click', () => {
                  void commitFieldValue(field, [...field.default]);
                });
                fTop.appendChild(resetBtn);
              }
              fRow.appendChild(fTop);

              const listWrap = doc.createElement('div');
              listWrap.className = 'ag-list-editor ag-preset-editor';
              listWrap.setAttribute('data-setting-list', field.key);
              listWrap.setAttribute('data-preset-editor', field.key);

              const activeList = doc.createElement('div');
              activeList.className = 'ag-preset-active-list';
              const activeIds = new Set();
              const activeTexts = new Set();

              if (arr.length === 0) {
                const emptyNote = doc.createElement('div');
                emptyNote.className = 'ag-sv-row-desc';
                emptyNote.textContent = '当前未启用任何快捷条目，可从下方预设池添加或新建自定义条目';
                activeList.appendChild(emptyNote);
              } else {
                arr.forEach((rawEntry, idx) => {
                  const parsed = parsePresetEntry(rawEntry);
                  if (parsed?.id) activeIds.add(parsed.id);
                  if (parsed?.text && parsed.text.trim()) activeTexts.add(parsed.text.trim());
                  const li = doc.createElement('div');
                  li.className = 'ag-list-item ag-preset-item';
                  li.setAttribute('data-preset-item', `${field.key}:${idx}`);
                  li.setAttribute('data-preset-id', parsed?.id || '');

                  const info = doc.createElement('div');
                  info.className = 'ag-preset-info';
                  const lblSpan = doc.createElement('span');
                  lblSpan.className = 'ag-preset-label';
                  lblSpan.textContent = parsed ? parsed.label : String(rawEntry);
                  info.appendChild(lblSpan);

                  const metaText = parsed?.tag || (parsed?.isCustom ? (parsed.autoSend ? '自定义 · 自动发送' : '自定义') : '');
                  if (metaText) {
                    const chip = doc.createElement('span');
                    chip.className = 'ag-chip';
                    chip.textContent = metaText;
                    info.appendChild(chip);
                  }
                  if (parsed?.isCustom && parsed?.text) {
                    const preview = doc.createElement('span');
                    preview.className = 'ag-preset-preview';
                    preview.textContent = `实际填充：${parsed.text}`;
                    preview.setAttribute('title', parsed.description ? `${parsed.description}\n实际填充：${parsed.text}` : `实际填充：${parsed.text}`);
                    info.appendChild(preview);
                  } else if (parsed?.description) {
                    const preview = doc.createElement('span');
                    preview.className = 'ag-preset-preview';
                    preview.textContent = parsed.description;
                    if (parsed.text) preview.setAttribute('title', `实际填充：${parsed.text}`);
                    info.appendChild(preview);
                  }
                  li.appendChild(info);

                  const ops = doc.createElement('div');
                  ops.className = 'ag-rule-ops';
                  const rmBtn = doc.createElement('button');
                  rmBtn.type = 'button';
                  rmBtn.className = 'ag-icon-btn';
                  rmBtn.setAttribute('data-list-remove', `${field.key}:${idx}`);
                  rmBtn.setAttribute('aria-label', `移除 ${parsed ? parsed.label : String(rawEntry)}`);
                  rmBtn.appendChild(createIconEl('close'));
                  rmBtn.addEventListener('click', () => {
                    const nextArr = arr.filter((_, i) => i !== idx);
                    void commitFieldValue(field, nextArr);
                  });
                  ops.appendChild(rmBtn);
                  li.appendChild(ops);
                  attachSortableItem({
                    containerEl: activeList,
                    itemEl: li,
                    listKey: draftKey,
                    index: idx,
                    itemCount: arr.length,
                    itemLabel: parsed ? parsed.label : String(rawEntry),
                    onReorder: (fromIdx, toIdx) => commitListReorder(fromIdx, toIdx)
                  });
                  activeList.appendChild(li);
                });
                attachSortableContainer(activeList, {
                  listKey: draftKey,
                  itemCount: arr.length,
                  onReorder: (fromIdx, toIdx) => commitListReorder(fromIdx, toIdx)
                });
                applyPendingFlipAndFocus(activeList, draftKey);
              }
              listWrap.appendChild(activeList);

              const availablePresets = presets.filter((pr) => pr && pr.id && !activeIds.has(pr.id));
              if (availablePresets.length > 0) {
                const poolWrap = doc.createElement('div');
                poolWrap.className = 'ag-preset-pool';
                poolWrap.setAttribute('data-preset-pool', field.key);
                const poolTitle = doc.createElement('div');
                poolTitle.className = 'ag-sv-row-desc';
                poolTitle.textContent = '可选预设条目（点击添加到上方展示列表）：';
                poolWrap.appendChild(poolTitle);
                const chipRow = doc.createElement('div');
                chipRow.className = 'ag-preset-pool-chips';
                for (const pr of availablePresets) {
                  const prLbl = pickLocaleText(pr.label, pr.id);
                  const addChip = doc.createElement('button');
                  addChip.type = 'button';
                  addChip.className = 'ag-btn ag-preset-pool-chip';
                  addChip.setAttribute('data-preset-add', `${field.key}:${pr.id}`);
                  const prDesc = pr.description ? pickLocaleText(pr.description, '') : '';
                  if (prDesc) addChip.setAttribute('title', prDesc);
                  addChip.textContent = `+ ${prLbl}`;
                  addChip.addEventListener('click', () => {
                    void commitFieldValue(field, [...arr, pr.id]);
                  });
                  chipRow.appendChild(addChip);
                }
                poolWrap.appendChild(chipRow);
                listWrap.appendChild(poolWrap);
              }

              if (editor.dynamicPresetsCommand) {
                const dynKey = `${p.id}:${field.key}`;
                const dynEntry = state.dynamicPresets.get(dynKey);
                if (!dynEntry?.loaded && !dynEntry?.loading) {
                  void loadDynamicPresets(field, currentValues);
                }

                const dynPoolWrap = doc.createElement('div');
                dynPoolWrap.className = 'ag-preset-pool ag-preset-dynamic-pool';
                dynPoolWrap.setAttribute('data-preset-dynamic-pool', field.key);

                const dynHead = doc.createElement('div');
                dynHead.className = 'ag-preset-pool-head';
                const dynTitle = doc.createElement('div');
                dynTitle.className = 'ag-sv-row-desc';
                dynTitle.textContent = editor.dynamicPoolTitle
                  ? pickLocaleText(editor.dynamicPoolTitle, '智能推荐可添加内容：')
                  : '智能推荐可添加内容：';
                dynHead.appendChild(dynTitle);

                if (isPlainObject(editor.dynamicAction) && editor.dynamicAction.command) {
                  const dynAct = editor.dynamicAction;
                  const actId = dynAct.id || dynAct.command;
                  const busyKey = `${p.id}:${actId}`;
                  const actBtn = doc.createElement('button');
                  actBtn.type = 'button';
                  actBtn.className = 'ag-btn';
                  actBtn.setAttribute('data-preset-dynamic-action', field.key);
                  actBtn.setAttribute('data-command-id', dynAct.command);
                  const isRunning = state.actionBusyId === busyKey;
                  actBtn.disabled = Boolean(state.actionBusyId);
                  if (isRunning) {
                    const sp = doc.createElement('span');
                    sp.className = 'ag-spinner';
                    actBtn.appendChild(sp);
                  }
                  const actLblText = pickLocaleText(dynAct.label, dynAct.command);
                  const actLbl = doc.createElement('span');
                  actLbl.textContent = isRunning ? `${actLblText}...` : actLblText;
                  actBtn.appendChild(actLbl);
                  actBtn.addEventListener('click', () => {
                    if (state.actionBusyId) return;
                    state.actionBusyId = busyKey;
                    state.manageToast = { tone: 'info', spinning: true, text: `正在执行 ${actLblText}...` };
                    renderSettingsBody();
                    void (async () => {
                      try {
                        const res = await executeCommand(p.id, dynAct.command, [{ values: currentValues, fieldKey: field.key }]);
                        const payload = (res && isPlainObject(res.result)) ? res.result : res;
                        if (res?.ok === false || payload?.ok === false) {
                          throw new Error(payload?.message || payload?.error || res?.error || 'COMMAND_FAILED');
                        }
                        await loadDynamicPresets(field, currentValues, { force: true });
                        const detailMsg = typeof payload?.message === 'string'
                          ? `：${payload.message}`
                          : (typeof res?.message === 'string' ? `：${res.message}` : '');
                        state.manageToast = { tone: 'info', spinning: false, text: `${actLblText} 完成${detailMsg}` };
                      } catch (err) {
                        state.manageToast = { tone: 'error', spinning: false, text: `${actLblText} 失败：${err?.message || String(err)}` };
                      } finally {
                        state.actionBusyId = null;
                        if (state.settingsMode !== 'closed') renderSettingsBody();
                      }
                    })();
                  });
                  dynHead.appendChild(actBtn);
                }
                dynPoolWrap.appendChild(dynHead);

                const availableDynamic = (dynEntry?.presets || []).filter((pr) => (
                  pr && pr.id && !activeIds.has(pr.id) && !activeTexts.has(String(pr.text || '').trim())
                ));

                if (dynEntry?.loading && availableDynamic.length === 0) {
                  const loadingHint = doc.createElement('div');
                  loadingHint.className = 'ag-preset-pool-meta';
                  loadingHint.textContent = '正在加载可添加内容...';
                  dynPoolWrap.appendChild(loadingHint);
                } else if (availableDynamic.length > 0) {
                  const dynChipRow = doc.createElement('div');
                  dynChipRow.className = 'ag-preset-pool-chips';
                  for (const pr of availableDynamic) {
                    const prLbl = pickLocaleText(pr.label, pr.id);
                    const prTag = pr.tag ? pickLocaleText(pr.tag, '') : '';
                    const prDesc = pr.description ? pickLocaleText(pr.description, '') : '';
                    const addChip = doc.createElement('button');
                    addChip.type = 'button';
                    addChip.className = 'ag-btn ag-preset-pool-chip';
                    addChip.setAttribute('data-preset-add', `${field.key}:${pr.id}`);
                    addChip.setAttribute('data-preset-dynamic', 'true');
                    addChip.setAttribute('title', `UI 显示：${prLbl}\n实际填充：${pr.text}${prDesc ? `\n${prDesc}` : ''}`);
                    const txtNode = doc.createElement('span');
                    txtNode.textContent = `+ ${prLbl}`;
                    addChip.appendChild(txtNode);
                    if (prTag) {
                      const tagEl = doc.createElement('span');
                      tagEl.className = 'ag-preset-chip-tag';
                      tagEl.textContent = prTag;
                      addChip.appendChild(tagEl);
                    }
                    addChip.addEventListener('click', () => {
                      const serialized = JSON.stringify({
                        id: pr.id,
                        label: prLbl,
                        text: String(pr.text || prLbl),
                        ...(prTag ? { tag: prTag } : {}),
                        ...(prDesc ? { description: prDesc } : {}),
                        source: pr.source || 'dynamic',
                        autoSend: Boolean(pr.autoSend)
                      });
                      void commitFieldValue(field, [...arr, serialized]);
                    });
                    dynChipRow.appendChild(addChip);
                  }
                  dynPoolWrap.appendChild(dynChipRow);
                } else {
                  const emptyHint = doc.createElement('div');
                  emptyHint.className = 'ag-preset-pool-meta';
                  emptyHint.textContent = editor.dynamicEmptyHint
                    ? pickLocaleText(editor.dynamicEmptyHint, '暂无待添加条目，可点击右上角按钮分析生成')
                    : '暂无待添加条目，可点击右上角按钮分析生成';
                  dynPoolWrap.appendChild(emptyHint);
                }

                if (dynEntry?.meta?.sessionsScanned > 0) {
                  const metaHint = doc.createElement('div');
                  metaHint.className = 'ag-preset-pool-meta';
                  const updatedStr = dynEntry.meta.updatedAt
                    ? ` · 更新于 ${String(dynEntry.meta.updatedAt).slice(0, 16).replace('T', ' ')}`
                    : '';
                  metaHint.textContent = `已扫描 ${dynEntry.meta.sessionsScanned} 个会话（${dynEntry.meta.messagesScanned || 0} 条手动输入）${updatedStr}`;
                  dynPoolWrap.appendChild(metaHint);
                }

                listWrap.appendChild(dynPoolWrap);
              }

              if (editor.allowCustom !== false) {
                const pDraft = state.presetDrafts.get(draftKey) || { label: '', text: '', autoSend: false };
                state.presetDrafts.set(draftKey, pDraft);

                const builder = doc.createElement('div');
                builder.className = 'ag-rule-builder ag-preset-builder';

                const row1 = doc.createElement('div');
                row1.className = 'ag-cmd-builder-row';

                const lblInput = doc.createElement('input');
                lblInput.type = 'text';
                lblInput.className = 'settings-input ag-cmd-name-input';
                lblInput.placeholder = editor.labelPlaceholder ? pickLocaleText(editor.labelPlaceholder, '按钮名称') : '按钮名称（如 代码审查）';
                lblInput.value = pDraft.label || '';
                lblInput.setAttribute('data-preset-custom-label', field.key);
                lblInput.setAttribute('aria-label', `${labelText} 名称`);
                lblInput.addEventListener('input', () => { pDraft.label = lblInput.value; });
                lblInput.addEventListener('change', () => { pDraft.label = lblInput.value; });

                const txtInput = doc.createElement('input');
                txtInput.type = 'text';
                txtInput.className = 'settings-input ag-cmd-command-input';
                txtInput.placeholder = editor.textPlaceholder ? pickLocaleText(editor.textPlaceholder, '填入文本...') : '点击后填入的提示词或命令...';
                txtInput.value = pDraft.text || '';
                txtInput.setAttribute('data-preset-custom-text', field.key);
                txtInput.setAttribute('aria-label', `${labelText} 文本`);
                txtInput.addEventListener('input', () => { pDraft.text = txtInput.value; });
                txtInput.addEventListener('change', () => { pDraft.text = txtInput.value; });

                row1.appendChild(lblInput);
                row1.appendChild(txtInput);
                builder.appendChild(row1);

                const row2 = doc.createElement('div');
                row2.className = 'ag-cmd-builder-row ag-cmd-builder-actions';

                const autoWrap = doc.createElement('label');
                autoWrap.className = 'ag-cmd-pin-label';
                const autoCheck = doc.createElement('input');
                autoCheck.type = 'checkbox';
                autoCheck.checked = Boolean(pDraft.autoSend);
                autoCheck.setAttribute('data-preset-custom-autosend', field.key);
                autoCheck.addEventListener('change', () => {
                  pDraft.autoSend = Boolean(autoCheck.checked);
                });
                const autoText = doc.createElement('span');
                autoText.textContent = '点击后立即发送';
                autoWrap.appendChild(autoCheck);
                autoWrap.appendChild(autoText);
                row2.appendChild(autoWrap);

                const addCustomBtn = doc.createElement('button');
                addCustomBtn.type = 'button';
                addCustomBtn.className = 'ag-btn';
                addCustomBtn.setAttribute('data-list-add', field.key);
                addCustomBtn.appendChild(createIconEl('plus'));
                const addLbl = doc.createElement('span');
                addLbl.textContent = '添加自定义';
                addCustomBtn.appendChild(addLbl);

                const handleAddCustomPreset = () => {
                  const rawLabel = String(lblInput.value || pDraft.label || '').trim();
                  const rawText = String(txtInput.value || pDraft.text || '').trim();
                  if (!rawLabel || !rawText) {
                    state.fieldErrors.set(`${p.id}:${field.key}`, '请输入自定义按钮名称和填入文本');
                    renderSettingsBody();
                    return;
                  }
                  const serialized = JSON.stringify({
                    id: `custom_${Date.now().toString(36)}`,
                    label: rawLabel,
                    text: rawText,
                    source: 'custom',
                    autoSend: Boolean(autoCheck.checked)
                  });
                  state.presetDrafts.set(draftKey, { label: '', text: '', autoSend: false });
                  state.fieldErrors.delete(`${p.id}:${field.key}`);
                  void commitFieldValue(field, [...arr, serialized]);
                };
                addCustomBtn.addEventListener('click', handleAddCustomPreset);
                lblInput.addEventListener('keydown', (e) => { if (e?.key === 'Enter') handleAddCustomPreset(); });
                txtInput.addEventListener('keydown', (e) => { if (e?.key === 'Enter') handleAddCustomPreset(); });
                row2.appendChild(addCustomBtn);
                builder.appendChild(row2);

                listWrap.appendChild(builder);
              }
              fRow.appendChild(listWrap);
            } else if (editorKind === 'catalog-filter-sort') {
              const catKey = `${p.id}:${field.key}`;
              const catEntry = state.catalogItems.get(catKey);
              if (!catEntry?.loaded && !catEntry?.loading) {
                void loadCatalogItems(field, currentValues);
              }
              const uiState = state.catalogUiState.get(catKey) || { query: '', dimension: 'all', sortMode: 'custom' };
              state.catalogUiState.set(catKey, uiState);

              const sortModeKey = typeof editor.sortModeKey === 'string' && editor.sortModeKey.trim()
                ? editor.sortModeKey.trim()
                : '';
              const sortModeField = sortModeKey ? fields.find((f) => f.key === sortModeKey) : null;
              const activeSortMode = sortModeKey && typeof currentValues[sortModeKey] === 'string'
                ? currentValues[sortModeKey]
                : (uiState.sortMode || 'custom');

              const headerBtns = doc.createElement('div');
              headerBtns.className = 'ag-catalog-head-actions';

              const refreshBtn = doc.createElement('button');
              refreshBtn.type = 'button';
              refreshBtn.className = 'ag-btn';
              refreshBtn.setAttribute('data-catalog-refresh', field.key);
              refreshBtn.appendChild(createIconEl('refresh'));
              const refLbl = doc.createElement('span');
              refLbl.textContent = catEntry?.loading ? '加载中...' : '刷新';
              refreshBtn.appendChild(refLbl);
              refreshBtn.disabled = Boolean(catEntry?.loading);
              refreshBtn.addEventListener('click', () => {
                void loadCatalogItems(field, currentValues, { force: true });
              });
              headerBtns.appendChild(refreshBtn);

              if (Array.isArray(field.default)) {
                const resetBtn = doc.createElement('button');
                resetBtn.type = 'button';
                resetBtn.className = 'ag-btn';
                resetBtn.setAttribute('data-catalog-reset', field.key);
                resetBtn.textContent = '恢复默认';
                resetBtn.addEventListener('click', () => {
                  state.catalogUiState.set(catKey, { query: '', dimension: 'all', sortMode: 'custom' });
                  const extra = sortModeField
                    ? { [sortModeField.key]: typeof sortModeField.default === 'string' ? sortModeField.default : 'custom' }
                    : null;
                  void commitFieldValue(field, [...field.default], extra);
                });
                headerBtns.appendChild(resetBtn);
              }
              fTop.appendChild(headerBtns);
              fRow.appendChild(fTop);

              const listWrap = doc.createElement('div');
              listWrap.className = 'ag-list-editor ag-catalog-editor';
              listWrap.setAttribute('data-setting-list', field.key);
              listWrap.setAttribute('data-catalog-editor', field.key);

              const controlsBar = doc.createElement('div');
              controlsBar.className = 'ag-catalog-controls';

              const searchInput = doc.createElement('input');
              searchInput.type = 'text';
              searchInput.className = 'settings-input ag-catalog-search';
              searchInput.placeholder = '按名称或 ID 过滤模型...';
              searchInput.value = uiState.query || '';
              searchInput.setAttribute('data-catalog-search', field.key);
              searchInput.setAttribute('aria-label', `${labelText} 搜索过滤`);
              controlsBar.appendChild(searchInput);

              const sortOptions = Array.isArray(editor.sortOptions) && editor.sortOptions.length > 0
                ? editor.sortOptions
                : [
                    { value: 'custom', label: '自定义排序' },
                    { value: 'name_asc', label: '名称 A → Z' },
                    { value: 'name_desc', label: '名称 Z → A' },
                    { value: 'provider', label: '按厂商分组' },
                    { value: 'frequency', label: '按使用频率' }
                  ];
              const sortSelect = doc.createElement('select');
              sortSelect.className = 'settings-input ag-catalog-sort-select';
              sortSelect.setAttribute('data-catalog-sort', field.key);
              sortSelect.setAttribute('aria-label', `${labelText} 排序规则`);
              for (const sOpt of sortOptions) {
                const o = doc.createElement('option');
                o.value = String(sOpt.value);
                o.textContent = pickLocaleText(sOpt.label, String(sOpt.value));
                if (o.value === activeSortMode) o.selected = true;
                sortSelect.appendChild(o);
              }
              sortSelect.value = activeSortMode;
              controlsBar.appendChild(sortSelect);

              const resetFilterBtn = doc.createElement('button');
              resetFilterBtn.type = 'button';
              resetFilterBtn.className = 'ag-btn';
              resetFilterBtn.setAttribute('data-catalog-filter-reset', field.key);
              resetFilterBtn.textContent = '重置筛选';
              setHidden(resetFilterBtn, !uiState.query && uiState.dimension === 'all');
              controlsBar.appendChild(resetFilterBtn);

              listWrap.appendChild(controlsBar);

              const dimensions = Array.isArray(editor.filterDimensions) && editor.filterDimensions.length > 0
                ? editor.filterDimensions
                : [
                    { id: 'all', label: '全部' },
                    { id: 'visible', label: '仅已启用' },
                    { id: 'hidden', label: '仅已隐藏' }
                  ];
              const dimBar = doc.createElement('div');
              dimBar.className = 'ag-catalog-dims';
              const dimButtons = new Map();
              for (const dim of dimensions) {
                const dBtn = doc.createElement('button');
                dBtn.type = 'button';
                dBtn.className = 'ag-btn ag-catalog-dim-btn';
                dBtn.setAttribute('data-catalog-dim', `${field.key}:${dim.id}`);
                dBtn.setAttribute('data-active', uiState.dimension === dim.id ? 'true' : 'false');
                dBtn.textContent = pickLocaleText(dim.label, dim.id);
                dimButtons.set(dim.id, dBtn);
                dimBar.appendChild(dBtn);
              }
              listWrap.appendChild(dimBar);

              const summaryLine = doc.createElement('div');
              summaryLine.className = 'ag-sv-row-desc ag-catalog-summary';
              summaryLine.setAttribute('data-catalog-summary', field.key);
              listWrap.appendChild(summaryLine);

              const rowsContainer = doc.createElement('div');
              rowsContainer.className = 'ag-catalog-rows';
              rowsContainer.setAttribute('data-catalog-rows', field.key);
              listWrap.appendChild(rowsContainer);

              const parseFilterOrderState = (rawList) => {
                const hiddenSet = new Set();
                const orderedIds = [];
                const seenIds = new Set();
                for (const entry of (Array.isArray(rawList) ? rawList : [])) {
                  const s = String(entry || '').trim();
                  if (!s) continue;
                  if (s.startsWith('!')) {
                    const hid = s.slice(1).trim();
                    if (hid) hiddenSet.add(hid);
                  } else if (!seenIds.has(s)) {
                    seenIds.add(s);
                    orderedIds.push(s);
                  }
                }
                return { hiddenSet, orderedIds };
              };

              const serializeFilterOrderState = (orderedIds, hiddenSet) => {
                const out = [];
                for (const id of orderedIds) {
                  if (id && !hiddenSet.has(id)) out.push(id);
                }
                for (const hid of hiddenSet) {
                  if (hid) out.push(`!${hid}`);
                }
                return out;
              };

              const buildMergedCatalog = () => {
                const { hiddenSet, orderedIds } = parseFilterOrderState(arr);
                const byId = new Map();
                const naturalOrder = [];
                for (const it of (catEntry?.items || [])) {
                  if (!byId.has(it.id)) {
                    byId.set(it.id, { ...it });
                    naturalOrder.push(it.id);
                  }
                }
                for (const id of [...orderedIds, ...Array.from(hiddenSet)]) {
                  if (!byId.has(id)) {
                    byId.set(id, { id, label: id, category: 'other', description: '', frequency: 0 });
                    naturalOrder.push(id);
                  }
                }
                const customRank = new Map();
                orderedIds.forEach((id, i) => customRank.set(id, i));
                const providerOrder = { gemini: 0, claude: 1, openai: 2, orchestrator: 3, other: 4 };

                const allItems = naturalOrder.map((id, natIdx) => ({
                  ...byId.get(id),
                  hidden: hiddenSet.has(id),
                  natIdx
                }));

                const mode = activeSortMode;
                allItems.sort((a, b) => {
                  if (mode === 'name_asc') return a.label.localeCompare(b.label, 'zh-CN');
                  if (mode === 'name_desc') return b.label.localeCompare(a.label, 'zh-CN');
                  if (mode === 'provider') {
                    const pa = providerOrder[a.category] ?? 99;
                    const pb = providerOrder[b.category] ?? 99;
                    if (pa !== pb) return pa - pb;
                    return a.label.localeCompare(b.label, 'zh-CN');
                  }
                  if (mode === 'frequency') {
                    const diff = (b.frequency || 0) - (a.frequency || 0);
                    if (diff !== 0) return diff;
                    return a.label.localeCompare(b.label, 'zh-CN');
                  }
                  const ra = customRank.has(a.id) ? customRank.get(a.id) : 1e6 + a.natIdx;
                  const rb = customRank.has(b.id) ? customRank.get(b.id) : 1e6 + b.natIdx;
                  return ra - rb;
                });

                return { allItems, hiddenSet, orderedIds };
              };

              const renderCatalogRows = () => {
                clearElement(rowsContainer);
                const curQuery = String(uiState.query || '').trim().toLowerCase();
                const curDim = uiState.dimension || 'all';
                setHidden(resetFilterBtn, !curQuery && curDim === 'all');
                for (const [dId, btn] of dimButtons.entries()) {
                  btn.setAttribute('data-active', curDim === dId ? 'true' : 'false');
                }

                if (catEntry?.loading && (!catEntry.items || catEntry.items.length === 0)) {
                  const loadingEl = doc.createElement('div');
                  loadingEl.className = 'ag-sv-row-desc';
                  loadingEl.textContent = '正在加载模型列表...';
                  rowsContainer.appendChild(loadingEl);
                  summaryLine.textContent = '正在读取可用模型...';
                  return;
                }

                const { allItems, hiddenSet } = buildMergedCatalog();
                const filtered = allItems.filter((item) => {
                  if (curDim === 'visible' && item.hidden) return false;
                  if (curDim === 'hidden' && !item.hidden) return false;
                  if (curDim !== 'all' && curDim !== 'visible' && curDim !== 'hidden' && item.category !== curDim) {
                    return false;
                  }
                  if (curQuery) {
                    const hay = `${item.label} ${item.id} ${item.description} ${item.category}`.toLowerCase();
                    if (!hay.includes(curQuery)) return false;
                  }
                  return true;
                });

                summaryLine.textContent = `显示 ${filtered.length} / 共 ${allItems.length} 个模型（已隐藏 ${hiddenSet.size} 个）`;

                if (filtered.length === 0) {
                  const emptyEl = doc.createElement('div');
                  emptyEl.className = 'ag-sv-row-desc';
                  emptyEl.setAttribute('data-catalog-empty', field.key);
                  emptyEl.textContent = allItems.length === 0 ? '暂无可用模型' : '无匹配当前过滤条件的模型';
                  rowsContainer.appendChild(emptyEl);
                  return;
                }

                const visibleOrderIds = allItems.filter((it) => !it.hidden).map((it) => it.id);

                filtered.forEach((item, idx) => {
                  const li = doc.createElement('div');
                  li.className = 'ag-list-item ag-catalog-row';
                  li.setAttribute('data-catalog-item', `${field.key}:${item.id}`);
                  li.setAttribute('data-hidden', item.hidden ? 'true' : 'false');

                  const leftWrap = doc.createElement('label');
                  leftWrap.className = 'ag-catalog-row-main';

                  const chk = doc.createElement('input');
                  chk.type = 'checkbox';
                  chk.checked = !item.hidden;
                  chk.setAttribute('data-catalog-toggle', `${field.key}:${item.id}`);
                  chk.setAttribute('aria-label', `${item.hidden ? '启用' : '隐藏'} ${item.label}`);
                  chk.addEventListener('change', () => {
                    const nextHidden = new Set(hiddenSet);
                    if (chk.checked) nextHidden.delete(item.id);
                    else nextHidden.add(item.id);
                    const baseIds = visibleOrderIds.includes(item.id)
                      ? visibleOrderIds
                      : (chk.checked ? [...visibleOrderIds, item.id] : visibleOrderIds);
                    void commitFieldValue(field, serializeFilterOrderState(baseIds, nextHidden));
                  });
                  leftWrap.appendChild(chk);

                  const metaBox = doc.createElement('div');
                  metaBox.className = 'ag-catalog-row-meta';
                  const titleSpan = doc.createElement('span');
                  titleSpan.className = 'ag-catalog-row-title';
                  titleSpan.textContent = item.label;
                  metaBox.appendChild(titleSpan);

                  const chipsBox = doc.createElement('span');
                  chipsBox.className = 'ag-catalog-row-chips';
                  const catChip = doc.createElement('span');
                  catChip.className = 'ag-chip';
                  catChip.textContent = item.category;
                  chipsBox.appendChild(catChip);
                  if (item.frequency > 0) {
                    const freqChip = doc.createElement('span');
                    freqChip.className = 'ag-chip';
                    freqChip.textContent = `使用 ${item.frequency} 次`;
                    chipsBox.appendChild(freqChip);
                  }
                  if (item.hidden) {
                    const hidChip = doc.createElement('span');
                    hidChip.className = 'ag-chip';
                    hidChip.setAttribute('data-tone', 'warn');
                    hidChip.textContent = '已隐藏';
                    chipsBox.appendChild(hidChip);
                  }
                  metaBox.appendChild(chipsBox);
                  leftWrap.appendChild(metaBox);
                  li.appendChild(leftWrap);

                  const ops = doc.createElement('div');
                  ops.className = 'ag-catalog-ops';

                  const moveItem = (dir) => {
                    const visIds = allItems.filter((it) => !it.hidden).map((it) => it.id);
                    const curIdx = visIds.indexOf(item.id);
                    if (curIdx < 0) return;
                    const targetIdx = curIdx + dir;
                    if (targetIdx < 0 || targetIdx >= visIds.length) return;
                    const nextOrder = visIds.slice();
                    const [moved] = nextOrder.splice(curIdx, 1);
                    nextOrder.splice(targetIdx, 0, moved);
                    const extra = (sortModeField && activeSortMode !== 'custom')
                      ? { [sortModeField.key]: 'custom' }
                      : null;
                    uiState.sortMode = 'custom';
                    void commitFieldValue(field, serializeFilterOrderState(nextOrder, hiddenSet), extra);
                  };

                  const upBtn = doc.createElement('button');
                  upBtn.type = 'button';
                  upBtn.className = 'ag-icon-btn';
                  upBtn.setAttribute('data-catalog-up', `${field.key}:${item.id}`);
                  upBtn.setAttribute('aria-label', `上移 ${item.label}`);
                  upBtn.textContent = '↑';
                  upBtn.disabled = item.hidden || idx === 0;
                  upBtn.addEventListener('click', () => moveItem(-1));

                  const downBtn = doc.createElement('button');
                  downBtn.type = 'button';
                  downBtn.className = 'ag-icon-btn';
                  downBtn.setAttribute('data-catalog-down', `${field.key}:${item.id}`);
                  downBtn.setAttribute('aria-label', `下移 ${item.label}`);
                  downBtn.textContent = '↓';
                  downBtn.disabled = item.hidden || idx === filtered.length - 1;
                  downBtn.addEventListener('click', () => moveItem(1));

                  ops.appendChild(upBtn);
                  ops.appendChild(downBtn);
                  li.appendChild(ops);
                  rowsContainer.appendChild(li);
                });
              };

              searchInput.addEventListener('input', () => {
                uiState.query = searchInput.value;
                renderCatalogRows();
              });
              resetFilterBtn.addEventListener('click', () => {
                uiState.query = '';
                uiState.dimension = 'all';
                searchInput.value = '';
                renderCatalogRows();
              });
              for (const [dId, dBtn] of dimButtons.entries()) {
                dBtn.addEventListener('click', () => {
                  uiState.dimension = dId;
                  renderCatalogRows();
                });
              }
              sortSelect.addEventListener('change', () => {
                const nextMode = String(sortSelect.value || 'custom');
                uiState.sortMode = nextMode;
                if (sortModeField) {
                  void commitFieldValue(sortModeField, nextMode);
                } else {
                  renderCatalogRows();
                }
              });

              renderCatalogRows();
              fRow.appendChild(listWrap);
            } else {
              fRow.appendChild(fTop);
              const listWrap = doc.createElement('div');
              listWrap.className = 'ag-list-editor';
              listWrap.setAttribute('data-setting-list', field.key);

              const plainList = doc.createElement('div');
              plainList.className = 'ag-plain-list';

              arr.forEach((itemStr, idx) => {
                const li = doc.createElement('div');
                li.className = 'ag-list-item';
                li.setAttribute('data-list-item', `${field.key}:${idx}`);
                const span = doc.createElement('span');
                span.className = 'ag-list-item-text';
                span.textContent = String(itemStr);
                const rmBtn = doc.createElement('button');
                rmBtn.type = 'button';
                rmBtn.className = 'ag-icon-btn';
                rmBtn.setAttribute('data-list-remove', `${field.key}:${idx}`);
                rmBtn.setAttribute('aria-label', `删除 ${itemStr}`);
                rmBtn.appendChild(createIconEl('close'));
                rmBtn.addEventListener('click', () => {
                  const nextArr = arr.filter((_, i) => i !== idx);
                  void commitFieldValue(field, nextArr);
                });
                li.appendChild(span);
                li.appendChild(rmBtn);
                attachSortableItem({
                  containerEl: plainList,
                  itemEl: li,
                  listKey: draftKey,
                  index: idx,
                  itemCount: arr.length,
                  itemLabel: String(itemStr),
                  onReorder: (fromIdx, toIdx) => commitListReorder(fromIdx, toIdx)
                });
                plainList.appendChild(li);
              });
              if (arr.length > 0) {
                attachSortableContainer(plainList, {
                  listKey: draftKey,
                  itemCount: arr.length,
                  onReorder: (fromIdx, toIdx) => commitListReorder(fromIdx, toIdx)
                });
                applyPendingFlipAndFocus(plainList, draftKey);
              }
              listWrap.appendChild(plainList);

              const addRow = doc.createElement('div');
              addRow.className = 'ag-list-add-row';
              const addInput = doc.createElement('input');
              addInput.type = 'text';
              addInput.className = 'settings-input';
              addInput.placeholder = placeholderText || '新增条目...';
              addInput.value = state.listDrafts.get(draftKey) || '';
              addInput.setAttribute('data-list-input', field.key);
              addInput.setAttribute('aria-label', `为 ${labelText} 新增条目`);
              addInput.addEventListener('input', () => {
                state.listDrafts.set(draftKey, addInput.value);
              });
              addInput.addEventListener('change', () => {
                state.listDrafts.set(draftKey, addInput.value);
              });

              const addBtn = doc.createElement('button');
              addBtn.type = 'button';
              addBtn.className = 'ag-btn';
              addBtn.setAttribute('data-list-add', field.key);
              addBtn.appendChild(createIconEl('plus'));
              const addLbl = doc.createElement('span');
              addLbl.textContent = '添加';
              addBtn.appendChild(addLbl);
              const handleAdd = () => {
                const entry = String(addInput.value || '').trim();
                if (!entry) return;
                state.listDrafts.set(draftKey, '');
                if (arr.includes(entry)) {
                  state.manageToast = { tone: 'info', spinning: false, text: '该条目已存在，无需重复添加' };
                  renderSettingsBody();
                  return;
                }
                void commitFieldValue(field, [...arr, entry]);
              };
              addBtn.addEventListener('click', handleAdd);
              addInput.addEventListener('keydown', (e) => {
                if (e?.key === 'Enter') handleAdd();
              });

              addRow.appendChild(addInput);
              if (field.browse?.command) {
                const browseBtn = doc.createElement('button');
                browseBtn.type = 'button';
                browseBtn.className = 'ag-btn';
                browseBtn.setAttribute('data-field-browse', field.key);
                browseBtn.setAttribute('data-list-browse', field.key);
                browseBtn.appendChild(createIconEl('folder'));
                const origBrowseLabel = field.browse.label ? pickLocaleText(field.browse.label, '浏览') : '浏览';
                const bLbl = doc.createElement('span');
                bLbl.textContent = origBrowseLabel;
                browseBtn.appendChild(bLbl);
                browseBtn.addEventListener('click', () => {
                  if (browseBtn.disabled) return;
                  browseBtn.disabled = true;
                  bLbl.textContent = '打开中…';
                  void (async () => {
                    try {
                      const res = await executeCommand(p.id, field.browse.command, [{ values: currentValues, fieldKey: field.key }]);
                      const payload = (res && isPlainObject(res.result)) ? res.result : (isPlainObject(res) ? res : {});
                      if (payload && payload.ok === false) {
                        const errMsg = `选择目录失败：${String(payload.error || '无法打开选择对话框')}`;
                        state.fieldErrors.set(`${p.id}:${field.key}`, errMsg);
                        state.manageToast = { tone: 'error', spinning: false, text: errMsg };
                        renderSettingsBody();
                        return;
                      }
                      if (payload && !payload.cancelled) {
                        const rawPaths = Array.isArray(payload.paths)
                          ? payload.paths
                          : (typeof payload.path === 'string' && payload.path.trim() ? [payload.path] : []);
                        const normalizedPicked = rawPaths
                          .map((x) => (typeof x === 'string' ? x.trim() : ''))
                          .filter(Boolean);
                        if (normalizedPicked.length > 0) {
                          state.fieldErrors.delete(`${p.id}:${field.key}`);
                          const nextSet = new Set(arr);
                          const added = [];
                          for (const pickedPath of normalizedPicked) {
                            if (!nextSet.has(pickedPath)) {
                              nextSet.add(pickedPath);
                              added.push(pickedPath);
                            }
                          }
                          if (added.length > 0) {
                            await commitFieldValue(field, [...arr, ...added]);
                          } else {
                            state.manageToast = { tone: 'info', spinning: false, text: '该目录已在白名单中' };
                            renderSettingsBody();
                          }
                        }
                      }
                    } catch (err) {
                      const errMsg = `选择目录失败：${err?.message || String(err)}`;
                      state.fieldErrors.set(`${p.id}:${field.key}`, errMsg);
                      state.manageToast = { tone: 'error', spinning: false, text: errMsg };
                      renderSettingsBody();
                    } finally {
                      browseBtn.disabled = false;
                      bLbl.textContent = origBrowseLabel;
                    }
                  })();
                });
                addRow.appendChild(browseBtn);
              }
              addRow.appendChild(addBtn);
              listWrap.appendChild(addRow);
              fRow.appendChild(listWrap);
            }
          } else if (isWriteOnly) {
            const input = doc.createElement('input');
            input.type = 'password';
            input.className = 'settings-input';
            input.value = '';
            input.placeholder = isConfigured
              ? '已保存（仅写，输入新值可覆盖）'
              : (placeholderText || '请输入敏感凭据...');
            input.setAttribute('autocomplete', 'off');
            input.setAttribute('data-setting-key', field.key);
            input.setAttribute('data-write-only', 'true');
            input.setAttribute('aria-label', labelText);

            const secretWrap = doc.createElement('div');
            secretWrap.className = 'ag-secret-input-wrap';
            secretWrap.appendChild(input);

            const saveBtn = doc.createElement('button');
            saveBtn.type = 'button';
            saveBtn.className = 'ag-btn ag-btn-primary';
            saveBtn.setAttribute('data-secret-save', field.key);
            saveBtn.textContent = '保存';

            const handleSaveSecret = () => {
              const raw = String(input.value || '').trim();
              if (!raw) {
                state.fieldErrors.set(`${p.id}:${field.key}`, '请输入要保存的值');
                renderSettingsBody();
                return;
              }
              input.value = '';
              void commitFieldValue(field, raw);
            };
            saveBtn.addEventListener('click', handleSaveSecret);
            input.addEventListener('keydown', (e) => {
              if (e?.key === 'Enter') handleSaveSecret();
            });
            secretWrap.appendChild(saveBtn);

            if (isConfigured) {
              const clearBtn = doc.createElement('button');
              clearBtn.type = 'button';
              clearBtn.className = 'ag-btn';
              clearBtn.setAttribute('data-secret-clear', field.key);
              clearBtn.textContent = '清除';
              clearBtn.addEventListener('click', () => {
                input.value = '';
                void commitFieldValue(field, '');
              });
              secretWrap.appendChild(clearBtn);
            }

            fTop.appendChild(secretWrap);
            fRow.appendChild(fTop);
          } else if (field.type === 'string' && field.editorMode === 'markdown-modal' && field.secret !== true) {
            const curStr = val !== undefined && val !== null ? String(val) : '';
            const hasDefault = typeof field.default === 'string';
            const isDefault = hasDefault && curStr === field.default;
            let statusText = '未配置';
            if (curStr.trim()) {
              statusText = isDefault ? `默认 · ${curStr.length} 字` : `已自定义 · ${curStr.length} 字`;
            }

            const entryWrap = doc.createElement('div');
            entryWrap.className = 'ag-modal-entry-wrap';
            entryWrap.setAttribute('data-markdown-modal-entry', field.key);

            const metaSpan = doc.createElement('span');
            metaSpan.className = 'ag-modal-entry-meta';
            metaSpan.setAttribute('data-markdown-modal-meta', field.key);
            metaSpan.textContent = statusText;
            entryWrap.appendChild(metaSpan);

            const openBtn = doc.createElement('button');
            openBtn.type = 'button';
            openBtn.className = 'ag-btn';
            openBtn.setAttribute('data-markdown-modal-open', field.key);
            const openLbl = doc.createElement('span');
            openLbl.textContent = pickLocaleText(field.openButtonLabel, '查看 / 编辑');
            openBtn.appendChild(openLbl);
            openBtn.appendChild(createIconEl('chevronRight'));
            openBtn.addEventListener('click', () => {
              state.fieldModal = {
                pluginId: p.id,
                field,
                mode: 'preview',
                draft: curStr,
                savedValue: curStr,
                onCommit: (nextText) => commitFieldValue(field, String(nextText ?? ''))
              };
              renderFieldModal();
            });
            entryWrap.appendChild(openBtn);

            fTop.appendChild(entryWrap);
            fRow.appendChild(fTop);
          } else if (field.type === 'string' && field.editorMode === 'shortcut' && field.secret !== true) {
            const curShortcut = typeof val === 'string' ? val.trim() : '';
            const defaultShortcut = typeof field.default === 'string' ? field.default.trim() : '';
            const shortcutKey = `${p.id}:${field.key}`;
            const shortcutWrap = doc.createElement('div');
            shortcutWrap.className = 'ag-shortcut-editor';
            shortcutWrap.setAttribute('data-shortcut-editor', field.key);

            const scInput = doc.createElement('input');
            scInput.type = 'text';
            scInput.readOnly = true;
            scInput.className = 'settings-input ag-shortcut-input';
            scInput.value = curShortcut ? formatShortcutDisplay(curShortcut) : '';
            scInput.placeholder = '未设置（点击录入）';
            scInput.setAttribute('data-setting-key', field.key);
            scInput.setAttribute('data-shortcut-input', field.key);
            scInput.setAttribute('data-shortcut-value', curShortcut);
            scInput.setAttribute('aria-label', labelText);
            if (state.recordingShortcutKey === shortcutKey) {
              scInput.setAttribute('data-recording', 'true');
            }

            const startRecording = () => {
              state.recordingShortcutKey = shortcutKey;
              scInput.setAttribute('data-recording', 'true');
              scInput.placeholder = '请按下组合键…';
            };
            const stopRecording = () => {
              if (state.recordingShortcutKey === shortcutKey) {
                state.recordingShortcutKey = null;
              }
              scInput.removeAttribute('data-recording');
              scInput.placeholder = '未设置（点击录入）';
            };

            scInput.addEventListener('focus', startRecording);
            scInput.addEventListener('click', startRecording);
            scInput.addEventListener('blur', stopRecording);
            scInput.addEventListener('keydown', (e) => {
              e?.preventDefault?.();
              e?.stopPropagation?.();
              if (e?.key === 'Escape') {
                stopRecording();
                scInput.blur?.();
                return;
              }
              if ((e?.key === 'Backspace' || e?.key === 'Delete') && !e?.metaKey && !e?.ctrlKey && !e?.altKey && !e?.shiftKey) {
                stopRecording();
                state.fieldErrors.delete(shortcutKey);
                void commitFieldValue(field, '');
                return;
              }
              const parsed = normalizeShortcutEvent(e);
              if (parsed.ignored) return;
              if (!parsed.ok) {
                state.fieldErrors.set(shortcutKey, parsed.error || '无效快捷键');
                renderSettingsBody();
                return;
              }
              stopRecording();
              state.fieldErrors.delete(shortcutKey);
              void commitFieldValue(field, parsed.value);
            });
            shortcutWrap.appendChild(scInput);

            if (curShortcut) {
              const clearBtn = doc.createElement('button');
              clearBtn.type = 'button';
              clearBtn.className = 'ag-btn';
              clearBtn.setAttribute('data-shortcut-clear', field.key);
              clearBtn.textContent = '清除';
              clearBtn.addEventListener('click', () => {
                stopRecording();
                state.fieldErrors.delete(shortcutKey);
                void commitFieldValue(field, '');
              });
              shortcutWrap.appendChild(clearBtn);
            }

            const canResetShortcut = (field.resetToDefault === true || typeof field.default === 'string')
              && curShortcut !== defaultShortcut;
            if (canResetShortcut) {
              const resetBtn = doc.createElement('button');
              resetBtn.type = 'button';
              resetBtn.className = 'ag-btn';
              resetBtn.setAttribute('data-shortcut-reset', field.key);
              resetBtn.textContent = '恢复默认';
              resetBtn.addEventListener('click', () => {
                stopRecording();
                state.fieldErrors.delete(shortcutKey);
                void commitFieldValue(field, defaultShortcut);
              });
              shortcutWrap.appendChild(resetBtn);
            }

            fTop.appendChild(shortcutWrap);
            fRow.appendChild(fTop);
          } else if (field.type === 'string' && field.multiline === true && field.secret !== true) {
            const canReset = field.resetToDefault === true || typeof field.default === 'string';
            if (canReset) {
              const resetBtn = doc.createElement('button');
              resetBtn.type = 'button';
              resetBtn.className = 'ag-btn';
              resetBtn.setAttribute('data-string-reset', field.key);
              resetBtn.textContent = '恢复默认';
              resetBtn.addEventListener('click', () => {
                void commitFieldValue(field, typeof field.default === 'string' ? field.default : '');
              });
              fTop.appendChild(resetBtn);
            }
            fRow.appendChild(fTop);

            const textarea = doc.createElement('textarea');
            textarea.className = 'settings-input ag-settings-textarea';
            textarea.rows = Number.isInteger(field.rows) ? field.rows : 6;
            textarea.value = val !== undefined && val !== null ? String(val) : '';
            if (placeholderText) textarea.placeholder = placeholderText;
            textarea.setAttribute('data-setting-key', field.key);
            textarea.setAttribute('aria-label', labelText);
            textarea.addEventListener('change', () => {
              void commitFieldValue(field, String(textarea.value));
            });

            const actions = doc.createElement('div');
            actions.className = 'ag-textarea-actions';
            const saveBtn = doc.createElement('button');
            saveBtn.type = 'button';
            saveBtn.className = 'ag-btn ag-btn-primary';
            saveBtn.setAttribute('data-textarea-save', field.key);
            saveBtn.textContent = '保存提示词';
            saveBtn.addEventListener('click', () => {
              void commitFieldValue(field, String(textarea.value));
            });
            actions.appendChild(saveBtn);

            fRow.appendChild(textarea);
            fRow.appendChild(actions);
          } else {
            const hasCombobox = field.secret !== true && (Array.isArray(field.options) || Boolean(field.optionsCommand));
            const hasProbeOrBrowse = field.secret !== true && (Boolean(field.probe?.command) || Boolean(field.browse?.command));
            const hasComposer = field.secret !== true && Boolean(field.composer?.command);
            const probeKey = `${p.id}:${field.key}`;
            const probeState = state.fieldProbeState.get(probeKey) || null;
            const comboKey = `${p.id}:${field.key}`;

            const input = doc.createElement('input');
            input.type = field.secret === true ? 'password' : 'text';
            input.className = hasCombobox ? 'settings-input ag-combobox-input' : 'settings-input';
            input.value = val !== undefined && val !== null ? String(val) : '';
            if (placeholderText) input.placeholder = placeholderText;
            if (field.secret === true) input.setAttribute('autocomplete', 'off');
            input.setAttribute('data-setting-key', field.key);
            input.setAttribute('aria-label', labelText);
            if (probeState?.status === 'error') {
              input.setAttribute('data-invalid', 'true');
            }

            if (hasCombobox) {
              input.setAttribute('data-combobox-input', field.key);
              const cached = state.comboboxOptions.get(comboKey);
              const allOptions = mergeComboboxOptions(field.options || [], cached?.options || []);
              const savedStr = val !== undefined && val !== null ? String(val) : '';
              const findOptionByValue = (v) => allOptions.find((o) => o.value === v) || null;
              const resolveDisplayText = (v) => {
                if (v === '') return '';
                const hit = findOptionByValue(v);
                return (hit && hit.label) ? hit.label : v;
              };
              const resolveCommitValue = (rawInputText) => {
                const text = String(rawInputText ?? '');
                if (text.trim() === '') return '';
                const curOpt = findOptionByValue(savedStr);
                if (curOpt && curOpt.label === text) return curOpt.value;
                const byVal = allOptions.find((o) => o.value === text);
                if (byVal) return byVal.value;
                const byLbl = allOptions.find((o) => o.label === text);
                if (byLbl) return byLbl.value;
                return text;
              };
              input.setAttribute('data-setting-value', savedStr);
              input.value = resolveDisplayText(savedStr);
              const matchedOpt = findOptionByValue(savedStr);
              if (matchedOpt && matchedOpt.label && matchedOpt.label !== matchedOpt.value) {
                input.setAttribute('title', `${matchedOpt.label} (${matchedOpt.value})`);
              } else if (savedStr) {
                input.setAttribute('title', savedStr);
              }
              const isOpen = state.openComboboxKey === comboKey;
              if (isOpen) fRow.setAttribute('data-combobox-open', 'true');

              const comboWrap = doc.createElement('div');
              comboWrap.className = 'ag-combobox-wrap';
              comboWrap.setAttribute('data-combobox', field.key);
              comboWrap.setAttribute('data-open', isOpen ? 'true' : 'false');

              const inputShell = doc.createElement('div');
              inputShell.className = 'ag-combobox-input-shell';
              inputShell.appendChild(input);

              const toggleBtn = doc.createElement('button');
              toggleBtn.type = 'button';
              toggleBtn.className = 'ag-combobox-toggle';
              toggleBtn.setAttribute('data-combobox-toggle', field.key);
              toggleBtn.setAttribute('aria-label', `展开 ${labelText} 候选项`);
              toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
              toggleBtn.appendChild(createIconEl('arrowDown'));
              inputShell.appendChild(toggleBtn);
              comboWrap.appendChild(inputShell);

              const menuEl = doc.createElement('div');
              menuEl.className = 'ag-combobox-menu';
              menuEl.setAttribute('data-combobox-menu', field.key);
              setHidden(menuEl, !isOpen);

              let highlightedIdx = -1;
              let currentFiltered = [];
              let skipNextChange = false;
              let lastFilterText = '';

              const syncCardOpenAttr = (openFlag) => {
                if (openFlag) {
                  fRow.setAttribute('data-combobox-open', 'true');
                  fRow.parentElement?.setAttribute?.('data-combobox-open', 'true');
                } else {
                  fRow.removeAttribute('data-combobox-open');
                  const card = fRow.parentElement;
                  if (card && !card.querySelector?.('.ag-combobox-wrap[data-open="true"]')) {
                    card.removeAttribute?.('data-combobox-open');
                  }
                }
              };

              const setMenuOpen = (nextOpen, filterText = '') => {
                state.openComboboxKey = nextOpen ? comboKey : null;
                lastFilterText = String(filterText || '');
                if (nextOpen && field.optionsCommand && !cached?.loaded && !cached?.loading) {
                  void loadDynamicOptions(field, currentValues);
                }
                if (nextOpen) {
                  highlightedIdx = -1;
                  renderMenuItems(lastFilterText);
                }
                setHidden(menuEl, !nextOpen);
                comboWrap.setAttribute('data-open', nextOpen ? 'true' : 'false');
                toggleBtn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                syncCardOpenAttr(nextOpen);
              };

              const renderMenuItems = (filterText = '') => {
                clearElement(menuEl);
                const q = String(filterText || '').trim().toLowerCase();
                const filtered = q
                  ? allOptions.filter((opt) => (
                    opt.value.toLowerCase().includes(q)
                    || opt.label.toLowerCase().includes(q)
                    || (opt.description && opt.description.toLowerCase().includes(q))
                  ))
                  : allOptions;
                currentFiltered = filtered;
                if (highlightedIdx >= filtered.length) highlightedIdx = filtered.length - 1;

                if (cached?.loading && filtered.length === 0) {
                  const loadingEl = doc.createElement('div');
                  loadingEl.className = 'ag-combobox-empty';
                  loadingEl.textContent = '正在加载候选项...';
                  menuEl.appendChild(loadingEl);
                  return;
                }
                if (filtered.length === 0) {
                  const emptyEl = doc.createElement('div');
                  emptyEl.className = 'ag-combobox-empty';
                  emptyEl.textContent = '无匹配预设项，按回车直接使用当前输入值';
                  menuEl.appendChild(emptyEl);
                  return;
                }
                filtered.forEach((opt, idx) => {
                  const optBtn = doc.createElement('button');
                  optBtn.type = 'button';
                  optBtn.className = 'ag-combobox-option';
                  optBtn.setAttribute('data-combobox-option', `${field.key}:${idx}`);
                  optBtn.setAttribute('data-option-value', opt.value);
                  if (opt.value === savedStr) {
                    optBtn.setAttribute('data-selected', 'true');
                  }
                  if (idx === highlightedIdx) {
                    optBtn.setAttribute('data-highlighted', 'true');
                  }
                  const lblSpan = doc.createElement('span');
                  lblSpan.className = 'ag-combobox-option-label';
                  lblSpan.textContent = opt.label || opt.value || '(留空)';
                  optBtn.appendChild(lblSpan);
                  if (opt.description || (opt.value && opt.label !== opt.value)) {
                    const subSpan = doc.createElement('span');
                    subSpan.className = 'ag-combobox-option-sub';
                    subSpan.textContent = opt.description || opt.value;
                    optBtn.appendChild(subSpan);
                  }
                  optBtn.addEventListener('mousedown', (ev) => {
                    ev?.preventDefault?.();
                  });
                  optBtn.addEventListener('click', (ev) => {
                    ev?.stopPropagation?.();
                    skipNextChange = true;
                    input.value = opt.value === '' ? '' : (opt.label || opt.value);
                    input.setAttribute('data-setting-value', opt.value);
                    setMenuOpen(false);
                    void commitFieldValue(field, opt.value);
                  });
                  menuEl.appendChild(optBtn);
                });
              };

              renderMenuItems('');

              toggleBtn.addEventListener('mousedown', (ev) => {
                ev?.preventDefault?.();
              });
              toggleBtn.addEventListener('click', (ev) => {
                ev?.stopPropagation?.();
                const nextOpen = state.openComboboxKey !== comboKey;
                setMenuOpen(nextOpen, '');
              });

              input.addEventListener('focus', () => {
                if (state.openComboboxKey !== comboKey) {
                  setMenuOpen(true, '');
                }
              });
              input.addEventListener('click', (ev) => {
                ev?.stopPropagation?.();
                if (state.openComboboxKey !== comboKey) {
                  setMenuOpen(true, '');
                }
              });
              input.addEventListener('input', () => {
                lastFilterText = String(input.value || '');
                if (state.openComboboxKey !== comboKey) {
                  setMenuOpen(true, lastFilterText);
                } else {
                  highlightedIdx = -1;
                  renderMenuItems(lastFilterText);
                }
              });
              input.addEventListener('keydown', (e) => {
                if (e?.key === 'ArrowDown') {
                  e.preventDefault?.();
                  if (state.openComboboxKey !== comboKey) {
                    setMenuOpen(true, '');
                  }
                  if (currentFiltered.length > 0) {
                    highlightedIdx = (highlightedIdx + 1) % currentFiltered.length;
                    renderMenuItems(state.openComboboxKey === comboKey ? lastFilterText : '');
                  }
                } else if (e?.key === 'ArrowUp') {
                  e.preventDefault?.();
                  if (state.openComboboxKey === comboKey && currentFiltered.length > 0) {
                    highlightedIdx = highlightedIdx <= 0 ? currentFiltered.length - 1 : highlightedIdx - 1;
                    renderMenuItems(lastFilterText);
                  }
                } else if (e?.key === 'Enter') {
                  skipNextChange = true;
                  if (state.openComboboxKey === comboKey && highlightedIdx >= 0 && currentFiltered[highlightedIdx]) {
                    const chosen = currentFiltered[highlightedIdx];
                    input.value = chosen.value === '' ? '' : (chosen.label || chosen.value);
                    input.setAttribute('data-setting-value', chosen.value);
                    setMenuOpen(false);
                    void commitFieldValue(field, chosen.value);
                  } else {
                    const nextVal = resolveCommitValue(input.value);
                    setMenuOpen(false);
                    void commitFieldValue(field, nextVal);
                  }
                } else if (e?.key === 'Escape') {
                  setMenuOpen(false);
                }
              });
              input.addEventListener('change', () => {
                if (skipNextChange) {
                  skipNextChange = false;
                  return;
                }
                const nextVal = resolveCommitValue(input.value);
                setMenuOpen(false);
                if (nextVal !== savedStr) {
                  void commitFieldValue(field, nextVal);
                } else {
                  input.value = resolveDisplayText(savedStr);
                }
              });

              comboWrap.appendChild(menuEl);
              fTop.appendChild(comboWrap);
              fRow.appendChild(fTop);
            } else if (hasProbeOrBrowse) {
              input.className = 'settings-input ag-path-input';
              if (input.value) input.setAttribute('title', input.value);
              input.addEventListener('change', () => {
                void commitFieldValue(field, String(input.value));
              });
              input.addEventListener('keydown', (e) => {
                if (e?.key === 'Enter') {
                  void commitFieldValue(field, String(input.value));
                }
              });

              if (probeState?.status) {
                const chip = doc.createElement('span');
                chip.className = 'ag-chip';
                if (probeState.status === 'error') {
                  chip.setAttribute('data-tone', 'danger');
                  chip.textContent = '未检测到';
                } else if (probeState.status === 'loading') {
                  chip.setAttribute('data-tone', 'muted');
                  chip.textContent = '检测中...';
                } else {
                  chip.setAttribute('data-tone', 'accent');
                  chip.textContent = '已就绪';
                }
                fTop.appendChild(chip);
              }
              fRow.appendChild(fTop);

              const pathWrap = doc.createElement('div');
              pathWrap.className = 'ag-path-control-row';
              pathWrap.appendChild(input);

              const pathActions = doc.createElement('div');
              pathActions.className = 'ag-path-actions';

              if (field.probe?.command) {
                const probeBtn = doc.createElement('button');
                probeBtn.type = 'button';
                probeBtn.className = 'ag-btn';
                probeBtn.setAttribute('data-field-probe', field.key);
                probeBtn.disabled = probeState?.status === 'loading';
                if (probeState?.status === 'loading') {
                  const sp = doc.createElement('span');
                  sp.className = 'ag-spinner';
                  probeBtn.appendChild(sp);
                } else {
                  probeBtn.appendChild(createIconEl('refresh'));
                }
                const pLbl = doc.createElement('span');
                pLbl.textContent = field.probe.buttonLabel ? pickLocaleText(field.probe.buttonLabel, '重新检测') : '重新检测';
                probeBtn.appendChild(pLbl);
                probeBtn.addEventListener('click', () => {
                  void runFieldProbe(field, 'manual', currentValues, field.key);
                });
                pathActions.appendChild(probeBtn);
              }

              if (field.browse?.command) {
                const browseBtn = doc.createElement('button');
                browseBtn.type = 'button';
                browseBtn.className = 'ag-btn';
                browseBtn.setAttribute('data-field-browse', field.key);
                browseBtn.appendChild(createIconEl('folder'));
                const origBrowseLabel = field.browse.label ? pickLocaleText(field.browse.label, '浏览选择') : '浏览选择';
                const bLbl = doc.createElement('span');
                bLbl.textContent = origBrowseLabel;
                browseBtn.appendChild(bLbl);
                browseBtn.addEventListener('click', () => {
                  if (browseBtn.disabled) return;
                  browseBtn.disabled = true;
                  bLbl.textContent = '打开中…';
                  void (async () => {
                    try {
                      const res = await executeCommand(p.id, field.browse.command, [{ values: currentValues, fieldKey: field.key }]);
                      const payload = (res && isPlainObject(res.result)) ? res.result : (isPlainObject(res) ? res : {});
                      if (payload && payload.ok === false) {
                        const errMsg = `选择路径失败：${String(payload.error || '无法打开选择对话框')}`;
                        state.fieldErrors.set(`${p.id}:${field.key}`, errMsg);
                        state.manageToast = { tone: 'error', spinning: false, text: errMsg };
                        renderSettingsBody();
                        return;
                      }
                      if (payload && !payload.cancelled && typeof payload.path === 'string' && payload.path.trim()) {
                        state.fieldErrors.delete(`${p.id}:${field.key}`);
                        input.value = payload.path.trim();
                        await commitFieldValue(field, payload.path.trim());
                      }
                    } catch (err) {
                      const errMsg = `选择路径失败：${err?.message || String(err)}`;
                      state.fieldErrors.set(`${p.id}:${field.key}`, errMsg);
                      state.manageToast = { tone: 'error', spinning: false, text: errMsg };
                      renderSettingsBody();
                    } finally {
                      browseBtn.disabled = false;
                      bLbl.textContent = origBrowseLabel;
                    }
                  })();
                });
                pathActions.appendChild(browseBtn);
              }

              pathWrap.appendChild(pathActions);
              fRow.appendChild(pathWrap);

              if (probeState && probeState.message && !state.fieldErrors.get(`${p.id}:${field.key}`)) {
                const statusEl = doc.createElement('div');
                statusEl.className = probeState.status === 'error' ? 'ag-field-error' : 'ag-field-hint';
                statusEl.setAttribute('data-field-probe-status', probeState.status);
                statusEl.setAttribute('data-field-probe-key', field.key);
                statusEl.textContent = probeState.message;
                fRow.appendChild(statusEl);
              }
            } else if (hasComposer) {
              const composerKey = `${p.id}:${field.key}`;
              input.className = 'settings-input ag-composer-input';
              input.setAttribute('data-composer-input', field.key);
              if (input.value) input.setAttribute('title', input.value);
              const commitEditedCommand = () => {
                state.fieldComposerTouched.add(composerKey);
                void commitFieldValue(field, String(input.value));
              };
              input.addEventListener('change', commitEditedCommand);
              input.addEventListener('keydown', (e) => {
                if (e?.key === 'Enter') commitEditedCommand();
              });
              fRow.appendChild(fTop);

              const composerWrap = doc.createElement('div');
              composerWrap.className = 'ag-composer-control-row';
              composerWrap.setAttribute('data-composer-row', field.key);
              composerWrap.appendChild(input);

              const composerActions = doc.createElement('div');
              composerActions.className = 'ag-composer-actions';

              const resetBtn = doc.createElement('button');
              resetBtn.type = 'button';
              resetBtn.className = 'ag-btn';
              resetBtn.setAttribute('data-field-composer-reset', field.key);
              resetBtn.appendChild(createIconEl('refresh'));
              const resetLbl = doc.createElement('span');
              resetLbl.textContent = field.composer.resetLabel
                ? pickLocaleText(field.composer.resetLabel, '恢复默认')
                : '恢复默认';
              resetBtn.appendChild(resetLbl);
              resetBtn.addEventListener('click', () => {
                void runFieldComposer(field, 'reset', currentValues, field.key);
              });
              composerActions.appendChild(resetBtn);

              composerWrap.appendChild(composerActions);
              fRow.appendChild(composerWrap);
            } else {
              input.addEventListener('change', () => {
                void commitFieldValue(field, String(input.value));
              });
              if (field.secret === true) {
                const secretWrap = doc.createElement('div');
                secretWrap.className = 'ag-secret-input-wrap';
                secretWrap.appendChild(input);
                const toggleBtn = doc.createElement('button');
                toggleBtn.type = 'button';
                toggleBtn.className = 'ag-btn';
                toggleBtn.setAttribute('data-secret-toggle', field.key);
                toggleBtn.textContent = '显示';
                toggleBtn.addEventListener('click', () => {
                  const nextReveal = input.type === 'password';
                  input.type = nextReveal ? 'text' : 'password';
                  toggleBtn.textContent = nextReveal ? '隐藏' : '显示';
                });
                secretWrap.appendChild(toggleBtn);
                fTop.appendChild(secretWrap);
              } else if (unitText) {
                const unitWrap = doc.createElement('div');
                unitWrap.className = 'ag-input-unit-wrap';
                unitWrap.appendChild(input);
                const unitSpan = doc.createElement('span');
                unitSpan.className = 'ag-input-unit';
                unitSpan.textContent = unitText;
                unitWrap.appendChild(unitSpan);
                fTop.appendChild(unitWrap);
              } else {
                fTop.appendChild(input);
              }
              fRow.appendChild(fTop);
            }
          }

          if (isPlainObject(field.guide) && (!field.guide.visibleWhen || isFieldVisible({ visibleWhen: field.guide.visibleWhen }, currentValues))) {
            fRow.appendChild(renderCalloutBox({
              fieldKey: field.key,
              kind: 'guide',
              tone: field.guide.tone || 'info',
              title: field.guide.title ? pickLocaleText(field.guide.title, '') : '',
              message: field.guide.description ? pickLocaleText(field.guide.description, '') : '',
              steps: field.guide.steps,
              commands: field.guide.commands,
              links: field.guide.links
            }));
          }

          const errText = state.fieldErrors.get(`${p.id}:${field.key}`);
          if (errText) {
            const errEl = doc.createElement('div');
            errEl.className = 'ag-field-error';
            errEl.setAttribute('data-field-error', field.key);
            errEl.textContent = errText;
            fRow.appendChild(errEl);
          }
          return fRow;
        };

        const hasGroups = visibleFields.some((f) => Boolean(f.group));
        if (!hasGroups) {
          const formCard = doc.createElement('div');
          formCard.className = 'settings-card-box';
          formCard.id = 'agy-plugin-detail-form';
          for (const field of visibleFields) {
            if (state.openComboboxKey === `${p.id}:${field.key}`) {
              formCard.setAttribute('data-combobox-open', 'true');
            }
            formCard.appendChild(renderFieldRow(field));
          }
          formSection.appendChild(formCard);
        } else {
          const formGroups = doc.createElement('div');
          formGroups.className = 'ag-sv-form-groups';
          formGroups.id = 'agy-plugin-detail-form';
          const buckets = new Map();
          for (const field of visibleFields) {
            const groupLabel = field.group ? pickLocaleText(field.group, '') : '';
            const key = groupLabel || '__default__';
            if (!buckets.has(key)) buckets.set(key, { title: groupLabel, fields: [] });
            buckets.get(key).fields.push(field);
          }
          for (const bucket of buckets.values()) {
            const block = doc.createElement('div');
            block.className = 'ag-sv-group-block';
            if (bucket.title) {
              const gHead = doc.createElement('div');
              gHead.className = 'ag-sv-group-title';
              gHead.textContent = bucket.title;
              block.appendChild(gHead);
            }
            const gCard = doc.createElement('div');
            gCard.className = 'settings-card-box';
            for (const field of bucket.fields) {
              if (state.openComboboxKey === `${p.id}:${field.key}`) {
                gCard.setAttribute('data-combobox-open', 'true');
              }
              gCard.appendChild(renderFieldRow(field));
            }
            block.appendChild(gCard);
            formGroups.appendChild(block);
          }
          formSection.appendChild(formGroups);
        }
      }
      body.appendChild(formSection);

      // 4. 声明式 Action 按钮区
      const schemaActions = Array.isArray(schema?.actions) ? schema.actions : [];
      if (schemaActions.length > 0) {
        const actSection = createSectionBlock('快捷操作');
        const actCard = doc.createElement('div');
        actCard.className = 'settings-card-box';
        actCard.id = 'agy-plugin-detail-actions';

        const actRow = doc.createElement('div');
        actRow.className = 'ag-actions-row';

        for (const act of schemaActions) {
          const actId = act.id || act.command;
          const busyKey = `${p.id}:${actId}`;
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'ag-btn';
          btn.setAttribute('data-schema-action', actId);
          btn.setAttribute('data-command-id', act.command || '');
          const isRunning = state.actionBusyId === busyKey;
          btn.disabled = Boolean(state.actionBusyId);
          if (isRunning) {
            const sp = doc.createElement('span');
            sp.className = 'ag-spinner';
            btn.appendChild(sp);
          }
          const lbl = doc.createElement('span');
          const actLabel = pickLocaleText(act.label, act.command || actId);
          lbl.textContent = isRunning ? `${actLabel}...` : actLabel;
          btn.appendChild(lbl);
          btn.addEventListener('click', () => {
            if (state.actionBusyId) return;
            state.actionBusyId = busyKey;
            state.manageToast = { tone: 'info', spinning: true, text: `正在执行 ${actLabel}...` };
            renderSettingsBody();
            void (async () => {
              try {
                const res = await executeCommand(p.id, act.command, Array.isArray(act.args) ? act.args : []);
                if (res && res.ok === false) {
                  throw new Error(res.error || 'COMMAND_FAILED');
                }
                invalidatePluginDynamicPresets(p.id);
                const detailMsg = typeof res?.result?.message === 'string'
                  ? `：${res.result.message}`
                  : (typeof res?.message === 'string' ? `：${res.message}` : '');
                state.manageToast = { tone: 'info', spinning: false, text: `${actLabel} 执行成功${detailMsg}` };
              } catch (err) {
                state.manageToast = { tone: 'error', spinning: false, text: `${actLabel} 执行失败：${err?.message || String(err)}` };
              } finally {
                state.actionBusyId = null;
                if (state.settingsMode !== 'closed') renderSettingsBody();
              }
            })();
          });
          actRow.appendChild(btn);
        }

        actCard.appendChild(actRow);
        actSection.appendChild(actCard);
        body.appendChild(actSection);
      }
    }

    function renderAppearanceTab(body) {
      const queryLower = state.settingsSearchQuery.trim().toLowerCase();

      // 1. 入口与原生设置集成
      const entrySection = createSectionBlock(
        '入口与集成',
        '控制右上角快捷入口显示与原生设置面板注入方式。'
      );
      const entryCard = doc.createElement('div');
      entryCard.className = 'settings-card-box';
      entryCard.id = 'agy-entry-settings-card';

      const warnIfBothDisabled = () => {
        if (state.hostSettings.showTopbarEntry === false && state.hostSettings.injectNativeSettings === false) {
          state.manageToast = {
            tone: 'warn',
            spinning: false,
            text: '右上角入口与原生设置注入均已关闭，可通过插件浮窗右上角 ⚙ 重新打开设置'
          };
        }
      };

      const topbarEntryRow = doc.createElement('div');
      topbarEntryRow.className = 'settings-pref-row';
      const topbarEntryInfo = doc.createElement('div');
      topbarEntryInfo.className = 'ag-sv-row-info';
      const topbarEntryLbl = doc.createElement('span');
      topbarEntryLbl.className = 'ag-sv-row-title';
      topbarEntryLbl.textContent = '右上角显示 Agy-Daddy 入口';
      const topbarEntryDesc = doc.createElement('span');
      topbarEntryDesc.className = 'ag-sv-row-desc';
      topbarEntryDesc.textContent = '在窗口右上角顶栏显示 Agy 快捷入口按钮';
      topbarEntryInfo.appendChild(topbarEntryLbl);
      topbarEntryInfo.appendChild(topbarEntryDesc);

      const topbarEntryToggleWrap = doc.createElement('label');
      topbarEntryToggleWrap.className = 'ag-toggle-label';
      const topbarEntryInput = doc.createElement('input');
      topbarEntryInput.type = 'checkbox';
      topbarEntryInput.id = 'agy-show-topbar-entry';
      topbarEntryInput.checked = state.hostSettings.showTopbarEntry !== false;
      topbarEntryInput.setAttribute('data-host-setting', 'showTopbarEntry');
      topbarEntryInput.setAttribute('aria-label', '右上角显示 Agy-Daddy 入口');
      topbarEntryInput.addEventListener('change', () => {
        const nextVal = Boolean(topbarEntryInput.checked);
        state.hostSettings.showTopbarEntry = nextVal;
        syncTopbarEntryVisibility();
        warnIfBothDisabled();
        void persistHostSettings({ showTopbarEntry: nextVal });
        renderSettingsBody();
      });
      topbarEntryToggleWrap.appendChild(topbarEntryInput);
      topbarEntryRow.appendChild(topbarEntryInfo);
      topbarEntryRow.appendChild(topbarEntryToggleWrap);
      entryCard.appendChild(topbarEntryRow);

      const hideTrayRow = doc.createElement('div');
      hideTrayRow.className = 'settings-pref-row';
      const hideTrayInfo = doc.createElement('div');
      hideTrayInfo.className = 'ag-sv-row-info';
      const hideTrayLbl = doc.createElement('span');
      hideTrayLbl.className = 'ag-sv-row-title';
      hideTrayLbl.textContent = '隐藏通知栏图标';
      const hideTrayDesc = doc.createElement('span');
      hideTrayDesc.className = 'ag-sv-row-desc';
      hideTrayDesc.textContent = '隐藏系统通知栏（托盘）常驻图标，后台守护进程与插件功能继续正常运行';
      hideTrayInfo.appendChild(hideTrayLbl);
      hideTrayInfo.appendChild(hideTrayDesc);

      const hideTrayToggleWrap = doc.createElement('label');
      hideTrayToggleWrap.className = 'ag-toggle-label';
      const hideTrayInput = doc.createElement('input');
      hideTrayInput.type = 'checkbox';
      hideTrayInput.id = 'agy-hide-tray-icon';
      hideTrayInput.checked = state.hostSettings.hideTrayIcon === true;
      hideTrayInput.setAttribute('data-host-setting', 'hideTrayIcon');
      hideTrayInput.setAttribute('aria-label', '隐藏通知栏图标');
      hideTrayInput.addEventListener('change', () => {
        const nextVal = Boolean(hideTrayInput.checked);
        state.hostSettings.hideTrayIcon = nextVal;
        void persistHostSettings({ hideTrayIcon: nextVal });
        renderSettingsBody();
      });
      hideTrayToggleWrap.appendChild(hideTrayInput);
      hideTrayRow.appendChild(hideTrayInfo);
      hideTrayRow.appendChild(hideTrayToggleWrap);
      entryCard.appendChild(hideTrayRow);

      const nativeRow = doc.createElement('div');
      nativeRow.className = 'settings-pref-row';
      const nativeInfo = doc.createElement('div');
      nativeInfo.className = 'ag-sv-row-info';
      const nativeLbl = doc.createElement('span');
      nativeLbl.className = 'ag-sv-row-title';
      nativeLbl.textContent = '注入原生设置面板';
      const nativeDesc = doc.createElement('span');
      nativeDesc.className = 'ag-sv-row-desc';
      nativeDesc.textContent = '在 Antigravity 原生设置弹窗左侧导航注入 Agy-Daddy 入口';
      nativeInfo.appendChild(nativeLbl);
      nativeInfo.appendChild(nativeDesc);

      const nativeToggleWrap = doc.createElement('label');
      nativeToggleWrap.className = 'ag-toggle-label';
      const nativeInput = doc.createElement('input');
      nativeInput.type = 'checkbox';
      nativeInput.id = 'agy-inject-native-settings';
      nativeInput.checked = state.hostSettings.injectNativeSettings !== false;
      nativeInput.setAttribute('data-host-setting', 'injectNativeSettings');
      nativeInput.setAttribute('aria-label', '注入原生设置面板');
      nativeInput.addEventListener('change', () => {
        const nextVal = Boolean(nativeInput.checked);
        const wasNative = state.settingsMode === 'native';
        state.hostSettings.injectNativeSettings = nextVal;
        if (!nextVal) {
          teardownNativeSettingsMount();
          if (wasNative) {
            openFallbackModal();
          }
        } else {
          syncNativeSettingsIntegration();
        }
        warnIfBothDisabled();
        void persistHostSettings({ injectNativeSettings: nextVal });
        renderSettingsBody();
      });
      nativeToggleWrap.appendChild(nativeInput);
      nativeRow.appendChild(nativeInfo);
      nativeRow.appendChild(nativeToggleWrap);
      entryCard.appendChild(nativeRow);

      const autoNativeRow = doc.createElement('div');
      autoNativeRow.className = 'settings-pref-row';
      const autoNativeInfo = doc.createElement('div');
      autoNativeInfo.className = 'ag-sv-row-info';
      const autoNativeLbl = doc.createElement('span');
      autoNativeLbl.className = 'ag-sv-row-title';
      autoNativeLbl.textContent = '安装插件时自动注入原生扩展';
      const autoNativeDesc = doc.createElement('span');
      autoNativeDesc.className = 'ag-sv-row-desc';
      autoNativeDesc.textContent = '关闭后，新安装含原生扩展的插件不会自动写入 ~/.gemini/config/plugins，可在插件详情页按需开启';
      autoNativeInfo.appendChild(autoNativeLbl);
      autoNativeInfo.appendChild(autoNativeDesc);

      const autoNativeToggleWrap = doc.createElement('label');
      autoNativeToggleWrap.className = 'ag-toggle-label';
      const autoNativeInput = doc.createElement('input');
      autoNativeInput.type = 'checkbox';
      autoNativeInput.id = 'agy-auto-sync-native';
      autoNativeInput.checked = state.hostSettings.autoSyncNativeOnInstall !== false;
      autoNativeInput.setAttribute('data-host-setting', 'autoSyncNativeOnInstall');
      autoNativeInput.setAttribute('aria-label', '安装插件时自动注入原生扩展');
      autoNativeInput.addEventListener('change', () => {
        const nextVal = Boolean(autoNativeInput.checked);
        state.hostSettings.autoSyncNativeOnInstall = nextVal;
        void persistHostSettings({ autoSyncNativeOnInstall: nextVal });
        renderSettingsBody();
      });
      autoNativeToggleWrap.appendChild(autoNativeInput);
      autoNativeRow.appendChild(autoNativeInfo);
      autoNativeRow.appendChild(autoNativeToggleWrap);
      entryCard.appendChild(autoNativeRow);

      entrySection.appendChild(entryCard);
      body.appendChild(entrySection);

      // 2. 顶栏胶囊布局（胶囊顺序 + 顶栏显示胶囊上限）
      const layoutSection = createSectionBlock(
        '顶栏胶囊',
        '拖动左侧手柄调整顶栏插件胶囊顺序，管理固定状态与显示数量上限。'
      );
      const layoutCard = doc.createElement('div');
      layoutCard.className = 'settings-card-box';
      layoutCard.id = 'agy-topbar-layout-card';

      const maxRow = doc.createElement('div');
      maxRow.className = 'settings-pref-row';
      const maxInfo = doc.createElement('div');
      maxInfo.className = 'ag-sv-row-info';
      const maxLbl = doc.createElement('span');
      maxLbl.className = 'ag-sv-row-title';
      maxLbl.textContent = '顶栏显示胶囊上限';
      const maxDesc = doc.createElement('span');
      maxDesc.className = 'ag-sv-row-desc';
      maxDesc.textContent = '超出上限的顶栏胶囊将自动收进右侧溢出菜单';
      maxInfo.appendChild(maxLbl);
      maxInfo.appendChild(maxDesc);

      const maxInput = doc.createElement('input');
      maxInput.type = 'number';
      maxInput.id = 'agy-max-visible-units';
      maxInput.className = 'settings-input';
      maxInput.setAttribute('min', '1');
      maxInput.setAttribute('max', '20');
      maxInput.setAttribute('aria-label', '顶栏显示胶囊上限');
      maxInput.value = String(state.hostSettings.maxVisibleUnits);
      maxInput.addEventListener('change', () => {
        const parsed = Math.max(1, Math.min(20, Math.floor(Number(maxInput.value) || DEFAULT_HOST_SETTINGS.maxVisibleUnits)));
        state.hostSettings.maxVisibleUnits = parsed;
        renderUnits();
        void persistHostSettings({ maxVisibleUnits: parsed });
        renderSettingsBody();
      });
      maxRow.appendChild(maxInfo);
      maxRow.appendChild(maxInput);
      layoutCard.appendChild(maxRow);

      const orderedUnits = getOrderedUnits();
      const visibleUnits = queryLower
        ? orderedUnits.filter((u) => `${getUnitPluginDisplayName(u)} ${u.id || ''} ${u.pluginId || ''}`.toLowerCase().includes(queryLower))
        : orderedUnits;

      const orderList = doc.createElement('div');
      orderList.id = 'agy-topbar-order-list';
      orderList.className = 'ag-order-list';
      if (orderedUnits.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'ag-sv-empty';
        empty.textContent = '当前暂无已注册的顶栏胶囊';
        orderList.appendChild(empty);
      } else if (visibleUnits.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'ag-sv-empty';
        empty.textContent = `未找到匹配「${state.settingsSearchQuery}」的顶栏胶囊`;
        orderList.appendChild(empty);
      } else {
        const topbarListKey = '__host__:topbarOrder';
        const isFiltered = Boolean(queryLower);
        visibleUnits.forEach((u) => {
          const origIdx = orderedUnits.indexOf(u);
          const unitDisplayName = getUnitPluginDisplayName(u);
          const row = doc.createElement('div');
          row.className = 'ag-order-row';
          row.setAttribute('data-order-unit', u.key);

          const info = doc.createElement('div');
          info.className = 'ag-sv-row-info';
          const titleLine = doc.createElement('div');
          titleLine.className = 'ag-plugin-info';
          const lbl = doc.createElement('span');
          lbl.className = 'ag-plugin-name';
          lbl.textContent = unitDisplayName;
          const pinned = isUnitPinned(u.pluginId, u.id);
          const stateChip = doc.createElement('span');
          stateChip.className = 'ag-chip';
          stateChip.setAttribute('data-tone', !pinned || u.inOverflow ? 'muted' : 'accent');
          stateChip.textContent = !pinned ? '已取消固定' : (u.inOverflow ? '已溢出折叠' : '顶栏显示');
          titleLine.appendChild(lbl);
          titleLine.appendChild(stateChip);
          const pidSpan = doc.createElement('span');
          pidSpan.className = 'ag-sv-row-desc';
          pidSpan.textContent = u.pluginId;
          info.appendChild(titleLine);
          info.appendChild(pidSpan);
          row.appendChild(info);

          const ctrls = doc.createElement('div');
          ctrls.className = 'ag-plugin-actions';

          const pinBtn = doc.createElement('button');
          pinBtn.type = 'button';
          pinBtn.className = 'ag-pin-btn';
          pinBtn.setAttribute('data-order-pin', u.key);
          pinBtn.setAttribute('data-pinned', pinned ? 'true' : 'false');
          const pinTip = pinned ? '已固定到顶栏（点击取消固定）' : '已取消固定（点击固定到顶栏）';
          pinBtn.setAttribute('title', pinTip);
          pinBtn.setAttribute('aria-label', pinTip);
          pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
          pinBtn.appendChild(createIconEl(pinned ? 'pinFilled' : 'pin'));
          pinBtn.addEventListener('click', () => setUnitPinned(u.key, !pinned));

          ctrls.appendChild(pinBtn);
          row.appendChild(ctrls);

          attachSortableItem({
            containerEl: orderList,
            itemEl: row,
            listKey: topbarListKey,
            index: origIdx,
            itemCount: orderedUnits.length,
            disabled: isFiltered,
            disabledReason: isFiltered ? '清空筛选后可拖动调整顺序' : '',
            itemLabel: unitDisplayName,
            onReorder: reorderTopbarUnits
          });
          orderList.appendChild(row);
        });
        attachSortableContainer(orderList, {
          listKey: topbarListKey,
          itemCount: orderedUnits.length,
          disabled: isFiltered,
          onReorder: reorderTopbarUnits
        });
        applyPendingFlipAndFocus(orderList, topbarListKey);
      }
      layoutCard.appendChild(orderList);
      layoutSection.appendChild(layoutCard);
      body.appendChild(layoutSection);

      // 2. 版本与宿主环境
      const verSection = createSectionBlock('关于底座');
      const verCard = doc.createElement('div');
      verCard.className = 'settings-card-box';
      verCard.id = 'agy-general-settings-card';

      const verRow = doc.createElement('div');
      verRow.className = 'settings-pref-row';
      const verInfo = doc.createElement('div');
      verInfo.className = 'ag-sv-row-info';
      const vTitle = doc.createElement('span');
      vTitle.className = 'ag-sv-row-title';
      vTitle.textContent = 'Agy-Daddy 插件底座';
      const vBody = doc.createElement('span');
      vBody.className = 'ag-sv-row-desc';
      vBody.textContent = state.updateInfo?.hasUpdate
        ? `发现新版本 ${state.updateInfo.latestVersion}（当前 v${state.updateInfo.currentVersion} · Antigravity v${state.antigravityVersion}）`
        : `当前版本 v${HOST_VERSION} · 宿主 Antigravity v${state.antigravityVersion}`;
      verInfo.appendChild(vTitle);
      verInfo.appendChild(vBody);

      const verChip = doc.createElement('span');
      verChip.className = 'ag-chip';
      verChip.setAttribute('data-tone', state.updateInfo?.hasUpdate ? 'warn' : 'muted');
      verChip.textContent = state.updateInfo?.hasUpdate ? `有更新 ${state.updateInfo.latestVersion}` : '已是最新';

      verRow.appendChild(verInfo);
      verRow.appendChild(verChip);
      verCard.appendChild(verRow);
      verSection.appendChild(verCard);
      body.appendChild(verSection);
    }

    function renderDiagnosticsSection(body) {
      const hasBridge = hasBridgeAvailable();
      const queryLower = state.settingsSearchQuery.trim().toLowerCase();

      const knownIds = Array.from(new Set([
        ...state.pluginInstances.keys(),
        ...state.metrics.keys(),
        ...state.pluginMeta.keys()
      ])).sort();
      const visibleIds = queryLower
        ? knownIds.filter((id) => {
          const meta = state.pluginMeta.get(id);
          return `${id} ${pickLocaleText(meta?.displayName, '')}`.toLowerCase().includes(queryLower);
        })
        : knownIds;

      const anchorNames = Object.keys(state.anchorsRegistry?.anchors || {});
      const results = anchorNames.map((name) => ({ name, hit: Boolean(queryAnchor(name)) }));
      const matchedCount = results.filter((r) => r.hit).length;
      const visibleAnchors = queryLower
        ? results.filter((r) => r.name.toLowerCase().includes(queryLower))
        : results;

      let circuitOpenCount = 0;
      let inactiveEnabledCount = 0;
      for (const id of knownIds) {
        const metric = getMetric(id);
        const meta = state.pluginMeta.get(id);
        const crashes = Math.max(metric.crashes, Number(meta?.health?.crashesInWindow || 0));
        if (crashes >= 3 || Boolean(meta?.health?.circuitOpen)) circuitOpenCount++;
        if (meta && meta.enabled !== false && meta.active === false) inactiveEnabledCount++;
      }

      const diagSection = createSectionBlock(
        '运行与诊断',
        '汇总插件运行健康度、代码重新载入、页面锚点兼容性与脱敏诊断包导出。'
      );
      const diagCard = doc.createElement('div');
      diagCard.className = 'settings-card-box';
      diagCard.id = 'agy-diagnostics-summary-card';

      const isExpanded = Boolean(
        state.diagnosticsExpanded
        || circuitOpenCount > 0
        || inactiveEnabledCount > 0
        || (queryLower && (visibleIds.length > 0 || visibleAnchors.length > 0))
      );

      // 摘要行（始终可见）
      const summaryRow = doc.createElement('div');
      summaryRow.className = 'settings-pref-row';
      const sInfo = doc.createElement('div');
      sInfo.className = 'ag-sv-row-info';
      const sTitle = doc.createElement('span');
      sTitle.className = 'ag-sv-row-title';
      sTitle.textContent = '运行健康度与宿主锚点';
      const sDesc = doc.createElement('span');
      sDesc.id = 'agy-diagnostics-export-status';
      sDesc.className = 'ag-sv-row-desc';
      if (state.diagnosticsExportInfo?.path) {
        sDesc.textContent = `已挂载 ${state.pluginInstances.size}/${knownIds.length} · 锚点 ${matchedCount}/${results.length} 命中 · 最近导出：${state.diagnosticsExportInfo.path}`;
      } else {
        const extraStatus = [
          inactiveEnabledCount > 0 ? `${inactiveEnabledCount} 个未激活` : '',
          circuitOpenCount > 0 ? `${circuitOpenCount} 个已熔断` : ''
        ].filter(Boolean).join(' · ');
        sDesc.textContent = `已挂载 ${state.pluginInstances.size}/${knownIds.length} · 锚点 ${matchedCount}/${results.length} 命中${extraStatus ? ` · ${extraStatus}` : ''}`;
      }
      sInfo.appendChild(sTitle);
      sInfo.appendChild(sDesc);

      const sActions = doc.createElement('div');
      sActions.className = 'ag-plugin-actions';

      const toggleDetailBtn = doc.createElement('button');
      toggleDetailBtn.type = 'button';
      toggleDetailBtn.id = 'agy-diagnostics-detail-toggle';
      toggleDetailBtn.className = 'ag-btn';
      toggleDetailBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      toggleDetailBtn.textContent = isExpanded ? '收起明细' : '展开明细';
      toggleDetailBtn.addEventListener('click', () => {
        state.diagnosticsExpanded = !isExpanded;
        renderSettingsBody();
      });

      const expBtn = doc.createElement('button');
      expBtn.type = 'button';
      expBtn.id = 'agy-export-diagnostics-btn';
      expBtn.className = 'ag-btn';
      expBtn.disabled = Boolean(state.manageBusyId) || !hasBridge;
      if (state.manageBusyId === '__diag_export__') {
        const sp = doc.createElement('span');
        sp.className = 'ag-spinner';
        expBtn.appendChild(sp);
      } else {
        expBtn.appendChild(createIconEl('download'));
      }
      const expLbl = doc.createElement('span');
      expLbl.textContent = state.manageBusyId === '__diag_export__' ? '导出中...' : '导出诊断包';
      expBtn.appendChild(expLbl);
      expBtn.addEventListener('click', () => {
        void runManageAction('__diag_export__', '正在生成脱敏诊断包...', async () => {
          const res = await hostBridgePost('/host/diagnostics/export', {});
          const outPath = res?.path || 'agy-daddy-diagnostic-bundle.json';
          state.diagnosticsExportInfo = { path: outPath, timestamp: Date.now() };
          state.manageToast = { tone: 'info', spinning: false, text: `已导出脱敏诊断包：${outPath}` };
        });
      });

      sActions.appendChild(toggleDetailBtn);
      sActions.appendChild(expBtn);
      summaryRow.appendChild(sInfo);
      summaryRow.appendChild(sActions);
      diagCard.appendChild(summaryRow);

      // 代码热载入与守护进程操作行
      const reloadRow = doc.createElement('div');
      reloadRow.className = 'settings-pref-row';
      reloadRow.id = 'agy-diagnostics-reload-row';
      const rInfo = doc.createElement('div');
      rInfo.className = 'ag-sv-row-info';
      const rTitle = doc.createElement('span');
      rTitle.className = 'ag-sv-row-title';
      rTitle.textContent = '代码热载入与守护进程';
      const rDesc = doc.createElement('span');
      rDesc.className = 'ag-sv-row-desc';
      rDesc.textContent = '重新载入最新宿主界面与插件代码；改动核心守护进程后可重启进程。';
      rInfo.appendChild(rTitle);
      rInfo.appendChild(rDesc);

      const rActions = doc.createElement('div');
      rActions.className = 'ag-plugin-actions';

      const reloadAllBtn = doc.createElement('button');
      reloadAllBtn.type = 'button';
      reloadAllBtn.id = 'agy-reload-all-btn';
      reloadAllBtn.className = 'ag-btn';
      reloadAllBtn.disabled = Boolean(state.manageBusyId) || !hasBridge;
      reloadAllBtn.title = '重新构建并热载入最新宿主界面与所有已启用插件代码';
      if (state.manageBusyId === '__diag_reload_all__') {
        const sp = doc.createElement('span');
        sp.className = 'ag-spinner';
        reloadAllBtn.appendChild(sp);
      } else {
        reloadAllBtn.appendChild(createIconEl('refresh'));
      }
      const reloadAllLbl = doc.createElement('span');
      reloadAllLbl.textContent = state.manageBusyId === '__diag_reload_all__' ? '载入中...' : '重新载入';
      reloadAllBtn.appendChild(reloadAllLbl);
      reloadAllBtn.addEventListener('click', () => {
        void runManageAction('__diag_reload_all__', '正在重新载入最新界面与插件代码...', async () => {
          const res = await hostBridgePost('/host/reload-all', {
            rebuildRenderer: true,
            restoreView: {
              open: true,
              tab: state.activeSettingsTab || 'plugins',
              diagnosticsExpanded: Boolean(state.diagnosticsExpanded)
            }
          });
          if (state.disposed) return;
          applyManagePayload(res);
          const errCount = Array.isArray(res?.activationErrors) ? res.activationErrors.length : 0;
          const reloadedCount = Number(res?.reloadedCount || 0);
          if (errCount > 0) {
            state.manageToast = {
              tone: 'warn',
              spinning: false,
              text: `已重载 ${reloadedCount} 个插件，${errCount} 个加载失败`
            };
          } else {
            state.manageToast = {
              tone: 'info',
              spinning: false,
              text: `已重新载入最新代码（${reloadedCount} 个插件${res?.rendererRebuilt ? ' · 渲染层已重建' : ''}）`
            };
          }
        });
      });

      const restartDaemonBtn = doc.createElement('button');
      restartDaemonBtn.type = 'button';
      restartDaemonBtn.id = 'agy-restart-daemon-btn';
      restartDaemonBtn.className = 'ag-btn';
      restartDaemonBtn.disabled = Boolean(state.manageBusyId) || !hasBridge;
      restartDaemonBtn.title = '重启后台守护进程以加载最新核心代码（将短暂重连 1–2 秒）';
      if (state.manageBusyId === '__diag_restart_daemon__') {
        const sp = doc.createElement('span');
        sp.className = 'ag-spinner';
        restartDaemonBtn.appendChild(sp);
      } else {
        restartDaemonBtn.appendChild(createIconEl('refresh'));
      }
      const restartDaemonLbl = doc.createElement('span');
      restartDaemonLbl.textContent = state.manageBusyId === '__diag_restart_daemon__' ? '重启中...' : '重启守护进程';
      restartDaemonBtn.appendChild(restartDaemonLbl);
      restartDaemonBtn.addEventListener('click', () => {
        void runManageAction('__diag_restart_daemon__', '正在重启守护进程以加载最新核心代码...', async () => {
          const res = await hostBridgePost('/host/daemon/restart', {
            rebuildRenderer: true,
            reason: 'diagnostics-ui'
          });
          if (state.disposed) return;
          if (res?.dryRun) {
            state.manageToast = {
              tone: 'info',
              spinning: false,
              text: '测试模式已跳过守护进程重启'
            };
          } else {
            state.manageToast = {
              tone: 'info',
              spinning: true,
              text: '守护进程正在重启，界面将在 1–2 秒内自动重新载入...'
            };
          }
        });
      });

      rActions.appendChild(reloadAllBtn);
      rActions.appendChild(restartDaemonBtn);
      reloadRow.appendChild(rInfo);
      reloadRow.appendChild(rActions);
      diagCard.appendChild(reloadRow);

      // 折叠明细体
      const detailBody = doc.createElement('div');
      detailBody.id = 'agy-diagnostics-detail-body';
      detailBody.className = 'ag-diag-detail-body';
      setHidden(detailBody, !isExpanded);

      const healthSub = doc.createElement('div');
      healthSub.className = 'ag-diag-subhead';
      healthSub.textContent = `插件运行健康度（${state.pluginInstances.size}/${knownIds.length}）`;
      detailBody.appendChild(healthSub);

      const healthWrap = doc.createElement('div');
      healthWrap.id = 'agy-health-settings-card';
      if (knownIds.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'ag-sv-empty';
        empty.textContent = '暂无运行中的插件指标';
        healthWrap.appendChild(empty);
      } else if (visibleIds.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'ag-sv-empty';
        empty.textContent = `未找到匹配「${state.settingsSearchQuery}」的插件指标`;
        healthWrap.appendChild(empty);
      } else {
        for (const id of visibleIds) {
          const metric = getMetric(id);
          const meta = state.pluginMeta.get(id);
          const crashes = Math.max(metric.crashes, Number(meta?.health?.crashesInWindow || 0));
          const circuitOpen = crashes >= 3 || Boolean(meta?.health?.circuitOpen);
          const isMissingPath = Boolean(
            (meta?.installHealth && meta.installHealth.status !== 'ok') ||
            meta?.health?.lastErrorCode === 'INSTALL_PATH_MISSING'
          );
          const isDisabled = meta?.enabled === false;
          const isInactive = !isDisabled && meta?.active === false;
          const localRenderErr = state.rendererErrors.get(id);
          const errText = localRenderErr?.message || meta?.health?.lastError || '';
          const bestRepair = Array.isArray(meta?.installHealth?.repairCandidates)
            ? meta.installHealth.repairCandidates[0]
            : null;

          const row = doc.createElement('div');
          row.className = 'settings-pref-row';
          row.setAttribute('data-health-plugin', id);

          const info = doc.createElement('div');
          info.className = 'ag-sv-row-info';
          const nameLine = doc.createElement('span');
          nameLine.className = 'ag-sv-row-title';
          nameLine.textContent = pickLocaleText(meta?.displayName, id);
          const textSpan = doc.createElement('span');
          textSpan.className = 'ag-sv-row-desc';
          textSpan.textContent = `${id} · mount=${metric.mountMs}ms · obs=${metric.observerMs || 0}ms · timers=${metric.timersCount} · crashes=${crashes}${errText ? ` · ${errText}` : ''}`;
          info.appendChild(nameLine);
          info.appendChild(textSpan);
          row.appendChild(info);

          const right = doc.createElement('div');
          right.className = 'ag-plugin-actions';
          if (isMissingPath) {
            const missChip = doc.createElement('span');
            missChip.className = 'ag-chip';
            missChip.setAttribute('data-tone', 'danger');
            missChip.textContent = meta?.installHealth?.status === 'broken_symlink' ? '路径失效' : '文件丢失';
            right.appendChild(missChip);
          } else if (circuitOpen) {
            const chip = doc.createElement('span');
            chip.className = 'ag-chip';
            chip.setAttribute('data-tone', 'danger');
            chip.textContent = '已熔断';
            right.appendChild(chip);
          } else if (isDisabled) {
            const offChip = doc.createElement('span');
            offChip.className = 'ag-chip';
            offChip.textContent = '已停用';
            right.appendChild(offChip);
          } else if (isInactive) {
            const warnChip = doc.createElement('span');
            warnChip.className = 'ag-chip';
            warnChip.setAttribute('data-tone', errText ? 'danger' : 'warn');
            warnChip.textContent = '未激活';
            right.appendChild(warnChip);
          } else if (localRenderErr || (meta?.health?.lastErrorStage === 'renderer' && errText)) {
            const renChip = doc.createElement('span');
            renChip.className = 'ag-chip';
            renChip.setAttribute('data-tone', 'warn');
            renChip.textContent = '注入失败';
            right.appendChild(renChip);
          } else {
            const okChip = doc.createElement('span');
            okChip.className = 'ag-chip';
            okChip.textContent = state.pluginInstances.has(id) ? '正常' : '未挂载';
            right.appendChild(okChip);
          }
          if (isMissingPath && bestRepair && hasBridge) {
            const repBtn = doc.createElement('button');
            repBtn.type = 'button';
            repBtn.className = 'ag-btn ag-btn-primary';
            repBtn.setAttribute('data-diag-row-repair', id);
            repBtn.disabled = Boolean(state.manageBusyId);
            repBtn.textContent = '一键修复';
            repBtn.addEventListener('click', () => {
              repairPluginFromUi(id, { mode: 'auto' });
            });
            right.appendChild(repBtn);
          } else if ((isInactive || localRenderErr || (meta?.health?.lastErrorStage === 'renderer' && errText)) && !isMissingPath && hasBridge) {
            const actBtn = doc.createElement('button');
            actBtn.type = 'button';
            actBtn.className = 'ag-btn ag-btn-primary';
            actBtn.setAttribute('data-diag-row-activate', id);
            actBtn.disabled = Boolean(state.manageBusyId);
            actBtn.textContent = '激活';
            actBtn.addEventListener('click', () => {
              activatePluginFromUi(id, { resetCircuit: true });
            });
            right.appendChild(actBtn);
          }
          if (isMissingPath || circuitOpen || isInactive || errText) {
            const inspBtn = doc.createElement('button');
            inspBtn.type = 'button';
            inspBtn.className = 'ag-btn';
            inspBtn.setAttribute('data-diag-row-inspect', id);
            inspBtn.textContent = '诊断';
            inspBtn.addEventListener('click', () => {
              state.activeSettingsTab = 'plugins';
              state.marketplaceOpen = false;
              state.selectedPluginId = id;
              state.focusPluginDiagnostics = id;
              renderSettingsBody();
            });
            right.appendChild(inspBtn);
          }
          if (crashes > 0 || circuitOpen) {
            const resetBtn = doc.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'ag-btn';
            resetBtn.setAttribute('data-reset-circuit', id);
            resetBtn.disabled = Boolean(state.manageBusyId);
            resetBtn.textContent = '解除熔断';
            resetBtn.addEventListener('click', () => {
              api.reEnablePlugin(id);
              if (hasBridge) {
                void runManageAction(id, `正在解除 ${id} 熔断并重连...`, async () => {
                  const res = await hostBridgePost('/host/reload', { pluginId: id, resetCircuit: true });
                  applyManagePayload(res);
                  if (meta?.health) {
                    meta.health = { ...meta.health, crashesInWindow: 0, circuitOpen: false };
                  }
                  state.manageToast = { tone: 'info', spinning: false, text: `已解除 ${id} 熔断并完成重连` };
                });
                return;
              }
              if (meta?.health) {
                meta.health = { ...meta.health, crashesInWindow: 0, circuitOpen: false };
              }
              state.manageToast = { tone: 'info', spinning: false, text: `已重置 ${id} 熔断计数` };
              renderSettingsBody();
            });
            right.appendChild(resetBtn);
          }
          row.appendChild(right);
          healthWrap.appendChild(row);
        }
      }
      detailBody.appendChild(healthWrap);

      const anchorSub = doc.createElement('div');
      anchorSub.className = 'ag-diag-subhead';
      anchorSub.textContent = `宿主锚点状态（${matchedCount}/${results.length} 命中）`;
      detailBody.appendChild(anchorSub);

      const anchorWrap = doc.createElement('div');
      anchorWrap.id = 'agy-anchor-health-card';
      if (visibleAnchors.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'ag-sv-empty';
        empty.textContent = `未找到匹配「${state.settingsSearchQuery}」的宿主锚点`;
        anchorWrap.appendChild(empty);
      } else {
        const grid = doc.createElement('div');
        grid.className = 'ag-anchor-grid';
        for (const r of visibleAnchors) {
          const cell = doc.createElement('div');
          cell.className = 'ag-anchor-item';
          cell.setAttribute('data-anchor-name', r.name);
          cell.setAttribute('data-anchor-matched', r.hit ? 'true' : 'false');
          const nameEl = doc.createElement('span');
          nameEl.className = 'ag-anchor-name';
          nameEl.textContent = r.name;
          const statusChip = doc.createElement('span');
          statusChip.className = 'ag-chip';
          statusChip.setAttribute('data-tone', r.hit ? 'accent' : 'warn');
          statusChip.textContent = r.hit ? '命中' : '未命中';
          cell.appendChild(nameEl);
          cell.appendChild(statusChip);
          grid.appendChild(cell);
        }
        anchorWrap.appendChild(grid);
      }
      detailBody.appendChild(anchorWrap);

      diagCard.appendChild(detailBody);
      diagSection.appendChild(diagCard);
      body.appendChild(diagSection);
    }

    function formatHealthDuration(ms) {
      const val = Number(ms);
      if (!Number.isFinite(val) || val <= 0) return '0s';
      if (val < 1000) return `${Math.round(val)}ms`;
      if (val < 60000) return `${(val / 1000).toFixed(1)}s`;
      const mins = Math.floor(val / 60000);
      const secs = Math.floor((val % 60000) / 1000);
      return `${mins}m ${secs}s`;
    }

    function buildMergedAnchorRows(health, queryLower = '') {
      const liveProbe = probeHealthAnchors();
      const liveByName = new Map(liveProbe.items.map((item) => [item.name, item]));
      const remoteItems = Array.isArray(health?.injection?.anchors?.items) ? health.injection.anchors.items : [];
      const remoteByName = new Map(remoteItems.map((item) => [item.name, item]));
      const names = Array.from(new Set([
        ...remoteItems.map((item) => item.name),
        ...liveProbe.items.map((item) => item.name)
      ]));
      const rows = names.map((name) => {
        const live = liveByName.get(name) || null;
        const remote = remoteByName.get(name) || null;
        const status = live ? live.status : (remote?.status || 'missing');
        const matchedSelector = live ? live.matchedSelector : (remote?.matchedSelector || null);
        const affectedPlugins = Array.isArray(remote?.affectedPlugins) ? remote.affectedPlugins : [];
        return { name, status, matchedSelector, affectedPlugins };
      });
      if (!queryLower) return rows;
      return rows.filter((row) => `${row.name} ${row.matchedSelector || ''} ${row.affectedPlugins.join(' ')}`.toLowerCase().includes(queryLower));
    }

    function buildMergedPluginHealthRows(health, queryLower = '') {
      const remotePlugins = Array.isArray(health?.plugins) ? health.plugins : [];
      const remoteById = new Map(remotePlugins.map((p) => [p.id, p]));
      const allIds = Array.from(new Set([
        ...remotePlugins.map((p) => p.id),
        ...state.pluginInstances.keys(),
        ...state.isolatedPlugins.keys(),
        ...state.rendererErrors.keys(),
        ...state.pluginMeta.keys()
      ])).sort();
      const rows = allIds.map((id) => {
        const remote = remoteById.get(id) || null;
        const meta = state.pluginMeta.get(id) || null;
        const localErr = state.rendererErrors.get(id) || null;
        const enabled = remote ? Boolean(remote.enabled) : (meta?.enabled !== false);
        const nodeState = remote?.nodeState || (enabled ? (meta?.active === false ? 'inactive' : 'not_applicable') : 'disabled');
        const localMounted = state.pluginInstances.has(id) || state.isolatedPlugins.has(id);
        const rendererMounted = localErr
          ? false
          : (localMounted ? true : Boolean(remote?.rendererMounted));
        const lastError = localErr?.message || remote?.lastError || meta?.health?.lastError || null;
        const lastErrorStack = localErr?.stack || remote?.lastErrorStack || meta?.health?.lastErrorStack || null;
        const affectedByMissingAnchors = Array.isArray(remote?.affectedByMissingAnchors)
          ? remote.affectedByMissingAnchors
          : [];
        return {
          id,
          name: remote?.name || pickLocaleText(meta?.displayName, id),
          enabled,
          nodeState,
          rendererMounted,
          lastError,
          lastErrorStack,
          affectedByMissingAnchors
        };
      });
      if (!queryLower) return rows;
      return rows.filter((row) => `${row.id} ${row.name} ${row.lastError || ''}`.toLowerCase().includes(queryLower));
    }

    function appendKvCardItem(grid, label, value, mono = false) {
      const item = doc.createElement('div');
      item.className = 'ag-sm-kv-item';
      const lbl = doc.createElement('span');
      lbl.className = 'ag-sm-kv-label';
      lbl.textContent = label;
      const valEl = doc.createElement('span');
      valEl.className = mono ? 'ag-sm-kv-val ag-sm-mono' : 'ag-sm-kv-val';
      valEl.textContent = value;
      item.appendChild(lbl);
      item.appendChild(valEl);
      grid.appendChild(item);
    }

    function renderSafeModeDiagnosticsView(body) {
      const hasBridge = hasBridgeAvailable();
      const queryLower = state.settingsSearchQuery.trim().toLowerCase();
      const health = state.hostHealth;
      const safeStatus = state.safeMode || computeSafeModeStatus();

      // 1. 故障摘要与升级事件
      const summaryActions = doc.createElement('div');
      summaryActions.className = 'ag-plugin-actions';

      const refreshHealthBtn = doc.createElement('button');
      refreshHealthBtn.type = 'button';
      refreshHealthBtn.id = 'agy-safe-mode-refresh-btn';
      refreshHealthBtn.className = 'ag-btn';
      refreshHealthBtn.disabled = Boolean(state.hostHealthLoading) || !hasBridge;
      refreshHealthBtn.appendChild(createIconEl('refresh'));
      const refreshLbl = doc.createElement('span');
      refreshLbl.textContent = state.hostHealthLoading ? '刷新中...' : '刷新健康快照';
      refreshHealthBtn.appendChild(refreshLbl);
      refreshHealthBtn.addEventListener('click', () => {
        void fetchHostHealth({ reportFirst: true });
      });
      summaryActions.appendChild(refreshHealthBtn);

      const exitSafeViewBtn = doc.createElement('button');
      exitSafeViewBtn.type = 'button';
      exitSafeViewBtn.id = 'agy-safe-mode-manage-btn';
      exitSafeViewBtn.className = 'ag-btn';
      exitSafeViewBtn.textContent = '插件管理';
      exitSafeViewBtn.addEventListener('click', () => {
        state.safeModeViewOpen = false;
        renderSettingsBody();
      });
      summaryActions.appendChild(exitSafeViewBtn);

      const faultSection = createSectionBlock(
        '故障摘要与升级事件',
        '独立 Shadow DOM 诊断视图：聚合 daemon hostHealth 快照与宿内实时探活。',
        summaryActions
      );
      faultSection.id = 'agy-safe-mode-diagnostics-view';

      const faultCard = doc.createElement('div');
      faultCard.className = 'settings-card-box';
      faultCard.id = 'agy-safe-mode-fault-card';

      const fault = health?.fault || null;
      const hasFault = Boolean(safeStatus.active || fault?.active);
      const banner = doc.createElement('div');
      banner.className = 'ag-sm-banner';
      banner.setAttribute('data-tone', hasFault ? (safeStatus.topbarMissing || safeStatus.settingsInjectionFailed || fault?.active ? 'danger' : 'warn') : 'ok');

      const bannerMain = doc.createElement('div');
      bannerMain.className = 'ag-sm-banner-main';
      const titleRow = doc.createElement('div');
      titleRow.className = 'ag-sm-banner-title-row';

      const bTitle = doc.createElement('span');
      bTitle.className = 'ag-sm-banner-title';
      bTitle.textContent = hasFault
        ? `当前异常：${fault?.code || (safeStatus.topbarMissing ? 'topbar_missing' : (safeStatus.settingsInjectionFailed ? 'settings_injection_failed' : 'plugin_error'))}`
        : '当前无活动故障';
      titleRow.appendChild(bTitle);

      if (fault?.exceeded5s) {
        const exChip = doc.createElement('span');
        exChip.className = 'ag-chip';
        exChip.setAttribute('data-tone', 'danger');
        exChip.textContent = '>5s 告警';
        titleRow.appendChild(exChip);
      }
      if (fault?.active) {
        const durChip = doc.createElement('span');
        durChip.className = 'ag-chip';
        durChip.setAttribute('data-tone', 'warn');
        durChip.textContent = `持续 ${formatHealthDuration(fault.durationMs)}`;
        titleRow.appendChild(durChip);
      }
      bannerMain.appendChild(titleRow);

      const bDesc = doc.createElement('div');
      bDesc.className = 'ag-sm-banner-desc';
      const reasonParts = [];
      if (fault?.reason) reasonParts.push(`Daemon: ${fault.reason}`);
      if (safeStatus.reasons.length > 0) reasonParts.push(`宿内: ${safeStatus.reasons.join('；')}`);
      if (fault?.since) reasonParts.push(`开始于 ${fault.since}`);
      if (state.hostHealthError) reasonParts.push(`快照拉取失败: ${state.hostHealthError}`);
      bDesc.textContent = reasonParts.length > 0 ? reasonParts.join(' · ') : '所有核心锚点与插件均运行正常。';
      bannerMain.appendChild(bDesc);

      banner.appendChild(bannerMain);
      faultCard.appendChild(banner);

      const upgradeSub = doc.createElement('div');
      upgradeSub.className = 'ag-diag-subhead';
      const upgradeEvents = Array.isArray(health?.antigravity?.upgradeEvents) ? health.antigravity.upgradeEvents : [];
      upgradeSub.textContent = `近期版本升级事件（${upgradeEvents.length}）`;
      faultCard.appendChild(upgradeSub);

      const upgradeList = doc.createElement('div');
      upgradeList.id = 'agy-safe-mode-upgrade-events';
      upgradeList.className = 'ag-sm-list';
      if (upgradeEvents.length === 0) {
        const emptyUp = doc.createElement('div');
        emptyUp.className = 'ag-sv-empty';
        emptyUp.textContent = '暂无近期版本升级事件';
        upgradeList.appendChild(emptyUp);
      } else {
        for (const ev of upgradeEvents) {
          const item = doc.createElement('div');
          item.className = 'ag-sm-list-item';
          const head = doc.createElement('div');
          head.className = 'ag-sm-list-head';
          const verSpan = doc.createElement('span');
          verSpan.className = 'ag-sv-row-title ag-sm-mono';
          verSpan.textContent = `${ev.fromVersion} -> ${ev.toVersion}`;
          const outChip = doc.createElement('span');
          outChip.className = 'ag-chip';
          outChip.setAttribute('data-tone', ev.outcome === 'succeeded' ? 'accent' : (ev.outcome === 'failed' || ev.outcome === 'blocked' ? 'danger' : 'warn'));
          outChip.textContent = ev.outcome;
          head.appendChild(verSpan);
          head.appendChild(outChip);
          const detail = doc.createElement('span');
          detail.className = 'ag-sv-row-desc';
          detail.textContent = `${ev.at}${ev.pid ? ` · PID ${ev.pid}` : ''}${ev.reason ? ` · ${ev.reason}` : ''}`;
          item.appendChild(head);
          item.appendChild(detail);
          upgradeList.appendChild(item);
        }
      }
      faultCard.appendChild(upgradeList);
      faultSection.appendChild(faultCard);
      body.appendChild(faultSection);

      // 2. 14 锚点实时探活表
      const anchorRows = buildMergedAnchorRows(health, queryLower);
      const healthyAnchors = anchorRows.filter((r) => r.status === 'ok').length;
      const missingAnchorsCount = anchorRows.length - healthyAnchors;
      const probeSourceLabel = health?.injection?.probeSource || 'runtime';

      const anchorSection = createSectionBlock(
        `14 锚点实时探活表（命中 ${healthyAnchors}/${anchorRows.length} · 失效 ${missingAnchorsCount}）`,
        `探活来源：${probeSourceLabel} · 逐项展示命中 selector（或 MISSING）与波及插件。`
      );
      const anchorCard = doc.createElement('div');
      anchorCard.className = 'settings-card-box';
      anchorCard.id = 'agy-safe-mode-anchors-card';

      const tableWrap = doc.createElement('div');
      tableWrap.className = 'ag-sm-table-wrap';
      const table = doc.createElement('table');
      table.id = 'agy-safe-mode-anchors-table';
      table.className = 'ag-sm-table';

      const thead = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      for (const colTitle of ['锚点', '状态', '命中 Selector', '波及插件']) {
        const th = doc.createElement('th');
        th.textContent = colTitle;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = doc.createElement('tbody');
      if (anchorRows.length === 0) {
        const tr = doc.createElement('tr');
        const td = doc.createElement('td');
        td.textContent = '暂无锚点探活数据';
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        for (const row of anchorRows) {
          const tr = doc.createElement('tr');
          tr.setAttribute('data-anchor-name', row.name);
          tr.setAttribute('data-anchor-status', row.status);

          const tdName = doc.createElement('td');
          tdName.className = 'ag-sm-mono';
          tdName.textContent = row.name;

          const tdStatus = doc.createElement('td');
          const sChip = doc.createElement('span');
          sChip.className = 'ag-chip';
          sChip.setAttribute('data-tone', row.status === 'ok' ? 'accent' : 'danger');
          sChip.textContent = row.status === 'ok' ? 'OK' : 'MISSING';
          tdStatus.appendChild(sChip);

          const tdSel = doc.createElement('td');
          tdSel.className = 'ag-sm-mono';
          tdSel.textContent = row.matchedSelector || 'MISSING';

          const tdAffected = doc.createElement('td');
          tdAffected.textContent = row.affectedPlugins.length > 0 ? row.affectedPlugins.join(', ') : '—';

          tr.appendChild(tdName);
          tr.appendChild(tdStatus);
          tr.appendChild(tdSel);
          tr.appendChild(tdAffected);
          tbody.appendChild(tr);
        }
      }
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      anchorCard.appendChild(tableWrap);
      anchorSection.appendChild(anchorCard);
      body.appendChild(anchorSection);

      // 3. 插件健康列表
      const pluginRows = buildMergedPluginHealthRows(health, queryLower);
      const pluginSection = createSectionBlock(
        `插件健康列表（${pluginRows.length}）`,
        '展示每个插件的 node 激活态、renderer 挂载态、受缺失锚点影响情况与最近错误栈。'
      );
      const pluginCard = doc.createElement('div');
      pluginCard.className = 'settings-card-box';
      pluginCard.id = 'agy-safe-mode-plugins-card';

      const pluginList = doc.createElement('div');
      pluginList.className = 'ag-sm-list';
      if (pluginRows.length === 0) {
        const emptyPl = doc.createElement('div');
        emptyPl.className = 'ag-sv-empty';
        emptyPl.textContent = '暂无已安装或已挂载插件';
        pluginList.appendChild(emptyPl);
      } else {
        for (const p of pluginRows) {
          const item = doc.createElement('div');
          item.className = 'ag-sm-list-item';
          item.setAttribute('data-safe-mode-plugin', p.id);

          const head = doc.createElement('div');
          head.className = 'ag-sm-list-head';

          const titleWrap = doc.createElement('div');
          titleWrap.className = 'ag-sv-row-info';
          const nameEl = doc.createElement('span');
          nameEl.className = 'ag-sv-row-title';
          nameEl.textContent = `${p.name} (${p.id})`;
          titleWrap.appendChild(nameEl);

          const chips = doc.createElement('div');
          chips.className = 'ag-plugin-actions';
          const nodeChip = doc.createElement('span');
          nodeChip.className = 'ag-chip';
          nodeChip.setAttribute('data-tone', p.nodeState === 'error' || p.nodeState === 'inactive' ? 'danger' : (p.nodeState === 'active' ? 'accent' : 'muted'));
          nodeChip.textContent = `node: ${p.nodeState}`;
          const renChip = doc.createElement('span');
          renChip.className = 'ag-chip';
          renChip.setAttribute('data-tone', p.rendererMounted ? 'accent' : (p.enabled ? 'warn' : 'muted'));
          renChip.textContent = `renderer: ${p.rendererMounted ? 'mounted' : 'unmounted'}`;
          chips.appendChild(nodeChip);
          chips.appendChild(renChip);

          head.appendChild(titleWrap);
          head.appendChild(chips);
          item.appendChild(head);

          if (p.affectedByMissingAnchors.length > 0) {
            const aff = doc.createElement('span');
            aff.className = 'ag-sv-row-desc';
            aff.textContent = `缺失依赖锚点：${p.affectedByMissingAnchors.join(', ')}`;
            item.appendChild(aff);
          }

          if (p.lastError) {
            const errLine = doc.createElement('span');
            errLine.className = 'ag-sv-row-desc ag-plugin-meta-danger';
            errLine.textContent = `最近错误：${p.lastError}`;
            item.appendChild(errLine);
          }

          if (p.lastErrorStack) {
            const stackPre = doc.createElement('pre');
            stackPre.className = 'ag-sm-stack';
            stackPre.textContent = p.lastErrorStack;
            item.appendChild(stackPre);
          }

          pluginList.appendChild(item);
        }
      }
      pluginCard.appendChild(pluginList);
      pluginSection.appendChild(pluginCard);
      body.appendChild(pluginSection);

      // 4. Daemon / Antigravity / CDP 摘要
      const sysSection = createSectionBlock(
        'Daemon / Antigravity / CDP 摘要',
        '展示会话变量隔离状态、客户端版本与调试参数、CDP /json/list 目标匹配与过滤明细。'
      );
      const sysCard = doc.createElement('div');
      sysCard.className = 'settings-card-box';
      sysCard.id = 'agy-safe-mode-system-card';

      const kvGrid = doc.createElement('div');
      kvGrid.className = 'ag-sm-kv-grid';

      const dInfo = health?.daemon;
      const envIsolationText = dInfo
        ? (dInfo.hasSessionEnvPollution
          ? `存在污染 (${(dInfo.inheritedSessionVars || []).join(', ') || 'unknown'})`
          : `已隔离（继承变量: ${(dInfo.inheritedSessionVars || []).length}）`)
        : '未知（未连接 daemon）';
      appendKvCardItem(
        kvGrid,
        'Daemon & 会话变量隔离',
        dInfo
          ? `PID ${dInfo.pid ?? '—'} · 端口 ${dInfo.bridgePort ?? '—'} · ${envIsolationText}`
          : `桥接端口 ${state.bridgePort || '—'} · ${envIsolationText}`
      );

      const aInfo = health?.antigravity;
      appendKvCardItem(
        kvGrid,
        'Antigravity 进程',
        aInfo
          ? `v${aInfo.version || state.antigravityVersion} · PID ${aInfo.pid ?? '—'} · hasDebugSwitch=${String(Boolean(aInfo.hasDebugSwitch))} · ${aInfo.running ? '运行中' : '未运行'}`
          : `v${state.antigravityVersion} · 暂无进程快照`
      );

      const cInfo = health?.cdp;
      const matchedTargets = Array.isArray(cInfo?.targets?.matched) ? cInfo.targets.matched : [];
      const filteredTargets = Array.isArray(cInfo?.targets?.filtered) ? cInfo.targets.filtered : [];
      appendKvCardItem(
        kvGrid,
        'CDP 发现与 /json/list',
        cInfo
          ? `端口 ${cInfo.port ?? '—'} · reachable=${String(Boolean(cInfo.reachable))} · 已匹配 ${matchedTargets.length} / 已过滤 ${filteredTargets.length}`
          : '暂无 CDP 发现快照'
      );

      appendKvCardItem(
        kvGrid,
        '宿内注入与上次补参',
        `injectedCount=${health?.injection?.injectedCount ?? 0} · lastRelaunch=${aInfo?.lastRelaunch?.status || '—'}${aInfo?.lastRelaunch?.reason ? ` (${aInfo.lastRelaunch.reason})` : ''}`
      );

      sysCard.appendChild(kvGrid);

      if (matchedTargets.length > 0 || filteredTargets.length > 0) {
        const cdpSub = doc.createElement('div');
        cdpSub.className = 'ag-diag-subhead';
        cdpSub.textContent = `CDP 页面 URL 明细（已匹配 ${matchedTargets.length} · 被过滤 ${filteredTargets.length}）`;
        sysCard.appendChild(cdpSub);

        const cdpList = doc.createElement('div');
        cdpList.id = 'agy-safe-mode-cdp-targets';
        cdpList.className = 'ag-sm-list';

        for (const t of matchedTargets) {
          const item = doc.createElement('div');
          item.className = 'ag-sm-list-item';
          item.setAttribute('data-cdp-target-kind', 'matched');
          const head = doc.createElement('div');
          head.className = 'ag-sm-list-head';
          const urlEl = doc.createElement('span');
          urlEl.className = 'ag-sm-mono';
          urlEl.textContent = t.url || '(no url)';
          const chip = doc.createElement('span');
          chip.className = 'ag-chip';
          chip.setAttribute('data-tone', 'accent');
          chip.textContent = `已匹配 (${t.type || 'page'})`;
          head.appendChild(urlEl);
          head.appendChild(chip);
          item.appendChild(head);
          cdpList.appendChild(item);
        }

        for (const f of filteredTargets) {
          const item = doc.createElement('div');
          item.className = 'ag-sm-list-item';
          item.setAttribute('data-cdp-target-kind', 'filtered');
          const head = doc.createElement('div');
          head.className = 'ag-sm-list-head';
          const urlEl = doc.createElement('span');
          urlEl.className = 'ag-sm-mono';
          urlEl.textContent = f.url || '(no url)';
          const chip = doc.createElement('span');
          chip.className = 'ag-chip';
          chip.setAttribute('data-tone', 'warn');
          chip.textContent = `被过滤: ${f.filterReason}`;
          head.appendChild(urlEl);
          head.appendChild(chip);
          item.appendChild(head);
          cdpList.appendChild(item);
        }
        sysCard.appendChild(cdpList);
      }

      sysSection.appendChild(sysCard);
      body.appendChild(sysSection);
    }

    function renderSettingsBody() {
      const rootEl = getActiveSettingsRootEl();
      if (!rootEl) return;
      const parts = ensureSettingsViewSkeleton(rootEl);
      if (!parts) return;
      syncSettingsTopbarActiveState(rootEl);
      const { body } = parts;
      clearElement(body);

      renderToastBanner(body);

      if (state.activeSettingsTab === 'appearance') {
        renderAppearanceTab(body);
        return;
      }
      if (state.selectedPluginId) {
        renderPluginDetailView(body, state.selectedPluginId);
        return;
      }
      if (state.marketplaceOpen) {
        renderMarketplaceView(body);
        return;
      }
      if (state.safeModeViewOpen) {
        renderSafeModeDiagnosticsView(body);
        return;
      }
      renderPluginsListView(body);
    }

    function renderSettingsView() {
      const rootEl = getActiveSettingsRootEl();
      if (!rootEl) return;
      ensureSettingsViewSkeleton(rootEl);
      renderSettingsBody();
    }

    function openFallbackModal() {
      ensureDomShell();
      if (!modalBackdropEl || !modalSettingsRootEl) return false;
      closeAllPopovers('__settings__');
      setHidden(modalBackdropEl, false);
      state.settingsMode = 'modal';
      settingsBtnEl?.setAttribute?.('data-active', 'true');
      updateElevationAttr();
      renderSettingsView();
      if (state.activeSettingsTab === 'plugins' && hasBridgeAvailable() && !state.manageLoading) {
        void fetchManagePlugins();
      }
      return true;
    }

    function closeSettings() {
      closeFieldModal(false);
      resetDragReorderState();
      state.pendingFlipReorder = null;
      state.recordingShortcutKey = null;
      state.openComboboxKey = null;
      state.commandEdits.clear();
      state.safeModeViewOpen = false;
      if (state.settingsMode === 'native') {
        deactivateNativeSettingsView();
        scheduleRuntimeHealthReport();
        return false;
      }
      if (state.settingsMode === 'modal') {
        setHidden(modalBackdropEl, true);
        state.settingsMode = 'closed';
        settingsBtnEl?.setAttribute?.('data-active', 'false');
        updateElevationAttr();
        scheduleRuntimeHealthReport();
        return false;
      }
      return false;
    }

    async function openSettings(opts = {}) {
      ensureDomShell();
      if (state.settingsMode === 'closed') {
        state.comboboxOptions.clear();
      }
      if (opts?.safeMode === true) {
        return openSafeModeDiagnostics();
      }
      state.safeModeViewOpen = false;
      const rawTab = opts && opts.tab !== undefined ? String(opts.tab).toLowerCase() : '';
      const explicitTab = (opts && opts.tab !== undefined) ? normalizeTabId(opts.tab) : null;
      if (explicitTab) {
        state.activeSettingsTab = explicitTab;
      }
      if (rawTab === 'diagnostics' || rawTab === 'health') {
        state.diagnosticsExpanded = true;
        state.marketplaceOpen = false;
      } else if (rawTab === 'marketplace') {
        state.marketplaceOpen = true;
      } else if (explicitTab) {
        state.marketplaceOpen = false;
      }
      if (opts && opts.pluginId !== undefined) {
        if (opts.pluginId && (!explicitTab || explicitTab === 'plugins')) {
          state.activeSettingsTab = 'plugins';
          state.selectedPluginId = String(opts.pluginId);
          state.focusPluginDiagnostics = opts.focusDiagnostics ? String(opts.pluginId) : null;
          state.marketplaceOpen = false;
        } else if (!opts.pluginId) {
          state.selectedPluginId = null;
          state.focusPluginDiagnostics = null;
        }
      } else {
        state.focusPluginDiagnostics = null;
      }
      state.manageConfirmUninstallId = null;

      // 1. 若允许注入原生设置，优先切入原生设置弹窗
      if (state.hostSettings.injectNativeSettings !== false) {
        if (syncNativeSettingsIntegration()) {
          state.settingsInjectionAttemptFailed = false;
          activateNativeSettingsView();
          evaluateSafeMode();
          scheduleRuntimeHealthReport();
          return { ok: true, mode: 'native', tab: state.activeSettingsTab, pluginId: state.selectedPluginId };
        }

        // 2. 未打开但命中 settings.openTrigger -> 尝试点击触发并短等待弹窗出现
        const triggerEl = queryAnchor('settings.openTrigger');
        if (triggerEl && typeof triggerEl.click === 'function') {
          try { triggerEl.click(); } catch {}
          if (syncNativeSettingsIntegration()) {
            state.settingsInjectionAttemptFailed = false;
            activateNativeSettingsView();
            evaluateSafeMode();
            scheduleRuntimeHealthReport();
            return { ok: true, mode: 'native', tab: state.activeSettingsTab, pluginId: state.selectedPluginId };
          }
          const waitMs = Number(opts.triggerWaitMs) > 0 ? Number(opts.triggerWaitMs) : 150;
          const deadline = Date.now() + waitMs;
          while (Date.now() < deadline && !state.disposed) {
            await new Promise((r) => setTimeout(r, 25));
            if (syncNativeSettingsIntegration()) {
              state.settingsInjectionAttemptFailed = false;
              activateNativeSettingsView();
              evaluateSafeMode();
              scheduleRuntimeHealthReport();
              return { ok: true, mode: 'native', tab: state.activeSettingsTab, pluginId: state.selectedPluginId };
            }
          }
        }
        state.settingsInjectionAttemptFailed = true;
      }

      // 3. 关闭原生注入、锚点未命中或未弹出 -> 自动降级为居中独立模态窗
      openFallbackModal();
      evaluateSafeMode();
      scheduleRuntimeHealthReport();
      return { ok: true, mode: 'modal', tab: state.activeSettingsTab, pluginId: state.selectedPluginId };
    }

    function toggleSettingsPanel(force, opts = {}) {
      ensureDomShell();
      const isCurrentlyOpen = state.settingsMode !== 'closed';
      const wantOpen = typeof force === 'boolean' ? force : !isCurrentlyOpen;
      if (!wantOpen) {
        closeSettings();
        return false;
      }
      void openSettings(opts);
      return true;
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

    function notifyStateSubscribers(key, value, version, replay = false) {
      const subs = state.stateSubs.get(key);
      if (!subs) return;
      for (const s of Array.from(subs)) {
        if (s.isIsolated) {
          dispatchToIsolated({
            event: 'bus.state',
            pluginId: s.pluginId,
            key,
            value,
            version,
            replay
          });
        } else if (typeof s.fn === 'function') {
          try { s.fn(value, { version, replay }); } catch {}
        }
      }
    }

    function emitEventImpl(topic, payload) {
      const set = state.events.get(topic);
      if (!set) return 0;
      let count = 0;
      for (const item of Array.from(set)) {
        if (item.isIsolated) {
          dispatchToIsolated({
            event: 'bus.event',
            pluginId: item.pluginId,
            topic,
            payload
          });
          count++;
        } else if (typeof item.fn === 'function') {
          try { item.fn(payload); count++; } catch {}
        }
      }
      return count;
    }

    function setStickyStateImpl(key, val) {
      const prev = state.stickyState.get(key);
      const next = { value: val, version: prev ? prev.version + 1 : 1 };
      state.stickyState.set(key, next);
      if (key === 'state:host.locale@1' && val && typeof val === 'object') {
        const nextLocale = String(val.bcp47 || val.locale || val.lang || '').trim();
        if (nextLocale && nextLocale !== state.locale) {
          state.locale = nextLocale;
          if (state.settingsMode !== 'closed') {
            renderSettingsView();
          }
        }
      }
      notifyStateSubscribers(key, next.value, next.version, false);
      return next;
    }

    function invokeIsolatedServiceMethod(providerPluginId, serviceName, methodName, args) {
      return new Promise((resolve, reject) => {
        const invokeId = `svcinv:${++serviceInvokeSeq}:${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => {
          state.pendingServiceInvokes.delete(invokeId);
          reject(new Error(`SERVICE_TIMEOUT: ${serviceName}.${methodName}`));
        }, 5000);
        state.pendingServiceInvokes.set(invokeId, { pluginId: providerPluginId, resolve, reject, timer });
        dispatchToIsolated({
          event: 'service.invoke',
          pluginId: providerPluginId,
          invokeId,
          service: serviceName,
          name: serviceName,
          method: methodName,
          args: Array.isArray(args) ? args : []
        });
      });
    }

    function handleCrossWorldRequest(ev) {
      const detail = ev?.detail;
      if (!detail || detail.direction !== 'to-main') return;
      void (async () => {
        let reply;
        try {
          const action = detail.action || (detail.service ? 'services.call' : '');
          const pid = detail.pluginId || 'isolated';
          if (detail.pluginId && action !== 'plugin.dispose') {
            state.isolatedPlugins.add(String(detail.pluginId));
          }
          let val = null;

          if (action === 'topbar.registerUnit') {
            if (!detail.pluginId || !detail.unit?.id) {
              throw new Error('Invalid unit payload');
            }
            const reg = registerUnitImpl(detail.pluginId, {
              id: detail.unit.id,
              order: detail.unit.order,
              label: detail.unit.label,
              iconSvg: detail.unit.iconSvg,
              segments: detail.unit.segments,
              title: detail.unit.title,
              badge: detail.unit.badge,
              tone: detail.unit.tone,
              accentColor: detail.unit.accentColor,
              onClick: () => dispatchToIsolated({
                event: 'unit.click',
                pluginId: detail.pluginId,
                unitId: detail.unit.id
              })
            });
            val = { ok: true, slotSelector: reg.slotSelector };
          } else if (action === 'topbar.updateUnit') {
            const uId = detail.unitId || detail.unit?.id || detail.id;
            const patch = isPlainObject(detail.patch) ? detail.patch : (isPlainObject(detail.unit) ? detail.unit : detail);
            if (!detail.pluginId || !uId) throw new Error('Invalid updateUnit payload');
            val = updateUnitImpl(detail.pluginId, uId, patch);
          } else if (action === 'topbar.disposeUnit') {
            const uId = detail.unitId || detail.id;
            if (detail.pluginId && uId) disposeUnitImpl(detail.pluginId, uId);
            val = { ok: true };
          } else if (action === 'topbar.setAvailable') {
            if (detail.pluginId) setTopbarAvailableImpl(detail.pluginId, detail.available !== false);
            val = { ok: true };
          } else if (action === 'topbar.registerPopover') {
            const pop = detail.popover || detail;
            if (!detail.pluginId || !pop?.id) throw new Error('Invalid popover payload');
            const reg = registerPopoverImpl(detail.pluginId, {
              id: pop.id,
              anchorId: pop.anchorId,
              title: pop.title,
              isIsolated: true
            });
            val = { ok: true, slotSelector: reg.slotSelector, panelSelector: reg.panelSelector };
          } else if (action === 'topbar.togglePopover') {
            const popId = detail.popoverId || detail.id;
            if (!detail.pluginId || !popId) throw new Error('Invalid togglePopover payload');
            const open = togglePopoverImpl(detail.pluginId, popId, detail.force, {
              anchorRect: detail.anchorRect,
              placement: detail.placement
            });
            val = { ok: true, open };
          } else if (action === 'topbar.disposePopover') {
            const popId = detail.popoverId || detail.id;
            if (detail.pluginId && popId) disposePopoverImpl(detail.pluginId, popId);
            val = { ok: true };
          } else if (action === 'styles.inject') {
            const res = injectPluginStyle(pid, detail.css || '', {
              scope: detail.scope || 'document',
              id: detail.styleId || detail.id
            });
            val = { ok: res.ok, styleId: res.styleId, scope: res.scope };
          } else if (action === 'styles.dispose') {
            disposePluginStyle(pid, detail.styleId || detail.id || null);
            val = { ok: true };
          } else if (action === 'surfaces.provide') {
            val = provideSurfaceImpl(pid, detail.surfaceName, null, detail.selector || null);
          } else if (action === 'surfaces.revoke') {
            val = revokeSurfaceImpl(pid, detail.surfaceName);
          } else if (action === 'surfaces.subscribe') {
            const sName = String(detail.surfaceName || '');
            if (!sName) throw new Error('surfaceName is required');
            if (!state.surfaceSubs.has(sName)) state.surfaceSubs.set(sName, new Set());
            const set = state.surfaceSubs.get(sName);
            let exists = false;
            for (const item of set) {
              if (item.isIsolated && item.pluginId === pid) { exists = true; break; }
            }
            if (!exists) set.add({ pluginId: pid, isIsolated: true, fn: null });
            const existingSurf = state.surfaces.get(sName);
            const domEl = existingSurf?.el || findSurfaceElement(sName);
            const available = Boolean(existingSurf || domEl);
            const selector = existingSurf?.selector || `[data-agy-surface="${sName}"]`;
            if (available) {
              dispatchToIsolated({
                event: 'surface.changed',
                pluginId: pid,
                surfaceName: sName,
                available: true,
                selector
              });
            }
            val = { ok: true, surfaceName: sName, available, selector };
          } else if (action === 'surfaces.unsubscribe') {
            const sName = String(detail.surfaceName || '');
            const set = state.surfaceSubs.get(sName);
            if (set) {
              for (const item of Array.from(set)) {
                if (item.isIsolated && item.pluginId === pid) set.delete(item);
              }
              if (set.size === 0) state.surfaceSubs.delete(sName);
            }
            val = { ok: true };
          } else if (action === 'settings.get') {
            val = getPluginSettings(pid);
          } else if (action === 'settings.update') {
            const patch = isPlainObject(detail.patch) ? detail.patch : (isPlainObject(detail.values) ? detail.values : {});
            val = await updatePluginSettings(pid, patch);
          } else if (action === 'settings.open') {
            const openOpts = isPlainObject(detail.options) ? detail.options : detail;
            const rawTab = typeof openOpts.tab === 'string' && openOpts.tab.trim() ? openOpts.tab.trim() : 'plugins';
            const hasExplicitTarget = ('targetPluginId' in detail) || (isPlainObject(detail.options) && ('pluginId' in detail.options));
            const targetPid = ('targetPluginId' in detail)
              ? detail.targetPluginId
              : (isPlainObject(detail.options) && ('pluginId' in detail.options)
                ? detail.options.pluginId
                : detail.pluginId);
            val = await openSettings({
              tab: rawTab,
              pluginId: hasExplicitTarget ? (targetPid || null) : (targetPid || undefined)
            });
          } else if (action === 'events.emit') {
            val = { delivered: emitEventImpl(detail.topic, detail.payload) };
          } else if (action === 'events.subscribe') {
            const topic = String(detail.topic || '');
            if (!topic) throw new Error('topic is required');
            if (!state.events.has(topic)) state.events.set(topic, new Set());
            const set = state.events.get(topic);
            let exists = false;
            for (const item of set) {
              if (item.isIsolated && item.pluginId === pid) { exists = true; break; }
            }
            if (!exists) set.add({ pluginId: pid, isIsolated: true, fn: null });
            val = { ok: true };
          } else if (action === 'events.unsubscribe') {
            const topic = String(detail.topic || '');
            const set = state.events.get(topic);
            if (set) {
              for (const item of Array.from(set)) {
                if (item.isIsolated && item.pluginId === pid) set.delete(item);
              }
              if (set.size === 0) state.events.delete(topic);
            }
            val = { ok: true };
          } else if (action === 'state.set') {
            val = setStickyStateImpl(detail.key, detail.value);
          } else if (action === 'state.get') {
            val = state.stickyState.get(detail.key) || null;
          } else if (action === 'state.subscribe') {
            const key = String(detail.key || '');
            if (!key) throw new Error('state key is required');
            if (!state.stateSubs.has(key)) state.stateSubs.set(key, new Set());
            const set = state.stateSubs.get(key);
            let exists = false;
            for (const item of set) {
              if (item.isIsolated && item.pluginId === pid) { exists = true; break; }
            }
            if (!exists) set.add({ pluginId: pid, isIsolated: true, fn: null });
            const cur = state.stickyState.get(key) || null;
            if (cur) {
              dispatchToIsolated({
                event: 'bus.state',
                pluginId: pid,
                key,
                value: cur.value,
                version: cur.version,
                replay: true
              });
            }
            val = cur;
          } else if (action === 'state.unsubscribe') {
            const key = String(detail.key || '');
            const set = state.stateSubs.get(key);
            if (set) {
              for (const item of Array.from(set)) {
                if (item.isIsolated && item.pluginId === pid) set.delete(item);
              }
              if (set.size === 0) state.stateSubs.delete(key);
            }
            val = { ok: true };
          } else if (action === 'services.provide') {
            const svcName = String(detail.name || detail.service || '');
            const methodNames = Array.isArray(detail.methods) ? detail.methods : [];
            if (!svcName) throw new Error('service name is required');
            const proxyMethods = {};
            for (const mName of methodNames) {
              proxyMethods[mName] = (...args) => invokeIsolatedServiceMethod(pid, svcName, mName, args);
            }
            state.services.set(svcName, { pluginId: pid, methods: proxyMethods, isIsolated: true });
            val = { ok: true, service: svcName };
          } else if (action === 'services.revoke') {
            const svcName = String(detail.name || detail.service || '');
            if (state.services.get(svcName)?.pluginId === pid) {
              state.services.delete(svcName);
            }
            val = { ok: true };
          } else if (action === 'service.reply') {
            const invId = detail.invokeId;
            const pending = state.pendingServiceInvokes.get(invId);
            if (pending) {
              state.pendingServiceInvokes.delete(invId);
              clearTimeout(pending.timer);
              const isOk = detail.reply ? Boolean(detail.reply.ok) : Boolean(detail.ok);
              const resVal = detail.reply ? detail.reply.value : detail.value;
              const errMsg = detail.reply ? detail.reply.error : detail.error;
              if (isOk) pending.resolve(resVal);
              else pending.reject(new Error(errMsg || 'Remote service call failed'));
            }
            val = { ok: true };
          } else if (action === 'services.call' || action === 'service.call') {
            const svcName = String(detail.service || detail.name || '');
            const svc = state.services.get(svcName);
            if (!svc || typeof svc.methods?.[detail.method] !== 'function') {
              throw new Error(`SERVICE_UNAVAILABLE: ${svcName}.${detail.method}`);
            }
            const raw = await svc.methods[detail.method](...(detail.args || []));
            val = raw === undefined ? null : JSON.parse(JSON.stringify(raw));
          } else if (action === 'commands.execute') {
            val = await executeCommand(pid, detail.commandId, detail.args || []);
          } else if (action === 'plugin.dispose') {
            if (detail.pluginId) state.isolatedPlugins.delete(String(detail.pluginId));
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

    let sendTextSeq = 0;

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
        const raw = String(text || '');
        if (!doc || typeof doc.execCommand !== 'function') {
          if ('textContent' in editor) editor.textContent = raw;
          const sendBtn = queryAnchor('composer.sendButton');
          if (sendBtn && !sendBtn.disabled && typeof sendBtn.click === 'function') {
            sendBtn.click();
            return true;
          }
          return false;
        }

        const seq = ++sendTextSeq;
        const trimmed = raw.trim();
        const slashMatch = trimmed.match(/^\/([a-zA-Z0-9][a-zA-Z0-9_-]*)$/);
        const insertStr = slashMatch ? `/${slashMatch[1]}` : raw;

        const readNormalizedEditorText = (ed) => {
          if (!ed) return '';
          const cur = String(
            (typeof ed.innerText === 'string' && ed.innerText.length > 0 ? ed.innerText : ed.textContent) || ''
          );
          return cur.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\r?\n$/, '');
        };

        const insertTextSafely = (ed, str) => {
          const beforeText = readNormalizedEditorText(ed);
          let capturedBeforeInput = null;
          const onBeforeInput = (ev) => {
            if (!ev) return;
            if (!ev.inputType || ev.inputType === 'insertText') {
              capturedBeforeInput = ev;
            }
          };
          const canListenDoc = typeof doc.addEventListener === 'function' && typeof doc.removeEventListener === 'function';
          const canListenEd = ed && typeof ed.addEventListener === 'function' && typeof ed.removeEventListener === 'function';
          if (canListenDoc) doc.addEventListener('beforeinput', onBeforeInput, true);
          if (canListenEd) ed.addEventListener('beforeinput', onBeforeInput, true);
          let inserted = false;
          try {
            inserted = Boolean(doc.execCommand('insertText', false, str));
          } finally {
            if (canListenDoc) doc.removeEventListener('beforeinput', onBeforeInput, true);
            if (canListenEd) ed.removeEventListener('beforeinput', onBeforeInput, true);
          }
          const prevented = Boolean(capturedBeforeInput && capturedBeforeInput.defaultPrevented);
          const afterText = readNormalizedEditorText(ed);
          const textApplied = Boolean(str) && afterText !== beforeText && (afterText === str || afterText.endsWith(str));
          if (!inserted && !prevented && !textApplied && typeof globalThis.InputEvent === 'function') {
            ed.dispatchEvent?.(new globalThis.InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: str
            }));
          }
          return Boolean(inserted || prevented || textApplied);
        };

        const hasPendingContent = () => {
          const cur = readNormalizedEditorText(editor).trim();
          if (cur.length > 0) return true;
          return Boolean(editor.querySelector?.('[data-lexical-decorator], [data-uri]'));
        };

        const clickSendIfReady = () => {
          if (!hasPendingContent()) return false;
          const sendBtn = queryAnchor('composer.sendButton');
          if (sendBtn && !sendBtn.disabled && typeof sendBtn.click === 'function') {
            sendBtn.click();
            return true;
          }
          return false;
        };

        const findSlashOption = (cmdName) => {
          const lower = String(cmdName || '').trim().toLowerCase();
          if (!lower || typeof doc.querySelectorAll !== 'function') return null;
          const withSlash = `/${lower}`;
          const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const boundaryRe = new RegExp(`^\\/?${escaped}(?:$|\\s|[\\u4e00-\\u9fff])`, 'i');
          const opts = Array.from(doc.querySelectorAll('[role="listbox"] [role="option"], [role="menu"] [role="menuitem"], [role="option"]') || []).filter((opt) => {
            if (!opt) return false;
            if (opt.hidden === true || opt.getAttribute?.('aria-hidden') === 'true') return false;
            if (opt.closest?.('#agy-daddy-host, [data-agy-surface]')) return false;
            return true;
          });
          for (const opt of opts) {
            const cmdAttr = String(
              opt.getAttribute?.('data-command')
              || opt.getAttribute?.('data-slash-command')
              || opt.getAttribute?.('data-value')
              || ''
            ).trim().toLowerCase();
            if (cmdAttr && (cmdAttr === lower || cmdAttr === withSlash)) return opt;
            const leaves = Array.from(opt.querySelectorAll?.('span, div, code, strong, p') || []);
            if (leaves.some((el) => (!el.children || el.children.length === 0) && (() => {
              const txt = String(el.textContent || '').trim().toLowerCase();
              return txt === lower || txt === withSlash;
            })())) {
              return opt;
            }
          }
          for (const opt of opts) {
            const full = String(opt.textContent || '').replace(/\s+/g, ' ').trim();
            if (boundaryRe.test(full)) return opt;
          }
          return null;
        };

        const scheduleRetry = (fn, ms) => {
          const tid = setTimeout(() => {
            hostRetryTimers.delete(tid);
            if (!state.disposed && seq === sendTextSeq) fn();
          }, ms);
          hostRetryTimers.add(tid);
        };

        const runInsertAndSend = () => {
          if (state.disposed || seq !== sendTextSeq) return;
          try {
            editor.focus?.();
            const sel = typeof win?.getSelection === 'function'
              ? win.getSelection()
              : (typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null);
            if (sel && typeof doc.createRange === 'function') {
              const range = doc.createRange();
              range.selectNodeContents(editor);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }
            insertTextSafely(editor, insertStr);
          } catch {
            if ('textContent' in editor) editor.textContent = insertStr;
          }

          if (slashMatch) {
            const cmd = slashMatch[1];
            let attempt = 0;
            const pollSlash = () => {
              if (seq !== sendTextSeq) return;
              const opt = findSlashOption(cmd);
              if (opt) {
                const target = opt.querySelector?.('div.cursor-pointer') || opt;
                try {
                  if (typeof globalThis.MouseEvent === 'function') {
                    target.dispatchEvent?.(new globalThis.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                  }
                } catch {}
                target.click?.();
                scheduleRetry(() => {
                  clickSendIfReady();
                }, 40);
                return;
              }
              if (attempt++ < 6) {
                scheduleRetry(pollSlash, 35);
              } else {
                clickSendIfReady();
              }
            };
            pollSlash();
            return;
          }

          if (!clickSendIfReady()) {
            scheduleRetry(() => {
              clickSendIfReady();
            }, 35);
          }
        };

        if (hasPendingContent()) {
          try {
            editor.focus?.();
            doc.execCommand('selectAll', false, null);
            doc.execCommand('delete', false, null);
          } catch {}
          if (!hasPendingContent()) {
            runInsertAndSend();
          } else {
            scheduleRetry(runInsertAndSend, 20);
          }
        } else {
          runInsertAndSend();
        }
        return true;
      }
    };

    function createPluginContext(pluginId, pluginOptions = {}) {
      const privateToken = pluginOptions.pluginToken || '';
      const pluginFetchFn = pluginOptions.fetch || fetchFn;
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
            const reg = registerUnitImpl(pluginId, def);
            return reg.dispose;
          },
          updateUnit(unitId, patch) {
            return updateUnitImpl(pluginId, unitId, patch);
          },
          setAvailable(available) {
            setTopbarAvailableImpl(pluginId, available !== false);
          },
          registerPopover(def) {
            return registerPopoverImpl(pluginId, def);
          }
        },
        styles: {
          inject(cssText, opts = {}) {
            const res = injectPluginStyle(pluginId, cssText, opts);
            return res.dispose;
          }
        },
        surfaces: {
          provide(surfaceName, el) {
            provideSurfaceImpl(pluginId, surfaceName, el);
            return () => revokeSurfaceImpl(pluginId, surfaceName);
          },
          get(surfaceName) {
            return state.surfaces.get(surfaceName)?.el || findSurfaceElement(surfaceName);
          },
          mount(surfaceName, mountFn, opts = {}) {
            if (!state.surfaceSubs.has(surfaceName)) state.surfaceSubs.set(surfaceName, new Set());
            let currentEl = null;
            let currentDispose = null;
            let disposedLocal = false;
            let stopFallback = null;

            const cleanupCurrent = () => {
              if (typeof currentDispose === 'function') {
                try { currentDispose(); } catch {}
              }
              currentDispose = null;
              currentEl = null;
            };

            const mountOn = (targetEl) => {
              if (disposedLocal) return;
              if (targetEl === currentEl) return;
              cleanupCurrent();
              if (targetEl && typeof mountFn === 'function') {
                currentEl = targetEl;
                try {
                  const res = mountFn(targetEl);
                  if (typeof res === 'function') currentDispose = res;
                } catch (err) {
                  recordPluginRuntimeError(pluginId, err);
                }
              }
            };

            const syncTarget = (surfEl) => {
              if (surfEl) {
                mountOn(surfEl);
              } else if (opts.fallbackAnchor) {
                mountOn(queryAnchor(opts.fallbackAnchor));
              } else {
                cleanupCurrent();
              }
            };

            const subEntry = {
              pluginId,
              isIsolated: false,
              fn: (surfEl) => syncTarget(surfEl)
            };
            state.surfaceSubs.get(surfaceName).add(subEntry);

            const initialSurf = state.surfaces.get(surfaceName)?.el || findSurfaceElement(surfaceName);
            syncTarget(initialSurf);

            if (opts.fallbackAnchor) {
              ensureSharedObserver();
              const subId = `${pluginId}:surface-fallback:${surfaceName}:${Math.random().toString(36).slice(2)}`;
              state.anchorSubs.set(subId, {
                pluginId,
                anchorName: opts.fallbackAnchor,
                lastHit: null,
                fn: (fallbackEl) => {
                  const liveSurf = state.surfaces.get(surfaceName)?.el || findSurfaceElement(surfaceName);
                  if (!liveSurf) mountOn(fallbackEl);
                }
              });
              stopFallback = () => state.anchorSubs.delete(subId);
            }

            return () => {
              disposedLocal = true;
              cleanupCurrent();
              state.surfaceSubs.get(surfaceName)?.delete(subEntry);
              if (typeof stopFallback === 'function') stopFallback();
            };
          }
        },
        settings: {
          get() {
            return getPluginSettings(pluginId);
          },
          update(patch) {
            return updatePluginSettings(pluginId, patch);
          },
          onChange(fn) {
            if (typeof fn !== 'function') return () => {};
            if (!state.settingsSubs.has(pluginId)) state.settingsSubs.set(pluginId, new Set());
            state.settingsSubs.get(pluginId).add(fn);
            return () => state.settingsSubs.get(pluginId)?.delete(fn);
          },
          open(tabOrOpts = 'plugins') {
            let tab = 'plugins';
            let targetPluginId = pluginId;
            const isSubSection = (t) => {
              const s = String(t || '').toLowerCase();
              return normalizeTabId(s) !== 'plugins' || s === 'diagnostics' || s === 'health' || s === 'marketplace';
            };
            if (typeof tabOrOpts === 'string' && tabOrOpts.trim()) {
              tab = tabOrOpts.trim();
              if (isSubSection(tab)) targetPluginId = null;
            } else if (isPlainObject(tabOrOpts)) {
              if (typeof tabOrOpts.tab === 'string' && tabOrOpts.tab.trim()) {
                tab = tabOrOpts.tab.trim();
              }
              if ('pluginId' in tabOrOpts) {
                targetPluginId = (typeof tabOrOpts.pluginId === 'string' && tabOrOpts.pluginId.trim())
                  ? tabOrOpts.pluginId.trim()
                  : null;
              } else if (isSubSection(tab)) {
                targetPluginId = null;
              }
            }
            return openSettings({ tab, pluginId: targetPluginId });
          }
        },
        commands: {
          register(commandId, handler) {
            if (!commandId || typeof handler !== 'function') throw new Error('Invalid command registration');
            state.localCommands.set(commandId, { pluginId, handler });
            return () => {
              if (state.localCommands.get(commandId)?.pluginId === pluginId) {
                state.localCommands.delete(commandId);
              }
            };
          },
          execute(commandId, args = []) {
            return executeCommand(pluginId, commandId, args);
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
            state.services.set(name, { pluginId, methods, isIsolated: false });
            return () => {
              if (state.services.get(name)?.pluginId === pluginId) state.services.delete(name);
            };
          },
          get(name) {
            return state.services.get(name)?.methods || null;
          },
          async call(name, method, args = []) {
            const svc = state.services.get(name);
            if (!svc || typeof svc.methods?.[method] !== 'function') {
              throw new Error(`SERVICE_UNAVAILABLE: ${name}.${method}`);
            }
            return await svc.methods[method](...(Array.isArray(args) ? args : []));
          }
        },
        events: {
          emit(topic, payload) {
            return emitEventImpl(topic, payload);
          },
          on(topic, fn) {
            if (!state.events.has(topic)) state.events.set(topic, new Set());
            const entry = { pluginId, isIsolated: false, fn };
            state.events.get(topic).add(entry);
            return () => state.events.get(topic)?.delete(entry);
          }
        },
        state: {
          set(key, val) {
            return setStickyStateImpl(key, val);
          },
          get(key) {
            return state.stickyState.get(key) || null;
          },
          subscribe(key, fn) {
            if (!state.stateSubs.has(key)) state.stateSubs.set(key, new Set());
            const entry = { pluginId, isIsolated: false, fn };
            state.stateSubs.get(key).add(entry);
            const cur = state.stickyState.get(key);
            if (cur) try { fn(cur.value, { version: cur.version, replay: true }); } catch {}
            return () => state.stateSubs.get(key)?.delete(entry);
          }
        },
        bridge: {
          async post(subPath, payload = {}, opts = {}) {
            if (!state.bridgePort || typeof pluginFetchFn !== 'function') {
              throw new Error('Bridge unavailable in renderer');
            }
            const clean = subPath.startsWith('/') ? subPath : `/${subPath}`;
            const fetchInit = {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-AGY-Plugin-Token': privateToken
              },
              body: JSON.stringify(payload)
            };
            if (opts && opts.signal) fetchInit.signal = opts.signal;
            const resp = await pluginFetchFn.call(win || globalThis, `http://127.0.0.1:${state.bridgePort}/plugins/${pluginId}${clean}`, fetchInit);
            if (typeof resp.text === 'function') {
              const rawText = await resp.text();
              if (rawText) {
                try {
                  return JSON.parse(rawText);
                } catch {}
              }
              if (!resp.ok) {
                return {
                  ok: false,
                  status: resp.status,
                  error: `HTTP ${resp.status}${rawText ? `: ${rawText.slice(0, 200)}` : ''}`
                };
              }
              return { ok: true };
            }
            if (typeof resp.json === 'function') {
              return resp.json();
            }
            return { ok: Boolean(resp.ok), status: resp.status };
          }
        }
      };
    }

    async function mountPlugin(pluginId, pluginObj, pluginOptions = {}) {
      ensureDomShell();
      state.rendererErrors.delete(pluginId);
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
        renderPluginAlertCapsule();
        renderUnits();
        evaluateSafeMode();
        scheduleRuntimeHealthReport();
        return { ok: true };
      } catch (err) {
        const health = recordPluginRuntimeError(pluginId, err);
        await disposePlugin(pluginId);
        return { ok: false, error: err?.message || String(err), ...health };
      }
    }

    async function disposePlugin(pluginId) {
      dispatchLifecycleEvent({ type: 'plugin.dispose', pluginId });
      const inst = state.pluginInstances.get(pluginId);
      state.pluginInstances.delete(pluginId);
      state.isolatedPlugins.delete(pluginId);
      state.topbarSuppressedPlugins.delete(pluginId);
      if (inst && typeof inst.pluginObj?.dispose === 'function') {
        try { await inst.pluginObj.dispose(); } catch {}
      }

      for (const [k, u] of Array.from(state.units.entries())) {
        if (u.pluginId === pluginId) {
          state.units.delete(k);
          if (u.node?.remove) u.node.remove();
        }
      }
      renderUnits();

      for (const [k, p] of Array.from(state.popovers.entries())) {
        if (p.pluginId === pluginId) {
          state.popovers.delete(k);
          if (activePopoverId === k) activePopoverId = null;
          if (p.node?.remove) p.node.remove();
        }
      }
      disposePluginStyle(pluginId, null);

      for (const [sName, surf] of Array.from(state.surfaces.entries())) {
        if (surf.pluginId === pluginId) {
          revokeSurfaceImpl(pluginId, sName);
        }
      }
      for (const [sName, set] of state.surfaceSubs.entries()) {
        for (const e of Array.from(set)) if (e.pluginId === pluginId) set.delete(e);
        if (set.size === 0) state.surfaceSubs.delete(sName);
      }
      for (const [k, svc] of Array.from(state.services.entries())) {
        if (svc.pluginId === pluginId) state.services.delete(k);
      }
      for (const [invId, inv] of Array.from(state.pendingServiceInvokes.entries())) {
        if (inv.pluginId === pluginId) {
          state.pendingServiceInvokes.delete(invId);
          clearTimeout(inv.timer);
          inv.reject(new Error(`PLUGIN_DISPOSED: ${pluginId}`));
        }
      }
      for (const [cmdId, cmd] of Array.from(state.localCommands.entries())) {
        if (cmd.pluginId === pluginId) state.localCommands.delete(cmdId);
      }
      state.settingsSubs.delete(pluginId);

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
      updateElevationAttr();
      evaluateSafeMode();
      scheduleRuntimeHealthReport();
    }

    function getPluginUsageStats(pluginId) {
      let domNodes = 0;
      for (const u of state.units.values()) if (u.pluginId === pluginId) domNodes++;
      for (const p of state.popovers.values()) if (p.pluginId === pluginId) domNodes++;
      for (const s of state.pluginStyles.values()) if (s.pluginId === pluginId) domNodes++;
      for (const sf of state.surfaces.values()) if (sf.pluginId === pluginId) domNodes++;
      let observers = 0;
      for (const s of state.anchorSubs.values()) if (s.pluginId === pluginId) observers++;
      for (const set of state.surfaceSubs.values()) for (const e of set) if (e.pluginId === pluginId) observers++;
      let events = 0;
      for (const set of state.events.values()) for (const e of set) if (e.pluginId === pluginId) events++;
      for (const set of state.stateSubs.values()) for (const e of set) if (e.pluginId === pluginId) events++;
      const sSubs = state.settingsSubs.get(pluginId);
      if (sSubs) events += sSubs.size;
      let services = 0;
      for (const svc of state.services.values()) if (svc.pluginId === pluginId) services++;
      const timers = state.timers.get(pluginId)?.size || 0;
      return { domNodes, observers, timers, events, services };
    }

    const hostRetryTimers = new Set();
    function scheduleNativeSettingsSync() {
      if (state.disposed || state.hostSettings.injectNativeSettings === false) return;
      syncNativeSettingsIntegration();
      for (const delayMs of [30, 150, 400]) {
        const tid = setTimeout(() => {
          hostRetryTimers.delete(tid);
          if (!state.disposed) {
            syncNativeSettingsIntegration();
          }
        }, delayMs);
        hostRetryTimers.add(tid);
      }
    }

    function isSettingsOpenTriggerTarget(target) {
      if (!target) return false;
      const sels = resolveAnchorSelectors('settings.openTrigger');
      let cur = target;
      for (let d = 0; cur && d < 6; d++) {
        if (isHostOwnedElement(cur)) return false;
        for (const sel of sels) {
          try {
            if (typeof cur.matches === 'function' && cur.matches(sel)) return true;
          } catch {}
        }
        if (cur.getAttribute?.('data-testid') === 'settings-button') return true;
        cur = cur.parentElement || null;
      }
      return false;
    }

    const onCaptureClick = (ev) => {
      if (isSettingsOpenTriggerTarget(ev?.target)) {
        scheduleNativeSettingsSync();
      }
    };

    let lastHandledEscEvent = null;

    const onCaptureKeyDown = (e) => {
      if (e?.key !== 'Escape') return;
      if (state.recordingShortcutKey) {
        lastHandledEscEvent = e;
        state.recordingShortcutKey = null;
        for (const rootContainer of [shadow, nativeState.mountShadow]) {
          const activeInp = rootContainer?.querySelector?.('[data-shortcut-input][data-recording="true"]');
          if (activeInp) {
            activeInp.removeAttribute?.('data-recording');
            activeInp.placeholder = '未设置（点击录入）';
            activeInp.blur?.();
          }
        }
        e.preventDefault?.();
        e.stopPropagation?.();
        e.stopImmediatePropagation?.();
        return;
      }
      if (state.fieldModal) {
        lastHandledEscEvent = e;
        closeFieldModal(false);
        e.preventDefault?.();
        e.stopPropagation?.();
        e.stopImmediatePropagation?.();
      }
    };

    const onKeyDown = (e) => {
      if (e?.key === 'Escape') {
        if (e === lastHandledEscEvent) return;
        if (state.recordingShortcutKey) {
          state.recordingShortcutKey = null;
          return;
        }
        if (state.fieldModal) {
          closeFieldModal(false);
          return;
        }
        if (state.openComboboxKey) {
          state.openComboboxKey = null;
          if (state.settingsMode !== 'closed') renderSettingsBody();
          return;
        }
        if (state.settingsMode === 'modal') {
          closeSettings();
        }
        closeAllPopovers(null);
        return;
      }
      if ((e?.metaKey || e?.ctrlKey) && e?.key === ',') {
        scheduleNativeSettingsSync();
      }
    };
    const onOutsideMouseDown = (ev) => {
      if (state.openComboboxKey) {
        const path = typeof ev?.composedPath === 'function' ? ev.composedPath() : null;
        const insideCombo = Array.isArray(path) && path.some((n) => n?.classList?.contains?.('ag-combobox-wrap') || (typeof n?.getAttribute === 'function' && n.getAttribute('data-combobox')));
        if (!insideCombo) {
          state.openComboboxKey = null;
          if (state.settingsMode !== 'closed') renderSettingsBody();
        }
      }
      const hasOpenPopover = (overflowMenuEl && !overflowMenuEl.hidden)
        || (pluginAlertPopoverEl && !pluginAlertPopoverEl.hidden)
        || Array.from(state.popovers.values()).some((p) => p.node && !p.node.hidden);
      if (!hasOpenPopover || !hostEl) return;
      const path = typeof ev?.composedPath === 'function' ? ev.composedPath() : null;
      if (path && path.includes(hostEl)) return;
      if (typeof hostEl.contains === 'function' && hostEl.contains(ev?.target)) return;
      if (browserOccluderEl && (ev?.target === browserOccluderEl || (path && path.includes(browserOccluderEl)))) return;
      closeAllPopovers('__settings__');
    };
    if (doc?.addEventListener) {
      doc.addEventListener('click', onCaptureClick, true);
      doc.addEventListener('keydown', onCaptureKeyDown, true);
      doc.addEventListener('keydown', onKeyDown);
      doc.addEventListener('mousedown', onOutsideMouseDown);
    }
    if (win?.addEventListener) {
      occluderWindowResizeHandler = () => {
        if (state.disposed) return;
        if (state.auxSidebarExpanded) {
          syncAuxSidebarLayoutMetrics();
        }
        if (getActiveElevatedPanelEl()) {
          syncBrowserOccluder(false);
        }
        clampSafeModePillPosition();
      };
      win.addEventListener('resize', occluderWindowResizeHandler);
    }

    const api = {
      version: HOST_VERSION,
      configure(nextOpts = {}) {
        if (nextOpts.anchorsRegistry) state.anchorsRegistry = nextOpts.anchorsRegistry;
        if (nextOpts.healthTargetId !== undefined) state.healthTargetId = String(nextOpts.healthTargetId || '');
        if (nextOpts.healthReportId !== undefined) state.healthReportId = String(nextOpts.healthReportId || '');
        if (isPlainObject(nextOpts.healthAnchors)) state.healthAnchors = nextOpts.healthAnchors;
        if (nextOpts.bridgePort !== undefined) state.bridgePort = Number(nextOpts.bridgePort || 0);
        if (nextOpts.hostToken !== undefined) hostToken = String(nextOpts.hostToken || '');
        if (nextOpts.antigravityVersion) state.antigravityVersion = nextOpts.antigravityVersion;
        if (nextOpts.locale) state.locale = nextOpts.locale;
        if (isPlainObject(nextOpts.hostSettings)) {
          const hs = nextOpts.hostSettings;
          if (hs.themeMode) { state.themeMode = hs.themeMode; state.hostSettings.themeMode = hs.themeMode; }
          if (hs.heatPreset) { state.heatPreset = hs.heatPreset; state.hostSettings.heatPreset = hs.heatPreset; }
          if (isPlainObject(hs.customColors)) { state.customColors = { ...hs.customColors }; state.hostSettings.customColors = { ...hs.customColors }; }
          if (isPlainObject(hs.topbarPins)) state.hostSettings.topbarPins = { ...hs.topbarPins };
          if (Array.isArray(hs.topbarOrder)) state.hostSettings.topbarOrder = [...hs.topbarOrder];
          if (Number(hs.maxVisibleUnits) >= 1) state.hostSettings.maxVisibleUnits = Math.floor(Number(hs.maxVisibleUnits));
          if (typeof hs.showTopbarEntry === 'boolean') state.hostSettings.showTopbarEntry = hs.showTopbarEntry;
          if (typeof hs.injectNativeSettings === 'boolean') state.hostSettings.injectNativeSettings = hs.injectNativeSettings;
          if (typeof hs.autoSyncNativeOnInstall === 'boolean') state.hostSettings.autoSyncNativeOnInstall = hs.autoSyncNativeOnInstall;
          if (typeof hs.hideTrayIcon === 'boolean') state.hostSettings.hideTrayIcon = hs.hideTrayIcon;
          syncTopbarEntryVisibility();
          syncNativeSettingsIntegration();
          renderUnits();
          applyThemeVars();
        }
        if (nextOpts.pluginMeta) {
          ingestPluginMetaMap(nextOpts.pluginMeta);
          renderPluginAlertCapsule();
          renderUnits();
        }
        if (nextOpts.themeMode || nextOpts.heatPreset) {
          if (nextOpts.themeMode) { state.themeMode = nextOpts.themeMode; state.hostSettings.themeMode = nextOpts.themeMode; }
          if (nextOpts.heatPreset) { state.heatPreset = nextOpts.heatPreset; state.hostSettings.heatPreset = nextOpts.heatPreset; }
          applyThemeVars(nextOpts.accent || DEFAULT_ACCENT);
        }
        evaluateSafeMode();
        startRuntimeHealthReporting();
        scheduleRuntimeHealthReport();
        if (state.settingsMode !== 'closed') {
          renderSettingsView();
        }
      },
      queryAnchor,
      queryAnchorAll,
      probeHealthAnchors: (reg) => probeHealthAnchors(reg),
      getSafeModeState: () => ({
        ...state.safeMode,
        pillVisible: Boolean(safeModePillHostEl && !safeModePillHostEl.hidden),
        pillPosition: state.safeModePillPos ? { ...state.safeModePillPos } : null
      }),
      openSafeModeDiagnostics,
      reportRuntimeHealth: (opts) => reportRuntimeHealth({ force: true, ...(opts || {}) }),
      fetchHostHealth: (opts) => fetchHostHealth(opts),
      mountPlugin,
      disposePlugin,
      openSettings,
      closeSettings,
      toggleSettingsPanel,
      syncNativeSettings: () => {
        const res = syncNativeSettingsIntegration();
        evaluateSafeMode();
        scheduleRuntimeHealthReport();
        return res;
      },
      syncAuxSidebar: () => syncAuxSidebarState(),
      isAuxSidebarExpanded: () => Boolean(state.auxSidebarExpanded),
      getSettingsMode: () => state.settingsMode,
      getHostSettings: getHostSettingsSnapshot,
      updateHostSettings(patch = {}) {
        const res = persistHostSettings(patch);
        syncTopbarEntryVisibility();
        syncNativeSettingsIntegration();
        applyThemeVars();
        renderUnits();
        evaluateSafeMode();
        if (state.settingsMode !== 'closed') renderSettingsBody();
        return res;
      },
      getPluginSettings,
      notifyPluginSettingsChanged,
      getPluginUsageStats,
      getMetrics: (id) => (id ? getMetric(id) : Object.fromEntries(state.metrics.entries())),
      setTheme(mode, accent = DEFAULT_ACCENT, heatPreset) {
        const patch = {};
        if (mode) { state.themeMode = mode; state.hostSettings.themeMode = mode; patch.themeMode = mode; }
        if (heatPreset) { state.heatPreset = heatPreset; state.hostSettings.heatPreset = heatPreset; patch.heatPreset = heatPreset; }
        if (Object.keys(patch).length > 0 && hasBridgeAvailable()) {
          void persistHostSettings(patch);
        }
        return applyThemeVars(accent);
      },
      setUpdateInfo(info = {}) {
        state.updateInfo = {
          hasUpdate: Boolean(info.hasUpdate),
          currentVersion: info.currentVersion || HOST_VERSION,
          latestVersion: info.latestVersion || HOST_VERSION
        };
        const dot = shadow?.querySelector ? shadow.querySelector('#agy-update-dot') : null;
        if (dot) setHidden(dot, !state.updateInfo.hasUpdate);
        if (state.auxSidebarExpanded) {
          renderUnits();
        }
        if (state.settingsMode !== 'closed' && state.activeSettingsTab === 'appearance') {
          renderSettingsBody();
        }
        return { ...state.updateInfo };
      },
      reEnablePlugin(pluginId) {
        state.crashCounts.delete(pluginId);
        state.rendererErrors.delete(pluginId);
        const m = getMetric(pluginId);
        m.crashes = 0;
        renderPluginAlertCapsule();
        renderUnits();
        evaluateSafeMode();
        scheduleRuntimeHealthReport();
        return { ok: true, pluginId };
      },
      syncPluginStates(metaInput) {
        if (metaInput) {
          ingestPluginMetaMap(metaInput);
        }
        if (isPlainObject(metaInput)) {
          for (const [id, meta] of Object.entries(metaInput)) {
            if (meta?.active && !meta?.health?.lastError && !meta?.health?.circuitOpen) {
              state.rendererErrors.delete(id);
            }
          }
          if (state.managePlugins.length > 0) {
            const byId = new Map(state.managePlugins.map((p) => [p.id, p]));
            for (const [id] of Object.entries(metaInput)) {
              const latest = state.pluginMeta.get(id);
              if (latest) {
                const prev = byId.get(id) || {};
                byId.set(id, { ...prev, ...latest });
              }
            }
            state.managePlugins = Array.from(byId.values());
          }
        }
        renderPluginAlertCapsule();
        renderUnits();
        evaluateSafeMode();
        scheduleRuntimeHealthReport();
        if (state.settingsMode !== 'closed') {
          renderSettingsBody();
        }
        return { ok: true, unusableCount: getUnusablePlugins().length };
      },
      async dispose() {
        if (state.disposed) return;
        state.disposed = true;
        dispatchLifecycleEvent({ type: 'host.dispose', nonce: state.xworldNonce });
        resetDragReorderState();
        detachSafeModePillDragListeners();
        if (suppressSafeModeClickTimer) {
          clearTimeout(suppressSafeModeClickTimer);
          suppressSafeModeClickTimer = null;
        }
        if (runtimeHealthTimer) {
          clearInterval(runtimeHealthTimer);
          runtimeHealthTimer = null;
        }
        if (runtimeHealthDebounceTimer) {
          clearTimeout(runtimeHealthDebounceTimer);
          runtimeHealthDebounceTimer = null;
        }
        state.pendingFlipReorder = null;
        for (const tid of hostRetryTimers) clearTimeout(tid);
        hostRetryTimers.clear();
        state.rendererErrors.clear();
        state.isolatedPlugins.clear();
        teardownNativeSettingsMount();
        for (const id of Array.from(state.pluginInstances.keys())) {
          await disposePlugin(id);
        }
        for (const [k, rec] of Array.from(state.pluginStyles.entries())) {
          state.pluginStyles.delete(k);
          rec.node?.remove?.();
        }
        for (const [invId, inv] of Array.from(state.pendingServiceInvokes.entries())) {
          state.pendingServiceInvokes.delete(invId);
          clearTimeout(inv.timer);
          inv.reject(new Error('Host disposed'));
        }
        if (sharedObserver) {
          try { sharedObserver.disconnect(); } catch {}
          sharedObserver = null;
        }
        if (auxSidebarObserver) {
          try { auxSidebarObserver.disconnect(); } catch {}
          auxSidebarObserver = null;
        }
        if (rightOverlayResizeObserver) {
          try { rightOverlayResizeObserver.disconnect(); } catch {}
          rightOverlayResizeObserver = null;
          rightOverlayObservedEl = null;
        }
        doc?.documentElement?.removeAttribute?.('data-agy-aux-compact');
        doc?.documentElement?.style?.removeProperty?.('--agy-aux-strip-pr');
        if (themeObserver) {
          try { themeObserver.disconnect(); } catch {}
          themeObserver = null;
        }
        if (typeof removeMediaListener === 'function') {
          try { removeMediaListener(); } catch {}
          removeMediaListener = null;
        }
        if (occluderResizeObserver) {
          try { occluderResizeObserver.disconnect(); } catch {}
          occluderResizeObserver = null;
          occluderObservedEl = null;
        }
        if (occluderWindowResizeHandler && win?.removeEventListener) {
          try { win.removeEventListener('resize', occluderWindowResizeHandler); } catch {}
          occluderWindowResizeHandler = null;
        }
        if (portalOverlayClaimed) {
          portalOverlayClaimed = false;
          if (!hasExternalDialogOpen() && typeof win?.electronNative?.wcvBrowser?.setPortalOverlayOpen === 'function') {
            try {
              Promise.resolve(win.electronNative.wcvBrowser.setPortalOverlayOpen(false)).catch(() => {});
            } catch {}
          }
        }
        if (browserOccluderEl?.remove) browserOccluderEl.remove();
        browserOccluderEl = null;
        if (doc?.removeEventListener) {
          doc.removeEventListener('click', onCaptureClick, true);
          doc.removeEventListener('keydown', onCaptureKeyDown, true);
          doc.removeEventListener('keydown', onKeyDown);
          doc.removeEventListener('mousedown', onOutsideMouseDown);
          doc.removeEventListener(xworldChannelName, handleCrossWorldRequest);
        }
        closeFieldModal(false);
        state.recordingShortcutKey = null;
        if (lightDomStyleEl?.remove) lightDomStyleEl.remove();
        lightDomStyleEl = null;
        if (safeModePillHostEl?.remove) safeModePillHostEl.remove();
        safeModePillHostEl = null;
        safeModePillShadow = null;
        safeModePillBtnEl = null;
        if (hostEl?.remove) hostEl.remove();
        hostEl = null;
        shadow = null;
      }
    };

    if (win) {
      win.__AGYDaddyHost = api;
    }

    if (getUnusablePlugins().length > 0 && doc && typeof doc.createElement === 'function') {
      ensureDomShell();
      renderPluginAlertCapsule();
      renderUnits();
    }

    if (doc && typeof doc.createElement === 'function') {
      ensureSharedObserver();
      evaluateSafeMode();
    }
    startRuntimeHealthReporting();

    if (isPlainObject(mergedOpts.initialView) && mergedOpts.initialView.open) {
      const iv = mergedOpts.initialView;
      if (typeof iv.diagnosticsExpanded === 'boolean') {
        state.diagnosticsExpanded = iv.diagnosticsExpanded;
      }
      if (isPlainObject(iv.toast) && iv.toast.text) {
        state.manageToast = {
          tone: iv.toast.tone || 'info',
          spinning: false,
          text: String(iv.toast.text)
        };
      }
      const restoreTid = setTimeout(() => {
        hostRetryTimers.delete(restoreTid);
        if (!state.disposed) {
          void openSettings({ tab: iv.tab || 'plugins' });
        }
      }, 0);
      hostRetryTimers.add(restoreTid);
    }

    return api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createHostRuntime };
  } else {
    createHostRuntime();
  }
})(globalThis);
