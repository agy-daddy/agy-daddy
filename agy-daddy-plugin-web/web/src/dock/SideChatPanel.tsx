import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { apiClient } from '../api/client';
import { useI18n } from '../i18n';
import type { ModelItem, SideChatContextScope, SideChatSelectionContext } from '../types';
import styles from './SideChatPanel.module.css';

interface SideChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  error?: string | null;
}

export interface SideChatPanelProps {
  activeSessionId?: string | null;
  models: ModelItem[];
  activeModelId?: string | null;
  channel?: string;
  permissionLevel?: string;
  activeSelectionContext?: SideChatSelectionContext | null;
  onInsertToComposer?: (text: string) => void;
}

export function SideChatPanel({
  activeSessionId,
  models,
  activeModelId,
  channel = 'loopback',
  permissionLevel = 'L2',
  activeSelectionContext = null,
  onInsertToComposer,
}: SideChatPanelProps) {
  const { t } = useI18n();
  const bucketKey = activeSessionId || '__global__';
  const isL0Locked = channel !== 'loopback' && permissionLevel === 'L0';

  const [threadsByBucket, setThreadsByBucket] = useState<Record<string, SideChatMessage[]>>({});
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [contextScope, setContextScope] = useState<SideChatContextScope>('session_summary');
  const [prompt, setPrompt] = useState('');
  const [streamingReqId, setStreamingReqId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [insertedId, setInsertedId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const activeReqRef = useRef<string | null>(null);

  const messages = threadsByBucket[bucketKey] || [];
  const selectableModels = useMemo(() => models.filter((m) => !m.disabled), [models]);

  useEffect(() => {
    setConfirmClear(false);
    setErrorMsg(null);
  }, [bucketKey]);

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    [],
  );

  const updateBucketMessages = (
    targetBucket: string,
    updater: (prev: SideChatMessage[]) => SideChatMessage[],
  ) => {
    setThreadsByBucket((prev) => ({
      ...prev,
      [targetBucket]: updater(prev[targetBucket] || []),
    }));
  };

  const handleSend = () => {
    const trimmed = prompt.trim();
    if (!trimmed || streamingReqId || isL0Locked) return;

    const targetBucket = bucketKey;
    const historyPayload = messages
      .filter((m) => !m.error && m.text.trim())
      .map((m) => ({ role: m.role, content: m.text }));

    const userMsgId = `u-${Date.now()}`;
    const assistantMsgId = `a-${Date.now() + 1}`;
    const localReqId = `side-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    activeReqRef.current = localReqId;

    setErrorMsg(null);
    setPrompt('');
    setStreamingReqId(localReqId);

    updateBucketMessages(targetBucket, (prev) => [
      ...prev,
      { id: userMsgId, role: 'user', text: trimmed },
      { id: assistantMsgId, role: 'assistant', text: '', streaming: true },
    ]);

    void apiClient
      .streamSideChatCompletion(
        {
          prompt: trimmed,
          model: selectedModel || activeModelId || undefined,
          contextScope,
          sessionId: activeSessionId || null,
          selectionContext: contextScope === 'active_selection' ? activeSelectionContext : null,
          history: historyPayload,
        },
        {
          signal: controller.signal,
          onMeta: (meta) => {
            if (meta.requestId) {
              activeReqRef.current = meta.requestId;
              setStreamingReqId(meta.requestId);
            }
          },
          onDelta: (evt) => {
            updateBucketMessages(targetBucket, (prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, text: `${m.text}${evt.delta || ''}` } : m,
              ),
            );
          },
          onDone: (evt) => {
            abortControllerRef.current = null;
            activeReqRef.current = null;
            setStreamingReqId(null);
            updateBucketMessages(targetBucket, (prev) =>
              prev.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, text: evt.text || m.text, streaming: false }
                  : m,
              ),
            );
          },
          onError: (evt) => {
            abortControllerRef.current = null;
            activeReqRef.current = null;
            setStreamingReqId(null);
            setErrorMsg(evt.message);
            updateBucketMessages(targetBucket, (prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, streaming: false, error: evt.message } : m,
              ),
            );
          },
        },
      )
      .catch((err) => {
        if (controller.signal.aborted) return;
        abortControllerRef.current = null;
        activeReqRef.current = null;
        setStreamingReqId(null);
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(msg);
        updateBucketMessages(targetBucket, (prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, streaming: false, error: msg } : m,
          ),
        );
      });
  };

  const handleStop = () => {
    const reqId = activeReqRef.current || streamingReqId;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    activeReqRef.current = null;
    setStreamingReqId(null);
    updateBucketMessages(bucketKey, (prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    );
    if (reqId) {
      void apiClient.cancelSideChat(reqId).catch(() => {});
    }
  };

  const handleKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={styles.root} data-testid="side-chat-panel">
      <div className={styles.header}>
        <span className={styles.isolationBadge} data-testid="side-chat-isolation-badge">
          {t('sideChat.isolationBadge')}
        </span>

        {messages.length > 0 && (
          <button
            type="button"
            className={`${styles.btn} ${confirmClear ? styles.btnDanger : ''}`}
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                return;
              }
              setConfirmClear(false);
              setThreadsByBucket((prev) => ({ ...prev, [bucketKey]: [] }));
            }}
            data-testid="side-chat-clear-btn"
          >
            {confirmClear ? t('sideChat.clearConfirm') : t('sideChat.clear')}
          </button>
        )}
      </div>

      <div className={styles.controls}>
        <select
          className={styles.select}
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          aria-label={t('models.selectModel')}
          data-testid="side-chat-model-select"
        >
          <option value="">{t('sideChat.modelAuto')}</option>
          {selectableModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName || m.label || m.id}
            </option>
          ))}
        </select>

        <select
          className={styles.select}
          value={contextScope}
          onChange={(e) => setContextScope(e.target.value as SideChatContextScope)}
          aria-label={t('sideChat.scopeLabel')}
          data-testid="side-chat-scope-select"
        >
          <option value="none">{t('sideChat.scopeNone')}</option>
          <option value="session_summary">{t('sideChat.scopeSession')}</option>
          <option value="active_selection">{t('sideChat.scopeSelection')}</option>
        </select>
      </div>

      {isL0Locked && (
        <div className={styles.noticeBanner} role="alert" data-testid="side-chat-l0-banner">
          {t('sideChat.l0ReadOnly')}
        </div>
      )}

      {errorMsg && (
        <div className={styles.noticeBanner} role="alert" data-testid="side-chat-error">
          {errorMsg}
        </div>
      )}

      <div className={styles.messages} data-testid="side-chat-messages">
        {messages.length === 0 ? (
          <div className={styles.emptyCard}>
            <h4 className={styles.emptyTitle}>{t('sideChat.emptyTitle')}</h4>
            <p className={styles.emptyDesc}>{t('sideChat.emptyDesc')}</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`${styles.msgCard} ${msg.role === 'user' ? styles.msgUser : ''}`}
              data-testid={`side-chat-msg-${msg.role}`}
            >
              <pre className={styles.msgBody}>{msg.text || (msg.streaming ? '…' : '')}</pre>
              {msg.role === 'assistant' && !msg.streaming && msg.text && (
                <div className={styles.msgActions}>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => {
                      void apiClient.copyTextWithFallback(msg.text);
                      setCopiedId(msg.id);
                      setTimeout(() => setCopiedId((c) => (c === msg.id ? null : c)), 1500);
                    }}
                    data-testid={`side-chat-copy-${msg.id}`}
                  >
                    {copiedId === msg.id ? t('sideChat.copied') : t('sideChat.copy')}
                  </button>
                  {onInsertToComposer && (
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() => {
                        onInsertToComposer(msg.text);
                        setInsertedId(msg.id);
                        setTimeout(() => setInsertedId((c) => (c === msg.id ? null : c)), 2000);
                      }}
                      data-testid="side-chat-insert-btn"
                    >
                      {t('sideChat.insertToComposer')}
                    </button>
                  )}
                  {insertedId === msg.id && (
                    <span className={styles.insertedTag}>{t('sideChat.insertedNotice')}</span>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className={styles.composerBox}>
        <textarea
          className={styles.textarea}
          placeholder={t('sideChat.placeholder')}
          value={prompt}
          disabled={isL0Locked}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          data-testid="side-chat-input"
        />
        <div className={styles.composerFooter}>
          {streamingReqId ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              onClick={handleStop}
              data-testid="side-chat-stop-btn"
            >
              {t('sideChat.stop')}
            </button>
          ) : (
            <button
              type="button"
              className={styles.sendBtn}
              disabled={!prompt.trim() || isL0Locked}
              onClick={handleSend}
              data-testid="side-chat-send-btn"
            >
              {t('sideChat.send')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
