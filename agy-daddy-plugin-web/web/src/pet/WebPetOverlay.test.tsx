import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { apiClient } from '../api/client';
import type { PetStateResponse } from '../types';
import { WebPetOverlay } from './WebPetOverlay';

vi.mock('../api/client', () => ({
  apiClient: {
    interactPet: vi.fn().mockResolvedValue({ ok: true }),
    importPetTheme: vi.fn().mockResolvedValue({
      ok: true,
      theme: { id: 'custom-test', name: { en: 'Custom Test' }, builtin: false },
    }),
    savePluginSettings: vi.fn().mockResolvedValue({ ok: true, values: {} }),
  },
}));

function buildPetData(overrides?: Partial<PetStateResponse['state']>): PetStateResponse {
  return {
    ok: true,
    available: true,
    state: {
      enabled: true,
      desktopVisible: true,
      webVisible: true,
      themeId: 'daddy-orb',
      petScale: 1,
      roamMode: 'bottom-edge',
      webAnchor: { xRatio: 0.8, yRatio: 0.8 },
      motion: {
        animState: 'trotting',
        tps: 42,
        speedFactor: 1.5,
        roamSpeedPxPerSec: 36,
        primarySessionId: 'sess-1',
        primarySessionTitle: 'Alpha Session',
        watchedRunningCount: 1,
      },
      attention: {
        pendingApprovals: [],
        unreadReplies: [],
        activeBubble: {
          id: 'sess-1:4:approval',
          kind: 'approval',
          cascadeId: 'sess-1',
          sessionTitle: 'Alpha Session',
          summary: 'Run command npm test',
          timestamp: Date.now(),
        },
      },
      updatedAt: Date.now(),
      ...overrides,
    },
    scene: null,
    themes: [],
  };
}

describe('WebPetOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders canvas stage and attention bubble with pointer-events none wrapper', () => {
    const onSelectSession = vi.fn();
    const onOpenSettings = vi.fn();
    const onRefreshPet = vi.fn();

    render(
      <I18nProvider defaultLocale="en">
        <WebPetOverlay
          petData={buildPetData()}
          onSelectSession={onSelectSession}
          onOpenSettings={onOpenSettings}
          onRefreshPet={onRefreshPet}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('web-pet-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('web-pet-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('web-pet-bubble')).toHaveTextContent('Run command npm test');
    expect(screen.getByTestId('web-pet-status-pill')).toHaveTextContent('42 tok/s');

    fireEvent.click(screen.getByTestId('web-pet-bubble-focus'));
    expect(onSelectSession).toHaveBeenCalledWith('sess-1');
    expect(apiClient.interactPet).toHaveBeenCalledWith({
      action: 'bubble-click',
      bubbleId: 'sess-1:4:approval',
      cascadeId: 'sess-1',
    });
  });

  it('dismisses attention bubble and supports double-click to open settings', () => {
    const onSelectSession = vi.fn();
    const onOpenSettings = vi.fn();
    const onRefreshPet = vi.fn();

    render(
      <I18nProvider defaultLocale="en">
        <WebPetOverlay
          petData={buildPetData()}
          onSelectSession={onSelectSession}
          onOpenSettings={onOpenSettings}
          onRefreshPet={onRefreshPet}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('web-pet-bubble-dismiss'));
    expect(screen.queryByTestId('web-pet-bubble')).not.toBeInTheDocument();
    expect(apiClient.interactPet).toHaveBeenCalledWith({
      action: 'bubble-dismiss',
      bubbleId: 'sess-1:4:approval',
      cascadeId: 'sess-1',
    });

    fireEvent.doubleClick(screen.getByTestId('web-pet-stage'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('imports local theme file via quick menu and refreshes state', async () => {
    const onRefreshPet = vi.fn();

    render(
      <I18nProvider defaultLocale="en">
        <WebPetOverlay
          petData={buildPetData()}
          onSelectSession={vi.fn()}
          onOpenSettings={vi.fn()}
          onRefreshPet={onRefreshPet}
        />
      </I18nProvider>,
    );

    const input = screen.getByTestId('web-pet-import-input') as HTMLInputElement;
    const svgFile = new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'buddy.svg', {
      type: 'image/svg+xml',
    });
    if (!svgFile.text) {
      Object.defineProperty(svgFile, 'text', {
        value: async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      });
    }
    fireEvent.change(input, { target: { files: [svgFile] } });

    await waitFor(() => {
      expect(apiClient.importPetTheme).toHaveBeenCalledWith({
        fileName: 'buddy.svg',
        svgText: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      });
      expect(onRefreshPet).toHaveBeenCalled();
    });
  });

  it('renders nothing when webVisible is false', () => {
    render(
      <I18nProvider defaultLocale="en">
        <WebPetOverlay
          petData={buildPetData({ webVisible: false })}
          onSelectSession={vi.fn()}
          onOpenSettings={vi.fn()}
          onRefreshPet={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.queryByTestId('web-pet-overlay')).not.toBeInTheDocument();
  });
});
