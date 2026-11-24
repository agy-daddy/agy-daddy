import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { runHostCommand, savePluginSettings } from '../api/client';
import { createTranslator, normalizeLocale, useI18n } from '../i18n';
import type {
  LocalizedText,
  PluginSettingsResponse,
  SecretFieldState,
  SettingsEnumOption,
  SettingsSchema,
  SettingsSchemaAction,
  SettingsSchemaField,
} from '../types';
import styles from './SchemaSettingsForm.module.css';

export interface SchemaSettingsFormProps {
  pluginId: string;
  schema: SettingsSchema;
  values: Record<string, unknown>;
  secretState?: Record<string, SecretFieldState | boolean>;
  locale?: string;
  saving?: boolean;
  runningActionId?: string | null;
  error?: string | null;
  onSave?: (patch: Record<string, unknown>) => Promise<unknown> | unknown;
  onSaved?: (response: PluginSettingsResponse) => void;
  onRunAction?: (action: SettingsSchemaAction) => Promise<unknown> | unknown;
  className?: string;
}

export function localizeText(text: LocalizedText | undefined, locale = 'en'): string {
  if (typeof text === 'string') return text;
  if (!text || typeof text !== 'object') return '';
  if (typeof text[locale] === 'string' && text[locale]) return text[locale] as string;
  if (typeof text.en === 'string' && text.en) return text.en;
  if (typeof text['zh-CN'] === 'string' && text['zh-CN']) return text['zh-CN'];
  for (const val of Object.values(text)) {
    if (typeof val === 'string' && val) return val;
  }
  return '';
}

function isSecretField(
  field: SettingsSchemaField,
  secretState?: Record<string, SecretFieldState | boolean>,
): boolean {
  if (field.writeOnly === true || field.secret === true) return true;
  if (secretState && Object.prototype.hasOwnProperty.call(secretState, field.key)) return true;
  return false;
}

function getSecretMeta(
  field: SettingsSchemaField,
  values: Record<string, unknown>,
  secretState?: Record<string, SecretFieldState | boolean>,
): { configured: boolean; masked: string } {
  const entry = secretState?.[field.key];
  const rawVal = values[field.key];
  const rawMasked = typeof rawVal === 'string' && rawVal.length > 0 ? rawVal : '';

  if (typeof entry === 'boolean') {
    return {
      configured: entry,
      masked: rawMasked || (entry ? '••••••••' : ''),
    };
  }

  if (entry && typeof entry === 'object') {
    const masked = typeof entry.masked === 'string' && entry.masked.length > 0 ? entry.masked : rawMasked;
    const configured = Boolean(entry.configured ?? masked.length > 0);
    return {
      configured,
      masked: masked || (configured ? '••••••••' : ''),
    };
  }

  return {
    configured: rawMasked.length > 0,
    masked: rawMasked,
  };
}

function normalizeEnumOption(opt: SettingsEnumOption | string, locale: string): { value: string; label: string } {
  if (typeof opt === 'string') {
    return { value: opt, label: opt };
  }
  return {
    value: opt.value,
    label: localizeText(opt.label, locale) || opt.value,
  };
}

function buildInitialDrafts(
  schema: SettingsSchema,
  values: Record<string, unknown>,
  secretState?: Record<string, SecretFieldState | boolean>,
): {
  nonSecret: Record<string, unknown>;
  numberStrings: Record<string, string>;
} {
  const nonSecret: Record<string, unknown> = {};
  const numberStrings: Record<string, string> = {};

  for (const field of schema.fields || []) {
    if (isSecretField(field, secretState)) continue;

    const raw = values[field.key] !== undefined ? values[field.key] : field.default;
    if (field.type === 'boolean') {
      nonSecret[field.key] = Boolean(raw);
    } else if (field.type === 'number') {
      const hasNum = typeof raw === 'number' && Number.isFinite(raw);
      nonSecret[field.key] = hasNum ? raw : undefined;
      numberStrings[field.key] = hasNum ? String(raw) : raw !== undefined && raw !== null ? String(raw) : '';
    } else if (field.type === 'list') {
      nonSecret[field.key] = Array.isArray(raw) ? raw.map((item) => String(item)) : [];
    } else if (field.type === 'enum') {
      const fallback = field.options?.[0];
      const firstVal = fallback ? (typeof fallback === 'string' ? fallback : fallback.value) : '';
      nonSecret[field.key] = raw !== undefined && raw !== null ? String(raw) : firstVal;
    } else {
      nonSecret[field.key] = raw !== undefined && raw !== null ? String(raw) : '';
    }
  }

  return { nonSecret, numberStrings };
}

export function SchemaSettingsForm({
  pluginId,
  schema,
  values,
  secretState,
  locale: localeProp,
  saving: externalSaving,
  runningActionId: externalRunningActionId,
  error: externalError,
  onSave,
  onSaved,
  onRunAction,
  className,
}: SchemaSettingsFormProps) {
  const { locale: ctxLocale } = useI18n();
  const locale = normalizeLocale(localeProp ?? ctxLocale) || 'en';
  const t = createTranslator(locale);
  const baseId = useId();
  const [draft, setDraft] = useState<Record<string, unknown>>(
    () => buildInitialDrafts(schema, values, secretState).nonSecret,
  );
  const [numberDrafts, setNumberDrafts] = useState<Record<string, string>>(
    () => buildInitialDrafts(schema, values, secretState).numberStrings,
  );
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [dirtySecrets, setDirtySecrets] = useState<Record<string, boolean>>({});
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});
  const [listInputs, setListInputs] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [internalSaving, setInternalSaving] = useState(false);
  const [internalRunningActionId, setInternalRunningActionId] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);

  useEffect(() => {
    const initial = buildInitialDrafts(schema, values, secretState);
    setDraft(initial.nonSecret);
    setNumberDrafts(initial.numberStrings);
    setSecretDrafts({});
    setDirtySecrets({});
    setListInputs({});
    setFieldErrors({});
    setFeedbackError(null);
  }, [pluginId, schema, values, secretState]);

  const isSaving = Boolean(externalSaving ?? internalSaving);
  const activeActionId = externalRunningActionId ?? internalRunningActionId;
  const displayError = externalError || feedbackError;

  const titleText = localizeText(schema.title, locale);
  const descText = localizeText(schema.description, locale);

  const handleAddListItem = (field: SettingsSchemaField) => {
    const raw = (listInputs[field.key] ?? '').trim();
    if (!raw) return;
    const current = Array.isArray(draft[field.key]) ? (draft[field.key] as string[]) : [];
    if (typeof field.maxItems === 'number' && current.length >= field.maxItems) {
      setFieldErrors((prev) => ({
        ...prev,
        [field.key]: t('schema.errMaxItems', { maxItems: field.maxItems }),
      }));
      return;
    }
    setDraft((prev) => ({
      ...prev,
      [field.key]: [...current, raw],
    }));
    setListInputs((prev) => ({ ...prev, [field.key]: '' }));
    setFieldErrors((prev) => {
      if (!prev[field.key]) return prev;
      const next = { ...prev };
      delete next[field.key];
      return next;
    });
  };

  const handleRemoveListItem = (fieldKey: string, idx: number) => {
    const current = Array.isArray(draft[fieldKey]) ? (draft[fieldKey] as string[]) : [];
    setDraft((prev) => ({
      ...prev,
      [fieldKey]: current.filter((_, i) => i !== idx),
    }));
    setFieldErrors((prev) => {
      if (!prev[fieldKey]) return prev;
      const next = { ...prev };
      delete next[fieldKey];
      return next;
    });
  };

  const handleListKeyDown = (e: KeyboardEvent<HTMLInputElement>, field: SettingsSchemaField) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddListItem(field);
    }
  };

  const validateAndBuildPatch = (): { patch: Record<string, unknown>; errors: Record<string, string> } => {
    const patch: Record<string, unknown> = {};
    const errors: Record<string, string> = {};

    for (const field of schema.fields || []) {
      if (isSecretField(field, secretState)) {
        const nextSecret = secretDrafts[field.key] ?? '';
        if (dirtySecrets[field.key] && nextSecret.length > 0) {
          patch[field.key] = nextSecret;
        }
        continue;
      }

      if (field.type === 'boolean') {
        patch[field.key] = Boolean(draft[field.key]);
      } else if (field.type === 'number') {
        const rawStr = (numberDrafts[field.key] ?? '').trim();
        if (rawStr === '') {
          errors[field.key] = `${localizeText(field.label, locale) || field.key}: ${t('schema.errInvalidNumber')}`;
          continue;
        }
        const parsed = Number(rawStr);
        if (!Number.isFinite(parsed)) {
          errors[field.key] = `${localizeText(field.label, locale) || field.key}: ${t('schema.errInvalidNumber')}`;
          continue;
        }
        if (typeof field.min === 'number' && parsed < field.min) {
          errors[field.key] = t('schema.errMin', { min: field.min });
          continue;
        }
        if (typeof field.max === 'number' && parsed > field.max) {
          errors[field.key] = t('schema.errMax', { max: field.max });
          continue;
        }
        patch[field.key] = parsed;
      } else if (field.type === 'list') {
        const items = Array.isArray(draft[field.key]) ? (draft[field.key] as string[]) : [];
        if (typeof field.maxItems === 'number' && items.length > field.maxItems) {
          errors[field.key] = t('schema.errMaxItems', { maxItems: field.maxItems });
          continue;
        }
        patch[field.key] = items;
      } else {
        patch[field.key] = String(draft[field.key] ?? '');
      }
    }

    return { patch, errors };
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFeedbackError(null);
    setFeedbackStatus(null);

    const { patch, errors } = validateAndBuildPatch();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setFeedbackError(Object.values(errors)[0]);
      return;
    }

    setFieldErrors({});
    setInternalSaving(true);
    try {
      if (onSave) {
        const res = await onSave(patch);
        if (res && typeof res === 'object' && 'ok' in res) {
          onSaved?.(res as PluginSettingsResponse);
        }
      } else {
        const res = await savePluginSettings(pluginId, patch);
        onSaved?.(res);
      }
      setSecretDrafts({});
      setDirtySecrets({});
      setFeedbackStatus(t('schema.savedSuccess'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('schema.saveFailed');
      setFeedbackError(msg);
    } finally {
      setInternalSaving(false);
    }
  };

  const handleActionClick = async (action: SettingsSchemaAction) => {
    setFeedbackError(null);
    setFeedbackStatus(null);
    setInternalRunningActionId(action.id);
    try {
      if (onRunAction) {
        await onRunAction(action);
      } else {
        const cmdId = action.commandId || action.id;
        await runHostCommand(cmdId, { pluginId, args: [] });
      }
      setFeedbackStatus(t('schema.actionExecuted', { label: localizeText(action.label, locale) || action.id }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('schema.actionFailed');
      setFeedbackError(msg);
    } finally {
      setInternalRunningActionId(null);
    }
  };

  return (
    <form className={`${styles.form} ${className || ''}`.trim()} onSubmit={handleSubmit} noValidate>
      {(titleText || descText) && (
        <div className={styles.header}>
          {titleText && <h4 className={styles.title}>{titleText}</h4>}
          {descText && <p className={styles.description}>{descText}</p>}
        </div>
      )}

      <div className={styles.fields}>
        {(schema.fields || []).map((field) => {
          const inputId = `${baseId}-${field.key}`;
          const labelText = localizeText(field.label, locale) || field.key;
          const fieldDesc = localizeText(field.description, locale);
          const fieldErr = fieldErrors[field.key];
          const secret = isSecretField(field, secretState);

          if (field.type === 'boolean') {
            return (
              <div key={field.key} className={`${styles.fieldRow} ${styles.fieldRowInline}`}>
                <div>
                  <label htmlFor={inputId} className={styles.fieldLabel}>
                    {labelText}
                  </label>
                  {fieldDesc && <div className={styles.fieldDesc}>{fieldDesc}</div>}
                </div>
                <input
                  id={inputId}
                  type="checkbox"
                  className={styles.checkbox}
                  checked={Boolean(draft[field.key])}
                  disabled={isSaving}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      [field.key]: e.target.checked,
                    }))
                  }
                />
              </div>
            );
          }

          if (field.type === 'enum') {
            const options = (field.options || []).map((opt) => normalizeEnumOption(opt, locale));
            return (
              <div key={field.key} className={styles.fieldRow}>
                <label htmlFor={inputId} className={styles.fieldLabel}>
                  {labelText}
                </label>
                {fieldDesc && <div className={styles.fieldDesc}>{fieldDesc}</div>}
                <select
                  id={inputId}
                  className={styles.select}
                  value={String(draft[field.key] ?? '')}
                  disabled={isSaving}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                >
                  {options.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {fieldErr && <div className={styles.fieldError}>{fieldErr}</div>}
              </div>
            );
          }

          if (field.type === 'number') {
            return (
              <div key={field.key} className={styles.fieldRow}>
                <label htmlFor={inputId} className={styles.fieldLabel}>
                  {labelText}
                </label>
                {fieldDesc && <div className={styles.fieldDesc}>{fieldDesc}</div>}
                <input
                  id={inputId}
                  type="number"
                  className={styles.input}
                  min={field.min}
                  max={field.max}
                  value={numberDrafts[field.key] ?? ''}
                  placeholder={localizeText(field.placeholder, locale)}
                  disabled={isSaving}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setNumberDrafts((prev) => ({ ...prev, [field.key]: nextVal }));
                    setFieldErrors((prev) => {
                      if (!prev[field.key]) return prev;
                      const next = { ...prev };
                      delete next[field.key];
                      return next;
                    });
                  }}
                />
                {fieldErr && <div className={styles.fieldError}>{fieldErr}</div>}
              </div>
            );
          }

          if (field.type === 'list') {
            const items = Array.isArray(draft[field.key]) ? (draft[field.key] as string[]) : [];
            const atLimit = typeof field.maxItems === 'number' && items.length >= field.maxItems;
            const listPlaceholder = localizeText(field.placeholder, locale) || t('schema.addItemPlaceholder');
            return (
              <div key={field.key} className={styles.fieldRow}>
                <div className={styles.fieldHeader}>
                  <label htmlFor={inputId} className={styles.fieldLabel}>
                    {labelText}
                  </label>
                  {typeof field.maxItems === 'number' && (
                    <span className={styles.listHint}>
                      {items.length} / {field.maxItems}
                    </span>
                  )}
                </div>
                {fieldDesc && <div className={styles.fieldDesc}>{fieldDesc}</div>}
                <div className={styles.listContainer}>
                  {items.length > 0 && (
                    <div className={styles.listChips}>
                      {items.map((item, idx) => (
                        <span key={`${item}-${idx}`} className={styles.listChip}>
                          <span>{item}</span>
                          <button
                            type="button"
                            className={styles.listRemoveBtn}
                            aria-label={t('schema.removeItem', { item })}
                            disabled={isSaving}
                            onClick={() => handleRemoveListItem(field.key, idx)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className={styles.inputGroup}>
                    <input
                      id={inputId}
                      type="text"
                      className={styles.input}
                      value={listInputs[field.key] ?? ''}
                      placeholder={listPlaceholder}
                      disabled={isSaving || atLimit}
                      onChange={(e) =>
                        setListInputs((prev) => ({ ...prev, [field.key]: e.target.value }))
                      }
                      onKeyDown={(e) => handleListKeyDown(e, field)}
                    />
                    <button
                      type="button"
                      className={styles.smallBtn}
                      disabled={isSaving || atLimit}
                      onClick={() => handleAddListItem(field)}
                    >
                      {t('schema.add')}
                    </button>
                  </div>
                </div>
                {fieldErr && <div className={styles.fieldError}>{fieldErr}</div>}
              </div>
            );
          }

          if (secret) {
            const meta = getSecretMeta(field, values, secretState);
            const revealed = Boolean(revealedSecrets[field.key]);
            const placeholder =
              meta.masked ||
              localizeText(field.placeholder, locale) ||
              (meta.configured ? t('schema.secretKeepExisting') : t('schema.secretInputPlaceholder'));

            return (
              <div key={field.key} className={styles.fieldRow}>
                <div className={styles.fieldHeader}>
                  <label htmlFor={inputId} className={styles.fieldLabel}>
                    {labelText}
                  </label>
                  <span
                    className={`${styles.secretBadge} ${!meta.configured ? styles.secretBadgeUnset : ''}`.trim()}
                  >
                    {meta.configured ? t('schema.secretConfigured') : t('schema.secretUnset')}
                  </span>
                </div>
                {fieldDesc && <div className={styles.fieldDesc}>{fieldDesc}</div>}
                <div className={styles.inputGroup}>
                  <input
                    id={inputId}
                    type={revealed ? 'text' : 'password'}
                    className={styles.input}
                    autoComplete="off"
                    value={secretDrafts[field.key] ?? ''}
                    placeholder={placeholder}
                    disabled={isSaving}
                    onChange={(e) => {
                      const next = e.target.value;
                      setSecretDrafts((prev) => ({ ...prev, [field.key]: next }));
                      setDirtySecrets((prev) => ({ ...prev, [field.key]: next.length > 0 }));
                    }}
                  />
                  <button
                    type="button"
                    className={styles.smallBtn}
                    onClick={() =>
                      setRevealedSecrets((prev) => ({ ...prev, [field.key]: !prev[field.key] }))
                    }
                  >
                    {revealed ? t('schema.hide') : t('schema.show')}
                  </button>
                </div>
                {fieldErr && <div className={styles.fieldError}>{fieldErr}</div>}
              </div>
            );
          }

          return (
            <div key={field.key} className={styles.fieldRow}>
              <label htmlFor={inputId} className={styles.fieldLabel}>
                {labelText}
              </label>
              {fieldDesc && <div className={styles.fieldDesc}>{fieldDesc}</div>}
              <input
                id={inputId}
                type="text"
                className={styles.input}
                value={String(draft[field.key] ?? '')}
                placeholder={localizeText(field.placeholder, locale)}
                disabled={isSaving}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    [field.key]: e.target.value,
                  }))
                }
              />
              {fieldErr && <div className={styles.fieldError}>{fieldErr}</div>}
            </div>
          );
        })}
      </div>

      {schema.actions && schema.actions.length > 0 && (
        <div className={styles.actionsSection}>
          <div className={styles.actionsTitle}>{t('schema.actionsTitle')}</div>
          <div className={styles.actionsRow}>
            {schema.actions.map((action) => {
              const actionLabel = localizeText(action.label, locale) || action.id;
              const actionDesc = localizeText(action.description, locale);
              const isRunning = activeActionId === action.id;
              return (
                <button
                  key={action.id}
                  type="button"
                  title={actionDesc || undefined}
                  disabled={isSaving || activeActionId !== null}
                  className={`${styles.actionBtn} ${action.danger ? styles.actionBtnDanger : ''}`.trim()}
                  onClick={() => void handleActionClick(action)}
                >
                  {isRunning ? `${actionLabel}...` : actionLabel}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {displayError && (
        <div className={styles.alert} role="alert">
          {displayError}
        </div>
      )}
      {feedbackStatus && (
        <div className={styles.status} role="status">
          {feedbackStatus}
        </div>
      )}

      <div className={styles.footer}>
        <button type="submit" className={styles.saveBtn} disabled={isSaving}>
          {isSaving ? t('schema.saving') : t('schema.saveSettings')}
        </button>
      </div>
    </form>
  );
}
