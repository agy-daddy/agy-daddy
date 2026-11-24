import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { compressImageFile } from '../store/image';
import {
  formatCompactModelBadge,
  groupModelsForPicker,
  normalizeModelCatalog
} from '../store/modelCatalog';
import { sanitizePresets } from '../store/useRemoteStore';
import type {
  ChatMode,
  ComposerPreset,
  DispatchMode,
  ImageAttachment,
  ModelOption,
  ModelPickerGroup,
  OrchestratorMasterKey,
  OrchestratorThinkingMap,
  OrchestratorThinkingTier,
  PermissionInfo,
  PermissionLevel,
  QueuedMessage
} from '../types';
import { ModelPickerSheet } from './ModelPickerSheet';
import styles from './Composer.module.css';

export interface ComposerProps {
  text: string;
  images: ImageAttachment[];
  presets: ComposerPreset[];
  models: Array<ModelOption | string>;
  modelGroups?: ModelPickerGroup[];
  selectedModelId: string;
  orchestratorThinking?: OrchestratorThinkingMap;
  activeOrchestratorMaster?: OrchestratorMasterKey | null;
  chatMode: ChatMode;
  dispatchMode?: DispatchMode;
  permissionLevel: PermissionLevel;
  permissionInfo?: PermissionInfo | null;
  running: boolean;
  voiceSupported: boolean;
  queue?: QueuedMessage[];
  onTextChange: (next: string) => void;
  onAddImage: (img: ImageAttachment) => void;
  onRemoveImage: (id: string) => void;
  onModelChange: (modelId: string) => void;
  onSelectOrchestrator?: (
    modelId: string,
    masterKey: OrchestratorMasterKey,
    thinkingLevel: OrchestratorThinkingTier
  ) => void;
  onOpenModelPicker?: () => void;
  onChatModeChange: (mode: ChatMode) => void;
  onDispatchModeChange?: (mode: DispatchMode) => void;
  onSend: (overrideDispatch?: DispatchMode) => void;
  onCancel: () => void;
  onOptimize: () => Promise<void>;
  onRemoveQueueItem?: (id: string) => void;
}

const DEFAULT_PERM_LEVELS: Array<{
  level: PermissionLevel;
  label: string;
  description: string;
}> = [
  { level: 'L0', label: 'L0 只读', description: '仅查看对话、文件、Diff 与监控指标' },
  { level: 'L1', label: 'L1 对话与审批', description: '可发消息、排队插队、审批命令与回答提问' },
  { level: 'L2', label: 'L2 完整操作', description: '含文件写入、Git 提交推送与 PTY 终端' }
];

const TEXTAREA_MIN_HEIGHT = 66; // 3 lines default
const TEXTAREA_MAX_HEIGHT = 156;

export function Composer(props: ComposerProps) {
  const {
    text,
    images,
    presets,
    models,
    modelGroups,
    selectedModelId,
    orchestratorThinking,
    activeOrchestratorMaster,
    chatMode,
    permissionLevel,
    permissionInfo,
    running,
    voiceSupported,
    onTextChange,
    onAddImage,
    onRemoveImage,
    onModelChange,
    onSelectOrchestrator,
    onOpenModelPicker,
    onChatModeChange,
    onSend,
    onCancel,
    onOptimize
  } = props;

  const [presetsOpen, setPresetsOpen] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  const [localModelPickerOpen, setLocalModelPickerOpen] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [kbdOffset, setKbdOffset] = useState(0);
  const [isFocused, setIsFocused] = useState(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const isReadOnly = permissionLevel === 'L0';
  const safePresets = useMemo(() => sanitizePresets(presets), [presets]);
  const catalog = useMemo(() => normalizeModelCatalog(models), [models]);
  const pickerGroups = useMemo(
    () => (Array.isArray(modelGroups) && modelGroups.length > 0 ? modelGroups : groupModelsForPicker(models)),
    [modelGroups, models]
  );

  const effectiveModelId = useMemo(() => {
    if (catalog.some((m) => m.id === selectedModelId)) return selectedModelId;
    return catalog[0]?.id || '';
  }, [catalog, selectedModelId]);

  const modelBadge = useMemo(
    () =>
      formatCompactModelBadge(
        effectiveModelId,
        models,
        undefined,
        activeOrchestratorMaster
          ? { master: activeOrchestratorMaster, thinkingMap: orchestratorThinking }
          : null
      ),
    [effectiveModelId, models, activeOrchestratorMaster, orchestratorThinking]
  );

  const permDetails = permissionInfo?.levels && permissionInfo.levels.length > 0
    ? permissionInfo.levels
    : DEFAULT_PERM_LEVELS;

  // Upgrade visualViewport listener for clean iOS Safari & Android Chrome keyboard lift (zero occlusion)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const vv = window.visualViewport;

    const updateViewport = () => {
      const vvh = vv ? vv.height : window.innerHeight;
      const offsetTop = vv ? vv.offsetTop : 0;
      const rawDiff = vv ? Math.max(0, window.innerHeight - vv.height - offsetTop) : 0;
      const nextKbd = rawDiff > 40 ? Math.round(rawDiff) : 0;

      root.style.setProperty('--ag-vvh', `${Math.round(vvh)}px`);
      root.style.setProperty('--ag-kbd-offset', `${nextKbd}px`);
      setKbdOffset(nextKbd);
    };

    updateViewport();
    vv?.addEventListener('resize', updateViewport);
    vv?.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);

    return () => {
      vv?.removeEventListener('resize', updateViewport);
      vv?.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
      root.style.removeProperty('--ag-kbd-offset');
    };
  }, []);

  // Close popovers when tapping outside composer
  useEffect(() => {
    if (!presetsOpen && !permOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setPresetsOpen(false);
        setPermOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [presetsOpen, permOpen]);

  // Smooth auto-height starting from 3 lines (66px) up to 156px
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextH = Math.min(TEXTAREA_MAX_HEIGHT, Math.max(TEXTAREA_MIN_HEIGHT, el.scrollHeight));
    el.style.height = `${nextH}px`;
  }, [text]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (let i = 0; i < Math.min(files.length, 4 - images.length); i++) {
      const compressed = await compressImageFile(files[i]);
      onAddImage(compressed);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleOptimize = async () => {
    if (!text.trim() || optimizing) return;
    setOptimizing(true);
    try {
      await onOptimize();
    } finally {
      setOptimizing(false);
    }
  };

  const handleFocus = () => {
    setIsFocused(true);
    if (typeof window !== 'undefined') {
      const scrollInto = () => {
        wrapRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
      };
      requestAnimationFrame(scrollInto);
      setTimeout(scrollInto, 220);
    }
  };

  const handleOpenModelSelector = () => {
    setPresetsOpen(false);
    setPermOpen(false);
    if (onOpenModelPicker) {
      onOpenModelPicker();
    } else {
      setLocalModelPickerOpen(true);
    }
  };

  const canSend = !isReadOnly && (text.trim().length > 0 || images.length > 0);
  // Sending while running always defaults to queue; switching to Steer happens on the queued message card
  const actionLabel = running ? '入队' : '发送';

  const permToneClass =
    permissionLevel === 'L2'
      ? styles.permL2
      : permissionLevel === 'L1'
        ? styles.permL1
        : styles.permL0;

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      data-testid="composer-wrap"
      style={
        kbdOffset > 0
          ? { paddingBottom: `calc(20px + ${kbdOffset}px + env(safe-area-inset-bottom, 0px))` }
          : undefined
      }
    >
      {/* / 快捷词 + Plan 模式合并浮层 */}
      {presetsOpen && (
        <div className={styles.popover} data-testid="presets-popover">
          <button
            type="button"
            role="switch"
            aria-checked={chatMode === 'plan'}
            className={`${styles.planToggleRow} ${chatMode === 'plan' ? styles.planToggleRowActive : ''}`}
            data-testid="presets-plan-toggle"
            onClick={() => {
              if (text === '/') onTextChange('');
              onChatModeChange(chatMode === 'plan' ? 'chat' : 'plan');
              setPresetsOpen(false);
              taRef.current?.focus();
            }}
          >
            <div className={styles.planToggleText}>
              <div className={styles.planToggleTitle}>
                <span>Plan 规划模式</span>
                {chatMode === 'plan' && <span className={styles.planOnBadge}>已开启</span>}
              </div>
              <div className={styles.planToggleSub}>
                先制定方案与步骤，确认后再修改代码（唯一入口）
              </div>
            </div>
            <span
              className={`${styles.switchTrack} ${chatMode === 'plan' ? styles.switchTrackOn : ''}`}
              aria-hidden="true"
            >
              <span className={styles.switchThumb} />
            </span>
          </button>

          <div className={styles.popDivider} />
          <div className={styles.popSectionLabel}>快捷提示词</div>

          {safePresets.length === 0 ? (
            <div className={styles.popEmpty}>暂无快捷提示词预设</div>
          ) : (
            <div className={styles.presetsList}>
              {safePresets.map((p, idx) => (
                <button
                  key={p.id || idx}
                  type="button"
                  className={styles.presetItem}
                  onClick={() => {
                    const cleaned = text === '/' ? '' : text;
                    onTextChange(cleaned ? `${cleaned}\n${p.prompt}` : p.prompt);
                    setPresetsOpen(false);
                    taRef.current?.focus();
                  }}
                >
                  <div className={styles.presetLabel}>{p.label || p.prompt}</div>
                  <div className={styles.presetPrompt}>{p.prompt}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 权限说明浮层 */}
      {permOpen && (
        <div className={styles.popover} data-testid="permission-popover">
          <div className={styles.permPopHeader}>
            <span className={styles.permPopTitle}>当前访问权限 · {permissionLevel}</span>
            <button
              type="button"
              className={styles.popCloseBtn}
              aria-label="关闭权限说明"
              onClick={() => setPermOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className={styles.permList}>
            {permDetails.map((item) => {
              const active = item.level === permissionLevel;
              return (
                <div
                  key={item.level}
                  className={`${styles.permRow} ${active ? styles.permRowActive : ''}`}
                >
                  <div className={styles.permRowTop}>
                    <span className={styles.permRowLabel}>{item.label}</span>
                    {active && <span className={styles.permCurrentTag}>当前</span>}
                  </div>
                  <div className={styles.permRowDesc}>{item.description}</div>
                </div>
              );
            })}
          </div>
          <div className={styles.permFootnote}>
            安全边界：权限提升仅可在桌面主机端 Antigravity 面板操作
          </div>
        </div>
      )}

      {/* 统一圆角卡片输入框：所有操作控件均收纳在卡片内部 */}
      <div
        className={`${styles.card} ${isFocused ? styles.cardFocused : ''} ${isReadOnly ? styles.cardReadOnly : ''}`}
        data-testid="composer-card"
      >
        {/* 内部状态头：Plan 激活标签 & 图片附件缩略图 */}
        {(chatMode === 'plan' || images.length > 0) && (
          <div className={styles.cardHeader}>
            {chatMode === 'plan' && (
              <span className={styles.planChip} data-testid="composer-plan-chip">
                <span className={styles.planChipDot} />
                Plan 规划模式
                <button
                  type="button"
                  className={styles.planChipClose}
                  aria-label="退出 Plan 模式"
                  onClick={() => onChatModeChange('chat')}
                >
                  ×
                </button>
              </span>
            )}
            {images.length > 0 && (
              <div className={styles.imgStrip} data-hscroll="1">
                {images.map((img) => (
                  <div key={img.id} className={styles.thumbWrap}>
                    <img src={img.dataUrl} alt={img.name} className={styles.thumbImg} />
                    <button
                      type="button"
                      className={styles.thumbDel}
                      aria-label="移除图片"
                      onClick={() => onRemoveImage(img.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 3行高度主输入区 */}
        <textarea
          ref={taRef}
          rows={3}
          className={styles.textarea}
          data-testid="composer-textarea"
          disabled={isReadOnly}
          placeholder={
            isReadOnly
              ? 'L0 只读模式（请在桌面主机端切换至 L1/L2）'
              : running
                ? '运行中 · 输入消息自动入队，可在消息上点「立即插队」...'
                : chatMode === 'plan'
                  ? 'Plan 模式 · 描述需要规划的任务，或输入 / 快捷词...'
                  : '输入指令，或输入 / 打开快捷词与 Plan 模式...'
          }
          value={text}
          onFocus={handleFocus}
          onBlur={() => setIsFocused(false)}
          onInput={(e) => {
            const val = (e.target as HTMLTextAreaElement).value;
            onTextChange(val);
            if (val === '/') {
              setPermOpen(false);
              setPresetsOpen(true);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              if (canSend) onSend('queue');
            }
          }}
        />

        {/* 内部底部工具栏：附件 + /快捷词 + 模型选择 + 权限 + 提示词优化 + 发送/停止 */}
        <div className={styles.toolbar} data-testid="composer-toolbar">
          <div className={styles.toolLeft}>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => handleFiles((e.target as HTMLInputElement).files)}
            />
            <button
              type="button"
              className={styles.toolIconBtn}
              aria-label="上传图片"
              title="添加附件图片"
              data-testid="composer-attach-btn"
              disabled={isReadOnly}
              onClick={() => fileRef.current?.click()}
            >
              +
            </button>

            <button
              type="button"
              className={`${styles.toolChipBtn} ${presetsOpen ? styles.toolChipActive : ''}`}
              aria-label="快捷词与 Plan 模式"
              data-testid="composer-presets-btn"
              disabled={isReadOnly}
              onClick={() => {
                setPermOpen(false);
                setPresetsOpen((o) => !o);
              }}
            >
              / 快捷词
            </button>

            {catalog.length > 0 && (
              <button
                type="button"
                className={styles.modelTriggerBtn}
                aria-label="切换模型"
                data-testid="composer-model-btn"
                disabled={isReadOnly}
                onClick={handleOpenModelSelector}
                title={modelBadge.full}
              >
                <span className={styles.modelNameText}>{modelBadge.shortName}</span>
                {modelBadge.tag && (
                  <span className={styles.modelTagText}>{modelBadge.tag}</span>
                )}
                <span className={styles.modelChevron} aria-hidden="true">
                  ▾
                </span>
              </button>
            )}

            <button
              type="button"
              className={`${styles.permBtn} ${permToneClass}`}
              aria-label={`当前权限 ${permissionLevel}`}
              data-testid="composer-permission-btn"
              onClick={() => {
                setPresetsOpen(false);
                setPermOpen((o) => !o);
              }}
            >
              <span className={styles.permDot} />
              <span>{permissionLevel}</span>
            </button>
          </div>

          <div className={styles.toolRight}>
            <button
              type="button"
              className={`${styles.toolIconBtn} ${optimizing ? styles.optimizing : ''}`}
              aria-label="优化提示词"
              title="提示词优化"
              data-testid="composer-optimize-btn"
              disabled={isReadOnly || !text.trim() || optimizing}
              onClick={handleOptimize}
            >
              {optimizing ? '…' : '✦'}
            </button>

            {voiceSupported && (
              <button
                type="button"
                className={styles.toolIconBtn}
                aria-label="语音输入"
                disabled={isReadOnly}
                data-testid="voice-input-btn"
              >
                🎙
              </button>
            )}

            {running && (
              <button
                type="button"
                className={styles.stopBtn}
                onClick={onCancel}
                aria-label="停止当前生成"
                title="停止当前生成"
                data-testid="composer-stop-btn"
              >
                <span className={styles.stopSquare} aria-hidden="true" />
              </button>
            )}

            <button
              type="button"
              className={styles.sendBtn}
              disabled={!canSend}
              onClick={() => onSend('queue')}
              data-testid="composer-send-btn"
            >
              {actionLabel}
            </button>
          </div>
        </div>
      </div>

      {/* Standalone fallback sheet when Composer is rendered without a shared App-level ModelPickerSheet */}
      {!onOpenModelPicker && (
        <ModelPickerSheet
          open={localModelPickerOpen}
          models={models}
          modelGroups={pickerGroups}
          selectedModelId={effectiveModelId}
          orchestratorThinking={orchestratorThinking}
          activeOrchestratorMaster={activeOrchestratorMaster}
          disabled={isReadOnly}
          onSelectModel={onModelChange}
          onSelectOrchestrator={onSelectOrchestrator}
          onClose={() => setLocalModelPickerOpen(false)}
        />
      )}
    </div>
  );
}
