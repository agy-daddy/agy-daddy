import React, { useState } from 'react';
import type { TranslateFn } from '../i18n';
import styles from './SessionSidebar.module.css';

export interface PresetEntityIconDef {
  id: string;
  value: string;
  labelKey: string;
  paths: React.ReactNode;
}

export const PRESET_ENTITY_ICONS: PresetEntityIconDef[] = [
  {
    id: 'folder',
    value: 'preset:folder',
    labelKey: 'folder',
    paths: (
      <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.7c.4 0 .78.18 1.03.5l.77 1c.15.19.38.3.62.3H12.5c.83 0 1.5.67 1.5 1.5v5.2c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5v-7z" />
    ),
  },
  {
    id: 'code',
    value: 'preset:code',
    labelKey: 'code',
    paths: (
      <>
        <polyline points="5.5 4.5 2 8 5.5 11.5" />
        <polyline points="10.5 4.5 14 8 10.5 11.5" />
        <line x1="9" y1="3.5" x2="7" y2="12.5" />
      </>
    ),
  },
  {
    id: 'terminal',
    value: 'preset:terminal',
    labelKey: 'terminal',
    paths: (
      <>
        <rect x="2" y="3" width="12" height="10" rx="1.8" />
        <polyline points="4.8 6.3 7 8 4.8 9.7" />
        <line x1="8.2" y1="9.8" x2="11.2" y2="9.8" />
      </>
    ),
  },
  {
    id: 'globe',
    value: 'preset:globe',
    labelKey: 'globe',
    paths: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <ellipse cx="8" cy="8" rx="2.4" ry="5.5" />
        <line x1="2.6" y1="8" x2="13.4" y2="8" />
      </>
    ),
  },
  {
    id: 'rocket',
    value: 'preset:rocket',
    labelKey: 'rocket',
    paths: (
      <>
        <path d="M9.6 2.5c2.2-.2 3.9 1.5 3.7 3.7-.3 2.5-2.1 4.6-4.5 5.4L6.2 9c.8-2.4 2.9-4.2 3.4-6.5z" />
        <path d="M6.2 9L4 12l3-2.2" />
        <circle cx="9.8" cy="6.2" r="1" />
      </>
    ),
  },
  {
    id: 'layers',
    value: 'preset:layers',
    labelKey: 'layers',
    paths: (
      <>
        <polygon points="8 2.5 13.5 5.5 8 8.5 2.5 5.5 8 2.5" />
        <polyline points="2.5 8.2 8 11.2 13.5 8.2" />
        <polyline points="2.5 10.8 8 13.8 13.5 10.8" />
      </>
    ),
  },
  {
    id: 'cpu',
    value: 'preset:cpu',
    labelKey: 'cpu',
    paths: (
      <>
        <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
        <path d="M6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2" />
      </>
    ),
  },
  {
    id: 'database',
    value: 'preset:database',
    labelKey: 'database',
    paths: (
      <>
        <ellipse cx="8" cy="4.2" rx="4.8" ry="1.8" />
        <path d="M3.2 4.2v7.6c0 1 2.15 1.8 4.8 1.8s4.8-.8 4.8-1.8V4.2" />
        <path d="M3.2 8c0 1 2.15 1.8 4.8 1.8s4.8-.8 4.8-1.8" />
      </>
    ),
  },
  {
    id: 'shield',
    value: 'preset:shield',
    labelKey: 'shield',
    paths: (
      <path d="M8 2.4L13 4.3v3.5c0 3.1-2.1 5.3-5 6.1-2.9-.8-5-3-5-6.1V4.3L8 2.4z" />
    ),
  },
  {
    id: 'flask',
    value: 'preset:flask',
    labelKey: 'flask',
    paths: (
      <>
        <path d="M6.2 2.6h3.6" />
        <path d="M6.8 2.6v3.3L3.6 12a1.2 1.2 0 001.05 1.8h6.7a1.2 1.2 0 001.05-1.8L9.2 5.9V2.6" />
      </>
    ),
  },
  {
    id: 'book',
    value: 'preset:book',
    labelKey: 'book',
    paths: (
      <>
        <path d="M2.5 3.5h4.2c.7 0 1.3.6 1.3 1.3v8.4c0-.6-.5-1.1-1.1-1.1H2.5V3.5z" />
        <path d="M13.5 3.5H9.3c-.7 0-1.3.6-1.3 1.3v8.4c0-.6.5-1.1 1.1-1.1h4.4V3.5z" />
      </>
    ),
  },
  {
    id: 'sparkles',
    value: 'preset:sparkles',
    labelKey: 'sparkles',
    paths: (
      <>
        <path d="M8 2.2l1.1 3.2L12.3 6.5 9.1 7.6 8 10.8 6.9 7.6 3.7 6.5l3.2-1.1L8 2.2z" />
        <path d="M12.3 10.4l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3z" />
      </>
    ),
  },
  {
    id: 'package',
    value: 'preset:package',
    labelKey: 'package',
    paths: (
      <>
        <polygon points="8 2.3 13.2 5.2 13.2 10.8 8 13.7 2.8 10.8 2.8 5.2 8 2.3" />
        <polyline points="2.8 5.2 8 8.1 13.2 5.2" />
        <line x1="8" y1="8.1" x2="8" y2="13.7" />
      </>
    ),
  },
  {
    id: 'briefcase',
    value: 'preset:briefcase',
    labelKey: 'briefcase',
    paths: (
      <>
        <rect x="2.4" y="4.8" width="11.2" height="8" rx="1.4" />
        <path d="M5.8 4.8V3.6c0-.6.5-1.1 1.1-1.1h2.2c.6 0 1.1.5 1.1 1.1v1.2" />
        <line x1="2.4" y1="8.3" x2="13.6" y2="8.3" />
      </>
    ),
  },
  {
    id: 'palette',
    value: 'preset:palette',
    labelKey: 'palette',
    paths: (
      <>
        <path d="M8 2.5a5.5 5.5 0 100 11c.8 0 1.3-.5 1.3-1.2 0-.4-.2-.7-.2-1.1 0-.6.5-1.1 1.1-1.1h1.2a2.1 2.1 0 002.1-2.1A5.5 5.5 0 008 2.5z" />
        <circle cx="5.4" cy="7.1" r=".7" fill="currentColor" stroke="none" />
        <circle cx="7.4" cy="5.2" r=".7" fill="currentColor" stroke="none" />
        <circle cx="10.2" cy="5.6" r=".7" fill="currentColor" stroke="none" />
      </>
    ),
  },
  {
    id: 'git',
    value: 'preset:git',
    labelKey: 'git',
    paths: (
      <>
        <circle cx="5" cy="4.2" r="1.4" />
        <circle cx="5" cy="11.8" r="1.4" />
        <circle cx="11.2" cy="6.2" r="1.4" />
        <line x1="5" y1="5.6" x2="5" y2="10.4" />
        <path d="M5 8.5c0-1.4 1.3-2.3 4.8-2.3" />
      </>
    ),
  },
];

export const PRESET_ENTITY_EMOJIS: string[] = [
  '📁',
  '🚀',
  '⚡',
  '🔥',
  '🧩',
  '🛠️',
  '🎨',
  '📦',
  '🔬',
  '🌐',
  '🤖',
  '💼',
  '🧪',
  '🔒',
  '📝',
  '✨',
];

const PRESET_MAP = new Map(PRESET_ENTITY_ICONS.map((item) => [item.value, item]));

export interface EntityIconProps {
  icon?: string | null;
  kind: 'group' | 'project';
  size?: number;
}

export function EntityIcon({ icon, kind, size = 13 }: EntityIconProps) {
  const clean = typeof icon === 'string' ? icon.trim() : '';
  if (clean) {
    const preset = PRESET_MAP.get(clean);
    if (preset) {
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          data-entity-icon={clean}
        >
          {preset.paths}
        </svg>
      );
    }
    return (
      <span
        className={styles.entityEmojiIcon}
        style={{ fontSize: `${Math.max(11, size - 1)}px`, width: `${size + 2}px` }}
        aria-hidden="true"
        data-entity-icon={clean}
      >
        {clean}
      </span>
    );
  }
  if (kind === 'project') {
    const folderPreset = PRESET_MAP.get('preset:folder');
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {folderPreset?.paths}
      </svg>
    );
  }
  return null;
}

export interface EntityIconPickerProps {
  value?: string | null;
  disabled?: boolean;
  t: TranslateFn;
  testIdPrefix: string;
  onSelect: (icon: string | null) => void;
  onClose?: () => void;
}

export function EntityIconPicker({
  value,
  disabled = false,
  t,
  testIdPrefix,
  onSelect,
  onClose,
}: EntityIconPickerProps) {
  const current = typeof value === 'string' ? value.trim() : '';
  const isCustomInitial = Boolean(
    current && !PRESET_MAP.has(current) && !PRESET_ENTITY_EMOJIS.includes(current),
  );
  const [customDraft, setCustomDraft] = useState(isCustomInitial ? current : '');

  const handleCustomSubmit = (ev: React.FormEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (disabled) return;
    const trimmed = customDraft.trim();
    if (!trimmed) {
      onSelect(null);
      return;
    }
    onSelect(trimmed);
  };

  return (
    <div
      className={styles.iconPickerPanel}
      data-testid={`${testIdPrefix}-picker`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={styles.iconPickerHeader}>
        <span className={styles.iconPickerTitle}>{t('sidebar.iconPresetGroup')}</span>
        <div className={styles.iconPickerHeaderActions}>
          {current && (
            <button
              type="button"
              className={styles.iconPickerClearBtn}
              disabled={disabled}
              data-testid={`${testIdPrefix}-clear`}
              onClick={() => onSelect(null)}
            >
              {t('sidebar.clearIcon')}
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className={styles.iconPickerCloseBtn}
              aria-label={t('common.cancel')}
              onClick={onClose}
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className={styles.iconPickerGrid} role="listbox" aria-label={t('sidebar.iconPresetGroup')}>
        {PRESET_ENTITY_ICONS.map((item) => {
          const active = current === item.value;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={active}
              title={item.labelKey}
              aria-label={item.labelKey}
              disabled={disabled}
              data-testid={`${testIdPrefix}-preset-${item.id}`}
              className={`${styles.iconPickerCell} ${active ? styles.iconPickerCellActive : ''}`}
              onClick={() => onSelect(active ? null : item.value)}
            >
              <EntityIcon icon={item.value} kind="project" size={14} />
            </button>
          );
        })}
      </div>

      <div className={styles.iconPickerSubLabel}>{t('sidebar.iconEmojiGroup')}</div>
      <div className={styles.iconPickerGrid} role="listbox" aria-label={t('sidebar.iconEmojiGroup')}>
        {PRESET_ENTITY_EMOJIS.map((emoji) => {
          const active = current === emoji;
          return (
            <button
              key={emoji}
              type="button"
              role="option"
              aria-selected={active}
              aria-label={emoji}
              disabled={disabled}
              data-testid={`${testIdPrefix}-emoji-${emoji}`}
              className={`${styles.iconPickerCell} ${active ? styles.iconPickerCellActive : ''}`}
              onClick={() => onSelect(active ? null : emoji)}
            >
              <span className={styles.entityEmojiIcon}>{emoji}</span>
            </button>
          );
        })}
      </div>

      <form className={styles.iconPickerCustomRow} onSubmit={handleCustomSubmit}>
        <input
          type="text"
          className={styles.iconPickerCustomInput}
          value={customDraft}
          maxLength={24}
          disabled={disabled}
          placeholder={t('sidebar.iconCustomPlaceholder')}
          aria-label={t('sidebar.iconCustomPlaceholder')}
          data-testid={`${testIdPrefix}-custom-input`}
          onChange={(e) => setCustomDraft(e.target.value)}
        />
        <button
          type="submit"
          className={styles.popoverMiniBtn}
          disabled={disabled || !customDraft.trim()}
          data-testid={`${testIdPrefix}-custom-apply`}
        >
          {t('common.save')}
        </button>
      </form>
    </div>
  );
}
