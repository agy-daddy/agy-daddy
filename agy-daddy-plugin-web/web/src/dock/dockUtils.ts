import { ApiError } from '../api/client';
import type { I18nKey, Locale, TranslateFn } from '../i18n';

export const MAX_SELECTION_SNIPPET_CHARS = 8000;

/**
 * Truncate a workspace file or diff snippet to a safe character budget for Side Chat context.
 */
export function truncateSelectionSnippet(
  text: string,
  maxChars = MAX_SELECTION_SNIPPET_CHARS,
): string {
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function safeDecodePercent(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function finalizeNormalizedPath(candidate: string): string {
  let normalized = safeDecodePercent(candidate);
  if (/^\/[A-Za-z]:(?:\/|$)/.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized.replace(/\/+$/, '') || '/';
}

/**
 * Convert a file:// URI or raw filesystem path into a normalized local path string.
 */
export function normalizeWorkspacePath(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('file://')) {
    try {
      const url = new URL(trimmed);
      return finalizeNormalizedPath(url.pathname);
    } catch {
      return finalizeNormalizedPath(trimmed.replace(/^file:\/\//, ''));
    }
  }

  return finalizeNormalizedPath(trimmed);
}

export function isPathOutsideError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'PATH_OUTSIDE_WORKSPACE';
}

/**
 * Format a byte count into a compact human-readable label.
 */
export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Format an ISO timestamp into a short locale string for dock previews.
 */
export function formatTimestamp(iso?: string | null, locale: Locale = 'en'): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function resolveDockErrorKey(code: string): I18nKey | null {
  switch (code) {
    case 'PATH_OUTSIDE_WORKSPACE':
      return 'dockErr.pathOutside';
    case 'FILE_NOT_FOUND':
      return 'dockErr.notFound';
    case 'ROOT_NOT_FOUND':
      return 'dockErr.rootNotFound';
    case 'PAYLOAD_TOO_LARGE':
      return 'dockErr.payloadTooLarge';
    case 'IS_A_DIRECTORY':
      return 'dockErr.isDirectory';
    case 'NOT_A_DIRECTORY':
      return 'dockErr.notDirectory';
    case 'INVALID_ROOT':
    case 'ROOT_NOT_DIRECTORY':
      return 'dockErr.invalidRoot';
    case 'UNAUTHORIZED':
      return 'dockErr.unauthorized';
    case 'CSRF_REQUIRED':
      return 'dockErr.csrfRequired';
    case 'WORKSPACE_SERVICE_UNAVAILABLE':
      return 'dockErr.unavailable';
    default:
      return null;
  }
}

/**
 * Map API and runtime errors to concise localized user-facing messages.
 */
export function formatDockError(
  err: unknown,
  fallback = 'Request failed, please try again.',
  t?: TranslateFn,
): string {
  if (err instanceof ApiError) {
    const key = resolveDockErrorKey(err.code);
    if (key && t) return t(key);
    if (key) {
      const englishMap: Record<string, string> = {
        'dockErr.pathOutside': 'Access denied: target path is outside allowed workspace roots.',
        'dockErr.notFound': 'Target file or directory not found.',
        'dockErr.rootNotFound': 'Workspace directory does not exist on disk.',
        'dockErr.payloadTooLarge': 'File content exceeds size limit.',
        'dockErr.isDirectory': 'Target is a directory, not a regular file.',
        'dockErr.notDirectory': 'Target path is not a directory.',
        'dockErr.invalidRoot': 'Workspace root is invalid or inaccessible.',
        'dockErr.unauthorized': 'Session unauthorized or expired; refresh with pairing URL.',
        'dockErr.csrfRequired': 'Security validation failed (missing CSRF header).',
        'dockErr.unavailable': 'Workspace service is currently unavailable.',
      };
      return englishMap[key] || fallback;
    }
    if (err.message && err.message !== err.code) {
      return `${err.message} (${err.code})`;
    }
    return t ? t('dockErr.actionFailed', { code: err.code }) : `Operation failed (${err.code})`;
  }

  if (err instanceof Error && err.message) {
    return err.message;
  }
  return fallback;
}
