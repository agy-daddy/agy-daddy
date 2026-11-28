import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setConfirmWriteHandler } from '../api/client';
import { I18nProvider } from '../i18n';
import { ThemeProvider } from '../theme/ThemeProvider';
import { HostAdminModal } from './HostAdminModal';

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HostAdminModal auto-update UI', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    setConfirmWriteHandler(null);
  });

  afterEach(() => {
    setConfirmWriteHandler(null);
    globalThis.fetch = originalFetch;
  });

  it('renders host & plugin updates, enforces loading states, persists update settings, and handles pin + permission confirm', async () => {
    const user = userEvent.setup();
    const checkDeferred = createDeferred<Response>();
    let applyCount = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.startsWith('/api/v1/host/plugins?')) {
        return jsonResponse({
          ok: true,
          scope: 'web',
          hiddenDesktopCount: 0,
          allPluginsCount: 2,
          plugins: [
            {
              id: 'agy-daddy.quota',
              displayName: 'Quota Monitor',
              description: 'Quota stats',
              version: '1.1.1',
              trustLevel: 'T0',
              badge: 'official',
              world: 'isolated',
              enabled: true,
              active: true,
              hasNative: false,
              hasRollback: true,
              pinned: false,
              permissions: ['rpc:read'],
              sourceKind: 'npm',
              sourceSpec: 'npm:@agy-daddy/plugin-quota@latest',
              updateInfo: {
                targetId: 'agy-daddy.quota',
                currentVersion: '1.1.1',
                latestVersion: '1.2.0',
                status: 'available',
                addedPermissions: [],
                addedHighRiskPermissions: [],
              },
            },
            {
              id: 'third.sample',
              displayName: 'Sample Plugin',
              description: 'Community extension',
              version: '1.0.0',
              trustLevel: 'T2',
              badge: 'community',
              world: 'isolated',
              enabled: true,
              active: true,
              hasNative: false,
              hasRollback: false,
              pinned: true,
              permissions: ['dom:read'],
              sourceKind: 'github',
              sourceSpec: 'github:third/sample',
              updateInfo: {
                targetId: 'third.sample',
                currentVersion: '1.0.0',
                latestVersion: '2.0.0',
                majorUpdateAvailable: '2.0.0',
                status: 'available',
                addedPermissions: ['process:spawn'],
                addedHighRiskPermissions: ['process:spawn'],
              },
            },
          ],
          catalog: [],
          marketStats: { total: 2, installed: 2, active: 2, catalogCount: 0 },
        });
      }

      if (url === '/api/v1/host/updates') {
        return jsonResponse({
          ok: true,
          hostVersion: '1.1.1',
          anchorsVersion: '1.1.1',
          installMode: 'wrapper',
          settings: {
            updateChannel: 'stable',
            autoUpdateMode: 'notify',
            updateCheckInterval: '6h',
            updateSourcePreference: 'auto',
            npmRegistryUrl: '',
          },
          scheduler: {
            enabled: true,
            runningCheck: false,
            applyingUpdate: false,
            lastCheckedAt: '2026-11-28T08:30:00.000Z',
            nextCheckAt: null,
          },
          summary: {
            availableCount: 3,
            pluginAvailableCount: 2,
            hostAvailable: true,
            registryAvailable: false,
            blockedCount: 0,
          },
          targets: {
            host: {
              targetId: 'host',
              kind: 'host',
              currentVersion: '1.1.1',
              latestVersion: '1.2.0',
              status: 'available',
              hasRollback: true,
              wrapperUpdateRecommended: true,
              wrapperMinVersion: '1.2.0',
              releaseNotesUrl: 'https://github.com/agy-daddy/agy-daddy/releases/tag/v1.2.0',
            },
            'agy-daddy.quota': {
              targetId: 'agy-daddy.quota',
              currentVersion: '1.1.1',
              latestVersion: '1.2.0',
              status: 'available',
            },
            'third.sample': {
              targetId: 'third.sample',
              currentVersion: '1.0.0',
              latestVersion: '2.0.0',
              majorUpdateAvailable: '2.0.0',
              status: 'available',
              addedPermissions: ['process:spawn'],
              addedHighRiskPermissions: ['process:spawn'],
            },
          },
        });
      }

      if (url === '/api/v1/host/updates/check') {
        return checkDeferred.promise;
      }

      if (url === '/api/v1/host/updates/apply') {
        applyCount++;
        if (applyCount === 1 && Array.isArray(body.targets) && body.targets.includes('third.sample')) {
          return jsonResponse({
            ok: false,
            errorCode: 'PERMISSION_CONFIRMATION_REQUIRED',
            needsPermissionConfirm: true,
            needsMajorConfirm: true,
            confirmations: [
              {
                pluginId: 'third.sample',
                displayName: 'Sample Plugin',
                trustLevel: 'T2',
                fromVersion: '1.0.0',
                toVersion: '2.0.0',
                majorUpdate: true,
                currentPermissions: ['dom:read'],
                addedPermissions: ['process:spawn'],
                addedHighRiskPermissions: ['process:spawn'],
              },
            ],
          });
        }
        return jsonResponse({
          ok: true,
          deferredReload: true,
          results: [{ targetId: 'third.sample', outcome: 'succeeded', fromVersion: '1.0.0', toVersion: '2.0.0' }],
        });
      }

      if (url === '/api/v1/host/updates/pin') {
        return jsonResponse({ ok: true, pluginId: body.pluginId, pinned: body.pinned });
      }

      if (url === '/api/v1/host/update-settings') {
        return jsonResponse({ ok: true, values: body.patch || {} });
      }

      if (url === '/api/v1/host/doctor') {
        return jsonResponse({
          ok: true,
          generatedAt: '2026-11-28T08:45:00.000Z',
          hostApiVersion: '1.2.0',
          platform: 'darwin',
          arch: 'arm64',
          paths: { stateDir: '/tmp/state', pluginsDir: '/tmp/plugins' },
          runtime: {},
          antigravity: { hostProcess: {}, cdpPort: 9222, cdpTargetsCount: 1 },
          anchors: { schemaVersion: 1, count: 15, sourcePath: 'anchors.json' },
          plugins: { count: 1, items: [] },
          daemon: { lockPresent: false, lock: null },
          migration: { completed: true, migratedAt: null },
          legacySuite: {},
          updates: { installMode: 'wrapper', scheduler: { enabled: true } },
        });
      }

      return jsonResponse({ ok: true, values: {} });
    });

    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <I18nProvider defaultLocale="en">
        <ThemeProvider>
          <HostAdminModal open initialTab="plugins" onClose={() => {}} />
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('host-updates-panel')).toBeInTheDocument());
    expect(screen.getByTestId('host-updates-panel')).toHaveTextContent('Host v1.1.1');
    expect(screen.getByTestId('host-updates-panel')).toHaveTextContent('Wrapper');
    expect(screen.getByTestId('host-updates-panel')).toHaveTextContent('3 update(s) available');
    expect(screen.getByTestId('plugin-update-badge-agy-daddy.quota')).toHaveTextContent(
      'v1.1.1 → v1.2.0',
    );
    expect(screen.getByTestId('plugin-pinned-badge-third.sample')).toHaveTextContent('Pinned');

    // Immediate loading feedback & anti-double-click on Check Updates
    const checkBtn = screen.getByTestId('updates-check-btn');
    await user.click(checkBtn);
    expect(checkBtn).toBeDisabled();
    expect(checkBtn).toHaveTextContent('Checking…');
    await user.click(checkBtn);
    expect(fetchMock.mock.calls.filter(([u]) => u === '/api/v1/host/updates/check')).toHaveLength(1);

    checkDeferred.resolve(
      jsonResponse({
        ok: true,
        hostVersion: '1.1.1',
        summary: { availableCount: 3, pluginAvailableCount: 2, hostAvailable: true },
        targets: {},
      }),
    );
    await waitFor(() => expect(screen.getByTestId('updates-check-btn')).not.toBeDisabled());
    expect(screen.getByText('Found 3 available update(s)')).toBeInTheDocument();

    // Update settings write to /api/v1/host/update-settings (not /api/v1/host/settings)
    await user.selectOptions(screen.getByTestId('updates-channel-select'), 'next');
    await user.selectOptions(screen.getByTestId('updates-auto-mode-select'), 'manual');
    expect(screen.getByTestId('updates-interval-select')).toBeDisabled();

    const regInput = screen.getByTestId('updates-registry-input');
    await user.clear(regInput);
    await user.type(regInput, 'https://registry.npmmirror.com/');
    await user.click(screen.getByTestId('updates-registry-save-btn'));

    expect(
      fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/host/settings'),
    ).toBe(false);
    const updateSettingsCalls = fetchMock.mock.calls.filter(
      ([u]) => String(u) === '/api/v1/host/update-settings',
    );
    expect(updateSettingsCalls.length).toBeGreaterThanOrEqual(3);
    const lastSettingsBody = JSON.parse(String(updateSettingsCalls.at(-1)?.[1]?.body));
    expect(lastSettingsBody.patch.npmRegistryUrl).toBe('https://registry.npmmirror.com');

    // Pin toggle
    await user.click(screen.getByTestId('plugin-pin-agy-daddy.quota'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/host/updates/pin'),
      ).toBe(true),
    );

    // Permission & major upgrade confirmation flow + deferredReload notice
    await user.click(screen.getByTestId('plugin-update-third.sample'));
    await waitFor(() =>
      expect(screen.getByTestId('host-admin-update-confirm')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('host-admin-update-confirm')).toHaveTextContent(
      'process:spawn (High Risk)',
    );
    expect(screen.getByTestId('host-admin-update-confirm')).toHaveTextContent('Major Upgrade');

    await user.click(screen.getByTestId('updates-confirm-approve-btn'));
    await waitFor(() =>
      expect(
        screen.getByText('Update applied; agy-daddy.web is reloading…'),
      ).toBeInTheDocument(),
    );

    // Doctor tab shows Updates & Scheduler card
    await user.click(screen.getByRole('tab', { name: 'Doctor' }));
    await waitFor(() => expect(screen.getByTestId('doctor-updates-card')).toBeInTheDocument());
  });

  it('enforces L0/L1 read-only gate and invokes WriteConfirmModal challenge on remote L2 channel', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers as Record<string, string>) || {};
      if (url.startsWith('/api/v1/host/plugins?')) {
        return jsonResponse({
          ok: true,
          scope: 'web',
          plugins: [
            {
              id: 'agy-daddy.quota',
              displayName: 'Quota Monitor',
              description: 'Quota stats',
              version: '1.1.1',
              trustLevel: 'T0',
              badge: 'official',
              world: 'isolated',
              enabled: true,
              active: true,
              hasNative: false,
              hasRollback: true,
              permissions: [],
              sourceKind: 'npm',
              sourceSpec: 'npm:@agy-daddy/plugin-quota@latest',
            },
          ],
          catalog: [],
          marketStats: { total: 1, installed: 1, active: 1, catalogCount: 0 },
        });
      }
      if (url === '/api/v1/host/updates') {
        return jsonResponse({
          ok: true,
          hostVersion: '1.1.1',
          installMode: 'wrapper',
          settings: {
            updateChannel: 'stable',
            autoUpdateMode: 'notify',
            updateCheckInterval: '6h',
            updateSourcePreference: 'auto',
            npmRegistryUrl: '',
          },
          summary: { availableCount: 1, pluginAvailableCount: 0, hostAvailable: true },
          targets: {
            host: {
              targetId: 'host',
              currentVersion: '1.1.1',
              latestVersion: '1.2.0',
              status: 'available',
              hasRollback: true,
            },
          },
        });
      }
      if (url === '/api/v1/host/updates/apply' && !headers['X-Agy-Confirm']) {
        return jsonResponse(
          {
            ok: false,
            error: 'CONFIRMATION_REQUIRED',
            confirmToken: 'cf_upd_123',
            channel: 'cloudflare',
            action: 'POST /api/v1/host/updates/apply',
          },
          403,
        );
      }
      if (url === '/api/v1/host/updates/apply' && headers['X-Agy-Confirm'] === 'cf_upd_123') {
        return jsonResponse({
          ok: true,
          handoff: true,
          targetVersion: '1.2.0',
        });
      }
      return jsonResponse({ ok: true, values: {} });
    });

    globalThis.fetch = fetchMock as typeof fetch;

    // 1. L1 on non-loopback channel locks all update controls
    const { rerender } = render(
      <I18nProvider defaultLocale="en">
        <ThemeProvider>
          <HostAdminModal
            open
            initialTab="plugins"
            channel="lan"
            permissionLevel="L1"
            onClose={() => {}}
          />
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('host-updates-panel')).toBeInTheDocument());
    expect(screen.getByTestId('host-admin-perm-locked')).toBeInTheDocument();
    expect(screen.getByTestId('updates-check-btn')).toBeDisabled();
    expect(screen.getByTestId('updates-host-apply-btn')).toBeDisabled();
    expect(screen.getByTestId('updates-host-rollback-btn')).toBeDisabled();
    expect(screen.getByTestId('updates-channel-select')).toBeDisabled();
    expect(screen.getByTestId('plugin-pin-agy-daddy.quota')).toBeDisabled();

    // 2. L2 on remote cloudflare channel triggers WriteConfirmModal handler
    const confirmSpy = vi.fn(async () => true);
    setConfirmWriteHandler(confirmSpy);

    rerender(
      <I18nProvider defaultLocale="en">
        <ThemeProvider>
          <HostAdminModal
            open
            initialTab="plugins"
            channel="cloudflare"
            permissionLevel="L2"
            onClose={() => {}}
          />
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('updates-host-apply-btn')).not.toBeDisabled());
    await user.click(screen.getByTestId('updates-host-apply-btn'));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByText('Host updater started for v1.2.0; daemon is restarting…'),
      ).toBeInTheDocument(),
    );
  });

  it('surfaces rollback results and check errors on HTTP 400 instead of HTTP_400, and renders per-item isMajor badge', async () => {
    const user = userEvent.setup();
    let checkCalls = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/v1/host/plugins')) {
          return jsonResponse({
            ok: true,
            plugins: [
              {
                id: 'agy-daddy.quota',
                displayName: 'Quota Monitor',
                version: '1.1.1',
                trustLevel: 'T0',
                world: 'isolated',
                sourceKind: 'npm',
                enabled: true,
                active: true,
                webRelevant: true,
                permissions: ['rpc:read'],
              },
            ],
            catalog: [],
          });
        }
        if (url === '/api/v1/host/updates') {
          return jsonResponse({
            ok: true,
            hostVersion: '1.1.1',
            anchorsVersion: '1.1.1',
            installMode: 'wrapper',
            settings: {
              updateChannel: 'stable',
              autoUpdateMode: 'notify',
              updateCheckInterval: '6h',
              updateSourcePreference: 'auto',
              npmRegistryUrl: '',
            },
            summary: { availableCount: 1, pluginAvailableCount: 1, hostAvailable: false },
            targets: {
              'agy-daddy.quota': {
                targetId: 'agy-daddy.quota',
                kind: 'plugin',
                currentVersion: '1.1.1',
                latestVersion: '1.2.0',
                status: 'available',
              },
            },
          });
        }
        if (url === '/api/v1/host/updates/check') {
          checkCalls++;
          return new Response(
            JSON.stringify({
              ok: false,
              errorCode: 'UPDATE_RATE_LIMITED',
              error: 'UPDATE_RATE_LIMITED',
              message: 'Rate limit exceeded',
              errors: [
                {
                  targetId: 'host',
                  errorCode: 'UPDATE_RATE_LIMITED',
                  errorMessage: 'Rate limit exceeded',
                },
              ],
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url === '/api/v1/host/updates/apply') {
          return new Response(
            JSON.stringify({
              ok: false,
              errorCode: 'UPDATE_ROLLBACK_TRIGGERED',
              results: [
                {
                  targetId: 'agy-daddy.quota',
                  outcome: 'rolled_back',
                  errorCode: 'UPDATE_ROLLBACK_TRIGGERED',
                  errorMessage: 'Plugin crashed on reload',
                },
              ],
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return jsonResponse({ ok: true });
      }),
    );

    render(
      <I18nProvider defaultLocale="en">
        <ThemeProvider>
          <HostAdminModal
            open
            initialTab="plugins"
            channel="loopback"
            permissionLevel="L2"
            onClose={() => {}}
          />
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('updates-check-btn')).toBeInTheDocument());

    await user.click(screen.getByTestId('updates-check-btn'));
    await waitFor(() => expect(checkCalls).toBe(1));
    await waitFor(() => expect(screen.getByText('Rate limit exceeded')).toBeInTheDocument());

    await user.click(screen.getByTestId('plugin-update-agy-daddy.quota'));
    await waitFor(() =>
      expect(
        screen.getByText(
          'agy-daddy.quota failed health check and rolled back (UPDATE_ROLLBACK_TRIGGERED)',
        ),
      ).toBeInTheDocument(),
    );
  });
});
