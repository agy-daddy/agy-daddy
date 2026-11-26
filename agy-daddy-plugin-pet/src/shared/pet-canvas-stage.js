'use strict';

const { evaluatePetRig } = require('./pet-rig-evaluator');

/**
 * Shared HTML5 Canvas Path2D + Sprite stage used by both PC-Web (<WebPetOverlay />)
 * and Desktop Antigravity Settings/Popover live previews.
 */
function createPetCanvasStage(canvas, options = {}) {
  let scene = options.scene || null;
  let state = options.state || { animState: 'idle', speedFactor: 1.0, flipX: false, scale: 1.0 };
  let assetMap = options.assetMap || {};
  let rafId = null;
  let running = false;
  let lastDrawAt = 0;
  let logicalW = Number(options.width || 160);
  let logicalH = Number(options.height || 160);

  const pathCache = new Map();
  const imageCache = new Map();

  function getCachedPath(sceneId, layer) {
    if (!layer?.d || typeof globalThis.Path2D !== 'function') return null;
    const key = `${sceneId}:${layer.id}:${layer.d}`;
    let p = pathCache.get(key);
    if (!p) {
      p = new globalThis.Path2D(layer.d);
      pathCache.set(key, p);
    }
    return p;
  }

  function getCachedImage(srcKey) {
    if (!srcKey || typeof globalThis.Image !== 'function') return null;
    const resolved = assetMap[srcKey] || srcKey;
    let entry = imageCache.get(resolved);
    if (!entry) {
      const img = new globalThis.Image();
      entry = { img, loaded: false };
      img.onload = () => { entry.loaded = true; };
      img.src = resolved;
      imageCache.set(resolved, entry);
    }
    return entry.loaded ? entry.img : null;
  }

  function resize(w = logicalW, h = logicalH) {
    logicalW = Math.max(32, Number(w) || 160);
    logicalH = Math.max(32, Number(h) || 160);
    const dpr = Math.min(3, Math.max(1, Number(globalThis.devicePixelRatio || 1)));
    canvas.width = Math.round(logicalW * dpr);
    canvas.height = Math.round(logicalH * dpr);
    if (canvas.style) {
      canvas.style.width = `${logicalW}px`;
      canvas.style.height = `${logicalH}px`;
    }
  }

  function drawFrame(nowMs = Date.now()) {
    const ctx = canvas.getContext?.('2d');
    if (!ctx || !scene) return;
    const dpr = Math.min(3, Math.max(1, Number(globalThis.devicePixelRatio || 1)));
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, logicalW, logicalH);

    const vbW = Math.max(1, Number(scene.viewBox?.width || 160));
    const vbH = Math.max(1, Number(scene.viewBox?.height || 160));
    const petScale = Math.max(0.5, Math.min(2.0, Number(state.scale || 1.0)));
    const fitScale = Math.min(logicalW / vbW, logicalH / vbH) * petScale;
    const ox = (logicalW - vbW * fitScale) / 2;
    const oy = (logicalH - vbH * fitScale) / 2;

    ctx.translate(ox, oy);
    ctx.scale(fitScale, fitScale);
    if (state.flipX) {
      ctx.translate(vbW, 0);
      ctx.scale(-1, 1);
    }

    const { transforms, particles } = evaluatePetRig(scene, state, nowMs);

    for (const pt of particles) {
      ctx.save();
      ctx.globalAlpha = pt.opacity;
      ctx.fillStyle = pt.color;
      if (pt.preset === 'pixels') {
        ctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
      } else {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    for (const item of transforms) {
      const l = item.layer;
      ctx.save();
      ctx.globalAlpha = item.opacity;
      ctx.translate(item.pivotX + item.tx, item.pivotY + item.ty);
      if (item.rotRad) ctx.rotate(item.rotRad);
      if (item.scaleX !== 1 || item.scaleY !== 1) ctx.scale(item.scaleX, item.scaleY);
      ctx.translate(-item.pivotX, -item.pivotY);

      const hasFill = Boolean(l.fill && l.fill !== 'none');
      const hasStroke = Boolean(l.stroke && l.stroke !== 'none');
      if (hasFill) ctx.fillStyle = l.fill;
      if (hasStroke) {
        ctx.strokeStyle = l.stroke;
        ctx.lineWidth = Number(l.strokeWidth ?? 1.5);
      }

      if (l.kind === 'path') {
        const p2d = getCachedPath(scene.sceneId, l);
        if (p2d) {
          if (hasFill) ctx.fill(p2d);
          if (hasStroke) ctx.stroke(p2d);
        }
      } else if (l.kind === 'circle') {
        ctx.beginPath();
        ctx.arc(Number(l.cx || 0), Number(l.cy || 0), Number(l.r || 8), 0, Math.PI * 2);
        if (hasFill) ctx.fill();
        if (hasStroke) ctx.stroke();
      } else if (l.kind === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(Number(l.cx || 0), Number(l.cy || 0), Number(l.rx || 10), Number(l.ry || 8), 0, 0, Math.PI * 2);
        if (hasFill) ctx.fill();
        if (hasStroke) ctx.stroke();
      } else if (l.kind === 'rect') {
        const rx = Number(l.x || 0);
        const ry = Number(l.y || 0);
        const rw = Number(l.width || 10);
        const rh = Number(l.height || 10);
        const cr = Number(l.cornerRadius || 0);
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(rx, ry, rw, rh, cr);
        } else {
          ctx.rect(rx, ry, rw, rh);
        }
        if (hasFill) ctx.fill();
        if (hasStroke) ctx.stroke();
      } else if (l.kind === 'sprite' && l.spritePath) {
        const img = getCachedImage(l.spritePath);
        if (img) {
          ctx.drawImage(img, Number(l.x || 0), Number(l.y || 0), Number(l.width || vbW), Number(l.height || vbH));
        }
      }
      ctx.restore();
    }
    ctx.restore();
  }

  function resolveTargetFps() {
    const anim = state?.animState || 'idle';
    if (anim === 'sleeping') return scene?.fps?.sleep || 4;
    if (anim === 'idle') return scene?.fps?.idle || 12;
    return scene?.fps?.active || 30;
  }

  function loop(ts) {
    if (!running) return;
    const minInterval = 1000 / Math.max(1, resolveTargetFps());
    const now = typeof ts === 'number' ? ts : Date.now();
    if (now - lastDrawAt >= minInterval) {
      lastDrawAt = now;
      drawFrame(Date.now());
    }
    if (typeof globalThis.requestAnimationFrame === 'function') {
      rafId = globalThis.requestAnimationFrame(loop);
    }
  }

  resize(logicalW, logicalH);

  return {
    setScene(nextScene, nextAssets = null) {
      scene = nextScene || null;
      if (nextAssets && typeof nextAssets === 'object') {
        assetMap = nextAssets;
      }
      pathCache.clear();
      drawFrame(Date.now());
    },
    setState(nextState) {
      state = { ...state, ...(nextState || {}) };
      drawFrame(Date.now());
    },
    resize,
    drawFrame,
    start() {
      if (running) return;
      running = true;
      if (typeof globalThis.requestAnimationFrame === 'function') {
        rafId = globalThis.requestAnimationFrame(loop);
      } else {
        drawFrame(Date.now());
      }
    },
    stop() {
      running = false;
      if (rafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
    dispose() {
      this.stop();
      pathCache.clear();
      imageCache.clear();
    }
  };
}

module.exports = {
  createPetCanvasStage
};
