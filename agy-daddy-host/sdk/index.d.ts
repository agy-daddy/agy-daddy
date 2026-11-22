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
  | 'fileViewer.header';

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
}

export interface SettingsSchema {
  title: string | LocalizedText;
  fields: SettingsField[];
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
    settings?: { schema: string };
    'remote.panels'?: Array<{ id: string; service: string; title?: string }>;
    commands?: Array<{ id: string; title: string | LocalizedText }>;
    'chat.search'?: Array<{ id: string; title?: string | LocalizedText }>;
    locales?: string;
    native?: { mcp?: string; rules?: string[]; skills?: string[]; hooks?: string };
    migrations?: Array<{ from: string; files: string[] }>;
  };
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
}

export interface AgyRendererContext {
  pluginId: string;
  hostVersion: string;
  anchors: {
    query(name: AnchorName): HTMLElement | null;
    queryAll(name: AnchorName): HTMLElement[];
    observe(name: AnchorName, callback: (el: HTMLElement | null) => void): () => void;
  };
  topbar: {
    registerUnit(def: { id: string; order?: number; label?: string; render?: (node: HTMLElement) => void; onClick?: () => void }): () => void;
    registerPopover(def: { id: string; anchorId: string; render?: (node: HTMLElement) => void; onToggle?: (open: boolean) => void }): {
      toggle(force?: boolean): boolean;
      dispose(): void;
    };
  };
  settings: {
    registerSection(def: { id: string; title?: string | LocalizedText; schema?: SettingsSchema; values?: Record<string, unknown>; onChange?: (key: string, value: unknown) => void }): () => void;
  };
  schedule: {
    every(ms: number, fn: () => void): () => void;
    idle(fn: () => void): () => void;
  };
  services: {
    provide(name: string, methods: Record<string, (...args: unknown[]) => unknown>): () => void;
    get(name: string): Record<string, (...args: unknown[]) => unknown> | null;
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
