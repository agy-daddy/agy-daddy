// TypeScript definitions for @agy-daddy/sdk (Plugin API v1)

export type TrustLevel = 'T0' | 'T1' | 'T2';
export type Realm = 'node' | 'page-main' | 'page-isolated' | 'remote-client';
export type AnchorName =
  | 'topbar.rightCluster'
  | 'composer.root'
  | 'composer.editor'
  | 'composer.sendButton'
  | 'chat.scrollViewport'
  | 'chat.messageList'
  | 'chat.thinkingTrigger'
  | 'chat.actionButtons'
  | 'sidebar.conversationRows'
  | 'fileViewer.header'
  | 'settings.dialog'
  | 'settings.nav'
  | 'settings.content'
  | 'settings.openTrigger';

export type Permission =
  | 'dom:read'
  | 'dom:write'
  | 'page:main-world'
  | 'rpc:read'
  | 'rpc:write'
  | 'bridge:route'
  | 'fs:plugin-data'
  | 'fs:brain-read'
  | 'fs:user-files'
  | `net:outbound:${string}`
  | 'net:listen'
  | 'process:spawn'
  | 'host:launch-args'
  | 'native:install';

export interface LocalizedText {
  'zh-CN'?: string;
  en?: string;
  [locale: string]: string | undefined;
}

export interface SettingsField {
  key: string;
  type: 'boolean' | 'enum' | 'string' | 'number' | 'list';
  default?: unknown;
  min?: number;
  max?: number;
  options?: Array<string | { value: string; label: string | LocalizedText }>;
  label: string | LocalizedText;
  itemEditor?: Record<string, unknown>;
}

export interface SettingsAction {
  id: string;
  command: string;
  label: string | LocalizedText;
  args?: unknown[];
}

export interface SettingsSchema {
  title: string | LocalizedText;
  fields: SettingsField[];
  actions?: SettingsAction[];
}

export interface SettingsUpdateResult {
  ok: boolean;
  values: Record<string, unknown>;
  changedKeys: string[];
  rendererNotified?: number;
  errors?: string[];
}

export interface AgyPluginManifest {
  schemaVersion: 1;
  id: string;
  publisher: string;
  version: string;
  license?: string;
  displayName: string | LocalizedText;
  engines: { agyDaddy: string; antigravity?: string };
  main?: string;
  renderer?: string;
  remote?: string;
  world?: 'main' | 'isolated';
  dataVersion?: number;
  activationEvents?: string[];
  requires?: { anchors?: AnchorName[] };
  provides?: {
    services?: Record<string, string | { version: string; realm?: Realm }>;
    events?: string[];
    states?: string[];
    surfaces?: string[];
  };
  consumes?: Record<string, { version: string; optional?: boolean }>;
  permissions?: Permission[];
  contributes?: {
    'topbar.units'?: Array<{ id: string; order?: number }>;
    'topbar.popovers'?: Array<{ id: string; anchorId: string }>;
    'tray.menu'?: TrayMenuItemInput[];
    settings?: { schema: string };
    'remote.panels'?: Array<{ id: string; service: string; title?: string }>;
    commands?: Array<{ id: string; title: string | LocalizedText }>;
    'chat.search'?: Array<{ id: string; title?: string | LocalizedText }>;
    locales?: string;
    native?: { mcp?: string; rules?: string[]; skills?: string[]; hooks?: string };
  };
}

export type TrayMenuItemPosition = 'top' | 'plugins' | 'bottom' | { before: string } | { after: string };

export interface TrayMenuClickContext {
  id: string;
  fullId: string;
  pluginId: string;
  checked: boolean;
  update(patch: Partial<TrayMenuItemInput>): boolean | Promise<boolean>;
}

export interface TrayMenuItemInput {
  id: string;
  label?: string;
  type?: 'normal' | 'checkbox' | 'separator' | 'submenu';
  icon?: string;
  tooltip?: string;
  enabled?: boolean;
  checked?: boolean;
  visible?: boolean;
  order?: number;
  weight?: number;
  position?: TrayMenuItemPosition;
  command?: string;
  args?: unknown[];
  onClick?: (ctx: TrayMenuClickContext) => unknown | Promise<unknown>;
  submenu?: TrayMenuItemInput[];
}

export interface TrayMenuItemHandle {
  id: string;
  fullId: string;
  update(patch: Partial<TrayMenuItemInput>): boolean | Promise<boolean>;
  dispose(): boolean | Promise<boolean>;
}

export interface TrayMenuSnapshotItem {
  id: string;
  fullId: string;
  pluginId: string;
  type: 'normal' | 'checkbox' | 'separator' | 'submenu';
  label: string;
  enabled: boolean;
  order: number;
  position: TrayMenuItemPosition;
  faulted: boolean;
}

export interface ServiceCallResult<T = unknown> {
  ok: boolean;
  value: T;
  unavailable?: boolean;
  error?: string;
}

export interface AgyHostApi {
  pluginId: string;
  manifest: AgyPluginManifest;
  permissions: Set<string>;
  storage: {
    readJson<T = unknown>(fileName: string, fallback?: T): { ok: boolean; exists: boolean; corrupted?: boolean; data: T };
    writeJson(fileName: string, data: unknown): { ok: boolean; error?: string };
  };
  bridge: {
    registerRoute(subPath: string, handler: (body: unknown, meta?: unknown) => Promise<unknown> | unknown): Promise<() => void>;
  };
  rpc: {
    getOrigin(): Promise<string>;
    call<T = unknown>(method: string, body?: unknown): Promise<T>;
  };
  services: {
    provide(name: string, methods: Record<string, (...args: unknown[]) => unknown>, opts?: { version?: string; realm?: Realm }): () => void;
    call<T = unknown>(name: string, method: string, args?: unknown[], opts?: { optional?: boolean; timeoutMs?: number }): Promise<ServiceCallResult<T>>;
    get<T = Record<string, (...args: unknown[]) => Promise<unknown>>>(name: string, opts?: { optional?: boolean }): T;
  };
  events: {
    emit(topic: string, payload?: unknown): void;
    on(topic: string, handler: (payload: unknown) => void): () => void;
  };
  state: {
    set(key: string, value: unknown): { version: number; value: unknown };
    get(key: string): { version: number; value: unknown } | null;
    subscribe(key: string, handler: (value: unknown, meta: { version: number; replay?: boolean }) => void): () => void;
  };
  hooks: {
    register(name: 'hostLaunchArgs' | 'hostLaunchEnv' | string, handler: (ctx?: unknown) => unknown): () => void;
  };
  net: {
    fetch(url: string, init?: RequestInit): Promise<Response>;
  };
  settings: {
    get(): Record<string, unknown>;
    update(patch: Record<string, unknown>): Promise<SettingsUpdateResult>;
    save?(values: Record<string, unknown>, schema?: SettingsSchema | null): { ok: boolean; error?: string } | Promise<SettingsUpdateResult>;
    onChange(handler: (values: Record<string, unknown>, changedKeys: string[]) => void): () => void;
  };
  commands: {
    register(commandId: string, handler: (...args: unknown[]) => unknown): (() => void) | Promise<() => void>;
    execute<T = unknown>(commandId: string, args?: unknown[]): Promise<T>;
  };
  tray: {
    registerMenuItem(def: TrayMenuItemInput): TrayMenuItemHandle | Promise<TrayMenuItemHandle>;
    updateMenuItem(itemId: string, patch: Partial<TrayMenuItemInput>): boolean | Promise<boolean>;
    unregisterMenuItem(itemId: string): boolean | Promise<boolean>;
    listMenuItems(): TrayMenuSnapshotItem[] | Promise<TrayMenuSnapshotItem[]>;
  };
}

export interface AgyRendererContext {
  pluginId: string;
  hostVersion: string;
  hostDom: {
    getSessionId(): string | null;
    getComposer(): HTMLElement | null;
    getScrollViewport(): HTMLElement | null;
    getSidebarRows(): HTMLElement[];
    isAssistantBusy(): boolean;
    sendText(text: string): boolean;
  };
  anchors: {
    query(name: AnchorName): HTMLElement | null;
    queryAll(name: AnchorName): HTMLElement[];
    observe(name: AnchorName, callback: (el: HTMLElement | null) => void): () => void;
  };
  styles: {
    inject(cssText: string, opts?: { scope?: 'document' | 'shadow'; id?: string }): () => void;
  };
  topbar: {
    registerUnit(def: {
      id: string;
      order?: number;
      label?: string;
      iconSvg?: string;
      segments?: Array<{
        iconSvg?: string;
        text?: string;
        tone?: string;
        muted?: boolean;
        title?: string;
      }>;
      title?: string;
      badge?: string;
      tone?: string;
      accentColor?: string;
      render?: (node: HTMLElement) => void;
      onClick?: () => void;
    }): () => void;
    updateUnit(unitId: string, patch: {
      label?: string;
      iconSvg?: string;
      segments?: Array<{
        iconSvg?: string;
        text?: string;
        tone?: string;
        muted?: boolean;
        title?: string;
      }> | null;
      title?: string;
      badge?: string;
      tone?: string;
      accentColor?: string;
      order?: number;
      render?: (node: HTMLElement) => void;
      onClick?: () => void;
    }): Promise<unknown>;
    registerPopover(def: {
      id: string;
      anchorId?: string;
      title?: string;
      render?: (node: HTMLElement) => void;
      onToggle?: (open: boolean) => void;
    }): {
      toggle(
        force?: boolean | {
          force?: boolean;
          anchorRect?: { top: number; left: number; right: number; bottom: number; width: number; height: number } | null;
          placement?: 'top' | 'bottom' | 'auto';
        },
        opts?: {
          anchorRect?: { top: number; left: number; right: number; bottom: number; width: number; height: number } | null;
          placement?: 'top' | 'bottom' | 'auto';
        }
      ): boolean | Promise<unknown>;
      dispose(): void;
    };
  };
  surfaces: {
    provide(surfaceName: string, el: HTMLElement): () => void;
    mount(
      surfaceName: string,
      mountFn: (slotEl: HTMLElement, meta: { surfaceName: string; fallback: boolean }) => (() => void) | void,
      opts?: { fallbackAnchor?: AnchorName }
    ): () => void;
  };
  settings: {
    get(): Record<string, unknown>;
    update(patch: Record<string, unknown>): Promise<SettingsUpdateResult>;
    onChange(handler: (values: Record<string, unknown>, changedKeys: string[]) => void): () => void;
    open(opts?: string | { tab?: string; pluginId?: string }): Promise<unknown>;
  };
  schedule: {
    every(ms: number, fn: () => void): () => void;
    idle(fn: () => void): () => void;
  };
  services: {
    provide(name: string, methods: Record<string, (...args: unknown[]) => unknown>): () => void;
    call<T = unknown>(name: string, method: string, args?: unknown[]): Promise<T>;
    get(name: string): Record<string, (...args: unknown[]) => unknown> | null;
  };
  events: {
    emit(topic: string, payload?: unknown): void | Promise<unknown>;
    on(topic: string, handler: (payload: unknown) => void): () => void;
  };
  state: {
    set(key: string, value: unknown): { version: number; value: unknown } | Promise<unknown>;
    get(key: string): { version: number; value: unknown } | null | Promise<unknown>;
    subscribe(key: string, handler: (value: unknown, meta: { version: number; replay?: boolean }) => void): () => void;
  };
  commands: {
    execute<T = unknown>(commandId: string, args?: unknown[]): Promise<T>;
  };
  bridge: {
    post<T = unknown>(subPath: string, payload?: unknown): Promise<T>;
  };
}

export function createPluginScaffold(targetDir: string, options?: {
  id?: string;
  displayName?: string | LocalizedText;
  world?: 'main' | 'isolated';
  permissions?: Permission[];
  anchors?: AnchorName[];
}): { ok: boolean; targetDir: string; pluginId: string; files: string[] };

export function createMockHostHarness(options?: {
  stateDir?: string;
  origin?: string;
  onRpc?: (method: string, body: unknown) => unknown;
  seedAnchors?: Array<{ tag: string; attr: string; val: string }>;
}): unknown;
