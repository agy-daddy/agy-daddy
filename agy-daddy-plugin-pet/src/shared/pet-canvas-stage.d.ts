export interface PetCanvasSceneLike {
  sceneId: string;
  viewBox?: { width: number; height: number };
  fps?: { active?: number; idle?: number; sleep?: number };
  hitBox?: { x: number; y: number; width: number; height: number };
  particles?: { preset?: string; color?: string };
  layers: Array<Record<string, unknown>>;
}

export interface PetCanvasStageState {
  animState?: string;
  speedFactor?: number;
  flipX?: boolean;
  scale?: number;
}

export interface PetCanvasStageInstance {
  setScene(scene: PetCanvasSceneLike | null, nextAssets?: Record<string, string> | null): void;
  setState(state: PetCanvasStageState): void;
  resize(width?: number, height?: number): void;
  drawFrame(nowMs?: number): void;
  start(): void;
  stop(): void;
  dispose(): void;
}

export function createPetCanvasStage(
  canvas: HTMLCanvasElement,
  options?: {
    width?: number;
    height?: number;
    scene?: PetCanvasSceneLike | null;
    state?: PetCanvasStageState;
    assetMap?: Record<string, string>;
  },
): PetCanvasStageInstance;
