import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '../i18n';
import { ThemeProvider } from '../theme/ThemeProvider';
import { TopbarCapsules } from './TopbarCapsules';
import type { RemoteStatusResponse, TopbarPanels } from '../types';

const FULL_PANELS: TopbarPanels = {
  context: {
    available: true,
    source: 'service',
    data: {
      hasSession: true,
      model: 'claude-sonnet-4.5',
      used: 252_000,
      budget: 1_000_000,
      percent: 25,
      inputTokens: 180_000,
      cachedTokens: 144_000,
      cacheHitRate: 80,
      outputTokens: 12_500,
      speed: { tps: 48, streamingTps: 62, ttft: 0.45 },
      warnThresholdTokens: 240_000,
      cliffThresholdTokens: 328_000,
      cacheCliffRisk: 'warn',
      groups: {
        system: 15_000,
        user: 35_000,
        assistant: 120_000,
        tool: 82_000,
      },
      alerts: [{ level: 'warn', message: 'Approaching 240K cache warning threshold' }],
    },
  },
  usage: {
    available: true,
    source: 'service',
    data: {
      currency: 'USD',
      currencySymbol: '$',
      periods: {
        today: { totalUsd: 1.25, totalTokens: 420_000 },
        days7: { totalUsd: 8.4, totalTokens: 2_800_000 },
        days30: { totalUsd: 31.5, totalTokens: 10_500_000 },
        allTime: {
          totalUsd: 94.2,
          totalTokens: 31_400_000,
          byModel: {
            'claude-sonnet-4.5': { tokens: 20_000_000, costUSD: 62.0 },
            'gemini-3-pro': { tokens: 11_400_000, costUSD: 32.2 },
          },
        },
      },
      dailyActivity: [
        { date: '2026-11-22', tokens: 300_000 },
        { date: '2026-11-23', tokens: 620_000 },
        { date: '2026-11-24', tokens: 420_000 },
      ],
    },
  },
  quota: {
    available: true,
    source: 'service',
    data: {
      ultraSubTier: '20X',
      quotaMultiplier: 20,
      gemini: { remainingFraction: 0.82, percentText: '82%' },
      claude: { remainingFraction: 0.12, percentText: '12%' },
      pools: [
        {
          id: 'gemini-main',
          title: 'Gemini Main Pool',
          fiveHourBucket: { remainingFraction: 0.82, percentText: '82%', countdownText: '3h 10m' },
          weeklyBucket: { remainingFraction: 0.28, percentText: '28%', countdownText: '4d 2h' },
        },
        {
          id: 'claude-pool',
          title: 'Claude Pool',
          fiveHourBucket: { remainingFraction: 0.12, percentText: '12%', countdownText: '42m' },
        },
      ],
    },
  },
};

const SAMPLE_QR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25" width="160" height="160"><rect width="100%" height="100%" fill="#ffffff"/><path d="M2,2h5v5h-5z" fill="#0a0a0c"/><script>alert(1)</script></svg>';

const ONLINE_REMOTE: RemoteStatusResponse = {
  ok: true,
  available: true,
  running: true,
  port: 18765,
  url: 'https://demo.trycloudflare.com/?token=abc',
  pairingUrl: 'https://demo.trycloudflare.com/?token=abc',
  qrSvg: SAMPLE_QR_SVG,
  primaryChannel: 'cloudflare',
  permissionLevel: 'L1',
  allowRemoteWrite: true,
  channels: {
    cloudflare: true,
    tailscale: true,
    lan: true,
    loopback: true,
  },
  deviceCount: 2,
};

function renderTopbar(props: Partial<React.ComponentProps<typeof TopbarCapsules>> = {}) {
  return render(
    <I18nProvider defaultLocale="en">
      <ThemeProvider>
        <div>
          <TopbarCapsules panels={FULL_PANELS} {...props} />
          <div data-testid="outside-area">Outside</div>
        </div>
      </ThemeProvider>
    </I18nProvider>,
  );
}

describe('TopbarCapsules popovers & MobileQrPopover', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens Context popover with App-aligned metrics, markers, alerts, /compact, and refresh', async () => {
    const user = userEvent.setup();
    const onCapsuleClick = vi.fn();
    const onRunCompact = vi.fn();
    const onRefreshTopbar = vi.fn();

    renderTopbar({ onCapsuleClick, onRunCompact, onRefreshTopbar });

    const contextBtn = screen.getByText('Context').closest('button')!;
    await user.click(contextBtn);

    expect(onCapsuleClick).toHaveBeenCalledWith('context', FULL_PANELS.context);
    const popover = screen.getByTestId('topbar-popover-context');
    expect(popover).toBeInTheDocument();
    expect(screen.getByTestId('context-used-value')).toHaveTextContent('252K');
    expect(popover).toHaveTextContent('1M');
    expect(screen.getByTestId('context-warn-marker')).toBeInTheDocument();
    expect(screen.getByTestId('context-cliff-marker')).toBeInTheDocument();
    expect(popover).toHaveTextContent('180K');
    expect(popover).toHaveTextContent('144K');
    expect(popover).toHaveTextContent('80%');
    expect(popover).toHaveTextContent('12.5K');
    expect(popover).toHaveTextContent('48 t/s');
    expect(popover).toHaveTextContent('Approaching 240K cache warning threshold');

    await user.click(screen.getByTestId('popover-refresh-context'));
    expect(onRefreshTopbar).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('popover-run-compact-btn'));
    expect(onRunCompact).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('topbar-popover-context')).not.toBeInTheDocument();
  });

  it('opens Usage popover with period summary cards, model breakdown, and daily activity', async () => {
    const user = userEvent.setup();
    renderTopbar();

    const usageBtn = screen.getByText('Usage').closest('button')!;
    await user.click(usageBtn);

    const popover = screen.getByTestId('topbar-popover-usage');
    expect(popover).toBeInTheDocument();
    expect(screen.getByTestId('usage-card-today')).toHaveTextContent('$1.25');
    expect(screen.getByTestId('usage-card-today')).toHaveTextContent('420K');
    expect(screen.getByTestId('usage-card-days7')).toHaveTextContent('$8.40');
    expect(screen.getByTestId('usage-card-days30')).toHaveTextContent('$31.50');
    expect(screen.getByTestId('usage-card-total')).toHaveTextContent('$94.20');
    expect(popover).toHaveTextContent('claude-sonnet-4.5');
    expect(popover).toHaveTextContent('gemini-3-pro');
    expect(screen.getByTestId('usage-daily-bars')).toBeInTheDocument();
  });

  it('supports fallback flat fields in Usage popover when periods object is absent', async () => {
    const user = userEvent.setup();
    renderTopbar({
      panels: {
        context: { available: false },
        usage: {
          available: true,
          source: 'state',
          data: {
            todayCost: 0.75,
            todayTokens: 55_000,
            totalCost: 12.34,
            totalTokens: 980_000,
          },
        },
        quota: { available: false },
      },
    });

    await user.click(screen.getByText('Usage').closest('button')!);
    expect(screen.getByTestId('usage-card-today')).toHaveTextContent('$0.750');
    expect(screen.getByTestId('usage-card-today')).toHaveTextContent('55K');
    expect(screen.getByTestId('usage-card-total')).toHaveTextContent('$12.34');
    expect(screen.getByTestId('usage-card-total')).toHaveTextContent('980K');
  });

  it('opens Quota popover with plan tier, semantic color tones, and reset countdowns', async () => {
    const user = userEvent.setup();
    renderTopbar();

    await user.click(screen.getByText('Quota').closest('button')!);

    const popover = screen.getByTestId('topbar-popover-quota');
    expect(popover).toBeInTheDocument();
    expect(screen.getByTestId('quota-plan-badge')).toHaveTextContent('Ultra 20X · 20x');

    const geminiPool = screen.getByTestId('quota-pool-gemini-main');
    expect(geminiPool).toHaveTextContent('82%');
    expect(geminiPool).toHaveTextContent('Resets 3h 10m');
    expect(geminiPool).toHaveTextContent('28%');
    expect(geminiPool).toHaveTextContent('Resets 4d 2h');

    const tones = Array.from(popover.querySelectorAll('[data-tone]')).map((el) =>
      el.getAttribute('data-tone'),
    );
    expect(tones).toEqual(['ok', 'warn', 'danger']);
  });

  it('toggles, switches, and closes popovers on outside click and Escape key', async () => {
    const user = userEvent.setup();
    renderTopbar();

    const contextBtn = screen.getByText('Context').closest('button')!;
    const usageBtn = screen.getByText('Usage').closest('button')!;

    await user.click(contextBtn);
    expect(screen.getByTestId('topbar-popover-context')).toBeInTheDocument();

    // Clicking another capsule switches directly
    await user.click(usageBtn);
    expect(screen.queryByTestId('topbar-popover-context')).not.toBeInTheDocument();
    expect(screen.getByTestId('topbar-popover-usage')).toBeInTheDocument();

    // Clicking active capsule again closes it
    await user.click(usageBtn);
    expect(screen.queryByTestId('topbar-popover-usage')).not.toBeInTheDocument();

    // Outside click closes open popover
    await user.click(contextBtn);
    expect(screen.getByTestId('topbar-popover-context')).toBeInTheDocument();
    await user.click(screen.getByTestId('outside-area'));
    expect(screen.queryByTestId('topbar-popover-context')).not.toBeInTheDocument();

    // Escape closes open popover
    await user.click(usageBtn);
    expect(screen.getByTestId('topbar-popover-usage')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('topbar-popover-usage')).not.toBeInTheDocument();
  });

  it('opens MobileQrPopover with sanitized QR SVG, channel & permission badges, URL copy, and refresh', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const onRefreshRemote = vi.fn();

    renderTopbar({
      remoteStatus: ONLINE_REMOTE,
      onRefreshRemote,
    });

    const mobileBtn = screen.getByTestId('topbar-custom-menu-btn');
    await user.click(mobileBtn);
    await user.click(screen.getByTestId('topbar-mobile-qr-btn'));

    const popover = screen.getByTestId('mobile-qr-popover');
    expect(popover).toBeInTheDocument();
    expect(screen.getByTestId('mobile-channel-cloudflare')).toHaveTextContent('Cloudflare');
    expect(screen.getByTestId('mobile-channel-tailscale')).toHaveTextContent('Tailscale');
    expect(screen.getByTestId('mobile-channel-lan')).toHaveTextContent('LAN');
    expect(screen.getByTestId('mobile-channel-local')).toHaveTextContent('Local');
    expect(screen.getByTestId('mobile-permission-badge')).toHaveTextContent('L1 Chat');
    expect(screen.getByTestId('mobile-device-count')).toHaveTextContent('2 device(s)');

    // Sanitized QR SVG renders <rect>/<path> and strips <script>
    const qrCard = screen.getByTestId('mobile-qr-card');
    expect(qrCard.querySelector('svg')).toBeInTheDocument();
    expect(qrCard.querySelector('path')).toBeInTheDocument();
    expect(qrCard.querySelector('script')).toBeNull();

    const urlInput = screen.getByTestId('mobile-qr-url-input') as HTMLInputElement;
    expect(urlInput.value).toBe('https://demo.trycloudflare.com/?token=abc');

    const copyBtn = screen.getByTestId('mobile-qr-copy-btn');
    await user.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith('https://demo.trycloudflare.com/?token=abc');
    await waitFor(() => expect(copyBtn).toHaveTextContent('Copied'));

    await user.click(screen.getByTestId('mobile-qr-refresh-btn'));
    expect(onRefreshRemote).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('mobile-qr-popover')).not.toBeInTheDocument();
  });

  it('shows offline fallback in MobileQrPopover when remote plugin is unavailable', async () => {
    const user = userEvent.setup();
    renderTopbar({
      remoteStatus: { ok: true, available: false, running: false },
    });

    await user.click(screen.getByTestId('topbar-custom-menu-btn'));
    await user.click(screen.getByTestId('topbar-mobile-qr-btn'));
    expect(screen.getByTestId('mobile-qr-offline')).toHaveTextContent('Remote service offline');
    expect(screen.queryByTestId('mobile-qr-card')).not.toBeInTheDocument();
  });

  it('renders topbar channel switcher capsule and opens ChannelSwitcherPopover for L0/L1/L2', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const onRefreshWebAccess = vi.fn();
      renderTopbar({
        webAccessStatus: {
          ok: true,
          channel: 'lan',
          permissionLevel: 'L0',
          channelEndpoints: {
            cloudflare: {
              key: 'cloudflare',
              origin: 'https://ag.example.com',
              basePath: '/pc',
              displayHost: 'ag.example.com/pc',
              probeUrl: 'https://ag.example.com/pc/api/v1/ping',
            },
            lan: {
              key: 'lan',
              origin: 'http://192.168.1.20:18767',
              basePath: '',
              displayHost: '192.168.1.20:18767',
              probeUrl: 'http://192.168.1.20:18767/api/v1/ping',
            },
          },
        },
        onRefreshWebAccess,
      });

      const switcherBtn = screen.getByTestId('topbar-channel-switcher-btn');
      expect(switcherBtn).toHaveTextContent('LAN');

      await user.click(switcherBtn);
      expect(onRefreshWebAccess).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('channel-switcher-popover')).toBeInTheDocument();
      expect(screen.getByTestId('channel-row-cloudflare')).toBeInTheDocument();
      expect(screen.getByTestId('channel-row-lan')).toBeInTheDocument();

      await user.keyboard('{Escape}');
      expect(screen.queryByTestId('channel-switcher-popover')).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hides Context capsule when contextDisplayLocation is composer or slot is unavailable', () => {
    const { rerender } = render(
      <I18nProvider defaultLocale="en">
        <ThemeProvider>
          <TopbarCapsules panels={FULL_PANELS} contextDisplayLocation="composer" />
        </ThemeProvider>
      </I18nProvider>,
    );

    expect(screen.queryByText('Context')).not.toBeInTheDocument();
    expect(screen.getByText('Usage')).toBeInTheDocument();
    expect(screen.getByText('Quota')).toBeInTheDocument();

    rerender(
      <I18nProvider defaultLocale="en">
        <ThemeProvider>
          <TopbarCapsules
            panels={{ ...FULL_PANELS, context: { available: false } }}
            contextDisplayLocation="topbar"
          />
        </ThemeProvider>
      </I18nProvider>,
    );
    expect(screen.queryByText('Context')).not.toBeInTheDocument();
  });
});
