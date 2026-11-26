export interface BuiltinPetTheme {
  id: string;
  name: Record<string, string> | string;
  description?: Record<string, string> | string;
  accentHex?: string;
  usesHostAccent?: boolean;
  builtin?: boolean;
  scene: {
    sceneId: string;
    viewBox?: { width: number; height: number };
    fps?: { active?: number; idle?: number; sleep?: number };
    hitBox?: { x: number; y: number; width: number; height: number };
    particles?: { preset?: string; color?: string };
    layers: Array<Record<string, unknown>>;
  };
}

export const BUILTIN_THEMES: BuiltinPetTheme[];
export function getBuiltinThemes(): BuiltinPetTheme[];
export function getBuiltinThemeById(id: string): BuiltinPetTheme;
