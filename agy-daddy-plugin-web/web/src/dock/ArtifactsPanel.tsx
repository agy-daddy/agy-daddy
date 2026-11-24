import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../api/client';
import { useI18n } from '../i18n';
import type {
  ArtifactItem,
  ArtifactPreviewerDescriptor,
  ArtifactReadResponse,
  PluginArtifactPreviewResponse,
} from '../types';
import { resolveArtifactPreviewer } from './artifactPreviewers';
import { formatBytes, formatDockError, formatTimestamp } from './dockUtils';
import styles from './ArtifactsPanel.module.css';

export interface ArtifactsPanelProps {
  sessionId?: string | null;
  refreshKey?: number | string;
}

export function ArtifactsPanel({ sessionId, refreshKey }: ArtifactsPanelProps) {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [hostPlugins, setHostPlugins] = useState<ArtifactPreviewerDescriptor[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');
  const [zoom, setZoom] = useState<number>(1);

  const [preview, setPreview] = useState<ArtifactReadResponse | null>(null);
  const [pluginPayload, setPluginPayload] = useState<PluginArtifactPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const listAbortRef = useRef<AbortController | null>(null);
  const readAbortRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const previewLoadedKeyRef = useRef<string | null>(null);
  const pluginLoadedKeyRef = useRef<string | null>(null);

  // Discover host-registered artifact previewer plugins on mount (soft-ignore errors)
  useEffect(() => {
    if (typeof apiClient.listArtifactPreviewers !== 'function') return;
    const controller = new AbortController();
    apiClient
      .listArtifactPreviewers(controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setHostPlugins(Array.isArray(res?.plugins) ? res.plugins : []);
      })
      .catch(() => {
        // Built-in previewers remain active when host previewer discovery is unavailable.
      });
    return () => controller.abort();
  }, []);

  const selectItem = useCallback((itemKey: string) => {
    readAbortRef.current?.abort();
    previewLoadedKeyRef.current = null;
    pluginLoadedKeyRef.current = null;
    setSelectedName(itemKey);
    setViewMode('preview');
    setZoom(1);
    setPreview(null);
    setPluginPayload(null);
    setPreviewError(null);
    setPreviewLoading(false);
    setCopied(false);
  }, []);

  const loadList = useCallback(async () => {
    listAbortRef.current?.abort();
    readAbortRef.current?.abort();

    if (!sessionId) {
      previewLoadedKeyRef.current = null;
      pluginLoadedKeyRef.current = null;
      setItems([]);
      setSelectedName(null);
      setViewMode('preview');
      setZoom(1);
      setPreview(null);
      setPluginPayload(null);
      setListError(null);
      setPreviewError(null);
      setListLoading(false);
      setPreviewLoading(false);
      return;
    }

    const controller = new AbortController();
    listAbortRef.current = controller;
    setListLoading(true);
    setListError(null);

    try {
      const res = await apiClient.listArtifacts(sessionId, controller.signal);
      if (controller.signal.aborted) return;
      const nextItems = res.items || [];
      setItems(nextItems);

      if (nextItems.length === 0) {
        previewLoadedKeyRef.current = null;
        pluginLoadedKeyRef.current = null;
        setSelectedName(null);
        setPreview(null);
        setPluginPayload(null);
        setPreviewError(null);
      } else {
        setSelectedName((prev) => {
          const keep = prev && nextItems.some((it) => (it.path || it.name) === prev);
          const nextTarget = keep ? prev : nextItems[0].path || nextItems[0].name;
          if (nextTarget !== prev) {
            previewLoadedKeyRef.current = null;
            pluginLoadedKeyRef.current = null;
            setViewMode('preview');
            setZoom(1);
            setPreview(null);
            setPluginPayload(null);
            setPreviewError(null);
            setCopied(false);
          }
          return nextTarget;
        });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setItems([]);
      setListError(formatDockError(err, t('dockErr.requestFailed'), t));
    } finally {
      if (!controller.signal.aborted) {
        setListLoading(false);
      }
    }
  }, [sessionId, t]);

  useEffect(() => {
    previewLoadedKeyRef.current = null;
    pluginLoadedKeyRef.current = null;
    setSelectedName(null);
    setViewMode('preview');
    setZoom(1);
    setPreview(null);
    setPluginPayload(null);
    setPreviewError(null);
    void loadList();
    return () => {
      listAbortRef.current?.abort();
      readAbortRef.current?.abort();
    };
  }, [loadList, refreshKey]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const selectedItem = useMemo(
    () => items.find((it) => (it.path || it.name) === selectedName) ?? null,
    [items, selectedName],
  );

  const selectedItemPath = selectedItem ? selectedItem.path || selectedItem.name : null;

  const activePreviewer = useMemo(
    () => (selectedItem ? resolveArtifactPreviewer(selectedItem, hostPlugins) : null),
    [selectedItem, hostPlugins],
  );

  const rawUrl = useMemo(
    () =>
      sessionId && selectedItemPath
        ? apiClient.getArtifactRawUrl(sessionId, selectedItemPath)
        : '',
    [sessionId, selectedItemPath],
  );

  // Load artifact content only when the active previewer (or Raw toggle) requires text or plugin rendering.
  useEffect(() => {
    readAbortRef.current?.abort();

    if (!sessionId || !selectedItem || !selectedItemPath || !activePreviewer) {
      setPreviewLoading(false);
      return;
    }

    const needsPluginRender =
      activePreviewer.source === 'plugin' &&
      (activePreviewer.renderKind === 'plugin_html' ||
        activePreviewer.renderKind === 'plugin_markdown' ||
        (activePreviewer.renderKind === 'plugin_iframe' && !activePreviewer.iframeUrlTemplate));

    if (needsPluginRender) {
      const pluginKey = `${sessionId}:${selectedItemPath}:${activePreviewer.id}:${reloadNonce}`;
      if (pluginLoadedKeyRef.current === pluginKey && pluginPayload) {
        setPreviewLoading(false);
        return;
      }

      const controller = new AbortController();
      readAbortRef.current = controller;
      setPreviewLoading(true);
      setPreviewError(null);

      apiClient
        .renderPluginArtifactPreview(sessionId, {
          pluginId: activePreviewer.pluginId || activePreviewer.id,
          file: selectedItemPath,
          mime: selectedItem.mime,
        })
        .then((res) => {
          if (controller.signal.aborted) return;
          pluginLoadedKeyRef.current = pluginKey;
          setPluginPayload(res);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setPluginPayload(null);
          setPreviewError(formatDockError(err, t('dockErr.requestFailed'), t));
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setPreviewLoading(false);
          }
        });

      return () => controller.abort();
    }

    const needsTextRead =
      activePreviewer.requiresTextContent ||
      (viewMode === 'raw' && Boolean(activePreviewer.supportsRawToggle));

    if (!needsTextRead) {
      setPreviewLoading(false);
      setPreviewError(null);
      return;
    }

    const readKey = `${sessionId}:${selectedItemPath}:${reloadNonce}`;
    if (previewLoadedKeyRef.current === readKey && preview) {
      setPreviewLoading(false);
      return;
    }

    const controller = new AbortController();
    readAbortRef.current = controller;
    setPreviewLoading(true);
    setPreviewError(null);

    apiClient
      .readArtifact(sessionId, selectedItemPath, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        previewLoadedKeyRef.current = readKey;
        setPreview(res);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setPreview(null);
        setPreviewError(formatDockError(err, t('dockErr.requestFailed'), t));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setPreviewLoading(false);
        }
      });

    return () => controller.abort();
  }, [
    sessionId,
    selectedItem,
    selectedItemPath,
    activePreviewer,
    viewMode,
    reloadNonce,
    t,
    preview,
    pluginPayload,
  ]);

  const copyableText = preview?.content ?? pluginPayload?.content ?? null;

  const handleCopy = async () => {
    if (!copyableText || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(copyableText);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard write may be denied in non-secure contexts; ignore silently.
    }
  };

  const handleRetryPreview = () => {
    previewLoadedKeyRef.current = null;
    pluginLoadedKeyRef.current = null;
    setPreview(null);
    setPluginPayload(null);
    setPreviewError(null);
    setReloadNonce((n) => n + 1);
  };

  if (!sessionId) {
    return (
      <div className={styles.emptyState} data-testid="artifacts-no-session">
        <div className={styles.emptyTitle}>{t('artifacts.noSessionTitle')}</div>
        <div className={styles.emptyDesc}>{t('artifacts.noSessionDesc')}</div>
      </div>
    );
  }

  const showRawToggle = Boolean(activePreviewer?.supportsRawToggle);
  const showZoomControls = Boolean(
    activePreviewer &&
      (activePreviewer.id === 'builtin.image' || activePreviewer.id === 'builtin.svg') &&
      viewMode === 'preview',
  );
  const isWaitingForText = Boolean(
    activePreviewer &&
      (activePreviewer.requiresTextContent || (viewMode === 'raw' && activePreviewer.supportsRawToggle)) &&
      !preview,
  );

  return (
    <div className={styles.panel} data-testid="artifacts-panel">
      <header className={styles.header}>
        <span className={styles.headerTitle}>
          {t('artifacts.headerTitle')} <span className={styles.countBadge}>{items.length}</span>
        </span>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={() => void loadList()}
          disabled={listLoading}
          data-testid="artifacts-refresh-btn"
        >
          {listLoading ? t('common.refreshing') : t('common.refresh')}
        </button>
      </header>

      {listError && (
        <div className={styles.errorBanner} role="alert" data-testid="artifacts-list-error">
          <span>{listError}</span>
          <button type="button" className={styles.retryBtn} onClick={() => void loadList()}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {!listError && listLoading && items.length === 0 ? (
        <div className={styles.mutedPlaceholder}>{t('artifacts.loadingList')}</div>
      ) : null}

      {!listError && !listLoading && items.length === 0 ? (
        <div className={styles.emptyState} data-testid="artifacts-empty-state">
          <div className={styles.emptyTitle}>{t('artifacts.emptyTitle')}</div>
          <div className={styles.emptyDesc}>{t('artifacts.emptyDesc')}</div>
        </div>
      ) : null}

      {items.length > 0 && (
        <div className={styles.contentSplit}>
          <div className={styles.itemsList} data-testid="artifacts-list">
            {items.map((item) => {
              const itemKey = item.path || item.name;
              const active = selectedName === itemKey;
              return (
                <button
                  key={itemKey}
                  type="button"
                  className={`${styles.itemRow} ${active ? styles.itemRowActive : ''}`}
                  onClick={() => selectItem(itemKey)}
                  title={itemKey}
                  data-testid={`artifact-item-${item.name}`}
                >
                  <div className={styles.itemMain}>
                    <span className={styles.itemName}>{item.name}</span>
                    <span className={styles.itemMime}>{item.mime}</span>
                  </div>
                  <div className={styles.itemSub}>
                    <span>{formatBytes(item.size)}</span>
                    {item.modifiedAt && <span>{formatTimestamp(item.modifiedAt, locale)}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          <div className={styles.previewSection} data-testid="artifacts-preview">
            {selectedItem && (
              <div className={styles.previewHeader}>
                <div className={styles.previewTitleWrap}>
                  <span className={styles.previewName}>{preview?.name || selectedItem.name}</span>
                  <span className={styles.previewMeta}>
                    {preview?.mime || selectedItem.mime} · {formatBytes(preview?.size ?? selectedItem.size)}
                  </span>
                </div>

                <div className={styles.previewActions}>
                  {showRawToggle && (
                    <div className={styles.segmented} role="group" aria-label={t('artifacts.modePreview')}>
                      <button
                        type="button"
                        className={`${styles.segBtn} ${viewMode === 'preview' ? styles.segBtnActive : ''}`}
                        aria-pressed={viewMode === 'preview'}
                        onClick={() => setViewMode('preview')}
                        data-testid="artifact-mode-preview"
                      >
                        {t('artifacts.modePreview')}
                      </button>
                      <button
                        type="button"
                        className={`${styles.segBtn} ${viewMode === 'raw' ? styles.segBtnActive : ''}`}
                        aria-pressed={viewMode === 'raw'}
                        onClick={() => setViewMode('raw')}
                        data-testid="artifact-mode-raw"
                      >
                        {t('artifacts.modeRaw')}
                      </button>
                    </div>
                  )}

                  {showZoomControls && (
                    <div className={styles.zoomGroup}>
                      <button
                        type="button"
                        className={styles.toolbarBtn}
                        onClick={() => setZoom(0)}
                        data-testid="artifact-zoom-fit"
                      >
                        {t('artifacts.zoomFit')}
                      </button>
                      <button
                        type="button"
                        className={styles.toolbarBtn}
                        onClick={() => setZoom(1)}
                        data-testid="artifact-zoom-actual"
                      >
                        {t('artifacts.zoomActual')}
                      </button>
                      <button
                        type="button"
                        className={styles.toolbarBtn}
                        onClick={() =>
                          setZoom((z) =>
                            z <= 0 ? 0.75 : Math.max(0.25, Number((z - 0.25).toFixed(2))),
                          )
                        }
                        aria-label={t('artifacts.zoomOut')}
                        title={t('artifacts.zoomOut')}
                        data-testid="artifact-zoom-out"
                      >
                        -
                      </button>
                      <button
                        type="button"
                        className={styles.toolbarBtn}
                        onClick={() =>
                          setZoom((z) =>
                            z <= 0 ? 1.25 : Math.min(4, Number((z + 0.25).toFixed(2))),
                          )
                        }
                        aria-label={t('artifacts.zoomIn')}
                        title={t('artifacts.zoomIn')}
                        data-testid="artifact-zoom-in"
                      >
                        +
                      </button>
                    </div>
                  )}

                  {rawUrl && (
                    <a
                      href={rawUrl}
                      target="_blank"
                      rel="noreferrer"
                      download={selectedItem.name}
                      className={styles.actionLink}
                      data-testid="artifact-open-raw"
                    >
                      {t('artifacts.openRaw')}
                    </a>
                  )}

                  {copyableText && (
                    <button
                      type="button"
                      className={styles.copyBtn}
                      onClick={() => void handleCopy()}
                      data-testid="artifact-copy-btn"
                    >
                      {copied ? t('artifacts.copied') : t('artifacts.copy')}
                    </button>
                  )}
                </div>
              </div>
            )}

            {preview?.truncated && (
              <div className={styles.warningBanner} role="status" data-testid="artifact-truncated-banner">
                {t('artifacts.truncatedBanner', { size: formatBytes(preview.size) })}
              </div>
            )}

            {previewError && (
              <div className={styles.errorBanner} role="alert" data-testid="artifact-read-error">
                <span>{previewError}</span>
                {selectedItem && (
                  <button
                    type="button"
                    className={styles.retryBtn}
                    onClick={handleRetryPreview}
                  >
                    {t('common.retry')}
                  </button>
                )}
              </div>
            )}

            <div className={styles.previewBody}>
              {previewLoading ? (
                <div className={styles.mutedPlaceholder}>{t('artifacts.loadingPreview')}</div>
              ) : !previewError && selectedItem && activePreviewer && !isWaitingForText ? (
                activePreviewer.render({
                  sessionId,
                  item: selectedItem,
                  rawUrl,
                  textContent: preview?.content ?? null,
                  previewData: preview,
                  mode: viewMode,
                  zoom,
                  pluginPayload,
                  t,
                })
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
