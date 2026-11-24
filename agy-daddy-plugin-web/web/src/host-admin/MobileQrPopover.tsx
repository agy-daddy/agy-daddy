import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n, type TranslateFn } from '../i18n';
import type { RemoteStatusResponse } from '../types';
import styles from './MobileQrPopover.module.css';

export interface MobileQrPopoverProps {
  remoteStatus?: RemoteStatusResponse | null;
  remoteLoading?: boolean;
  onRefreshRemote?: () => void;
  onClose: () => void;
}

const SAFE_SVG_TAGS = new Set([
  'g',
  'rect',
  'path',
  'circle',
  'polygon',
  'polyline',
  'line',
]);

const SAFE_SVG_ATTRS = new Map<string, string>([
  ['d', 'd'],
  ['x', 'x'],
  ['y', 'y'],
  ['width', 'width'],
  ['height', 'height'],
  ['rx', 'rx'],
  ['ry', 'ry'],
  ['cx', 'cx'],
  ['cy', 'cy'],
  ['r', 'r'],
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['stroke-width', 'strokeWidth'],
  ['shape-rendering', 'shapeRendering'],
  ['transform', 'transform'],
  ['points', 'points'],
  ['x1', 'x1'],
  ['y1', 'y1'],
  ['x2', 'x2'],
  ['y2', 'y2'],
  ['opacity', 'opacity'],
]);

function isSafeSvgAttrValue(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return true;
  if (trimmed.includes('javascript:') || trimmed.includes('expression(') || trimmed.includes('url(')) {
    return false;
  }
  return true;
}

interface ParsedSvgElement {
  viewBox: string;
  width: string;
  height: string;
  shapeRendering?: string;
  children: React.ReactNode[];
}

function convertSvgNode(el: Element, keyPrefix: string): React.ReactNode | null {
  const tag = el.tagName.toLowerCase();
  if (!SAFE_SVG_TAGS.has(tag)) return null;

  const props: Record<string, string | number> = { key: keyPrefix };
  for (let i = 0; i < el.attributes.length; i += 1) {
    const attr = el.attributes[i];
    const nameLower = attr.name.toLowerCase();
    if (nameLower.startsWith('on')) continue;
    const reactProp = SAFE_SVG_ATTRS.get(nameLower);
    if (!reactProp) continue;
    if (!isSafeSvgAttrValue(attr.value)) continue;
    props[reactProp] = attr.value;
  }

  const children: React.ReactNode[] = [];
  if (tag === 'g') {
    for (let i = 0; i < el.children.length; i += 1) {
      const childNode = convertSvgNode(el.children[i], `${keyPrefix}-${i}`);
      if (childNode) children.push(childNode);
    }
  }

  return React.createElement(tag, props, children.length > 0 ? children : undefined);
}

function parseSafeQrSvg(rawSvg: string | undefined): ParsedSvgElement | null {
  if (!rawSvg || typeof rawSvg !== 'string') return null;
  const trimmed = rawSvg.trim();
  if (!trimmed.startsWith('<') || typeof DOMParser === 'undefined') return null;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(trimmed, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return null;
    const svgEl = doc.documentElement;
    if (!svgEl || svgEl.tagName.toLowerCase() !== 'svg') return null;

    const viewBox = svgEl.getAttribute('viewBox') || '0 0 29 29';
    const width = svgEl.getAttribute('width') || '164';
    const height = svgEl.getAttribute('height') || '164';
    const shapeRendering = svgEl.getAttribute('shape-rendering') || 'crispEdges';

    const children: React.ReactNode[] = [];
    for (let i = 0; i < svgEl.children.length; i += 1) {
      const child = convertSvgNode(svgEl.children[i], `qr-${i}`);
      if (child) children.push(child);
    }
    if (children.length === 0) return null;

    return { viewBox, width, height, shapeRendering, children };
  } catch {
    return null;
  }
}

function resolvePermissionBadge(
  status: RemoteStatusResponse,
  t: TranslateFn,
): { level: 'L0' | 'L1' | 'L2'; label: string } {
  const raw = String(status.permissionLevel || '').trim().toUpperCase();
  if (raw === 'L2') return { level: 'L2', label: t('topbar.mobilePermL2') };
  if (raw === 'L1') return { level: 'L1', label: t('topbar.mobilePermL1') };
  if (raw === 'L0') return { level: 'L0', label: t('topbar.mobilePermL0') };
  return status.allowRemoteWrite
    ? { level: 'L1', label: t('topbar.mobilePermL1') }
    : { level: 'L0', label: t('topbar.mobilePermL0') };
}

function resolveChannelBadges(
  status: RemoteStatusResponse,
  t: TranslateFn,
): Array<{ key: string; label: string; isPrimary: boolean }> {
  const channels = status.channels || {};
  const primary = String(status.primaryChannel || '').toLowerCase();
  const list: Array<{ key: string; label: string; isPrimary: boolean }> = [];

  if (channels.cloudflare) {
    list.push({
      key: 'cloudflare',
      label: t('topbar.mobileChannelCloudflare'),
      isPrimary: primary === 'cloudflare',
    });
  }
  if (channels.tailscale) {
    list.push({
      key: 'tailscale',
      label: t('topbar.mobileChannelTailscale'),
      isPrimary: primary === 'tailscale',
    });
  }
  if (channels.lan || channels.bonjour) {
    list.push({
      key: 'lan',
      label: t('topbar.mobileChannelLan'),
      isPrimary: primary === 'lan' || primary === 'bonjour',
    });
  }
  if (channels.loopback) {
    list.push({
      key: 'local',
      label: t('topbar.mobileChannelLocal'),
      isPrimary: primary === 'loopback' || primary === 'local',
    });
  }

  if (list.length === 0 && primary) {
    const fallbackLabel =
      primary === 'cloudflare'
        ? t('topbar.mobileChannelCloudflare')
        : primary === 'tailscale'
          ? t('topbar.mobileChannelTailscale')
          : primary === 'lan' || primary === 'bonjour'
            ? t('topbar.mobileChannelLan')
            : t('topbar.mobileChannelLocal');
    list.push({ key: primary, label: fallbackLabel, isPrimary: true });
  }

  return list;
}

export function MobileQrPopover({
  remoteStatus,
  remoteLoading = false,
  onRefreshRemote,
  onClose,
}: MobileQrPopoverProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const isOnline = Boolean(
    remoteStatus && remoteStatus.available && remoteStatus.running !== false,
  );
  const pairingUrl = remoteStatus?.pairingUrl || remoteStatus?.url || '';
  const parsedQr = useMemo(() => parseSafeQrSvg(remoteStatus?.qrSvg), [remoteStatus?.qrSvg]);

  const handleCopy = async () => {
    if (!pairingUrl) return;
    try {
      await navigator.clipboard?.writeText?.(pairingUrl);
    } catch {
      // Ignore clipboard permission errors in restricted contexts
    }
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
    }, 1500);
  };

  const channelBadges = remoteStatus ? resolveChannelBadges(remoteStatus, t) : [];
  const permBadge = remoteStatus ? resolvePermissionBadge(remoteStatus, t) : null;

  return (
    <div
      className={styles.popover}
      role="dialog"
      aria-label={t('topbar.mobileQrTitle')}
      data-testid="mobile-qr-popover"
    >
      <div className={styles.header}>
        <h3 className={styles.title}>{t('topbar.mobileQrTitle')}</h3>
        <div className={styles.headerActions}>
          {onRefreshRemote && (
            <button
              type="button"
              className={styles.refreshBtn}
              onClick={onRefreshRemote}
              disabled={remoteLoading}
              data-testid="mobile-qr-refresh-btn"
            >
              {remoteLoading ? t('common.refreshing') : t('popover.refresh')}
            </button>
          )}
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label={t('common.close')}
            data-testid="mobile-qr-close-btn"
          >
            ×
          </button>
        </div>
      </div>

      <div className={styles.body}>
        {!isOnline ? (
          <div className={styles.offlineBox} data-testid="mobile-qr-offline">
            <span>{t('topbar.mobileOffline')}</span>
            {onRefreshRemote && (
              <button
                type="button"
                className={styles.refreshBtn}
                onClick={onRefreshRemote}
                disabled={remoteLoading}
              >
                {t('popover.refresh')}
              </button>
            )}
          </div>
        ) : (
          <>
            <div className={styles.badgesRow}>
              {channelBadges.map((ch) => (
                <span
                  key={ch.key}
                  className={`${styles.badge} ${ch.isPrimary ? styles.badgePrimary : ''}`}
                  data-testid={`mobile-channel-${ch.key}`}
                >
                  {ch.label}
                </span>
              ))}
              {permBadge && (
                <span
                  className={`${styles.badge} ${permBadge.level === 'L0' ? styles.badgePermReadOnly : styles.badgePerm}`}
                  data-testid="mobile-permission-badge"
                >
                  {permBadge.label}
                </span>
              )}
              {typeof remoteStatus?.deviceCount === 'number' && (
                <span className={styles.badge} data-testid="mobile-device-count">
                  {t('topbar.mobileDevices', { count: remoteStatus.deviceCount })}
                </span>
              )}
            </div>

            <div className={styles.qrCard} data-testid="mobile-qr-card">
              {parsedQr ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox={parsedQr.viewBox}
                  width={parsedQr.width}
                  height={parsedQr.height}
                  shapeRendering={parsedQr.shapeRendering}
                  role="img"
                  aria-label={t('topbar.mobileQrTitle')}
                >
                  {parsedQr.children}
                </svg>
              ) : (
                <div className={styles.qrFallback} data-testid="mobile-qr-unavailable">
                  {t('topbar.mobileNoQr')}
                </div>
              )}
            </div>

            {pairingUrl && (
              <div className={styles.urlRow}>
                <input
                  type="text"
                  readOnly
                  value={pairingUrl}
                  className={styles.urlInput}
                  aria-label={t('topbar.mobileQrTitle')}
                  data-testid="mobile-qr-url-input"
                />
                <button
                  type="button"
                  className={styles.copyBtn}
                  onClick={() => void handleCopy()}
                  data-testid="mobile-qr-copy-btn"
                >
                  {copied ? t('topbar.mobileCopied') : t('topbar.mobileCopyUrl')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
