import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ThemeProvider } from '../theme/ThemeProvider';
import { CustomMenuPopover } from './CustomMenuPopover';
import { apiClient } from '../api/client';

describe('CustomMenuPopover', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('lists quick plugins, toggles regular plugin, and requires confirmation before disabling agy-daddy.web', async () => {
    vi.spyOn(apiClient, 'getHostPlugins').mockResolvedValue({
      ok: true,
      plugins: [
        {
          id: 'agy-daddy.context',
          displayName: 'Context Monitor',
          version: '1.0.0',
          description: 'Context monitor plugin',
          trustLevel: 'official',
          badge: 'Official',
          enabled: true,
          active: true,
          world: 'node',
          hasNative: false,
          hasRollback: false,
          sourceKind: 'workspace',
          sourceSpec: 'workspace:agy-daddy.context',
          permissions: [],
        },
        {
          id: 'agy-daddy.web',
          displayName: 'PC Web UI',
          version: '1.0.0',
          description: 'PC Web UI plugin',
          trustLevel: 'official',
          badge: 'Official',
          enabled: true,
          active: true,
          world: 'node',
          hasNative: false,
          hasRollback: false,
          sourceKind: 'workspace',
          sourceSpec: 'workspace:agy-daddy.web',
          permissions: [],
        },
      ],
      catalog: [],
      marketStats: { total: 2, installed: 2, active: 2, catalogCount: 0 },
    });
    const actionSpy = vi.spyOn(apiClient, 'runHostPluginAction').mockResolvedValue({ ok: true, id: 'mock', action: 'disable' });
    const onOpenHostAdmin = vi.fn();
    const onClose = vi.fn();

    render(
      <I18nProvider defaultLocale="en">
        <ThemeProvider>
          <CustomMenuPopover
            connectionLabel="Live"
            connectionStatus="connected"
            rpcConnected={true}
            channelLabel="Local"
            channel="loopback"
            permissionLevel="L2"
            onOpenHostAdmin={onOpenHostAdmin}
            onClose={onClose}
          />
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('menu-plugin-row-agy-daddy.context')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('menu-plugin-toggle-agy-daddy.context'));
    await waitFor(() => {
      expect(actionSpy).toHaveBeenCalledWith('agy-daddy.context', 'disable');
    });

    fireEvent.click(screen.getByTestId('menu-plugin-toggle-agy-daddy.web'));
    expect(screen.getByTestId('menu-disable-web-confirm')).toBeInTheDocument();
    expect(actionSpy).not.toHaveBeenCalledWith('agy-daddy.web', 'disable');

    fireEvent.click(screen.getByTestId('menu-disable-web-confirm-btn'));
    await waitFor(() => {
      expect(actionSpy).toHaveBeenCalledWith('agy-daddy.web', 'disable');
    });

    fireEvent.click(screen.getByTestId('menu-plugin-settings-agy-daddy.context'));
    expect(onOpenHostAdmin).toHaveBeenCalledWith('plugins', 'agy-daddy.context');
  });

  it('locks plugin toggles under L1 non-loopback tier', async () => {
    vi.spyOn(apiClient, 'getHostPlugins').mockResolvedValue({
      ok: true,
      plugins: [
        {
          id: 'agy-daddy.context',
          displayName: 'Context Monitor',
          version: '1.0.0',
          description: 'Context monitor plugin',
          trustLevel: 'official',
          badge: 'Official',
          enabled: true,
          active: true,
          world: 'node',
          hasNative: false,
          hasRollback: false,
          sourceKind: 'workspace',
          sourceSpec: 'workspace:agy-daddy.context',
          permissions: [],
        },
      ],
      catalog: [],
      marketStats: { total: 2, installed: 2, active: 2, catalogCount: 0 },
    });

    render(
      <I18nProvider defaultLocale="en">
        <ThemeProvider>
          <CustomMenuPopover
            connectionLabel="Live"
            connectionStatus="connected"
            channelLabel="LAN"
            channel="lan"
            permissionLevel="L1"
            onClose={vi.fn()}
          />
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('menu-perm-locked-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('menu-plugin-toggle-agy-daddy.context')).toBeDisabled();
  });
});
