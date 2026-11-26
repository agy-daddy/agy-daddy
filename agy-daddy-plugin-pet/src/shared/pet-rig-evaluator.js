'use strict';

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

/**
 * Maps live TPS + session state to animState, speedFactor, roam speed, and target FPS.
 * Matches DESKTOP_PET_DESIGN.md Section 3.5 formula.
 */
function mapTpsToMotion({
  tps = null,
  busy = false,
  idleMs = 0,
  hasApproval = false,
  hasError = false
} = {}) {
  if (hasApproval) {
    return {
      animState: 'approval',
      rawSpeedFactor: 1.4,
      roamSpeedPxPerSec: 0,
      targetFps: 24
    };
  }
  if (hasError) {
    return {
      animState: 'error',
      rawSpeedFactor: 1.0,
      roamSpeedPxPerSec: 0,
      targetFps: 20
    };
  }
  const numTps = typeof tps === 'number' && Number.isFinite(tps) && tps > 0 ? tps : null;
  if (numTps !== null) {
    const rawFactor = clamp(1.0 + 0.75 * Math.log2(1 + Math.max(0, numTps) / 15), 1.0, 3.5);
    if (numTps > 65) {
      return {
        animState: 'sprinting',
        rawSpeedFactor: Number(rawFactor.toFixed(2)),
        roamSpeedPxPerSec: Math.round(95 + ((rawFactor - 2.35) / 1.15) * 55),
        targetFps: 30
      };
    }
    if (numTps > 25) {
      return {
        animState: 'trotting',
        rawSpeedFactor: Number(rawFactor.toFixed(2)),
        roamSpeedPxPerSec: Math.round(55 + ((rawFactor - 1.6) / 0.75) * 40),
        targetFps: 30
      };
    }
    return {
      animState: 'walking',
      rawSpeedFactor: Number(rawFactor.toFixed(2)),
      roamSpeedPxPerSec: Math.round(32 + ((rawFactor - 1.0) / 0.6) * 23),
      targetFps: 30
    };
  }
  if (busy) {
    return {
      animState: 'thinking',
      rawSpeedFactor: 1.0,
      roamSpeedPxPerSec: 18,
      targetFps: 20
    };
  }
  if (Number(idleMs) > 45000) {
    return {
      animState: 'sleeping',
      rawSpeedFactor: 0.35,
      roamSpeedPxPerSec: 0,
      targetFps: 4
    };
  }
  return {
    animState: 'idle',
    rawSpeedFactor: 0.8,
    roamSpeedPxPerSec: 12,
    targetFps: 12
  };
}

function createSpeedSmoother(alpha = 0.35) {
  let ema = null;
  return {
    push(rawFactor) {
      const val = clamp(Number(rawFactor) || 0.8, 0.25, 3.5);
      if (ema === null) ema = val;
      else ema = alpha * val + (1 - alpha) * ema;
      return Number(ema.toFixed(2));
    },
    reset() {
      ema = null;
    }
  };
}

function evaluatePetRig(sceneSpec, runtimeState = {}, timestampMs = Date.now()) {
  const layers = Array.isArray(sceneSpec?.layers) ? sceneSpec.layers : [];
  const animState = String(runtimeState.animState || 'idle');
  const speedFactor = clamp(Number(runtimeState.speedFactor || 1.0), 0.25, 4.0);
  const tSec = Number(timestampMs) / 1000;
  const vbW = Number(sceneSpec?.viewBox?.width || 160);
  const vbH = Number(sceneSpec?.viewBox?.height || 160);

  const transforms = [];
  for (const layer of layers) {
    const allowedStates = layer.motion?.states;
    if (Array.isArray(allowedStates) && !allowedStates.includes(animState)) {
      continue;
    }
    const m = layer.motion || {};
    const phase = Number(m.phaseRad || 0);
    let tx = 0;
    let ty = 0;
    let rotRad = 0;
    let scaleY = 1;

    if (m.bobAmpY && m.bobFreqHz) {
      ty += Number(m.bobAmpY) * Math.sin(2 * Math.PI * Number(m.bobFreqHz) * speedFactor * tSec + phase);
    }
    if (m.swayAmpX && m.swayFreqHz) {
      tx += Number(m.swayAmpX) * Math.sin(2 * Math.PI * Number(m.swayFreqHz) * speedFactor * tSec + phase);
    }
    if (m.rotAmpDeg && m.rotFreqHz) {
      rotRad = ((Number(m.rotAmpDeg) * Math.PI) / 180) * Math.sin(2 * Math.PI * Number(m.rotFreqHz) * speedFactor * tSec + phase);
    }
    if (m.blinkIntervalMs && Number(m.blinkIntervalMs) > 0) {
      const cycle = Number(timestampMs) % Number(m.blinkIntervalMs);
      if (cycle < 130) scaleY = 0.12;
    }

    transforms.push({
      layer,
      pivotX: Number(layer.pivotX ?? vbW / 2),
      pivotY: Number(layer.pivotY ?? vbH / 2),
      tx,
      ty,
      rotRad,
      scaleX: 1,
      scaleY,
      opacity: layer.opacity !== undefined ? clamp(Number(layer.opacity), 0, 1) : 1
    });
  }

  const preset = sceneSpec?.particles?.preset || 'none';
  const particleColor = sceneSpec?.particles?.color || '#a78bfa';
  const particles = [];
  if (preset !== 'none' && animState !== 'sleeping') {
    const count = animState === 'sprinting' ? 8 : (animState === 'trotting' ? 6 : 3);
    for (let i = 0; i < count; i++) {
      const p = ((tSec * speedFactor * 0.7 + i / count) % 1 + 1) % 1;
      particles.push({
        x: vbW * (0.2 + ((i * 37) % 60) / 100),
        y: preset === 'exhaust' ? vbH * (0.65 + p * 0.3) : vbH * (0.45 - p * 0.4),
        size: 2.2 + (i % 3),
        opacity: Math.max(0.1, (1 - p) * 0.85),
        color: particleColor,
        preset
      });
    }
  }

  return { transforms, particles };
}

module.exports = {
  mapTpsToMotion,
  createSpeedSmoother,
  evaluatePetRig
};
