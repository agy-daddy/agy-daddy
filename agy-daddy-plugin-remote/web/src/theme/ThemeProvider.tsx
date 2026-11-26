import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useState } from 'preact/hooks';
import type { AppearanceMode, ColorThemeId, DrawerSpeedId } from '../types';

export const APPEARANCE_STORAGE_KEY = 'agy_remote_appearance';
export const COLOR_THEME_STORAGE_KEY = 'agy_remote_color_theme';
export const DRAWER_SPEED_STORAGE_KEY = 'agy_remote_drawer_speed';

export const DRAWER_SPEED_MS: Record<DrawerSpeedId, number> = {
  fast: 120,
  normal: 200,
  slow: 320,
  off: 0
};

export interface ThemeContextValue {
  appearance: AppearanceMode;
  resolvedTheme: 'dark' | 'light';
  colorTheme: ColorThemeId;
  drawerSpeed: DrawerSpeedId;
  drawerDurationMs: number;
  setAppearance: (next: AppearanceMode) => void;
  cycleAppearance: () => void;
  setColorTheme: (next: ColorThemeId) => void;
  setDrawerSpeed: (next: DrawerSpeedId) => void;
}

export function normalizeAppearance(raw: unknown): AppearanceMode | null {
  return raw === 'auto' || raw === 'dark' || raw === 'light' ? raw : null;
}

export function normalizeColorTheme(raw: unknown): ColorThemeId | null {
  return raw === 'monochrome' ||
    raw === 'purple' ||
    raw === 'blue' ||
    raw === 'green' ||
    raw === 'amber' ||
    raw === 'red'
    ? raw
    : null;
}

export function normalizeDrawerSpeed(raw: unknown): DrawerSpeedId | null {
  if (raw === 'smooth') return 'slow';
  return raw === 'fast' || raw === 'normal' || raw === 'slow' || raw === 'off' ? raw : null;
}

function getSystemTheme(): 'dark' | 'light' {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

function readStored<T extends string>(
  key: string,
  normalize: (raw: unknown) => T | null,
  fallback: T
): T {
  if (typeof window === 'undefined') return fallback;
  try {
    return normalize(window.localStorage?.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(key, value);
  } catch {}
}

export function applyThemeAttributes(opts: {
  appearance: AppearanceMode;
  resolvedTheme: 'dark' | 'light';
  colorTheme: ColorThemeId;
  drawerSpeed: DrawerSpeedId;
}): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.appearance = opts.appearance;
  root.dataset.theme = opts.resolvedTheme;
  root.dataset.colorTheme = opts.colorTheme;
  root.dataset.drawerSpeed = opts.drawerSpeed;
  root.style.setProperty('--ag-drawer-duration', `${DRAWER_SPEED_MS[opts.drawerSpeed]}ms`);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && typeof getComputedStyle === 'function') {
    const bg = getComputedStyle(root).getPropertyValue('--ag-bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }
}

const DEFAULT_THEME_CONTEXT: ThemeContextValue = {
  appearance: 'auto',
  resolvedTheme: 'dark',
  colorTheme: 'monochrome',
  drawerSpeed: 'normal',
  drawerDurationMs: DRAWER_SPEED_MS.normal,
  setAppearance: () => {},
  cycleAppearance: () => {},
  setColorTheme: () => {},
  setDrawerSpeed: () => {}
};

const ThemeContext = createContext<ThemeContextValue>(DEFAULT_THEME_CONTEXT);

export interface ThemeProviderProps {
  children: ComponentChildren;
  appearance?: AppearanceMode;
  colorTheme?: ColorThemeId;
  drawerSpeed?: DrawerSpeedId;
  onAppearanceChange?: (next: AppearanceMode) => void;
  onColorThemeChange?: (next: ColorThemeId) => void;
  onDrawerSpeedChange?: (next: DrawerSpeedId) => void;
}

export function ThemeProvider({
  children,
  appearance: controlledAppearance,
  colorTheme: controlledColorTheme,
  drawerSpeed: controlledDrawerSpeed,
  onAppearanceChange,
  onColorThemeChange,
  onDrawerSpeedChange
}: ThemeProviderProps) {
  const [internalAppearance, setInternalAppearance] = useState<AppearanceMode>(() =>
    readStored(APPEARANCE_STORAGE_KEY, normalizeAppearance, 'auto')
  );
  const [internalColorTheme, setInternalColorTheme] = useState<ColorThemeId>(() =>
    readStored(COLOR_THEME_STORAGE_KEY, normalizeColorTheme, 'monochrome')
  );
  const [internalDrawerSpeed, setInternalDrawerSpeed] = useState<DrawerSpeedId>(() =>
    readStored(DRAWER_SPEED_STORAGE_KEY, normalizeDrawerSpeed, 'normal')
  );
  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>(() => getSystemTheme());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (ev: MediaQueryListEvent) => {
      setSystemTheme(ev.matches ? 'dark' : 'light');
    };
    setSystemTheme(mql.matches ? 'dark' : 'light');
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handleChange);
      return () => mql.removeEventListener('change', handleChange);
    }
    return undefined;
  }, []);

  const appearance = controlledAppearance ?? internalAppearance;
  const colorTheme = controlledColorTheme ?? internalColorTheme;
  const drawerSpeed = controlledDrawerSpeed ?? internalDrawerSpeed;
  const resolvedTheme = appearance === 'auto' ? systemTheme : appearance;
  const drawerDurationMs = DRAWER_SPEED_MS[drawerSpeed];

  useEffect(() => {
    applyThemeAttributes({ appearance, resolvedTheme, colorTheme, drawerSpeed });
  }, [appearance, resolvedTheme, colorTheme, drawerSpeed]);

  const setAppearance = useCallback(
    (next: AppearanceMode) => {
      setInternalAppearance(next);
      writeStored(APPEARANCE_STORAGE_KEY, next);
      onAppearanceChange?.(next);
    },
    [onAppearanceChange]
  );

  const cycleAppearance = useCallback(() => {
    const order: AppearanceMode[] = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(appearance) + 1) % order.length];
    setAppearance(next);
  }, [appearance, setAppearance]);

  const setColorTheme = useCallback(
    (next: ColorThemeId) => {
      setInternalColorTheme(next);
      writeStored(COLOR_THEME_STORAGE_KEY, next);
      onColorThemeChange?.(next);
    },
    [onColorThemeChange]
  );

  const setDrawerSpeed = useCallback(
    (next: DrawerSpeedId) => {
      setInternalDrawerSpeed(next);
      writeStored(DRAWER_SPEED_STORAGE_KEY, next);
      onDrawerSpeedChange?.(next);
    },
    [onDrawerSpeedChange]
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      appearance,
      resolvedTheme,
      colorTheme,
      drawerSpeed,
      drawerDurationMs,
      setAppearance,
      cycleAppearance,
      setColorTheme,
      setDrawerSpeed
    }),
    [
      appearance,
      resolvedTheme,
      colorTheme,
      drawerSpeed,
      drawerDurationMs,
      setAppearance,
      cycleAppearance,
      setColorTheme,
      setDrawerSpeed
    ]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
