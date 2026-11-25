import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ThemeProvider } from '../theme/ThemeProvider';
import { WriteConfirmModal } from './WriteConfirmModal';

describe('WriteConfirmModal', () => {
  it('renders nothing when challenge is null', () => {
    render(
      <ThemeProvider>
        <I18nProvider defaultLocale="en">
          <WriteConfirmModal challenge={null} onConfirm={vi.fn()} onCancel={vi.fn()} />
        </I18nProvider>
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('cloudflare-confirm-modal')).toBeNull();
  });

  it('displays action details and resolves on Confirm, Cancel, and Escape key', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <ThemeProvider>
        <I18nProvider defaultLocale="zh-CN">
          <WriteConfirmModal
            challenge={{
              action: 'PUT /api/v1/fs/write',
              channel: 'cloudflare',
              confirmToken: 'tok-1',
              method: 'PUT',
              path: '/api/v1/fs/write',
            }}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        </I18nProvider>
      </ThemeProvider>,
    );

    const dialog = screen.getByTestId('cloudflare-confirm-modal');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId('cloudflare-confirm-action')).toHaveTextContent(
      'PUT /api/v1/fs/write',
    );

    fireEvent.click(screen.getByTestId('cloudflare-confirm-submit'));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('cloudflare-confirm-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
