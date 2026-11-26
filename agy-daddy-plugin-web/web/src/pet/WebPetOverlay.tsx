import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPetCanvasStage, type PetCanvasStageInstance } from '../../../../agy-daddy-plugin-pet/src/shared/pet-canvas-stage.js';
import { getBuiltinThemeById } from '../../../../agy-daddy-plugin-pet/src/shared/themes.js';
import { apiClient } from '../api/client';
import { useI18n } from '../i18n';
import type { PetAttentionItem, PetSceneSpec, PetStateResponse } from '../types';
import styles from './WebPetOverlay.module.css';

export interface WebPetOverlayProps {
  petData: PetStateResponse | null;
  onSelectSession: (cascadeId: string) => void;
  onOpenSettings: () => void;
  onRefreshPet: () => void;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function WebPetOverlay({
  petData,
  onSelectSession,
  onOpenSettings,
  onRefreshPet,
}: WebPetOverlayProps) {
  const { t } = useI18n();
  const petState = petData?.state ?? null;
  const isVisible = Boolean(petData?.available && petState?.enabled && petState?.webVisible);

  const stagePx = useMemo(() => {
    const scale = clamp(Number(petState?.petScale || 1), 0.6, 2);
    return Math.round(112 * scale);
  }, [petState?.petScale]);

  const activeScene: PetSceneSpec | null = useMemo(() => {
    if (!petState) return null;
    if (petData?.scene) return petData.scene;
    return getBuiltinThemeById(petState.themeId)?.scene ?? null;
  }, [petData?.scene, petState]);

  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [roamOffsetX, setRoamOffsetX] = useState(0);
  const [flipX, setFlipX] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dismissedBubbleIds, setDismissedBubbleIds] = useState<string[]>([]);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<PetCanvasStageInstance | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const roamDirRef = useRef(1);

  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const anchorPos = useMemo(() => {
    const xr = clamp(Number(petState?.webAnchor?.xRatio ?? 0.88), 0.02, 0.95);
    const yr = clamp(Number(petState?.webAnchor?.yRatio ?? 0.82), 0.05, 0.95);
    const maxX = Math.max(16, viewport.w - stagePx - 16);
    const maxY = Math.max(48, viewport.h - stagePx - 24);
    return {
      x: clamp(Math.round(xr * viewport.w), 16, maxX),
      y: clamp(Math.round(yr * viewport.h), 48, maxY),
    };
  }, [petState?.webAnchor?.xRatio, petState?.webAnchor?.yRatio, stagePx, viewport.h, viewport.w]);

  const renderedPos = useMemo(() => {
    const base = dragPos ?? anchorPos;
    const maxX = Math.max(16, viewport.w - stagePx - 16);
    return {
      x: clamp(base.x + (dragPos ? 0 : roamOffsetX), 16, maxX),
      y: base.y,
    };
  }, [anchorPos, dragPos, roamOffsetX, stagePx, viewport.w]);

  useEffect(() => {
    if (!isVisible || !canvasRef.current || !activeScene) {
      stageRef.current?.dispose();
      stageRef.current = null;
      return;
    }
    if (!stageRef.current) {
      stageRef.current = createPetCanvasStage(canvasRef.current, {
        width: stagePx,
        height: stagePx,
        scene: activeScene,
        state: {
          animState: petState?.motion.animState ?? 'idle',
          speedFactor: petState?.motion.speedFactor ?? 1,
          flipX,
          scale: 1,
        },
      });
      stageRef.current.start();
    } else {
      stageRef.current.resize(stagePx, stagePx);
      stageRef.current.setScene(activeScene);
    }
    return () => {
      stageRef.current?.dispose();
      stageRef.current = null;
    };
    // Intentionally recreate only when visibility, dimensions, or scene identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, stagePx, activeScene?.sceneId]);

  useEffect(() => {
    if (!stageRef.current || !petState) return;
    stageRef.current.setState({
      animState: petState.motion.animState,
      speedFactor: petState.motion.speedFactor,
      flipX,
      scale: 1,
    });
  }, [flipX, petState]);

  const hasPendingApproval = Boolean(petState?.attention?.pendingApprovals?.length);
  const canRoam = Boolean(
    isVisible &&
      petState &&
      petState.roamMode !== 'none' &&
      petState.motion.roamSpeedPxPerSec > 0 &&
      !hovered &&
      !dragPos &&
      !menuOpen &&
      !hasPendingApproval,
  );

  useEffect(() => {
    if (!canRoam || !petState) return;
    let raf = 0;
    let lastTs = performance.now();
    const speed = clamp(petState.motion.roamSpeedPxPerSec, 8, 120);
    const range = Math.min(180, Math.max(48, Math.round(viewport.w * 0.14)));

    const step = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - lastTs) / 1000));
      lastTs = now;
      setRoamOffsetX((prev) => {
        const next = prev + roamDirRef.current * speed * dt;
        if (next >= range) {
          roamDirRef.current = -1;
          setFlipX(true);
          return range;
        }
        if (next <= -range) {
          roamDirRef.current = 1;
          setFlipX(false);
          return -range;
        }
        return next;
      });
      raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, [canRoam, petState, viewport.w]);

  const activeBubble: PetAttentionItem | null = useMemo(() => {
    const candidate = petState?.attention?.activeBubble ?? null;
    if (!candidate) return null;
    if (dismissedBubbleIds.includes(candidate.id)) return null;
    return candidate;
  }, [dismissedBubbleIds, petState?.attention?.activeBubble]);

  const handlePointerDown = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (ev.button !== 0) return;
      if ((ev.target as HTMLElement)?.closest('button')) return;
      ev.currentTarget.setPointerCapture?.(ev.pointerId);
      dragRef.current = {
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        origX: renderedPos.x,
        origY: renderedPos.y,
        moved: false,
      };
    },
    [renderedPos.x, renderedPos.y],
  );

  const handlePointerMove = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      const current = dragRef.current;
      if (!current || current.pointerId !== ev.pointerId) return;
      const dx = ev.clientX - current.startX;
      const dy = ev.clientY - current.startY;
      if (!current.moved && Math.hypot(dx, dy) < 5) return;
      current.moved = true;
      const maxX = Math.max(16, viewport.w - stagePx - 16);
      const maxY = Math.max(48, viewport.h - stagePx - 24);
      setDragPos({
        x: clamp(Math.round(current.origX + dx), 16, maxX),
        y: clamp(Math.round(current.origY + dy), 48, maxY),
      });
    },
    [stagePx, viewport.h, viewport.w],
  );

  const handlePointerUp = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      const current = dragRef.current;
      dragRef.current = null;
      if (!current || current.pointerId !== ev.pointerId) return;
      if (!current.moved) return;
      const maxX = Math.max(16, viewport.w - stagePx - 16);
      const maxY = Math.max(48, viewport.h - stagePx - 24);
      const finalX = clamp(Math.round(current.origX + (ev.clientX - current.startX)), 16, maxX);
      const finalY = clamp(Math.round(current.origY + (ev.clientY - current.startY)), 48, maxY);
      setDragPos(null);
      setRoamOffsetX(0);
      const xRatio = clamp(Number((finalX / Math.max(1, viewport.w)).toFixed(4)), 0.02, 0.95);
      const yRatio = clamp(Number((finalY / Math.max(1, viewport.h)).toFixed(4)), 0.05, 0.95);
      void apiClient.interactPet?.({ action: 'update-web-anchor', webAnchor: { xRatio, yRatio } }).catch(() => {});
    },
    [stagePx, viewport.h, viewport.w],
  );

  const handleBubbleFocus = useCallback(
    (bubble: PetAttentionItem) => {
      setDismissedBubbleIds((prev) => (prev.includes(bubble.id) ? prev : [...prev, bubble.id]));
      onSelectSession(bubble.cascadeId);
      void apiClient.interactPet?.({
        action: 'bubble-click',
        bubbleId: bubble.id,
        cascadeId: bubble.cascadeId,
      }).catch(() => {});
    },
    [onSelectSession],
  );

  const handleBubbleDismiss = useCallback((bubble: PetAttentionItem) => {
    setDismissedBubbleIds((prev) => (prev.includes(bubble.id) ? prev : [...prev, bubble.id]));
    void apiClient.interactPet?.({
      action: 'bubble-dismiss',
      bubbleId: bubble.id,
      cascadeId: bubble.cascadeId,
    }).catch(() => {});
  }, []);

  const handleHideWebPet = useCallback(() => {
    setMenuOpen(false);
    void apiClient.savePluginSettings?.('agy-daddy.pet', { webVisible: false })
      .then(() => onRefreshPet())
      .catch(() => {});
  }, [onRefreshPet]);

  const handleThemeFileChange = useCallback(
    async (ev: ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      ev.target.value = '';
      setMenuOpen(false);
      if (!file) return;
      try {
        const lower = file.name.toLowerCase();
        const payload = lower.endsWith('.json')
          ? { fileName: file.name, jsonText: await file.text() }
          : lower.endsWith('.svg')
            ? { fileName: file.name, svgText: await file.text() }
            : { fileName: file.name, archiveBase64: bufferToBase64(await file.arrayBuffer()) };
        const res = await apiClient.importPetTheme(payload);
        const rawName = res?.theme?.name;
        const themeName = typeof rawName === 'string' ? rawName : rawName?.en || res?.theme?.id || file.name;
        setImportNotice(t('pet.importSuccess', { name: themeName }));
        onRefreshPet();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setImportNotice(t('pet.importFailed', { error: msg }));
      }
      window.setTimeout(() => setImportNotice(null), 3500);
    },
    [onRefreshPet, t],
  );

  if (!isVisible || !petState) return null;

  const badgeLabel =
    activeBubble?.kind === 'approval'
      ? t('pet.approvalBadge')
      : activeBubble?.kind === 'error'
        ? t('pet.errorBadge')
        : t('pet.replyBadge');

  const statusText =
    petState.motion.animState === 'sleeping'
      ? t('pet.statusSleeping')
      : petState.motion.tps > 0
        ? t('pet.statusRunning', { tps: Math.round(petState.motion.tps) })
        : t('pet.statusIdle');

  return (
    <div className={styles.overlayLayer} aria-label={t('pet.ariaOverlay')} data-testid="web-pet-overlay">
      <div
        className={styles.petAnchor}
        style={{ left: `${renderedPos.x}px`, top: `${renderedPos.y}px` }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {activeBubble && (
          <div
            className={`${styles.bubbleCard} ${
              activeBubble.kind === 'approval'
                ? styles.bubbleCardApproval
                : activeBubble.kind === 'error'
                  ? styles.bubbleCardError
                  : ''
            }`}
            data-testid="web-pet-bubble"
            role="status"
          >
            <div className={styles.bubbleHeader}>
              <span
                className={`${styles.bubbleBadge} ${
                  activeBubble.kind === 'approval'
                    ? styles.bubbleBadgeApproval
                    : activeBubble.kind === 'error'
                      ? styles.bubbleBadgeError
                      : ''
                }`}
              >
                {badgeLabel}
              </span>
              <button
                type="button"
                className={styles.bubbleClose}
                aria-label={t('pet.dismissBubble')}
                data-testid="web-pet-bubble-dismiss"
                onClick={() => handleBubbleDismiss(activeBubble)}
              >
                x
              </button>
            </div>
            <button
              type="button"
              className={styles.bubbleFocusBtn}
              data-testid="web-pet-bubble-focus"
              onClick={() => handleBubbleFocus(activeBubble)}
            >
              <span className={styles.bubbleTitle}>{activeBubble.sessionTitle || activeBubble.cascadeId}</span>
              <span className={styles.bubbleSummary}>{activeBubble.summary}</span>
            </button>
          </div>
        )}

        <div
          className={`${styles.petStageWrap} ${dragPos ? styles.petStageWrapDragging : ''}`}
          title={t('pet.dragHint')}
          data-testid="web-pet-stage"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDoubleClick={onOpenSettings}
          onContextMenu={(ev) => {
            ev.preventDefault();
            setMenuOpen((prev) => !prev);
          }}
        >
          <canvas
            ref={canvasRef}
            className={styles.petCanvas}
            width={stagePx}
            height={stagePx}
            data-testid="web-pet-canvas"
          />
          <div className={styles.petHudRow}>
            <span className={styles.tpsPill} data-testid="web-pet-status-pill">
              {statusText}
            </span>
            <button
              type="button"
              className={styles.hudBtn}
              aria-label={t('pet.menuAria')}
              data-testid="web-pet-menu-btn"
              onClick={() => setMenuOpen((prev) => !prev)}
            >
              ...
            </button>
          </div>
          {menuOpen && (
            <div className={styles.quickMenu} role="menu" data-testid="web-pet-menu">
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSettings();
                }}
              >
                {t('pet.openSettings')}
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => fileInputRef.current?.click()}
              >
                {t('pet.importTheme')}
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={handleHideWebPet}
              >
                {t('pet.hideWebPet')}
              </button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".agypet,.tar,.json,.svg"
            className={styles.hiddenFileInput}
            data-testid="web-pet-import-input"
            onChange={handleThemeFileChange}
          />
        </div>

        {importNotice && (
          <div className={styles.importNotice} role="status" data-testid="web-pet-import-notice">
            {importNotice}
          </div>
        )}
      </div>
    </div>
  );
}
