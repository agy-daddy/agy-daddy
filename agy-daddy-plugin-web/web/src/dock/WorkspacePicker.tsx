import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n';
import styles from './WorkspacePicker.module.css';

export interface WorkspacePickerOption {
  value: string;
  name: string;
  path: string;
  fromSession: boolean;
}

export interface WorkspacePickerProps {
  id?: string;
  options: WorkspacePickerOption[];
  value: string;
  disabled?: boolean;
  ariaLabelledBy?: string;
  onChange: (nextValue: string) => void;
}

export function WorkspacePicker({
  id = 'right-dock-root-select',
  options,
  value,
  disabled = false,
  ariaLabelledBy,
  onChange,
}: WorkspacePickerProps) {
  const { t } = useI18n();
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const isDisabled = disabled || options.length === 0;

  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === value) ?? null,
    [options, value],
  );

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (opt) =>
        opt.name.toLowerCase().includes(q) ||
        opt.path.toLowerCase().includes(q),
    );
  }, [options, query]);

  const { sessionGroup, otherGroup, flatOptions } = useMemo(() => {
    const session: WorkspacePickerOption[] = [];
    const other: WorkspacePickerOption[] = [];
    for (const opt of filteredOptions) {
      if (opt.fromSession) session.push(opt);
      else other.push(opt);
    }
    return {
      sessionGroup: session,
      otherGroup: other,
      flatOptions: [...session, ...other],
    };
  }, [filteredOptions]);

  useEffect(() => {
    if (!open) return;
    const selectedIdx = flatOptions.findIndex((opt) => opt.value === value);
    setHighlightedIndex(selectedIdx >= 0 ? selectedIdx : 0);
  }, [open, flatOptions, value]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const raf = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || flatOptions.length === 0) return;
    const activeEl = optionRefs.current[highlightedIndex];
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [open, highlightedIndex, flatOptions.length]);

  const selectAndClose = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (ev: KeyboardEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!open) setOpen(true);
    } else if (ev.key === 'Escape' && open) {
      ev.preventDefault();
      setOpen(false);
    }
  };

  const handlePopoverKeyDown = (ev: KeyboardEvent<HTMLElement>) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (flatOptions.length === 0) return;

    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % flatOptions.length);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setHighlightedIndex((prev) => (prev - 1 + flatOptions.length) % flatOptions.length);
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      setHighlightedIndex(0);
    } else if (ev.key === 'End') {
      ev.preventDefault();
      setHighlightedIndex(flatOptions.length - 1);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const chosen = flatOptions[highlightedIndex];
      if (chosen) {
        selectAndClose(chosen.value);
      }
    }
  };

  const activeOption = open && flatOptions.length > 0 ? flatOptions[highlightedIndex] : null;
  const activeDescendantId = activeOption ? `${listboxId}-opt-${highlightedIndex}` : undefined;

  const renderOption = (opt: WorkspacePickerOption, flatIdx: number) => {
    const isSelected = opt.value === value;
    const isHighlighted = flatIdx === highlightedIndex;
    return (
      <button
        key={opt.value}
        ref={(el) => {
          optionRefs.current[flatIdx] = el;
        }}
        id={`${listboxId}-opt-${flatIdx}`}
        type="button"
        role="option"
        aria-selected={isSelected}
        className={[
          styles.option,
          isHighlighted ? styles.optionHighlighted : '',
          isSelected ? styles.optionSelected : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onMouseEnter={() => setHighlightedIndex(flatIdx)}
        onClick={() => selectAndClose(opt.value)}
        data-testid={`workspace-picker-option-${flatIdx}`}
        data-workspace-path={opt.path}
      >
        <span className={styles.optionTop}>
          <span className={styles.optionName}>{opt.name}</span>
          {isSelected && (
            <span className={styles.optionCheck} aria-hidden="true">
              ✓
            </span>
          )}
        </span>
        <span className={styles.optionPath} title={opt.path}>
          {opt.path}
        </span>
      </button>
    );
  };

  return (
    <div ref={rootRef} className={styles.picker}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeDescendantId}
        aria-labelledby={ariaLabelledBy}
        aria-label={!ariaLabelledBy ? t('dock.workspaceSelectAria') : undefined}
        className={styles.trigger}
        disabled={isDisabled}
        title={selectedOption?.path || value || t('dock.workspaceEmpty')}
        onClick={() => {
          if (!isDisabled) setOpen((prev) => !prev);
        }}
        onKeyDown={handleTriggerKeyDown}
        data-testid="dock-root-select"
      >
        <span className={styles.triggerFolder} aria-hidden="true">
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 4.2h4.2l1.2 1.4H14v6.7H2z" />
          </svg>
        </span>
        <span className={styles.triggerName}>
          {selectedOption?.name || t('dock.workspaceEmpty')}
        </span>
        {selectedOption?.fromSession && (
          <span className={styles.sessionTag}>{t('dock.workspaceSessionTag')}</span>
        )}
        <span className={styles.triggerCaret} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div
          className={styles.popover}
          onKeyDown={handlePopoverKeyDown}
          data-testid="workspace-picker-popover"
        >
          <div className={styles.searchWrap}>
            <input
              ref={searchInputRef}
              type="text"
              className={styles.searchInput}
              value={query}
              onChange={(ev) => {
                setQuery(ev.target.value);
                setHighlightedIndex(0);
              }}
              placeholder={t('dock.workspaceSearchPlaceholder')}
              aria-label={t('dock.workspaceSearchPlaceholder')}
              aria-controls={listboxId}
              aria-activedescendant={activeDescendantId}
              data-testid="workspace-picker-search"
            />
            {query && (
              <button
                type="button"
                className={styles.clearSearchBtn}
                onClick={() => {
                  setQuery('');
                  setHighlightedIndex(0);
                  searchInputRef.current?.focus();
                }}
                aria-label={t('common.close')}
                data-testid="workspace-picker-search-clear"
              >
                ×
              </button>
            )}
          </div>

          <div
            id={listboxId}
            role="listbox"
            aria-label={t('dock.workspaceSelectAria')}
            className={styles.list}
            data-testid="workspace-picker-list"
          >
            {flatOptions.length === 0 ? (
              <div className={styles.emptyState} data-testid="workspace-picker-empty">
                {t('dock.workspaceNoMatches')}
              </div>
            ) : (
              <>
                {sessionGroup.length > 0 && (
                  <div className={styles.group}>
                    <div className={styles.groupHeader} role="presentation">
                      {t('dock.workspaceGroupSession')}
                    </div>
                    {sessionGroup.map((opt, idx) => renderOption(opt, idx))}
                  </div>
                )}
                {otherGroup.length > 0 && (
                  <div className={styles.group}>
                    <div className={styles.groupHeader} role="presentation">
                      {t('dock.workspaceGroupOther')}
                    </div>
                    {otherGroup.map((opt, idx) =>
                      renderOption(opt, sessionGroup.length + idx),
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
