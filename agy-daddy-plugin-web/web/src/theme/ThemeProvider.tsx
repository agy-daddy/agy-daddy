import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export type ColorTheme = 'monochrome' | 'purple' | 'blue' | 'green' | 'amber' | 'red';
export type DrawerSpeed = 'fast' | 'normal' | 'smooth' | 'off';

export const THEME_STORAGE_KEY = 'agy.web.theme';
export const COLOR_THEME_STORAGE_KEY = 'agy.web.colorTheme';
export const DRAWER_SPEED_STORAGE_KEY = 'agy.web.drawerSpeed';

export const DRAWER_SPEED_MS: Record<DrawerSpeed, number> = {
  fast: 120,
  normal: 200,
  smooth: 320,
  off: 0,
};

export interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  colorTheme: ColorTheme;
  drawerSpeed: DrawerSpeed;
  drawerDurationMs: number;
  setTheme: (next: ThemePreference) => void;
  cycleTheme: () => void;
  setColorTheme: (next: ColorTheme) => void;
  setDrawerSpeed: (next: DrawerSpeed) => void;
  hydrateFromSettings: (settings: Record<string, unknown> | null | undefined) => void;
}

export function normalizeThemePreference(raw: unknown): ThemePreference | null {
  return raw === 'system' || raw === 'light' || raw === 'dark' ? raw : null;
}

export function normalizeColorTheme(raw: unknown): ColorTheme | null {
  return raw === 'monochrome' ||
    raw === 'purple' ||
    raw === 'blue' ||
    raw === 'green' ||
    raw === 'amber' ||
    raw === 'red'
    ? raw
    : null;
}

export function normalizeDrawerSpeed(raw: unknown): DrawerSpeed | null {
  return raw === 'fast' || raw === 'normal' || raw === 'smooth' || raw === 'off' ? raw : null;
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

function readStored<T extends string>(
  key: string,
  normalize: (raw: unknown) => T | null,
  fallback: T,
): T {
  if (typeof window === 'undefined') return fallback;
  try {
    return normalize(window.localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage errors
  }
}

const DEFAULT_CONTEXT: ThemeContextValue = {
  preference: 'system',
  resolvedTheme: 'dark',
  colorTheme: 'monochrome',
  drawerSpeed: 'normal',
  drawerDurationMs: DRAWER_SPEED_MS.normal,
  setTheme: () => {},
  cycleTheme: () => {},
  setColorTheme: () => {},
  setDrawerSpeed: () => {},
  hydrateFromSettings: () => {},
};

const ThemeContext = createContext<ThemeContextValue>(DEFAULT_CONTEXT);

export interface ThemeProviderProps {
  children: React.ReactNode;
  defaultPreference?: ThemePreference;
  defaultColorTheme?: ColorTheme;
  defaultDrawerSpeed?: DrawerSpeed;
}

export function ThemeProvider({
  children,
  defaultPreference = 'system',
  defaultColorTheme = 'monochrome',
  defaultDrawerSpeed = 'normal',
}: ThemeProviderProps) {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    readStored(THEME_STORAGE_KEY, normalizeThemePreference, defaultPreference),
  );
  const [colorTheme, setColorThemeState] = useState<ColorTheme>(() =>
    readStored(COLOR_THEME_STORAGE_KEY, normalizeColorTheme, defaultColorTheme),
  );
  const [drawerSpeed, setDrawerSpeedState] = useState<DrawerSpeed>(() =>
    readStored(DRAWER_SPEED_STORAGE_KEY, normalizeDrawerSpeed, defaultDrawerSpeed),
  );
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());

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

  const resolvedTheme: ResolvedTheme = preference === 'system' ? systemTheme : preference;
  const drawerDurationMs = DRAWER_SPEED_MS[drawerSpeed];

  useEffect(() => {
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      root.dataset.theme = resolvedTheme;
      root.dataset.themePref = preference;
      root.dataset.colorTheme = colorTheme;
      root.dataset.drawerSpeed = drawerSpeed;
      root.style.setProperty('--drawer-duration', `${drawerDurationMs}ms`);
    }
  }, [resolvedTheme, preference, colorTheme, drawerSpeed, drawerDurationMs]);

  const setTheme = useCallback((next: ThemePreference) => {
    setPreference(next);
    writeStored(THEME_STORAGE_KEY, next);
  }, []);

  const cycleTheme = useCallback(() => {
    setTheme(preference === 'dark' ? 'light' : preference === 'light' ? 'system' : 'dark');
  }, [preference, setTheme]);

  const setColorTheme = useCallback((next: ColorTheme) => {
    setColorThemeState(next);
    writeStored(COLOR_THEME_STORAGE_KEY, next);
  }, []);

  const setDrawerSpeed = useCallback((next: DrawerSpeed) => {
    setDrawerSpeedState(next);
    writeStored(DRAWER_SPEED_STORAGE_KEY, next);
  }, []);

  const hydrateFromSettings = useCallback(
    (settings: Record<string, unknown> | null | undefined) => {
      if (!settings || typeof settings !== 'object') return;
      const tPref = normalizeThemePreference(settings.theme);
      if (tPref) {
        setPreference(tPref);
        writeStored(THEME_STORAGE_KEY, tPref);
      }
      const cPref = normalizeColorTheme(settings.colorTheme);
      if (cPref) {
        setColorThemeState(cPref);
        writeStored(COLOR_THEME_STORAGE_KEY, cPref);
      }
      const sPref = normalizeDrawerSpeed(settings.drawerSpeed);
      if (sPref) {
        setDrawerSpeedState(sPref);
        writeStored(DRAWER_SPEED_STORAGE_KEY, sPref);
      }
    },
    [],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolvedTheme,
      colorTheme,
      drawerSpeed,
      drawerDurationMs,
      setTheme,
      cycleTheme,
      setColorTheme,
      setDrawerSpeed,
      hydrateFromSettings,
    }),
    [
      preference,
      resolvedTheme,
      colorTheme,
      drawerSpeed,
      drawerDurationMs,
      setTheme,
      cycleTheme,
      setColorTheme,
      setDrawerSpeed,
      hydrateFromSettings,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
