import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '../i18n';
import { WebAccessPanel } from './WebAccessPanel';

describe('WebAccessPanel', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('orders channels Cloudflare-first, renders Priority Entry card & guidance, and falls back when clipboard is unavailable', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          running: true,
          channel: 'loopback',
          permissionLevel: 'L0',
          allowRemoteWrite: false,
          activeChannels: ['loopback', 'lan', 'cloudflare'],
          primaryChannel: 'cloudflare',
          primaryUrl: 'https://shared.trycloudflare.com/pc/?token=tok_1',
          urls: {
            loopback: 'http://127.0.0.1:18767/?token=tok_1',
            lan: 'http://192.168.1.20:18767/?token=tok_1',
            cloudflare: 'https://shared.trycloudflare.com/pc/?token=tok_1',
          },
          cloudflareState: {
            mode: 'shared_ready',
            tunnelMode: 'quick',
            publicOrigin: 'https://shared.trycloudflare.com',
            mountPath: '/pc',
            tokenSource: 'remote',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    const execCommandMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      value: execCommandMock,
      configurable: true,
    });

    render(
      <I18nProvider defaultLocale="en">
        <WebAccessPanel />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('web-access-primary-card')).toBeInTheDocument();
    });

    expect(screen.getByTestId('web-access-primary-channel')).toHaveTextContent('Cloudflare Tunnel');
    expect(screen.getByTestId('web-access-cf-notice')).toHaveTextContent('Quick Tunnel');

    // List order must strictly be cloudflare -> lan -> loopback
    const rows = Array.from(document.querySelectorAll('[data-testid^="web-access-row-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(rows).toEqual([
      'web-access-row-cloudflare',
      'web-access-row-lan',
      'web-access-row-loopback',
    ]);

    await user.click(screen.getByTestId('web-access-primary-copy'));
    expect(execCommandMock).toHaveBeenCalledWith('copy');
    await waitFor(() => {
      expect(screen.getByTestId('web-access-primary-copy')).toHaveTextContent('Copied');
    });
  });

  it('renders degradation guidance banner when remote plugin is unavailable', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          running: true,
          channel: 'loopback',
          permissionLevel: 'L0',
          allowRemoteWrite: false,
          activeChannels: ['loopback', 'cloudflare'],
          primaryChannel: 'loopback',
          primaryUrl: 'http://127.0.0.1:18767/?token=tok_local',
          urls: {
            loopback: 'http://127.0.0.1:18767/?token=tok_local',
          },
          cloudflareState: {
            mode: 'remote_unavailable',
            reasonCode: 'REMOTE_PLUGIN_OFFLINE',
            tokenSource: 'local',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <I18nProvider defaultLocale="en">
        <WebAccessPanel />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('web-access-cf-notice')).toHaveTextContent('agy-daddy.remote');
    });
  });
});
