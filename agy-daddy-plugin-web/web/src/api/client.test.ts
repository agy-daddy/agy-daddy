import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiRequest,
  getAppBasePrefix,
  listBackgroundTasks,
  markSessionRead,
  resolveApiUrl,
  sendTerminalInput,
  setConfirmWriteHandler,
  stopBackgroundTask,
  streamSideChatCompletion,
} from './client';

describe('apiRequest Cloudflare write confirmation gate', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    setConfirmWriteHandler(null);
  });

  afterEach(() => {
    setConfirmWriteHandler(null);
    vi.unstubAllGlobals();
  });

  it('does not silently auto-retry 403 CONFIRMATION_REQUIRED when no UI confirmation handler is registered', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'CONFIRMATION_REQUIRED',
          channel: 'cloudflare',
          action: 'POST /api/v1/sessions',
          confirmToken: 'tok-cf-123',
          confirmHint: 'Confirmation required',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      apiRequest('/api/v1/sessions', { method: 'POST', body: { title: 'demo' } }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'CONFIRMATION_REQUIRED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prompts the registered confirmation handler and retries once with X-Agy-Confirm on approval', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error: 'CONFIRMATION_REQUIRED',
            channel: 'cloudflare',
            action: 'PUT /api/v1/fs/write',
            confirmToken: 'tok-cf-approve',
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const handler = vi.fn().mockResolvedValue(true);
    setConfirmWriteHandler(handler);

    const res = await apiRequest<{ ok: boolean }>('/api/v1/fs/write', {
      method: 'PUT',
      body: { root: '/ws', path: 'a.ts', content: 'x' },
    });

    expect(res).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PUT /api/v1/fs/write',
        channel: 'cloudflare',
        confirmToken: 'tok-cf-approve',
        method: 'PUT',
        path: '/api/v1/fs/write',
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const retryHeaders = retryInit.headers as Record<string, string>;
    expect(retryHeaders['X-Agy-Confirm']).toBe('tok-cf-approve');
    expect(retryHeaders['X-Agy-Csrf']).toBe('1');
  });

  it('aborts without retrying when the user cancels the confirmation prompt', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'CONFIRMATION_REQUIRED',
          channel: 'cloudflare',
          action: 'POST /api/v1/sessions',
          confirmToken: 'tok-cf-cancel',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const handler = vi.fn().mockResolvedValue(false);
    setConfirmWriteHandler(handler);

    let caught: unknown = null;
    try {
      await apiRequest('/api/v1/sessions', { method: 'POST', body: { title: 'x' } });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(403);
    expect((caught as ApiError).code).toBe('CONFIRMATION_CANCELLED');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips modal prompt for passive markSessionRead telemetry on Cloudflare channel', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'CONFIRMATION_REQUIRED',
          channel: 'cloudflare',
          action: 'PUT /api/v1/sessions/s1/read',
          confirmToken: 'tok-cf-read',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const handler = vi.fn().mockResolvedValue(true);
    setConfirmWriteHandler(handler);

    await expect(markSessionRead('s1', { lastReadStepCount: 3 })).rejects.toMatchObject({
      status: 403,
      code: 'CONFIRMATION_REQUIRED',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prefixes API calls with /pc when mounted under /pc/ while preserving logical confirm action', async () => {
    const origLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { pathname: '/pc/' },
      configurable: true,
    });
    try {
      expect(getAppBasePrefix()).toBe('/pc');
      expect(resolveApiUrl('/api/v1/sessions')).toBe('/pc/api/v1/sessions');
      expect(resolveApiUrl('/pc/api/v1/sessions')).toBe('/pc/api/v1/sessions');

      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: false,
              error: 'CONFIRMATION_REQUIRED',
              channel: 'cloudflare',
              action: 'POST /api/v1/sessions',
              confirmToken: 'tok-pc-1',
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );

      const handler = vi.fn().mockResolvedValue(true);
      setConfirmWriteHandler(handler);

      const res = await apiRequest<{ ok: boolean }>('/api/v1/sessions', {
        method: 'POST',
        body: { title: 'pc-test' },
      });
      expect(res).toEqual({ ok: true });
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/pc/api/v1/sessions');
      expect(fetchMock.mock.calls[1]?.[0]).toBe('/pc/api/v1/sessions');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'POST /api/v1/sessions',
          path: '/api/v1/sessions',
        }),
      );
    } finally {
      Object.defineProperty(window, 'location', {
        value: origLocation,
        configurable: true,
      });
    }
  });

  it('renews expired PTY_WRITE lease token via confirmWriteHandler and streams Side Chat under /pc/', async () => {
    const origLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { pathname: '/pc/' },
      configurable: true,
    });
    try {
      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: false,
              error: 'CONFIRMATION_REQUIRED',
              channel: 'cloudflare',
              action: 'PTY_WRITE:term-1',
              confirmToken: 'tok-renewed-5m',
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, sessionId: 'term-1' }), { status: 200 }),
        );

      const handler = vi.fn().mockResolvedValue(true);
      setConfirmWriteHandler(handler);
      const renewedTokens: string[] = [];

      const inputRes = await sendTerminalInput('term-1', 'ls\n', {
        confirmToken: 'tok-expired',
        onConfirmTokenRenewed: (t) => renewedTokens.push(t),
      });
      expect(inputRes).toEqual({ ok: true, sessionId: 'term-1' });
      expect(renewedTokens).toEqual(['tok-renewed-5m']);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/pc/api/v1/terminal/sessions/term-1/input');

      const sseBody = [
        'event: meta\ndata: {"requestId":"req-1","model":"gemini-4-flash","label":"Flash","contextScope":"none"}\n\n',
        'event: delta\ndata: {"delta":"Hello "}\n\n',
        'event: done\ndata: {"requestId":"req-1","text":"Hello ","model":"gemini-4-flash","label":"Flash","durationMs":12}\n\n',
      ].join('');
      fetchMock.mockResolvedValueOnce(
        new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );

      const deltas: string[] = [];
      let doneText = '';
      await streamSideChatCompletion(
        { prompt: 'hi' },
        {
          onDelta: (d) => deltas.push(d.delta),
          onDone: (d) => {
            doneText = d.text;
          },
        },
      );
      expect(deltas).toEqual(['Hello ']);
      expect(doneText).toBe('Hello ');
      expect(fetchMock.mock.calls[2]?.[0]).toBe('/pc/api/v1/side-chat/completions');

      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: true, runningCount: 0, running: [], recent: [], serverTime: 1 }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: true, taskId: 'session:c1', alreadyFinished: true, status: 'done', exitCode: null }),
            { status: 200 },
          ),
        );

      const tasksRes = await listBackgroundTasks();
      expect(tasksRes.runningCount).toBe(0);
      const stopRes = await stopBackgroundTask('session:c1');
      expect(stopRes.alreadyFinished).toBe(true);
    } finally {
      Object.defineProperty(window, 'location', {
        value: origLocation,
        configurable: true,
      });
    }
  });
});
