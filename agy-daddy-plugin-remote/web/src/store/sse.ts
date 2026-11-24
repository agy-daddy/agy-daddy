export type SseStatus = 'disconnected' | 'connecting' | 'connected' | 'suspended';

export interface SseClientCallbacks {
  onStatusChange: (status: SseStatus) => void;
  onSessionDelta: (payload: Record<string, unknown>) => void;
  onAttentionUpdate: (payload: Record<string, unknown>) => void;
  onTelemetryPatch: (payload: Record<string, unknown>) => void;
  onQueueUpdate: (payload: Record<string, unknown>) => void;
}

export const SSE_BACKGROUND_SUSPEND_MS = 15_000;

export class RemoteSseClient {
  private token = '';
  private sessionId = '';
  private lastEventId = '';
  private es: EventSource | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private destroyed = false;
  private suspendedByVisibility = false;
  private callbacks: SseClientCallbacks;

  constructor(callbacks: SseClientCallbacks) {
    this.callbacks = callbacks;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  public connect(token: string, sessionId: string): void {
    const changed = this.token !== token || this.sessionId !== sessionId;
    this.token = token;
    this.sessionId = sessionId;
    if (changed) {
      this.lastEventId = '';
    }
    this.suspendedByVisibility = false;
    this.clearSuspendTimer();
    this.openStream();
  }

  public destroy(): void {
    this.destroyed = true;
    this.clearSuspendTimer();
    this.clearReconnectTimer();
    this.closeStream();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  private handleVisibilityChange = (): void => {
    if (this.destroyed || typeof document === 'undefined') return;
    if (document.hidden) {
      this.clearSuspendTimer();
      this.suspendTimer = setTimeout(() => {
        this.suspendedByVisibility = true;
        this.closeStream();
        this.callbacks.onStatusChange('suspended');
      }, SSE_BACKGROUND_SUSPEND_MS);
    } else {
      this.clearSuspendTimer();
      if (this.suspendedByVisibility || !this.es) {
        this.suspendedByVisibility = false;
        this.openStream();
      }
    }
  };

  private clearSuspendTimer(): void {
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeStream(): void {
    this.clearReconnectTimer();
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }

  private openStream(): void {
    if (this.destroyed || !this.token || typeof EventSource === 'undefined') {
      return;
    }
    this.closeStream();
    this.callbacks.onStatusChange('connecting');

    const params = new URLSearchParams();
    params.set('t', this.token);
    if (this.sessionId) params.set('sessionId', this.sessionId);
    if (this.lastEventId) params.set('lastEventId', this.lastEventId);

    const es = new EventSource(`/api/v1/stream?${params.toString()}`);
    this.es = es;

    es.onopen = () => {
      this.retryCount = 0;
      this.callbacks.onStatusChange('connected');
    };

    const bind = (eventName: string, handler: (data: Record<string, unknown>) => void) => {
      es.addEventListener(eventName, (ev: MessageEvent) => {
        if (ev.lastEventId) this.lastEventId = ev.lastEventId;
        try {
          const parsed = JSON.parse(String(ev.data || '{}')) as Record<string, unknown>;
          handler(parsed);
        } catch {}
      });
    };

    bind('session.delta', (d) => this.callbacks.onSessionDelta(d));
    bind('attention.update', (d) => this.callbacks.onAttentionUpdate(d));
    bind('telemetry.patch', (d) => this.callbacks.onTelemetryPatch(d));
    bind('queue.update', (d) => this.callbacks.onQueueUpdate(d));

    es.onerror = () => {
      if (this.destroyed || this.suspendedByVisibility) return;
      this.closeStream();
      this.callbacks.onStatusChange('disconnected');
      const delay = Math.min(12_000, 1000 * Math.pow(1.6, Math.min(this.retryCount++, 5)));
      this.reconnectTimer = setTimeout(() => {
        if (!this.destroyed && !this.suspendedByVisibility) {
          this.openStream();
        }
      }, delay);
    };
  }
}
