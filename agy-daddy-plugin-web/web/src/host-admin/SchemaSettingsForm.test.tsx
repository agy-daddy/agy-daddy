import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '../i18n';
import { ThemeProvider } from '../theme/ThemeProvider';
import { HostAdminModal } from './HostAdminModal';
import { SchemaSettingsForm } from './SchemaSettingsForm';
import { TopbarCapsules } from './TopbarCapsules';
import type { SettingsSchema, SecretFieldState } from '../types';

const FULL_SCHEMA: SettingsSchema = {
  version: 1,
  title: { 'zh-CN': '远程与网关设置', en: 'Remote & Gateway Settings' },
  description: { 'zh-CN': '配置所有字段类型与操作命令', en: 'Configure all field types and actions' },
  fields: [
    {
      key: 'enabled',
      type: 'boolean',
      default: false,
      label: { 'zh-CN': '启用功能', en: 'Enable Feature' },
    },
    {
      key: 'mode',
      type: 'enum',
      default: 'quick',
      options: [
        { value: 'quick', label: { 'zh-CN': '临时隧道', en: 'Quick Tunnel' } },
        { value: 'named', label: { 'zh-CN': '固定隧道', en: 'Named Tunnel' } },
      ],
      label: { 'zh-CN': '运行模式', en: 'Run Mode' },
    },
    {
      key: 'endpoint',
      type: 'string',
      default: 'https://example.local',
      label: { 'zh-CN': '服务地址', en: 'Endpoint URL' },
      placeholder: { 'zh-CN': '输入地址', en: 'Enter URL' },
    },
    {
      key: 'port',
      type: 'number',
      min: 1024,
      max: 65535,
      default: 18766,
      label: { 'zh-CN': '监听端口', en: 'Listen Port' },
    },
    {
      key: 'allowedRoots',
      type: 'list',
      maxItems: 3,
      default: [],
      label: { 'zh-CN': '根目录白名单', en: 'Allowed Roots' },
      placeholder: { 'zh-CN': '新增路径', en: 'Add path' },
    },
    {
      key: 'tunnelToken',
      type: 'string',
      writeOnly: true,
      secret: true,
      label: { 'zh-CN': '隧道密钥', en: 'Tunnel Token' },
    },
  ],
  actions: [
    {
      id: 'rescan',
      commandId: 'agy-daddy.remote.rescan',
      label: { 'zh-CN': '立即重扫', en: 'Rescan Now' },
    },
    {
      id: 'reset',
      commandId: 'agy-daddy.remote.reset',
      label: { 'zh-CN': '重置通道', en: 'Reset Channel' },
      danger: true,
    },
  ],
};

describe('Suite F2: SchemaSettingsForm', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders boolean, enum, string, number, list fields and schema.actions in English by default', () => {
    const values = {
      enabled: true,
      mode: 'named',
      endpoint: 'https://gw.internal',
      port: 19000,
      allowedRoots: ['/workspace/a'],
      tunnelToken: '****-9a1f',
    };
    const secretState: Record<string, SecretFieldState> = {
      tunnelToken: { configured: true, masked: '****-9a1f' },
    };

    render(
      <SchemaSettingsForm
        pluginId="agy-daddy.remote"
        schema={FULL_SCHEMA}
        values={values}
        secretState={secretState}
      />,
    );

    expect(screen.getByText('Remote & Gateway Settings')).toBeInTheDocument();

    const checkbox = screen.getByRole('checkbox', { name: /Enable Feature/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    const select = screen.getByRole('combobox', { name: /Run Mode/i }) as HTMLSelectElement;
    expect(select.value).toBe('named');
    expect(screen.getByRole('option', { name: 'Quick Tunnel' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Named Tunnel' })).toBeInTheDocument();

    const stringInput = screen.getByLabelText(/Endpoint URL/i) as HTMLInputElement;
    expect(stringInput.value).toBe('https://gw.internal');

    const numberInput = screen.getByLabelText(/Listen Port/i) as HTMLInputElement;
    expect(numberInput.value).toBe('19000');

    expect(screen.getByText('/workspace/a')).toBeInTheDocument();

    const secretInput = screen.getByLabelText(/Tunnel Token/i) as HTMLInputElement;
    expect(secretInput.value).toBe('');
    expect(secretInput.placeholder).toBe('****-9a1f');

    expect(screen.getByRole('button', { name: 'Rescan Now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset Channel' })).toBeInTheDocument();
  });

  it('renders localized Chinese schema labels when locale="zh-CN" is explicitly passed', () => {
    render(
      <SchemaSettingsForm
        pluginId="agy-daddy.remote"
        schema={FULL_SCHEMA}
        values={{ enabled: true, mode: 'quick' }}
        locale="zh-CN"
      />,
    );

    expect(screen.getByText('远程与网关设置')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /启用功能/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即重扫' })).toBeInTheDocument();
  });

  it('preserves unedited writeOnly/secretState fields without overwriting them on save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({ ok: true });

    render(
      <SchemaSettingsForm
        pluginId="agy-daddy.remote"
        schema={FULL_SCHEMA}
        values={{
          enabled: false,
          mode: 'quick',
          endpoint: 'https://gw.internal',
          port: 18766,
          allowedRoots: ['/repo/one'],
          tunnelToken: '****-9a1f',
        }}
        secretState={{
          tunnelToken: { configured: true, masked: '****-9a1f' },
        }}
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: /Enable Feature/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /Run Mode/i }), 'named');

    const portInput = screen.getByLabelText(/Listen Port/i);
    await user.clear(portInput);
    await user.type(portInput, '19500');

    await user.click(screen.getByRole('button', { name: /Save Settings/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Record<string, unknown>;

    expect(patch.enabled).toBe(true);
    expect(patch.mode).toBe('named');
    expect(patch.port).toBe(19500);
    expect(patch.allowedRoots).toEqual(['/repo/one']);
    expect('tunnelToken' in patch).toBe(false);
  });

  it('includes a writeOnly secret in patch only when explicitly edited by user', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({ ok: true });

    render(
      <SchemaSettingsForm
        pluginId="agy-daddy.remote"
        schema={FULL_SCHEMA}
        values={{
          enabled: true,
          mode: 'named',
          endpoint: 'https://gw.internal',
          port: 18766,
          allowedRoots: [],
          tunnelToken: '****-9a1f',
        }}
        secretState={{
          tunnelToken: { configured: true, masked: '****-9a1f' },
        }}
        onSave={onSave}
      />,
    );

    const secretInput = screen.getByLabelText(/Tunnel Token/i);
    await user.type(secretInput, 'new-secret-value-xyz');
    await user.click(screen.getByRole('button', { name: /Save Settings/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.tunnelToken).toBe('new-secret-value-xyz');
  });

  it('supports adding and removing list items and enforces maxItems', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({ ok: true });

    render(
      <SchemaSettingsForm
        pluginId="agy-daddy.remote"
        schema={FULL_SCHEMA}
        values={{
          enabled: true,
          mode: 'quick',
          endpoint: 'https://gw.internal',
          port: 18766,
          allowedRoots: ['/a', '/b'],
        }}
        onSave={onSave}
      />,
    );

    const listInput = screen.getByPlaceholderText('Add path');
    const addBtn = screen.getByRole('button', { name: /^Add$/i });

    await user.type(listInput, '/c');
    await user.click(addBtn);
    expect(screen.getByText('/c')).toBeInTheDocument();
    expect(addBtn).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Remove \/a/i }));
    expect(screen.queryByText('/a')).not.toBeInTheDocument();
    expect(addBtn).not.toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Save Settings/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].allowedRoots).toEqual(['/b', '/c']);
  });

  it('validates number bounds before submitting', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({ ok: true });

    render(
      <SchemaSettingsForm
        pluginId="agy-daddy.remote"
        schema={FULL_SCHEMA}
        values={{ port: 18766 }}
        onSave={onSave}
      />,
    );

    const portInput = screen.getByLabelText(/Listen Port/i);
    await user.clear(portInput);
    await user.type(portInput, '80');
    await user.click(screen.getByRole('button', { name: /Save Settings/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/1024/);
  });

  it('calls PUT /api/v1/host/plugins/:id/settings with { patch } and executes schema.actions via POST /api/v1/host/commands/:cmdId when callbacks are omitted', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/settings')) {
        return new Response(
          JSON.stringify({
            ok: true,
            values: { enabled: true, mode: 'quick', endpoint: 'https://updated.local', port: 18766, allowedRoots: [] },
            secretState: { tunnelToken: { configured: true, masked: '****-9a1f' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/commands/')) {
        return new Response(
          JSON.stringify({ ok: true, commandId: 'agy-daddy.remote.rescan', result: { scanned: 3 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <SchemaSettingsForm
        pluginId="agy-daddy.remote"
        schema={FULL_SCHEMA}
        values={{
          enabled: true,
          mode: 'quick',
          endpoint: 'https://old.local',
          port: 18766,
          allowedRoots: [],
          tunnelToken: '****-9a1f',
        }}
        secretState={{ tunnelToken: { configured: true, masked: '****-9a1f' } }}
      />,
    );

    const endpointInput = screen.getByLabelText(/Endpoint URL/i);
    await user.clear(endpointInput);
    await user.type(endpointInput, 'https://updated.local');
    await user.click(screen.getByRole('button', { name: /Save Settings/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [saveUrl, saveInit] = fetchMock.mock.calls[0];
    expect(saveUrl).toBe('/api/v1/host/plugins/agy-daddy.remote/settings');
    expect(saveInit?.method).toBe('PUT');
    expect((saveInit?.headers as Record<string, string>)['X-Agy-Csrf']).toBe('1');
    const parsedBody = JSON.parse(String(saveInit?.body));
    expect(parsedBody.patch.endpoint).toBe('https://updated.local');
    expect('tunnelToken' in parsedBody.patch).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Rescan Now' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [cmdUrl, cmdInit] = fetchMock.mock.calls[1];
    expect(cmdUrl).toBe('/api/v1/host/commands/agy-daddy.remote.rescan');
    expect(cmdInit?.method).toBe('POST');
    expect(JSON.parse(String(cmdInit?.body))).toEqual({ pluginId: 'agy-daddy.remote', args: [] });
  });
});

describe('TopbarCapsules & HostAdminModal (Modules 2 & 5)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders 10-language selector and ASCII parentheses in TopbarCapsules', async () => {
    const user = userEvent.setup();
    const onLocaleChange = vi.fn();

    render(
      <I18nProvider defaultLocale="en" onLocaleChange={onLocaleChange}>
        <ThemeProvider>
          <TopbarCapsules
            panels={{
              context: { available: true, source: 'service', data: { used: 1200, percent: 25 } },
              usage: { available: true, source: 'state', data: { totalCost: 0.42 } },
              quota: { available: true, source: 'service', data: { percent: 80 } },
            }}
          />
        </ThemeProvider>
      </I18nProvider>,
    );

    await user.click(screen.getByTestId('topbar-custom-menu-btn'));
    const select = screen.getByTestId('topbar-locale-select') as HTMLSelectElement;
    expect(select.options).toHaveLength(10);
    expect(select.value).toBe('en');

    const contextBtn = screen.getByText('Context').closest('button')!;
    const usageBtn = screen.getByText('Usage').closest('button')!;
    const quotaBtn = screen.getByText('Quota').closest('button')!;
    expect(contextBtn.title).toContain('(');
    expect(contextBtn.title).not.toContain('（');
    expect(usageBtn.title).toContain('(');
    expect(usageBtn.title).not.toContain('（');
    expect(quotaBtn.title).toContain('(');
    expect(quotaBtn.title).not.toContain('（');

    await user.selectOptions(select, 'ja');
    expect(onLocaleChange).toHaveBeenCalledWith('ja');
    expect(select.value).toBe('ja');
  });

  it('scopes plugins/settings to web by default, toggles desktop plugins, and syncs appearance locale without writing agy-daddy.web', async () => {
    const user = userEvent.setup();
    const onLocaleChange = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/v1/host/plugins?') || url === '/api/v1/host/plugins') {
        const isAll = url.includes('scope=all');
        return new Response(
          JSON.stringify({
            ok: true,
            scope: isAll ? 'all' : 'web',
            hiddenDesktopCount: 1,
            allPluginsCount: 2,
            plugins: isAll
              ? [
                  {
                    id: 'agy-daddy.web',
                    displayName: 'Web Workbench',
                    description: 'Web UI',
                    version: '1.0.0',
                    trustLevel: 'T0',
                    badge: 'built-in',
                    world: 'isolated',
                    enabled: true,
                    active: true,
                    hasNative: false,
                    hasRollback: false,
                    permissions: [],
                    sourceKind: 'builtin',
                    sourceSpec: 'builtin',
                    webRelevant: true,
                  },
                  {
                    id: 'agy-daddy.desktop-tray',
                    displayName: 'Desktop Tray',
                    description: 'Tray icon',
                    version: '1.0.0',
                    trustLevel: 'T1',
                    badge: 'desktop',
                    world: 'isolated',
                    enabled: true,
                    active: true,
                    hasNative: false,
                    hasRollback: false,
                    permissions: [],
                    sourceKind: 'builtin',
                    sourceSpec: 'builtin',
                    webRelevant: false,
                  },
                ]
              : [
                  {
                    id: 'agy-daddy.web',
                    displayName: 'Web Workbench',
                    description: 'Web UI',
                    version: '1.0.0',
                    trustLevel: 'T0',
                    badge: 'built-in',
                    world: 'isolated',
                    enabled: true,
                    active: true,
                    hasNative: false,
                    hasRollback: false,
                    permissions: [],
                    sourceKind: 'builtin',
                    sourceSpec: 'builtin',
                    webRelevant: true,
                  },
                ],
            catalog: [],
            marketStats: { total: 2, installed: isAll ? 2 : 1, active: isAll ? 2 : 1, catalogCount: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.includes('/api/v1/host/plugins/agy-daddy.web/settings')) {
        if (init?.method === 'PUT') {
          return new Response(
            JSON.stringify({ ok: true, values: { theme: 'dark', colorTheme: 'blue' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const isAll = url.includes('scope=all');
        return new Response(
          JSON.stringify({
            ok: true,
            scope: isAll ? 'all' : 'web',
            filteredDesktopFieldCount: isAll ? 0 : 2,
            values: { port: 18766 },
            schema: {
              version: 1,
              fields: [{ key: 'port', type: 'number', label: 'Port', default: 18766 }],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({ ok: true, values: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <I18nProvider defaultLocale="en" onLocaleChange={onLocaleChange}>
        <ThemeProvider>
          <HostAdminModal open initialTab="plugins" onClose={() => {}} />
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('web-plugin-scope-bar')).toBeInTheDocument());
    expect(screen.getByTestId('desktop-fields-hidden-notice')).toHaveTextContent(
      '2 desktop-only field(s) hidden',
    );
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/host/plugins?scope=web')).toBe(
      true,
    );
    expect(
      fetchMock.mock.calls.some(
        ([u]) => String(u) === '/api/v1/host/plugins/agy-daddy.web/settings?scope=web',
      ),
    ).toBe(true);

    const toggle = screen.getByTestId('toggle-desktop-plugins') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await user.click(toggle);

    await waitFor(() => expect(screen.getByText('Desktop Tray')).toBeInTheDocument());
    expect(screen.getByTestId('desktop-only-badge-agy-daddy.desktop-tray')).toHaveTextContent(
      'Desktop only',
    );
    expect(screen.queryByTestId('desktop-fields-hidden-notice')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/host/plugins?scope=all')).toBe(
      true,
    );

    // Switch to Appearance tab and test 10-language selector + theme saving
    await user.click(screen.getByTestId('admin-tab-appearance'));
    const appearanceSelect = screen.getByTestId('appearance-locale-select') as HTMLSelectElement;
    expect(appearanceSelect.options).toHaveLength(10);
    expect(screen.getByText('Synced with Host')).toBeInTheDocument();

    const putCountBefore = fetchMock.mock.calls.filter(([, i]) => i?.method === 'PUT').length;
    await user.selectOptions(appearanceSelect, 'fr');
    expect(onLocaleChange).toHaveBeenCalledWith('fr');
    const putCountAfterLocale = fetchMock.mock.calls.filter(([, i]) => i?.method === 'PUT').length;
    expect(putCountAfterLocale).toBe(putCountBefore);

    await user.click(screen.getByTestId('color-theme-blue'));
    await waitFor(() => {
      const puts = fetchMock.mock.calls.filter(([, i]) => i?.method === 'PUT');
      expect(puts).toHaveLength(1);
      expect(JSON.parse(String(puts[0][1]?.body))).toEqual({ patch: { colorTheme: 'blue' } });
    });
  });

  it('renders field groups and requests notification permission only when enableNotifications is turned on', async () => {
    const user = userEvent.setup();
    const requestPermission = vi.fn().mockResolvedValue('granted');
    const originalNotification = window.Notification;
    const MockNotification = vi.fn() as unknown as typeof Notification;
    Object.defineProperty(MockNotification, 'permission', {
      configurable: true,
      get: () => 'default',
    });
    (MockNotification as unknown as { requestPermission: typeof requestPermission }).requestPermission =
      requestPermission;
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: MockNotification,
    });

    const onWebSettingsUpdated = vi.fn();
    let storedValues: Record<string, unknown> = { enableNotifications: false };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/v1/host/plugins?')) {
        return new Response(
          JSON.stringify({
            ok: true,
            plugins: [
              {
                id: 'agy-daddy.web',
                displayName: 'PC Web Workbench',
                version: '1.1.1',
                trustLevel: 'T0',
                badge: 'built-in',
                world: 'isolated',
                enabled: true,
                active: true,
                hasNative: false,
                hasRollback: false,
                permissions: [],
                sourceKind: 'builtin',
                sourceSpec: 'builtin',
              },
            ],
            catalog: [],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/v1/host/plugins/agy-daddy.web/settings') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        storedValues = { ...storedValues, ...body.patch };
        return new Response(
          JSON.stringify({
            ok: true,
            values: { ...storedValues },
            schema: {
              version: 1,
              fields: [
                {
                  key: 'enableNotifications',
                  type: 'boolean',
                  default: false,
                  group: { en: 'Notifications & Alerts', 'zh-CN': '通知与提醒' },
                  label: { en: 'Browser Notifications', 'zh-CN': '浏览器系统通知' },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/v1/host/plugins/agy-daddy.web/settings')) {
        return new Response(
          JSON.stringify({
            ok: true,
            values: { ...storedValues },
            schema: {
              version: 1,
              fields: [
                {
                  key: 'enableNotifications',
                  type: 'boolean',
                  default: false,
                  group: { en: 'Notifications & Alerts', 'zh-CN': '通知与提醒' },
                  label: { en: 'Browser Notifications', 'zh-CN': '浏览器系统通知' },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      render(
        <I18nProvider defaultLocale="en">
          <ThemeProvider>
            <HostAdminModal
              open
              initialSelectedPluginId="agy-daddy.web"
              channel="loopback"
              permissionLevel="L2"
              onClose={vi.fn()}
              onWebSettingsUpdated={onWebSettingsUpdated}
            />
          </ThemeProvider>
        </I18nProvider>,
      );

      await waitFor(() => expect(screen.getByText('Notifications & Alerts')).toBeInTheDocument());
      const checkbox = screen.getByRole('checkbox', { name: /Browser Notifications/i }) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);

      // Saving while disabled never requests permission
      await user.click(screen.getByRole('button', { name: /Save Settings/i }));
      await waitFor(() => expect(onWebSettingsUpdated).toHaveBeenCalledWith({ enableNotifications: false }));
      expect(requestPermission).not.toHaveBeenCalled();

      // Re-query checkbox after HostAdminModal finishes reloading scoped settings
      const reloadedCheckbox = (await screen.findByRole('checkbox', {
        name: /Browser Notifications/i,
      })) as HTMLInputElement;
      await waitFor(() => expect(reloadedCheckbox).not.toBeDisabled());

      // Enabling and saving triggers Notification.requestPermission() once
      await user.click(reloadedCheckbox);
      expect(reloadedCheckbox.checked).toBe(true);
      await user.click(screen.getByRole('button', { name: /Save Settings/i }));
      await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
      expect(onWebSettingsUpdated).toHaveBeenLastCalledWith({ enableNotifications: true });
    } finally {
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        writable: true,
        value: originalNotification,
      });
    }
  });
});
