import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLOR_THEME_STORAGE_KEY,
  DRAWER_SPEED_STORAGE_KEY,
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
} from './ThemeProvider';

function ThemeProbe() {
  const {
    preference,
    resolvedTheme,
    colorTheme,
    drawerSpeed,
    drawerDurationMs,
    setTheme,
    setColorTheme,
    setDrawerSpeed,
    hydrateFromSettings,
    cycleTheme,
  } = useTheme();
  return (
    <div>
      <span data-testid="pref">{preference}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <span data-testid="color-theme">{colorTheme}</span>
      <span data-testid="drawer-speed">{drawerSpeed}</span>
      <span data-testid="drawer-ms">{drawerDurationMs}</span>
      <button type="button" onClick={cycleTheme} data-testid="cycle">
        cycle
      </button>
      <button type="button" onClick={() => setTheme('light')} data-testid="light">
        light
      </button>
      <button type="button" onClick={() => setColorTheme('blue')} data-testid="blue">
        blue
      </button>
      <button type="button" onClick={() => setDrawerSpeed('smooth')} data-testid="smooth">
        smooth
      </button>
      <button
        type="button"
        onClick={() =>
          hydrateFromSettings({ theme: 'dark', colorTheme: 'purple', drawerSpeed: 'fast' })
        }
        data-testid="hydrate"
      >
        hydrate
      </button>
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themePref;
    delete document.documentElement.dataset.colorTheme;
    delete document.documentElement.dataset.drawerSpeed;
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('dark'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it('defaults to Minimal Monochrome + system + normal drawer speed and syncs html attributes', () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('pref')).toHaveTextContent('system');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(screen.getByTestId('color-theme')).toHaveTextContent('monochrome');
    expect(screen.getByTestId('drawer-speed')).toHaveTextContent('normal');
    expect(screen.getByTestId('drawer-ms')).toHaveTextContent('200');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.colorTheme).toBe('monochrome');
    expect(document.documentElement.dataset.drawerSpeed).toBe('normal');

    fireEvent.click(screen.getByTestId('light'));
    expect(screen.getByTestId('pref')).toHaveTextContent('light');
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    fireEvent.click(screen.getByTestId('blue'));
    expect(screen.getByTestId('color-theme')).toHaveTextContent('blue');
    expect(document.documentElement.dataset.colorTheme).toBe('blue');
    expect(window.localStorage.getItem(COLOR_THEME_STORAGE_KEY)).toBe('blue');

    fireEvent.click(screen.getByTestId('smooth'));
    expect(screen.getByTestId('drawer-speed')).toHaveTextContent('smooth');
    expect(screen.getByTestId('drawer-ms')).toHaveTextContent('320');
    expect(document.documentElement.style.getPropertyValue('--drawer-duration')).toBe('320ms');
    expect(window.localStorage.getItem(DRAWER_SPEED_STORAGE_KEY)).toBe('smooth');

    fireEvent.click(screen.getByTestId('cycle'));
    expect(screen.getByTestId('pref')).toHaveTextContent('system');

    fireEvent.click(screen.getByTestId('hydrate'));
    expect(screen.getByTestId('color-theme')).toHaveTextContent('purple');
    expect(screen.getByTestId('drawer-ms')).toHaveTextContent('120');
  });
});
