'use strict';

const { measure } = require('./context-analyzer');

/**
 * Estimate token count for live DOM streaming text using the same
 * CJK/ASCII heuristic as context-analyzer's midpoint formula.
 */
function estimateTextTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const acc = { chars: 0, bytes: 0, cjk: 0 };
  measure(s, acc);
  return (acc.chars - acc.cjk) / 4 + acc.cjk * 1.2;
}

/**
 * Tracks assistant streaming DOM text deltas to produce live ~tok/s estimates
 * while generation is active, and signals completion when busy transitions to idle.
 */
function createStreamSpeedTracker(options = {}) {
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : 3000;
  const minElapsedSec = Number(options.minElapsedSec) > 0 ? Number(options.minElapsedSec) : 0.25;
  const minDeltaTokens = Number(options.minDeltaTokens) > 0 ? Number(options.minDeltaTokens) : 3;

  let active = false;
  let startedAt = 0;
  let baseTokens = 0;
  let firstTokenAt = null;
  let samples = [];
  let lastLive = null;

  function reset() {
    active = false;
    startedAt = 0;
    baseTokens = 0;
    firstTokenAt = null;
    samples = [];
    lastLive = null;
  }

  function sample({ busy = false, text = '' } = {}) {
    const t = Number(nowFn());

    if (!busy) {
      const wasActive = active;
      reset();
      return { live: null, completed: wasActive };
    }

    const curTokens = estimateTextTokens(text);

    if (!active) {
      active = true;
      startedAt = t;
      baseTokens = curTokens;
      firstTokenAt = null;
      samples = [{ t, tokens: curTokens }];
    } else if (curTokens < baseTokens) {
      // Turn switched or response DOM reset while still busy: re-anchor baseline
      baseTokens = curTokens;
      firstTokenAt = null;
      samples = [{ t, tokens: curTokens }];
    } else {
      samples.push({ t, tokens: curTokens });
    }

    // Keep one anchor sample at or just before (t - windowMs) for sliding window delta
    const cutoff = t - windowMs;
    while (samples.length > 2 && samples[1].t <= cutoff) {
      samples.shift();
    }

    const deltaTokens = Math.max(0, curTokens - baseTokens);
    const elapsedSec = Math.max(0, (t - startedAt) / 1000);

    if (deltaTokens > 0 && firstTokenAt === null) {
      firstTokenAt = t;
    }

    if (firstTokenAt === null) {
      lastLive = {
        active: true,
        phase: 'waiting',
        estimated: true,
        tps: null,
        ttft: null,
        streamingSec: 0,
        elapsedSec: Number(elapsedSec.toFixed(1)),
        estimatedOutputTokens: 0
      };
      return { live: lastLive, completed: false };
    }

    const streamingSec = Math.max(0, (t - firstTokenAt) / 1000);
    const ttft = Math.max(0, (firstTokenAt - startedAt) / 1000);

    let rawTps = null;
    if (streamingSec >= minElapsedSec && deltaTokens >= minDeltaTokens) {
      const anchor = samples[0];
      const windowSpanSec = (t - anchor.t) / 1000;
      const windowDelta = curTokens - anchor.tokens;
      if (windowSpanSec >= 0.4 && windowDelta > 0) {
        rawTps = windowDelta / windowSpanSec;
      } else {
        rawTps = deltaTokens / streamingSec;
      }
    }

    lastLive = {
      active: true,
      phase: 'streaming',
      estimated: true,
      tps: rawTps !== null && Number.isFinite(rawTps) ? Number(rawTps.toFixed(1)) : null,
      ttft: Number(ttft.toFixed(2)),
      streamingSec: Number(streamingSec.toFixed(1)),
      elapsedSec: Number(elapsedSec.toFixed(1)),
      estimatedOutputTokens: Math.round(deltaTokens)
    };

    return { live: lastLive, completed: false };
  }

  return {
    sample,
    reset,
    getState() {
      return {
        active,
        startedAt,
        baseTokens,
        firstTokenAt,
        live: lastLive
      };
    }
  };
}

module.exports = {
  estimateTextTokens,
  createStreamSpeedTracker
};
