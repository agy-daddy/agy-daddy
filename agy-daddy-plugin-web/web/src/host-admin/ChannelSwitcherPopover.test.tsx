import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nProvider } from '../i18n';
import type { WebAccessStatusResponse } from '../types';
import { ChannelSwitcherPopover, type ChannelProbeEntry } from './ChannelSwitcherPopover';

const FULL_STATUS: WebAccessStatusResponse = {
  ok: true,
  running: true,
  channel: 'cloudflare',
  permissionLevel: 'L0',
  allowRemoteWrite: false,
  channels: {
    cloudflare: true,
    tailscale: true,
    lan: true,
    bonjour: false,
    loopback: true,
  },
  urls: {
    cloudflare: 'https://ag.example.com/pc/',
    tailscale: 'http://100.64.0.8:18767',
    lan: 'http://192.168.1.20:18767',
    loopback: 'http://127.0.0.1:18767',
  },
  channelEndpoints: {
    cloudflare: {
      key: 'cloudflare',
      origin: 'https://ag.example.com',
      basePath: '/pc',
      displayHost: 'ag.example.com/pc',
      probeUrl: 'https://ag.example.com/pc/api/v1/ping',
    },
    tailscale: {
      key: 'tailscale',
      origin: 'http://100.64.0.8:18767',
      basePath: '',
      displayHost: '100.64.0.8:18767',
      probeUrl: 'http://100.64.0.8:18767/api/v1/ping',
    },
    lan: {
      key: 'lan',
      origin: 'http://192.168.1.20:18767',
      basePath: '',
      displayHost: '192.168.1.20:18767',
      probeUrl: 'http://192.168.1.20:18767/api/v1/ping',
    },
    loopback: {
      key: 'loopback',
      origin: 'http://127.0.0.1:18767',
      basePath: '',
      displayHost: '127.0.0.1:18767',
      probeUrl: 'http://127.0.0.1:18767/api/v1/ping',
    },
  },
  cloudflareState: {
    mode: 'shared_ready',
    tunnelMode: 'quick',
    publicOrigin: 'https://ag.example.com',
    mountPath: '/pc',
    tokenSource: 'remote',
  },
};

function Harness({
  status = FULL_STATUS,
  activeSessionId = 'sess-1',
  onNavigate,
  initialCache = {},
}: {
  status?: WebAccessStatusResponse;
  activeSessionId?: string | null;
  onNavigate?: (url: string) => void;
  initialCache?: Record<string, ChannelProbeEntry>;
}) {
  const [cache, setCache] = useState<Record<string, ChannelProbeEntry>>(initialCache);
  return (
    <I18nProvider defaultLocale="en">
      <ChannelSwitcherPopover
        status={status}
        activeSessionId={activeSessionId}
        probeCache={cache}
        onProbeCacheChange={setCache}
        onNavigate={onNavigate}
        onClose={() => {}}
      />
    </I18nProvider>
  );
}

describe('ChannelSwitcherPopover', () => {
  const originalLocation = window.location;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      configurable: true,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockLocation(href: string) {
    const u = new URL(href);
    Object.defineProperty(window, 'location', {
      value: {
        href: u.href,
        protocol: u.protocol,
        host: u.host,
        pathname: u.pathname,
        search: u.search,
        assign: vi.fn(),
        replace: vi.fn(),
      },
      configurable: true,
    });
  }

  it('skips probing http:// endpoints from https:// page, renders mixed notice & opens _blank on switch (with <a> fallback)', async () => {
    mockLocation('https://ag.example.com/pc/?session=sess-1');

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://ag.example.com/pc/api/v1/ping')) {
        return new Response(JSON.stringify({ ok: true, channel: 'cloudflare' }), { status: 200 });
      }
      if (url === '/pc/api/v1/web/switch-ticket' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'));
        return new Response(
          JSON.stringify({
            ok: true,
            targetChannel: body.targetChannel,
            switchUrl: `http://192.168.1.20:18767/?switch_ticket=tkt_lan_1&session=${body.sessionId || ''}`,
            expiresInMs: 60000,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getByTestId('channel-switcher-https-notice')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('channel-probe-cloudflare')).toHaveTextContent('ms');
    });
    expect(screen.getByTestId('channel-probe-lan')).toHaveTextContent('Direct Connect');
    expect(screen.getByTestId('channel-probe-lan')).toHaveTextContent('Not probed on HTTPS');
    expect(screen.getByTestId('channel-recommended-cloudflare')).toHaveTextContent('Recommended');

    // Zero fetch calls made to http:// endpoints
    const probedUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(probedUrls.some((u) => u.startsWith('http://'))).toBe(false);

    // Clicking switch on http:// LAN calls window.open synchronously; when blocked (null), renders fallback <a>
    await user.click(screen.getByTestId('channel-switch-lan'));
    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => {
      const fallback = screen.getByTestId('channel-fallback-link-lan') as HTMLAnchorElement;
      expect(fallback.href).toBe('http://192.168.1.20:18767/?switch_ticket=tkt_lan_1&session=sess-1');
    });
  });

  it('probes all channels in http:// context, marks lowest RTT Recommended, and switches back to Cloudflare', async () => {
    mockLocation('http://192.168.1.20:18767/?session=sess-99');

    const lanStatus: WebAccessStatusResponse = {
      ...FULL_STATUS,
      channel: 'lan',
    };

    let nowMs = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://ag.example.com/pc/api/v1/ping')) {
        nowMs += 45;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.startsWith('http://100.64.0.8:18767/api/v1/ping')) {
        nowMs += 12;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.startsWith('http://192.168.1.20:18767/api/v1/ping')) {
        nowMs += 3;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.startsWith('http://127.0.0.1:18767/api/v1/ping')) {
        throw new TypeError('Failed to fetch');
      }
      if (url === '/api/v1/web/switch-ticket' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'));
        return new Response(
          JSON.stringify({
            ok: true,
            targetChannel: body.targetChannel,
            switchUrl: `https://ag.example.com/pc/?switch_ticket=tkt_cf_back&session=${body.sessionId || ''}`,
            expiresInMs: 60000,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<Harness status={lanStatus} activeSessionId="sess-99" onNavigate={onNavigate} />);

    expect(screen.queryByTestId('channel-switcher-https-notice')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('channel-probe-cloudflare')).toHaveTextContent('ms');
      expect(screen.getByTestId('channel-probe-tailscale')).toHaveTextContent('ms');
      expect(screen.getByTestId('channel-probe-lan')).toHaveTextContent('ms');
      expect(screen.getByTestId('channel-probe-loopback')).toHaveTextContent('Unreachable');
    });

    // Switch back to Cloudflare preserving sessionId
    await user.click(screen.getByTestId('channel-switch-cloudflare'));
    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith(
        'https://ag.example.com/pc/?switch_ticket=tkt_cf_back&session=sess-99',
      );
    });
  });

  it('mints one-time switch-ticket when copying non-loopback L0 URL without embedded token', async () => {
    mockLocation('http://192.168.1.20:18767/');

    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/ping')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === '/api/v1/web/switch-ticket' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            ok: true,
            targetChannel: 'tailscale',
            switchUrl: 'http://100.64.0.8:18767/?switch_ticket=tkt_copy_ts&session=sess-1',
            expiresInMs: 60000,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    render(<Harness status={{ ...FULL_STATUS, channel: 'lan' }} />);

    await user.click(screen.getByTestId('channel-copy-tailscale'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        'http://100.64.0.8:18767/?switch_ticket=tkt_copy_ts&session=sess-1',
      );
    });
  });
});
